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
  | 'accepted'
  | 'incorrect'
  | 'already_submitted'
  | 'rate_limited'
  | 'error'

export interface PlatformSubmissionResult {
  verdict: PlatformVerdict
  message: string
  points?: number
}

export class CTFPlatformAdapter {
  private config: CTFdConfig
  private readonly maxRetries: number
  private readonly baseBackoffMs: number

  constructor(
    config: CTFdConfig,
    retryOptions: { maxRetries?: number; baseBackoffMs?: number } = {},
  ) {
    this.config = config
    this.maxRetries = retryOptions.maxRetries ?? 4
    this.baseBackoffMs = retryOptions.baseBackoffMs ?? 1000
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
   * §Round-5 — Submit with exponential backoff retry.
   *
   * Gracefully handles transient failures:
   *   - HTTP 429 (rate limited) → 1s → 2s → 4s → 8s backoff
   *   - HTTP 5xx → 1 retry after 2s
   *   - TimeoutError → 1 retry after 5s
   *   - 'incorrect'/'already_submitted' → never retried (terminal)
   */
  public async submitWithRetry(req: SubmissionRequest): Promise<PlatformSubmissionResult> {
    let lastResponse: PlatformSubmissionResult | null = null

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      const response = await this.submitToCTFd(req)

      // Terminal outcomes — don't retry
      if (response.verdict === 'accepted' || response.verdict === 'already_submitted') {
        return response
      }
      if (response.verdict === 'incorrect') {
        return response
      }

      lastResponse = response

      // Don't wait on the last attempt
      if (attempt >= this.maxRetries - 1) break

      // Calculate backoff
      const delayMs = this.calculateBackoff(attempt, response)
      if (delayMs > 0) {
        await sleep(delayMs)
      }
    }

    return lastResponse ?? { verdict: 'error', message: 'All retry attempts exhausted' }
  }

  /**
   * Calculate backoff based on failure type and attempt index.
   */
  private calculateBackoff(attempt: number, response: PlatformSubmissionResult): number {
    if (response.verdict === 'rate_limited') {
      // Exponential: 1s, 2s, 4s, 8s
      return this.baseBackoffMs * Math.pow(2, attempt)
    }
    if (response.verdict === 'error') {
      // Fixed: 2s, 5s
      return attempt === 0 ? 2000 : 5000
    }
    return 0
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
