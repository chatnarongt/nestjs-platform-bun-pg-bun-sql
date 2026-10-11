import { ConfigService } from '@nestjs/config'
import { NestFactory } from '@nestjs/core'
import { PlatformBun } from './libs/platform-bun/platform-bun.adapter.js'
import { AppModule } from './modules/app/index.js'

async function bootstrap() {
  const app = await NestFactory.create(AppModule, new PlatformBun())

  const configService = app.get(ConfigService)

  const port = configService.get<number>('PORT') ?? 3000

  await app.listen(port)
}
await bootstrap()
