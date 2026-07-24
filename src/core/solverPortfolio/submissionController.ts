import { FlagDiscriminator } from './flagDiscriminator.js'

export interface SubmissionRequest {
  taskId: string
  solverId: string
  candidateValue: string
  modelId: string
}

export type SubmissionStatus =
  | 'simulated_accepted'
  | 'accepted'
  | 'rejected'
  | 'error'

export interface SubmissionResponse {
  status: SubmissionStatus
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
    if (req.modelId.includes('m3') || req.modelId.includes('mini')) {
      return {
        status: 'rejected',
        accepted: false,
        message: `Submission REJECTED by SubmissionController Policy: Model '${req.modelId}' has no platform submission permissions.`,
      }
    }

    const discrimination = FlagDiscriminator.discriminate({
      candidateValue: req.candidateValue,
    })

    if (!discrimination.valid) {
      return {
        status: 'rejected',
        accepted: false,
        message: `Submission REJECTED: Candidate failed discrimination: ${discrimination.reason}`,
      }
    }

    if (this.isFakeMode) {
      return {
        status: 'simulated_accepted',
        accepted: false,
        message: `[FakePlatform] Candidate '${req.candidateValue}' simulated accepted for task '${req.taskId}'.`,
        points: 100,
      }
    }

    throw new Error('Real CTFd platform submission is intentionally disabled in Phase 3.1.')
  }
}
