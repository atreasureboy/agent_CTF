import type {
  SubmissionRequest,
  SubmissionResponse,
} from '../solverPortfolio/submissionController.js'

export type CtfPlatform = 'ctfd' | 'gzctf'

export interface CtfPlatformConfig {
  baseUrl: string
  apiToken: string
  platform?: CtfPlatform
  challengeId?: string | number
}

/** @deprecated Use CtfPlatformConfig */
export type CTFdConfig = CtfPlatformConfig

export type PlatformVerdict =
  'accepted' | 'incorrect' | 'already_submitted' | 'rate_limited' | 'error'

export interface PlatformSubmissionResult {
  verdict: PlatformVerdict
  message: string
  points?: number
}

export interface RemoteChallenge {
  id: number | string
  title: string
  category: string
  description: string
  points: number
  solved: boolean
  solvedTime: string | null
  tags: string[]
  hints: RemoteHint[]
}

export interface RemoteChallengeDetail extends RemoteChallenge {
  files: RemoteFile[]
  connectionInfo: string | null
}

export interface RemoteFile {
  id: number | string
  name: string
  url: string
}

export interface RemoteHint {
  id: number | string
  content: string
  cost: number
}

export interface GameInfo {
  title: string
  description: string
  start: string
  end: string
  teams: number
}

const DEFAULT_TIMEOUT_MS = 10000
const DEFAULT_MAX_RETRIES = 4
const DEFAULT_BACKOFF_MS = 1000

export class CTFPlatformAdapter {
  private config: CtfPlatformConfig
  private platform: CtfPlatform
  private readonly maxRetries: number
  private readonly baseBackoffMs: number
  private preparedChallengeCache: WeakMap<
    { baseUrl: string; id: number | string },
    RemoteChallengeDetail | null
  >
  private gameCache: Map<string, { game: GameInfo; ts: number }>

  constructor(
    config: CtfPlatformConfig,
    retryOptions: { maxRetries?: number; baseBackoffMs?: number } = {},
  ) {
    this.config = config
    this.platform = config.platform ?? 'ctfd'
    this.maxRetries = retryOptions.maxRetries ?? DEFAULT_MAX_RETRIES
    this.baseBackoffMs = retryOptions.baseBackoffMs ?? DEFAULT_BACKOFF_MS
    this.preparedChallengeCache = new WeakMap()
    this.gameCache = new Map()
  }

  public get platformType(): CtfPlatform {
    return this.platform
  }

  public get baseUrl(): string {
    return this.config.baseUrl.replace(/\/$/, '')
  }

  // ═══════════════════════════════════════════════════════════════
  // Platform detection
  // ═══════════════════════════════════════════════════════════════

  public async detectPlatform(): Promise<CtfPlatform> {
    try {
      const gzRes = await this.fetch(`${this.baseUrl}/api/game`, {
        signal: AbortSignal.timeout(3000),
      })
      if (gzRes.ok) {
        this.platform = 'gzctf'
        return 'gzctf'
      }
    } catch {
      /* not GZCTF */
    }
    try {
      const ctfdRes = await this.fetch(`${this.baseUrl}/api/v1/challenges`, {
        headers: { Authorization: `Bearer ${this.config.apiToken}` },
        signal: AbortSignal.timeout(3000),
      })
      if (ctfdRes.ok) {
        this.platform = 'ctfd'
        return 'ctfd'
      }
    } catch {
      /* not CTFd */
    }
    this.platform = 'ctfd'
    return 'ctfd'
  }

  // ═══════════════════════════════════════════════════════════════
  // Game / competition info
  // ═══════════════════════════════════════════════════════════════

  public async getGameInfo(): Promise<GameInfo | null> {
    const cacheKey = this.baseUrl
    const cached = this.gameCache.get(cacheKey)
    if (cached && Date.now() - cached.ts < 30000) return cached.game

    try {
      const res = await this.authenticatedFetch(
        this.platform === 'gzctf' ? `/api/game` : `/api/v1/competition`,
      )
      if (!res?.ok) return null
      const json = (await res.json()) as Record<string, unknown>

      const game: GameInfo = {
        title: toString(json.title ?? json.name),
        description: toString(json.description),
        start: toString(json.start ?? json.startTime),
        end: toString(json.end ?? json.endTime),
        teams: toNumber(json.teams),
      }
      this.gameCache.set(cacheKey, { game, ts: Date.now() })
      return game
    } catch {
      return null
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Challenge listing
  // ═══════════════════════════════════════════════════════════════

  public async listChallenges(): Promise<RemoteChallenge[]> {
    const res = await this.authenticatedFetch(
      this.platform === 'gzctf' ? `/api/game/challenges` : `/api/v1/challenges`,
    )
    if (!res?.ok) {
      throw new Error(
        `Failed to list challenges: ${res?.status ?? 'network error'} ${res?.statusText ?? ''}`,
      )
    }
    const json = (await res.json()) as Record<string, unknown>
    const raw = (Array.isArray(json) ? json : Array.isArray(json.data) ? json.data : []) as Record<
      string,
      unknown
    >[]

    return raw.map((c) => this.parseRemoteChallenge(c))
  }

  public async getChallengeDetail(id: number | string): Promise<RemoteChallengeDetail | null> {
    const cacheKey = { baseUrl: this.baseUrl, id }
    const cached = this.preparedChallengeCache.get(cacheKey)
    if (cached !== undefined) return cached

    try {
      const res = await this.authenticatedFetch(
        this.platform === 'gzctf' ? `/api/game/challenges/${id}` : `/api/v1/challenges/${id}`,
      )
      if (!res?.ok) return null
      const json = (await res.json()) as Record<string, unknown>
      const data = (json.data as Record<string, unknown>) ?? json
      const detail = this.parseRemoteChallengeDetail(data)
      this.preparedChallengeCache.set(cacheKey, detail)
      return detail
    } catch {
      return null
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Attachment download
  // ═══════════════════════════════════════════════════════════════

  public async downloadAttachment(
    challengeId: number | string,
    fileId: number | string,
  ): Promise<{ name: string; data: Buffer } | null> {
    try {
      const url =
        this.platform === 'gzctf'
          ? `${this.baseUrl}/api/game/challenges/${challengeId}/attachment`
          : `${this.baseUrl}/api/v1/files/${fileId}`
      const res = await this.fetch(url, {
        headers: { Authorization: `Bearer ${this.config.apiToken}` },
        signal: AbortSignal.timeout(30000),
      })
      if (!res?.ok) return null
      const buf = Buffer.from(await res.arrayBuffer())
      const disp = res.headers.get('content-disposition') ?? ''
      const nameMatch = disp.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/)
      const name = (nameMatch ? nameMatch[1]?.replace(/['"]/g, '') : undefined) ?? `file_${fileId}`
      return { name, data: buf }
    } catch {
      return null
    }
  }

  public async downloadAllAttachments(
    challengeId: number | string,
  ): Promise<{ name: string; data: Buffer }[]> {
    const detail = await this.getChallengeDetail(challengeId)
    if (!detail || !detail.files.length) return []
    const downloads: { name: string; data: Buffer }[] = []
    for (const f of detail.files) {
      const dl = await this.downloadAttachment(challengeId, f.id)
      if (dl) downloads.push(dl)
    }
    return downloads
  }

  // ═══════════════════════════════════════════════════════════════
  // Flag submission
  // ═══════════════════════════════════════════════════════════════

  public async submitToCTFd(req: SubmissionRequest): Promise<PlatformSubmissionResult> {
    const challengeId = this.config.challengeId
    if (!challengeId) {
      return {
        verdict: 'error',
        message: 'CTFd Adapter Error: Missing challengeId in configuration.',
      }
    }
    return this.submitFlag(challengeId, req.candidateValue.trim())
  }

  public async submitFlag(
    challengeId: number | string,
    flag: string,
  ): Promise<PlatformSubmissionResult> {
    try {
      if (this.platform === 'gzctf') {
        return this.submitGzctf(challengeId, flag)
      }
      return this.submitCtfd(challengeId, flag)
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'TimeoutError') {
        return { verdict: 'error', message: 'Submission timed out after 10s.' }
      }
      return {
        verdict: 'error',
        message: `Network Error: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }

  private async submitCtfd(
    challengeId: number | string,
    flag: string,
  ): Promise<PlatformSubmissionResult> {
    const url = `${this.baseUrl}/api/v1/challenges/attempt`
    const body = { challenge_id: challengeId, submission: flag }

    const res = await this.fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiToken}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    })

    if (res.status === 429) {
      return { verdict: 'rate_limited', message: 'Rate limited — back off.' }
    }
    if (!res.ok) {
      return { verdict: 'error', message: `HTTP ${res.status}: ${res.statusText}` }
    }

    const json = (await res.json()) as {
      success?: boolean
      data?: { status?: string; message?: string }
    }
    const status = json.data?.status ?? ''
    const message = json.data?.message ?? ''

    if (status === 'correct')
      return { verdict: 'accepted', message: `[CTFd] ${message}`, points: 100 }
    if (status === 'already_solved')
      return { verdict: 'already_submitted', message: `[CTFd] ${message}` }
    if (status === 'incorrect') return { verdict: 'incorrect', message: `[CTFd] ${message}` }
    return { verdict: 'error', message: `[CTFd] ${status}: ${message}` }
  }

  private async submitGzctf(
    challengeId: number | string,
    flag: string,
  ): Promise<PlatformSubmissionResult> {
    const url = `${this.baseUrl}/api/game/challenges/${challengeId}`
    const body = { flag }

    const res = await this.fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiToken}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    })

    if (res.status === 429) {
      return { verdict: 'rate_limited', message: 'Rate limited — back off.' }
    }
    if (res.status === 404) {
      return { verdict: 'error', message: `[GZCTF] Challenge ${challengeId} not found.` }
    }
    if (!res.ok) {
      return { verdict: 'error', message: `HTTP ${res.status}: ${res.statusText}` }
    }

    const json = (await res.json()) as {
      status?: number
      message?: string
      data?: { status?: string; message?: string }
    }
    const status = json.status ?? json.data?.status ?? ''
    const message = json.message ?? json.data?.message ?? ''
    const statusStr = String(status)

    if (statusStr === 'accepted' || statusStr === 'correct' || statusStr === 'success') {
      return { verdict: 'accepted', message: `[GZCTF] ${message}` }
    }
    if (statusStr === 'already_solved' || statusStr === 'duplicate') {
      return { verdict: 'already_submitted', message: `[GZCTF] ${message}` }
    }
    if (statusStr === 'incorrect' || statusStr === 'wrong') {
      return { verdict: 'incorrect', message: `[GZCTF] ${message}` }
    }
    return { verdict: 'error', message: `[GZCTF] ${statusStr}: ${message}` }
  }

  // ═══════════════════════════════════════════════════════════════
  // Retry wrapper
  // ═══════════════════════════════════════════════════════════════

  public async submitWithRetry(req: SubmissionRequest): Promise<PlatformSubmissionResult> {
    let lastResponse: PlatformSubmissionResult | null = null
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      const response = await this.submitToCTFd(req)
      if (response.verdict === 'accepted' || response.verdict === 'already_submitted') {
        return response
      }
      if (response.verdict === 'incorrect') return response
      lastResponse = response
      if (attempt >= this.maxRetries - 1) break
      const delayMs = this.calculateBackoff(attempt, response)
      if (delayMs > 0) await sleep(delayMs)
    }
    return lastResponse ?? { verdict: 'error', message: 'All retry attempts exhausted' }
  }

  private calculateBackoff(attempt: number, response: PlatformSubmissionResult): number {
    if (response.verdict === 'rate_limited') return this.baseBackoffMs * Math.pow(2, attempt)
    if (response.verdict === 'error') return attempt === 0 ? 2000 : 5000
    return 0
  }

  // ═══════════════════════════════════════════════════════════════
  // Response mapping
  // ═══════════════════════════════════════════════════════════════

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
        return { status: 'rejected', accepted: false, message: res.message }
      case 'already_submitted':
        return {
          status: 'accepted',
          accepted: true,
          message: `[Already submitted] ${res.message}`,
          points: res.points ?? 100,
        }
      case 'rate_limited':
        return { status: 'error', accepted: false, message: res.message }
      default:
        return { status: 'error', accepted: false, message: res.message }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Internal helpers
  // ═══════════════════════════════════════════════════════════════

  private async authenticatedFetch(path: string): Promise<Response | null> {
    try {
      return await this.fetch(`${this.baseUrl}${path}`, {
        headers: { Authorization: `Bearer ${this.config.apiToken}` },
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      })
    } catch {
      return null
    }
  }

  private async fetch(url: string, init?: RequestInit): Promise<Response> {
    return fetch(url, init)
  }

  private parseRemoteChallenge(raw: Record<string, unknown>): RemoteChallenge {
    const pickId = (): string | number => {
      const val = raw.id ?? raw.Id ?? raw.challengeId
      if (typeof val === 'string' || typeof val === 'number') return val
      return 0
    }
    const id = pickId()
    return {
      id,
      title: toString(raw.title ?? raw.name ?? raw.Title),
      category: toString(raw.category ?? raw.Category ?? raw.tag) || 'misc',
      description: toString(raw.description ?? raw.content ?? raw.details ?? raw.Description),
      points: toNumber(raw.points ?? raw.score ?? raw.value),
      solved: Boolean(raw.solved ?? raw.solvedByMe ?? raw.isSolved),
      solvedTime: toString(raw.solvedTime ?? raw.solved_time ?? raw.solveTime),
      tags: Array.isArray(raw.tags) ? raw.tags.map(String) : [],
      hints: Array.isArray(raw.hints)
        ? (raw.hints as Record<string, unknown>[]).map((h) => ({
            id: (h.id ?? 0) as string | number,
            content: toString(h.content ?? h.Content),
            cost: toNumber(h.cost ?? h.Cost),
          }))
        : [],
    }
  }

  private parseRemoteChallengeDetail(raw: Record<string, unknown>): RemoteChallengeDetail {
    const base = this.parseRemoteChallenge(raw)
    const fileList = (Array.isArray(raw.files) ? raw.files : []) as Record<string, unknown>[]
    const files: RemoteFile[] = fileList.map((f) => ({
      id:
        typeof f.id === 'string' || typeof f.id === 'number'
          ? f.id
          : typeof f.fileId === 'string' || typeof f.fileId === 'number'
            ? f.fileId
            : 0,
      name: toString(f.name ?? f.fileName ?? f.filename ?? f.Name),
      url: toString(f.url ?? f.Url ?? f.downloadUrl),
    }))
    return {
      ...base,
      files,
      connectionInfo: toString(raw.connectionInfo ?? raw.connection_info ?? raw.conn),
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function toString(val: unknown): string {
  return typeof val === 'string' ? val : ''
}

function toNumber(val: unknown): number {
  return typeof val === 'number' ? val : 0
}
