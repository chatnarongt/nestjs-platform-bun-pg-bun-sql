import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { BenchModule } from '../bench/bench.module.js'
import { DatabaseModule } from '../database/database.module.js'
import { ProbeModule } from '../probe/probe.module.js'

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    DatabaseModule,
    ProbeModule,
    BenchModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
