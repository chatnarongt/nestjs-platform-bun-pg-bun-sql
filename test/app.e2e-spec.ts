import { INestApplication } from '@nestjs/common'
import { Test, TestingModule } from '@nestjs/testing'
import request from 'supertest'
import { App } from 'supertest/types'
import { PlatformBun } from '../src/libs/platform-bun/platform-bun.adapter.js'
import { AppModule } from '../src/modules/app/app.module.js'

describe('AppController (e2e)', () => {
  let app: INestApplication<App>

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile()

    app = moduleFixture.createNestApplication(new PlatformBun())
    await app.init()
  })

  it('/probe/liveness (GET)', () => {
    return request(app.getHttpServer()).get('/probe/liveness').expect(200).expect('OK')
  })

  afterEach(async () => {
    await app.close()
  })
})
