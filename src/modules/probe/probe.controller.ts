import { Controller, Get, ServiceUnavailableException } from '@nestjs/common'
import { LivenessService, ReadinessService } from './services/index.js'

@Controller('probe')
export class ProbeController {
  constructor(
    private readonly livenessService: LivenessService,
    private readonly readinessService: ReadinessService,
  ) {}

  @Get('liveness')
  checkLiveness(): 'OK' {
    if (!this.livenessService.checkLiveness()) {
      throw new ServiceUnavailableException()
    }
    return 'OK'
  }

  @Get('readiness')
  checkReadiness(): 'OK' {
    if (!this.readinessService.checkReadiness()) {
      throw new ServiceUnavailableException()
    }
    return 'OK'
  }
}
