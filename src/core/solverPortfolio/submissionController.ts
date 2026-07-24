import { FlagDiscriminator } from './flagDiscriminator.js'

export interface SubmissionRequest {
  taskId: string
  solverId: string
  candidateValue: string
  modelId: string
}

export interface SubmissionResponse {
  accepted: boolean
  message: string
  points?: number
}

export class SubmissionController {
  private isFakeMode: boolean

  constructor(isFakeMode = true) {
    this.isFakeMode = isFakeMode
  }

  public async submitFlag(req: SubmissionRequest): Promise<SubmissionResponse> {
    // Enforcement check: M3 or auxiliary models are strictly forbidden from direct submission
    if (req.modelId.includes('m3') || req.modelId.includes('mini')) {
      return {
        accepted: false,
        message: `Submission REJECTED by SubmissionController Policy: Model '${req.modelId}' has no platform submission permissions.`,
      }
    }

    // Must pass FlagDiscriminator first
    const discrimination = FlagDiscriminator.discriminate({
      candidateValue: req.candidateValue,
    })

    if (!discrimination.valid) {
      return {
        accepted: false,
        message: `Submission REJECTED: Candidate failed discrimination: ${discrimination.reason}`,
      }
    }

    if (this.isFakeMode) {
      // Fake mode simulated platform response for test / offline benchmark environment
      return {
        accepted: true,
        message: `[FakePlatform] Candidate '${req.candidateValue}' accepted for task '${req.taskId}'.`,
        points: 100,
      }
    }

    throw new Error('Real CTFd platform submission is intentionally disabled in Phase 3.0.')
  }
}
