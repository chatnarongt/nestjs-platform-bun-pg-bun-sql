import { Module } from '@nestjs/common'
import { BenchController } from './bench.controller.js'

@Module({
  controllers: [BenchController],
})
export class BenchModule {}
