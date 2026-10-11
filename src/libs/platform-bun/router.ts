import type { MatchFunction } from 'path-to-regexp'
import { match } from 'path-to-regexp'
import type { Handler } from './shims.js'
import { BunRequest, BunResponse } from './shims.js'

type LayerHandler =
  | Handler
  | ((err: unknown, req: BunRequest, res: BunResponse, next: (e?: unknown) => void) => unknown)

type Layer = {
  method: string | null
  matcher: MatchFunction<Record<string, string>>
  handle: LayerHandler
}

/** The `this.instance` object AbstractHttpAdapter's verb methods delegate to. */
export class RouteStack {
  private layers: Layer[] = []
  errorLayer: LayerHandler | null = null

  use(...args: unknown[]): this {
    const handlers = this.extractHandlers(args)
    for (const handle of handlers) this.push(null, '/', false, handle)
    return this
  }

  get(path: string, ...handlers: LayerHandler[]) {
    return this.pushAll('get', path, handlers)
  }
  post(path: string, ...handlers: LayerHandler[]) {
    return this.pushAll('post', path, handlers)
  }
  put(path: string, ...handlers: LayerHandler[]) {
    return this.pushAll('put', path, handlers)
  }
  patch(path: string, ...handlers: LayerHandler[]) {
    return this.pushAll('patch', path, handlers)
  }
  delete(path: string, ...handlers: LayerHandler[]) {
    return this.pushAll('delete', path, handlers)
  }
  head(path: string, ...handlers: LayerHandler[]) {
    return this.pushAll('head', path, handlers)
  }
  options(path: string, ...handlers: LayerHandler[]) {
    return this.pushAll('options', path, handlers)
  }
  all(path: string, ...handlers: LayerHandler[]) {
    return this.pushAll(null, path, handlers)
  }
  search(path: string, ...handlers: LayerHandler[]) {
    return this.pushAll('search', path, handlers)
  }
  propfind(path: string, ...handlers: LayerHandler[]) {
    return this.pushAll('propfind', path, handlers)
  }
  proppatch(path: string, ...handlers: LayerHandler[]) {
    return this.pushAll('proppatch', path, handlers)
  }
  mkcol(path: string, ...handlers: LayerHandler[]) {
    return this.pushAll('mkcol', path, handlers)
  }
  copy(path: string, ...handlers: LayerHandler[]) {
    return this.pushAll('copy', path, handlers)
  }
  move(path: string, ...handlers: LayerHandler[]) {
    return this.pushAll('move', path, handlers)
  }
  lock(path: string, ...handlers: LayerHandler[]) {
    return this.pushAll('lock', path, handlers)
  }
  unlock(path: string, ...handlers: LayerHandler[]) {
    return this.pushAll('unlock', path, handlers)
  }
  query(path: string, ...handlers: LayerHandler[]) {
    return this.pushAll('query', path, handlers)
  }

  setErrorHandler(handler: LayerHandler) {
    this.errorLayer = handler
    return this
  }

  /**
   * Run matching layers connect-style. Returns the propagated error, or
   * undefined when the chain completed cleanly (response may or may not be sent).
   */
  async dispatch(req: BunRequest, res: BunResponse): Promise<unknown> {
    const path = req.path
    const layers = this.layers.filter((layer) => this.matches(layer, req.method, path))

    for (const layer of layers) {
      const result = layer.matcher(path)
      if (result !== false) req.params = { ...req.params, ...result.params }

      let continued = false
      let error: unknown
      let errored = false

      await new Promise<void>((resolve) => {
        const settle = () => resolve()
        const next = (e?: unknown) => {
          if (e !== undefined) {
            errored = true
            error = e
          }
          continued = true
          settle()
        }
        let result: unknown
        try {
          result =
            layer.handle.length === 4
              ? (
                  layer.handle as (
                    e: unknown,
                    r: BunRequest,
                    s: BunResponse,
                    n: (e?: unknown) => void,
                  ) => unknown
                )(error, req, res, next)
              : (layer.handle as Handler)(req, res, next)
        } catch (e) {
          errored = true
          error = e
          settle()
          return
        }
        if (result && typeof (result as Promise<unknown>).then === 'function') {
          ;(result as Promise<unknown>).then(settle, (e) => {
            errored = true
            error = e
            settle()
          })
        } else if (continued || res.writableEnded) {
          settle()
        }
        // sync handler that deferred `next` — chain waits for it
      })

      if (errored) return error
      if (!continued) return undefined
    }
    return undefined
  }

  private extractHandlers(args: unknown[]): LayerHandler[] {
    if (
      typeof args[0] === 'string' ||
      (args[0] &&
        typeof args[0] === 'object' &&
        typeof (args[0] as { handle?: unknown }).handle !== 'function')
    ) {
      // (path, ...handlers) or (path, nested) — nested `use` not supported
      return args.slice(1).filter((a) => typeof a === 'function') as LayerHandler[]
    }
    return args.filter((a) => typeof a === 'function') as LayerHandler[]
  }

  private pushAll(method: string | null, path: string, handlers: LayerHandler[]) {
    for (const handle of handlers) this.push(method, path, true, handle)
    return this
  }

  private push(method: string | null, path: string, end: boolean, handle: LayerHandler) {
    this.layers.push({
      method,
      matcher: match(path, { end }),
      handle,
    })
  }

  private matches(layer: Layer, method: string, path: string): boolean {
    if (!layer.matcher(path)) return false
    if (layer.method === null) return true
    if (layer.method === method.toLowerCase()) return true
    return layer.method === 'get' && method === 'HEAD'
  }
}
