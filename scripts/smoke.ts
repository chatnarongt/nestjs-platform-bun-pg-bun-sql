/**
 * Bun-native smoke test for PlatformBun.
 * Runs against compiled dist/ because Bun does not emit decorator metadata.
 */
import { NestFactory } from '@nestjs/core'
import type { PlatformBun } from '../src/libs/platform-bun/platform-bun.adapter.js'
import type { AppModule } from '../src/modules/app/index.js'

const dist = (path: string) => new URL(`../dist/${path}`, import.meta.url).href
const { PlatformBun: PlatformBunCtor } = (await import(
  dist('libs/platform-bun/platform-bun.adapter.js')
)) as {
  PlatformBun: new () => PlatformBun
}
const { AppModule: AppModuleCtor } = (await import(dist('modules/app/index.js'))) as {
  AppModule: typeof AppModule
}

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`FAIL: ${message}`)
    process.exit(1)
  }
  console.log(`ok: ${message}`)
}

const app = await NestFactory.create(AppModuleCtor, new PlatformBunCtor(), { logger: false })
await app.listen(0, '127.0.0.1')
const address = app.getHttpServer().address()
const base = `http://127.0.0.1:${address?.port}`

const liveness = await fetch(`${base}/probe/liveness`)
assert(liveness.status === 200, `GET /probe/liveness → 200 (got ${liveness.status})`)
assert((await liveness.text()) === 'OK', 'GET /probe/liveness body is OK')

const readiness = await fetch(`${base}/probe/readiness`)
assert(readiness.status === 200, `GET /probe/readiness → 200 (got ${readiness.status})`)

const missing = await fetch(`${base}/nope`)
assert(missing.status === 404, `GET /nope → 404 (got ${missing.status})`)

await app.close()
console.log('smoke passed')
process.exit(0)
