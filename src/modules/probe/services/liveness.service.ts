import { Injectable } from '@nestjs/common'

@Injectable()
export class LivenessService {
  checkLiveness(): boolean {
    return true
  }
}
