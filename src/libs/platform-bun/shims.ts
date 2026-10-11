import { EventEmitter } from 'node:events'

export type AddressInfo = {
  port: number
  family: string
  address: string
}

type Handler = (req: BunRequest, res: BunResponse, next: (err?: unknown) => void) => unknown

/** Node-shaped request. Extensible — Nest core writes `REQUEST_CONTEXT_ID` onto it. */
export class BunRequest {
  method: string
  originalUrl: string
  headers: Record<string, string | string[] | undefined>
  query: Record<string, string | string[] | undefined> = {}
  params: Record<string, string> = {}
  body: unknown = {}
  rawBody?: Buffer
  ip: string
  hostname: string
  hosts: Record<string, string[]> = {}
  socket: EventEmitter & {
    setKeepAlive: (v: boolean) => void
    setNoDelay: (v: boolean) => void
    setTimeout: (ms: number) => void
    remoteAddress?: string
    destroy?: () => void
  }

  constructor(webReq: Request, ip: string) {
    const url = new URL(webReq.url)
    this.method = webReq.method
    this.originalUrl = url.pathname + url.search
    this.headers = Object.fromEntries(webReq.headers)
    this.hostname = url.hostname
    this.ip = ip
    for (const [key, value] of url.searchParams) {
      const existing = this.query[key]
      if (existing === undefined) this.query[key] = value
      else if (Array.isArray(existing)) existing.push(value)
      else this.query[key] = [existing, value]
    }
    const socket = new EventEmitter() as BunRequest['socket']
    socket.setKeepAlive = () => {}
    socket.setNoDelay = () => {}
    socket.setTimeout = () => {}
    socket.remoteAddress = ip
    webReq.signal?.addEventListener?.('abort', () => socket.emit('close'))
    this.socket = socket
  }

  get path() {
    return this.originalUrl.split(/[?#]/)[0]
  }
}

/**
 * Node `ServerResponse`-shaped shim that materializes a Web `Response`.
 * First `write()` flips to streaming so SSE and `StreamableFile` work.
 */
export class BunResponse extends EventEmitter {
  statusCode = 200
  headersSent = false
  writableEnded = false
  readonly writable = true

  #headers = new Headers()
  #buffer: Buffer[] = []
  #controller: ReadableStreamDefaultController<Uint8Array> | null = null
  #resolve: (res: Response) => void
  readonly done: Promise<Response>

  constructor() {
    super()
    this.done = new Promise<Response>((resolve) => {
      this.#resolve = resolve
    })
  }

  setHeader(name: string, value: string | number | string[]) {
    this.#headers.set(name, Array.isArray(value) ? value.join(', ') : String(value))
    return this
  }

  getHeader(name: string) {
    return this.#headers.get(name) ?? undefined
  }

  appendHeader(name: string, value: string | number | string[]) {
    const next = Array.isArray(value) ? value.join(', ') : String(value)
    const existing = this.#headers.get(name)
    this.#headers.set(name, existing ? `${existing}, ${next}` : next)
    return this
  }

  removeHeader(name: string) {
    this.#headers.delete(name)
    return this
  }

  flushHeaders() {
    this.headersSent = true
  }

  writeHead(statusCode: number, headers?: Record<string, string | number | string[]>) {
    this.statusCode = statusCode
    if (headers) {
      for (const [name, value] of Object.entries(headers)) this.setHeader(name, value)
    }
    this.headersSent = true
    return this
  }

  write(chunk: string | Uint8Array): boolean {
    this.headersSent = true
    if (!this.#controller) this.#startStream()
    this.#controller?.enqueue(this.#toBytes(chunk))
    return true
  }

  end(chunk?: string | Uint8Array): this {
    if (this.writableEnded) return this
    this.writableEnded = true
    this.headersSent = true
    if (chunk !== undefined && chunk !== null && chunk !== '') {
      if (!this.#controller) this.#startStream()
      this.#controller?.enqueue(this.#toBytes(chunk))
    }
    if (this.#controller) {
      try {
        this.#controller.close()
      } catch {
        /* already closed */
      }
      this.#controller = null
    } else {
      const body = this.#buffer.length ? Buffer.concat(this.#buffer) : null
      this.#resolve(new Response(body, { status: this.statusCode, headers: this.#headers }))
    }
    this.emit('finish')
    return this
  }

  json(body: unknown): this {
    if (!this.#headers.has('Content-Type')) this.setHeader('Content-Type', 'application/json')
    return this.end(JSON.stringify(body))
  }

  send(body?: string): this {
    if (body === undefined || body === null || body === '') return this.end()
    if (!this.#headers.has('Content-Type'))
      this.setHeader('Content-Type', 'text/plain; charset=utf-8')
    return this.end(body)
  }

  /** Node stream `pipe` compatibility — always accepts more writes. */
  get destroyed() {
    return this.writableEnded
  }

  #startStream() {
    this.#controller = null
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.#controller = controller
      },
    })
    this.#resolve(new Response(stream, { status: this.statusCode, headers: this.#headers }))
  }

  #toBytes(chunk: string | Uint8Array) {
    return typeof chunk === 'string' ? Buffer.from(chunk) : chunk
  }
}

/**
 * `net.Server`-shaped handle returned by `getHttpServer()`.
 * Under Bun it wraps `Bun.serve`; under Node (vitest/supertest) it falls back to `node:http`
 * so the same dispatch path can be exercised without the Bun runtime.
 * ponytail: node bridge is a test-only shim — delete when tests run under Bun.
 */
export class BunServer extends EventEmitter {
  private handle: { stop: (force?: boolean) => void } | import('node:http').Server | null = null
  private openSockets = new Set<{ destroy: () => void }>()
  private addressInfo: AddressInfo | null = null
  private forceCloseConnections = false
  private dispatch: (req: Request) => Promise<Response>

  constructor(dispatch: (req: Request) => Promise<Response>) {
    super()
    this.dispatch = dispatch
  }

  setForceCloseConnections(value: boolean) {
    this.forceCloseConnections = value
  }

  address() {
    return this.addressInfo
  }

  listen(port: number, hostname?: string, callback?: () => void): this
  listen(port: number, callback?: () => void): this
  listen(port: number, hostnameOrCallback?: string | (() => void), maybeCallback?: () => void) {
    const hostname = typeof hostnameOrCallback === 'string' ? hostnameOrCallback : undefined
    const callback = typeof hostnameOrCallback === 'function' ? hostnameOrCallback : maybeCallback

    const start = (address: AddressInfo) => {
      this.addressInfo = address
      this.emit('listening')
      callback?.()
    }

    if (typeof Bun !== 'undefined') {
      const server = Bun.serve({
        port,
        hostname: hostname ?? '0.0.0.0',
        fetch: (req: Request) => this.dispatch(req),
      })
      this.handle = server
      start({ port: server.port ?? port, family: 'IPv4', address: hostname ?? '0.0.0.0' })
      return this
    }

    void this.startNodeServer(port, hostname, start)
    return this
  }

  close(callback?: () => void) {
    if (!this.handle) {
      callback?.()
      return Promise.resolve()
    }
    const handle = this.handle
    this.handle = null
    this.addressInfo = null

    if ('stop' in handle) {
      handle.stop(this.forceCloseConnections)
      this.emit('close')
      callback?.()
      return Promise.resolve()
    }

    return new Promise<void>((resolve) => {
      const done = () => {
        this.emit('close')
        callback?.()
        resolve()
      }
      if (this.forceCloseConnections) {
        for (const socket of this.openSockets) socket.destroy()
        this.openSockets.clear()
      }
      handle.close(() => done())
    })
  }

  private async startNodeServer(
    port: number,
    hostname: string | undefined,
    start: (a: AddressInfo) => void,
  ) {
    const http = await import('node:http')
    const { Readable } = await import('node:stream')

    const server = http.createServer(async (nodeReq, nodeRes) => {
      const host = nodeReq.headers.host ?? `${hostname ?? '127.0.0.1'}:${port}`
      const chunks: Buffer[] = []
      for await (const chunk of nodeReq) chunks.push(chunk as Buffer)
      const body = chunks.length ? Buffer.concat(chunks) : undefined

      const webReq = new Request(`http://${host}${nodeReq.url ?? '/'}`, {
        method: nodeReq.method,
        headers: nodeReq.headers as Record<string, string>,
        body,
        duplex: 'half',
      } as RequestInit & { duplex: 'half' })

      const webRes = await this.dispatch(webReq)
      nodeRes.writeHead(webRes.status, Object.fromEntries(webRes.headers))
      if (webRes.body) {
        Readable.fromWeb(webRes.body as unknown as import('node:stream/web').ReadableStream).pipe(
          nodeRes,
        )
      } else {
        nodeRes.end()
      }
    })

    server.on('connection', (socket) => {
      this.openSockets.add(socket)
      socket.on('close', () => this.openSockets.delete(socket))
    })

    this.handle = server
    server.listen(port, hostname ?? '0.0.0.0', () => {
      const info = server.address() as AddressInfo | null
      start(info ?? { port, family: 'IPv4', address: hostname ?? '0.0.0.0' })
    })
  }
}

export type { Handler }
