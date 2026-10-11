import { Injectable } from '@nestjs/common'

@Injectable()
export class ReadinessService {
  checkReadiness(): boolean {
    return true
  }
}
