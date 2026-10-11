import {
  BadRequestException,
  HttpStatus,
  InternalServerErrorException,
  Logger,
  type NestApplicationOptions,
  type RequestMethod,
  StreamableFile,
  VERSION_NEUTRAL,
  type VersioningOptions,
  VersioningType,
} from '@nestjs/common'
import type { VersionValue } from '@nestjs/common/internal'
import { AbstractHttpAdapter } from '@nestjs/core'
import { LegacyRouteConverter, RouterMethodFactory } from '@nestjs/core/internal'
import { pathToRegexp } from 'path-to-regexp'
import { RouteStack } from './router.js'
import { BunRequest, BunResponse, BunServer } from './shims.js'

type Handler = (req: BunRequest, res: BunResponse, next: (err?: unknown) => void) => unknown

function isJsonContentType(contentType: string) {
  const mediaType = contentType.split(';')[0].trim().toLowerCase()
  return mediaType.startsWith('application/json') || mediaType.endsWith('+json')
}

function getMediaTypeVersion(acceptHeader: string | string[] | undefined, key: string) {
  const mediaRanges = ([] as string[])
    .concat(acceptHeader ?? [])
    .flatMap((value) => value.split(','))
  for (const mediaRange of mediaRanges) {
    const [, ...parameters] = mediaRange.split(';')
    for (const parameter of parameters) {
      const trimmedParameter = parameter.trim()
      if (trimmedParameter.startsWith(key)) return trimmedParameter.slice(key.length)
    }
  }
  return undefined
}

/**
 * NestJS HTTP adapter backed by `Bun.serve`.
 * Bridges Bun's Web Request/Response to Nest's `(req, res, next)` Node-shaped world.
 */
export class PlatformBun extends AbstractHttpAdapter<BunServer, BunRequest, BunResponse> {
  private readonly routerMethodFactory = new RouterMethodFactory()
  private readonly logger = new Logger(PlatformBun.name)
  private rawBody = false
  private isShuttingDown = false
  private return503OnClosing = false
  private notFoundHandler: Handler | null = null
  private onRequestHook: ((...args: unknown[]) => unknown) | undefined
  private onResponseHook: ((...args: unknown[]) => unknown) | undefined

  constructor() {
    super(new RouteStack() as never)
  }

  initHttpServer(options: NestApplicationOptions) {
    if (options?.httpsOptions) {
      // ponytail: TLS — upgrade to Bun.serve({ tls }) when needed
      throw new Error('httpsOptions is not supported by PlatformBun')
    }
    this.return503OnClosing = !!options?.return503OnClosing
    const server = new BunServer((webReq: Request) => this.dispatch(webReq))
    server.setForceCloseConnections(!!options?.forceCloseConnections)
    this.setHttpServer(server)

    // Security hooks + request/response instrumentation run first, like ExpressAdapter.
    this.instance.use(async (req: BunRequest, res: BunResponse, next: (err?: unknown) => void) => {
      if (this.onResponseHook) {
        res.on('finish', () => {
          void this.onResponseHook?.apply(this, [req, res])
        })
      }
      if (this.onRequestHook) await this.onRequestHook.apply(this, [req, res, next])
      else next()
    })
  }

  setOnRequestHook(hook: (...args: unknown[]) => unknown) {
    this.onRequestHook = hook
  }

  setOnResponseHook(hook: (...args: unknown[]) => unknown) {
    this.onResponseHook = hook
  }

  async listen(
    port: number,
    hostnameOrCallback?: string | (() => void),
    maybeCallback?: () => void,
  ) {
    const hostname = typeof hostnameOrCallback === 'string' ? hostnameOrCallback : undefined
    const callback = typeof hostnameOrCallback === 'function' ? hostnameOrCallback : maybeCallback
    this.httpServer?.listen(port, hostname, callback)
    return this.httpServer
  }

  beforeClose() {
    this.isShuttingDown = true
  }

  close() {
    this.isShuttingDown = true
    return this.httpServer?.close()
  }

  getRequestMethod(request: BunRequest) {
    return request.method
  }

  getRequestUrl(request: BunRequest) {
    return request.originalUrl
  }

  getRequestHostname(request: BunRequest) {
    return request.hostname
  }

  status(response: BunResponse, statusCode: number) {
    response.statusCode = statusCode
    return response
  }

  reply(response: BunResponse, body: unknown, statusCode?: number) {
    if (statusCode !== undefined && statusCode !== null) response.statusCode = statusCode
    if (body === undefined || body === null) return response.end()

    if (body instanceof StreamableFile) {
      this.applyStreamHeaders(response, body)
      const stream = body.getStream()
      stream.once('error', (err: Error) => body.errorHandler(err, response as never))
      stream.pipe(response as never)
      return
    }

    const contentType = response.getHeader('Content-Type')
    const bodyStatus = (body as { statusCode?: number } | null)?.statusCode
    if (
      typeof contentType === 'string' &&
      !isJsonContentType(contentType) &&
      bodyStatus !== undefined &&
      bodyStatus >= HttpStatus.BAD_REQUEST
    ) {
      this.logger.warn(
        "Content-Type doesn't match Reply body, you might need a custom ExceptionFilter for non-JSON responses",
      )
      response.setHeader('Content-Type', 'application/json')
    }

    return typeof body === 'object' ? response.json(body) : response.send(String(body))
  }

  end(response: BunResponse, message?: string) {
    return response.end(message)
  }

  redirect(response: BunResponse, statusCode: number, url: string) {
    response.statusCode = statusCode
    response.setHeader('Location', url)
    return response.end()
  }

  setErrorHandler(
    // biome-ignore lint/complexity/noBannedTypes: matches AbstractHttpAdapter signature
    handler: Function,
    _prefix?: string,
  ) {
    // ponytail: prefix ignored — single-app only
    return this.instance.setErrorHandler(handler as never)
  }

  setNotFoundHandler(
    // biome-ignore lint/complexity/noBannedTypes: matches AbstractHttpAdapter signature
    handler: Function,
    _prefix?: string,
  ) {
    // ponytail: prefix ignored — single-app only
    this.notFoundHandler = handler as never
  }

  isHeadersSent(response: BunResponse) {
    return response.headersSent
  }

  getHeader(response: BunResponse, name: string) {
    return response.getHeader(name)
  }

  setHeader(response: BunResponse, name: string, value: string) {
    return response.setHeader(name, value)
  }

  appendHeader(response: BunResponse, name: string, value: string) {
    return response.appendHeader(name, value)
  }

  registerParserMiddleware(_prefix?: string, rawBody?: boolean) {
    this.rawBody = !!rawBody
  }

  enableCors(options?: Record<string, unknown>) {
    const cors = this.createCorsMiddleware(options)
    return this.instance.use(cors)
  }

  createMiddlewareFactory(requestMethod: RequestMethod) {
    // biome-ignore lint/complexity/noBannedTypes: matches AbstractHttpAdapter signature
    return (path: string, callback: Function) => {
      try {
        const convertedPath = LegacyRouteConverter.tryConvert(path)
        return this.routerMethodFactory
          .get(this.instance, requestMethod)
          .call(this.instance, convertedPath, callback)
      } catch (e) {
        if (e instanceof TypeError) LegacyRouteConverter.printError(path)
        throw e
      }
    }
  }

  getType() {
    return 'bun'
  }

  isRouteOrderSensitive() {
    return true
  }

  useStaticAssets(..._args: unknown[]) {
    // ponytail: static files — upgrade to a Bun.file() middleware when needed
    throw new Error('useStaticAssets is not supported by PlatformBun')
  }

  setViewEngine(_engine: string) {
    // ponytail: views — JSON API first-class
    throw new Error('setViewEngine is not supported by PlatformBun')
  }

  render(_response: BunResponse, _view: string, _options: unknown) {
    // ponytail: views — JSON API first-class
    throw new Error('render is not supported by PlatformBun')
  }

  normalizePath(path: string) {
    try {
      const convertedPath = LegacyRouteConverter.tryConvert(path)
      // Call "pathToRegexp" to trigger a TypeError if path invalid
      pathToRegexp(convertedPath)
      return convertedPath
    } catch (e) {
      if (e instanceof TypeError) LegacyRouteConverter.printError(path)
      throw e
    }
  }

  mapException(error: unknown) {
    if (error instanceof SyntaxError || error instanceof URIError) {
      return new BadRequestException(error.message)
    }
    return error
  }

  applyVersionFilter(
    // biome-ignore lint/complexity/noBannedTypes: matches AbstractHttpAdapter signature
    handler: Function,
    version: VersionValue,
    versioningOptions: VersioningOptions,
  ) {
    const callNextHandler = (_req: BunRequest, _res: BunResponse, next?: (e?: unknown) => void) => {
      if (!next)
        throw new InternalServerErrorException('HTTP adapter does not support filtering on version')
      return next()
    }
    const run = (req: BunRequest, res: BunResponse, next: (e?: unknown) => void) =>
      handler(req, res, next)

    if (version === VERSION_NEUTRAL || versioningOptions.type === VersioningType.URI) {
      return (req: BunRequest, res: BunResponse, next: (e?: unknown) => void) => run(req, res, next)
    }

    if (versioningOptions.type === VersioningType.CUSTOM) {
      return (req: BunRequest, res: BunResponse, next: (e?: unknown) => void) => {
        const extractedVersion = versioningOptions.extractor?.(req) as string | string[] | undefined
        const versions = Array.isArray(version) ? (version as string[]) : null
        if (versions) {
          if (
            Array.isArray(extractedVersion) &&
            versions.some((v) => extractedVersion.includes(v))
          ) {
            return run(req, res, next)
          }
          if (typeof extractedVersion === 'string' && versions.includes(extractedVersion)) {
            return run(req, res, next)
          }
        } else if (typeof version === 'string') {
          if (Array.isArray(extractedVersion) && extractedVersion.includes(version))
            return run(req, res, next)
          if (typeof extractedVersion === 'string' && version === extractedVersion)
            return run(req, res, next)
        }
        return callNextHandler(req, res, next)
      }
    }

    if (versioningOptions.type === VersioningType.MEDIA_TYPE) {
      return (req: BunRequest, res: BunResponse, next: (e?: unknown) => void) => {
        const headerVersion = getMediaTypeVersion(
          req.headers?.accept as string | undefined,
          versioningOptions.key,
        )
        const versions = Array.isArray(version) ? (version as unknown[]) : null
        if (headerVersion === undefined) {
          if (versions?.includes(VERSION_NEUTRAL)) return run(req, res, next)
        } else if (versions) {
          if (versions.includes(headerVersion)) return run(req, res, next)
        } else if (typeof version === 'string' && version === headerVersion) {
          return run(req, res, next)
        }
        return callNextHandler(req, res, next)
      }
    }

    if (versioningOptions.type === VersioningType.HEADER) {
      return (req: BunRequest, res: BunResponse, next: (e?: unknown) => void) => {
        const headerName = versioningOptions.header
        const customHeaderVersionParameter = headerName
          ? (req.headers?.[headerName] ?? req.headers?.[headerName.toLowerCase()])
          : undefined
        const versions = Array.isArray(version) ? (version as unknown[]) : null
        if (customHeaderVersionParameter === undefined) {
          if (versions?.includes(VERSION_NEUTRAL)) return run(req, res, next)
        } else if (versions) {
          if (versions.includes(customHeaderVersionParameter)) return run(req, res, next)
        } else if (typeof version === 'string' && version === customHeaderVersionParameter) {
          return run(req, res, next)
        }
        return callNextHandler(req, res, next)
      }
    }

    throw new Error('Unsupported versioning options')
  }

  private async dispatch(webReq: Request): Promise<Response> {
    const req = new BunRequest(webReq, this.resolveIp(webReq))
    const res = new BunResponse()

    if (this.isShuttingDown && this.return503OnClosing) {
      res.setHeader('Connection', 'close')
      res.statusCode = HttpStatus.SERVICE_UNAVAILABLE
      res.end('Service Unavailable')
      return res.done
    }

    let error: unknown
    try {
      await this.parseBody(req, webReq)
      error = await this.instance.dispatch(req, res)
    } catch (e) {
      error = e
    }

    if (error !== undefined) {
      await this.runErrorHandler(error, req, res)
    } else if (!res.writableEnded) {
      await this.runNotFound(req, res)
    }
    return res.done
  }

  private async parseBody(req: BunRequest, webReq: Request) {
    if (webReq.method === 'GET' || webReq.method === 'HEAD') {
      req.body = {}
      return
    }
    const raw = Buffer.from(await webReq.arrayBuffer())
    if (this.rawBody) req.rawBody = raw
    if (raw.length === 0) {
      req.body = {}
      return
    }

    const contentType = webReq.headers.get('content-type') ?? ''
    if (isJsonContentType(contentType)) {
      req.body = JSON.parse(raw.toString('utf8'))
      return
    }
    if (contentType.includes('application/x-www-form-urlencoded')) {
      const params = new URLSearchParams(raw.toString('utf8'))
      const body: Record<string, string | string[]> = {}
      for (const [key, value] of params) {
        const existing = body[key]
        if (existing === undefined) body[key] = value
        else if (Array.isArray(existing)) existing.push(value)
        else body[key] = [existing, value]
      }
      req.body = body
      return
    }
    if (contentType.startsWith('text/')) {
      req.body = raw.toString('utf8')
      return
    }
    req.body = raw
  }

  private async runErrorHandler(error: unknown, req: BunRequest, res: BunResponse) {
    const handler = this.instance.errorLayer
    if (!handler) {
      if (!res.writableEnded) {
        res.statusCode = HttpStatus.INTERNAL_SERVER_ERROR
        res.json({ statusCode: 500, message: 'Internal server error' })
      }
      return
    }
    try {
      await (
        handler as (e: unknown, r: BunRequest, s: BunResponse, n: (e?: unknown) => void) => unknown
      )(error, req, res, () => {})
    } catch {
      if (!res.writableEnded) {
        res.statusCode = HttpStatus.INTERNAL_SERVER_ERROR
        res.json({ statusCode: 500, message: 'Internal server error' })
      }
    }
  }

  private async runNotFound(req: BunRequest, res: BunResponse) {
    if (!this.notFoundHandler) {
      res.statusCode = HttpStatus.NOT_FOUND
      res.json({ statusCode: 404, message: `Cannot ${req.method} ${req.originalUrl}` })
      return
    }
    await (this.notFoundHandler as unknown as Handler)(req, res, () => {})
  }

  private resolveIp(webReq: Request): string {
    const forwarded = webReq.headers.get('x-forwarded-for')
    if (forwarded) return forwarded.split(',')[0].trim()
    const url = new URL(webReq.url)
    return url.hostname
  }

  private createCorsMiddleware(options: Record<string, unknown> = {}) {
    const origin = options.origin ?? true
    const methods = (options.methods as string[] | undefined) ?? [
      'GET',
      'HEAD',
      'PUT',
      'PATCH',
      'POST',
      'DELETE',
    ]
    const allowedHeaders = options.allowedHeaders as string | string[] | undefined
    const exposedHeaders = options.exposedHeaders as string | string[] | undefined
    const credentials = !!options.credentials
    const maxAge = (options.maxAge as number | undefined) ?? 86400
    const optionsSuccessStatus = (options.optionsSuccessStatus as number | undefined) ?? 204

    return (req: BunRequest, res: BunResponse, next: (err?: unknown) => void) => {
      const requestOrigin = req.headers.origin as string | undefined
      const allowOrigin =
        origin === true
          ? (requestOrigin ?? '*')
          : typeof origin === 'string'
            ? origin
            : Array.isArray(origin) && requestOrigin && origin.includes(requestOrigin)
              ? requestOrigin
              : null

      if (allowOrigin) {
        res.setHeader('Access-Control-Allow-Origin', allowOrigin)
        res.setHeader('Vary', 'Origin')
        if (credentials) res.setHeader('Access-Control-Allow-Credentials', 'true')
        if (exposedHeaders) {
          res.setHeader(
            'Access-Control-Expose-Headers',
            Array.isArray(exposedHeaders) ? exposedHeaders.join(',') : exposedHeaders,
          )
        }
      }

      if (req.method === 'OPTIONS' && req.headers['access-control-request-method']) {
        res.setHeader(
          'Access-Control-Allow-Methods',
          Array.isArray(methods) ? methods.join(',') : String(methods),
        )
        if (allowedHeaders) {
          res.setHeader(
            'Access-Control-Allow-Headers',
            Array.isArray(allowedHeaders) ? allowedHeaders.join(',') : allowedHeaders,
          )
        } else if (req.headers['access-control-request-headers']) {
          res.setHeader(
            'Access-Control-Allow-Headers',
            req.headers['access-control-request-headers'] as string,
          )
          res.setHeader('Vary', 'Origin, Access-Control-Request-Headers')
        }
        res.setHeader('Access-Control-Max-Age', String(maxAge))
        res.statusCode = optionsSuccessStatus
        res.end()
        return
      }
      next()
    }
  }

  private applyStreamHeaders(response: BunResponse, body: StreamableFile) {
    const headers = body.getHeaders()
    for (const [name, value] of Object.entries(headers)) {
      if (value === undefined || response.getHeader(name) !== undefined) continue
      response.setHeader(name, value as string)
    }
  }
}
