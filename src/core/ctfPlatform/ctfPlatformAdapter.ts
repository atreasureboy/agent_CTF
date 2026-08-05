import type {
  SubmissionRequest,
  SubmissionResponse,
} from '../solverPortfolio/submissionController.js'

export interface CTFdConfig {
  baseUrl: string
  apiToken: string
  challengeId?: string | number
}

export type PlatformVerdict =
  'accepted' | 'incorrect' | 'already_submitted' | 'rate_limited' | 'error'

export interface PlatformSubmissionResult {
  verdict: PlatformVerdict
  message: string
  points?: number
}

export class CTFPlatformAdapter {
  private config: CTFdConfig

  constructor(config: CTFdConfig) {
    this.config = config
  }

  /**
   * Submit flag to CTFd platform via HTTP REST API protocol.
   */
  public async submitToCTFd(req: SubmissionRequest): Promise<PlatformSubmissionResult> {
    const challengeId = this.config.challengeId
    if (!challengeId) {
      return {
        verdict: 'error',
        message: 'CTFd Adapter Error: Missing challengeId in configuration.',
      }
    }

    try {
      const url = `${this.config.baseUrl.replace(/\/$/, '')}/api/v1/challenges/attempt`
      const body = {
        challenge_id: challengeId,
        submission: req.candidateValue.trim(),
      }

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiToken}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      })

      if (res.status === 429) {
        return {
          verdict: 'rate_limited',
          message: 'CTFd Rate Limit: Too many flag submission attempts. Back off and retry later.',
        }
      }

      if (!res.ok) {
        return {
          verdict: 'error',
          message: `CTFd HTTP Error ${res.status}: ${res.statusText}`,
        }
      }

      const json = (await res.json()) as {
        success?: boolean
        data?: { status?: string; message?: string }
      }

      const status = json.data?.status || ''
      const message = json.data?.message || 'No response message'

      if (status === 'correct') {
        return {
          verdict: 'accepted',
          message: `[CTFd Success] ${message}`,
          points: 100,
        }
      } else if (status === 'already_solved') {
        return {
          verdict: 'already_submitted',
          message: `[CTFd Notice] ${message}`,
        }
      } else if (status === 'incorrect') {
        return {
          verdict: 'incorrect',
          message: `[CTFd Rejected] ${message}`,
        }
      }

      return {
        verdict: 'error',
        message: `[CTFd Unknown Status] ${status}: ${message}`,
      }
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'TimeoutError') {
        return {
          verdict: 'error',
          message: 'CTFd submission timed out after 10s.',
        }
      }
      const errMsg = err instanceof Error ? err.message : String(err)
      return {
        verdict: 'error',
        message: `CTFd Network Error: ${errMsg}`,
      }
    }
  }

  /**
   * Convert PlatformSubmissionResult to standard SubmissionResponse for SubmissionController.
   */
  public static mapToSubmissionResponse(res: PlatformSubmissionResult): SubmissionResponse {
    switch (res.verdict) {
      case 'accepted':
        return {
          status: 'accepted',
          accepted: true,
          message: res.message,
          points: res.points ?? 100,
        }
      case 'incorrect':
        return {
          status: 'rejected',
          accepted: false,
          message: res.message,
        }
      case 'already_submitted':
        return {
          status: 'rejected',
          accepted: false,
          message: res.message,
        }
      case 'rate_limited':
        return {
          status: 'error',
          accepted: false,
          message: res.message,
        }
      default:
        return {
          status: 'error',
          accepted: false,
          message: res.message,
        }
    }
  }
}
