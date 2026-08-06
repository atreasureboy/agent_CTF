export type ModelHealthStatus =
  'healthy' | 'degraded' | 'circuit_open' | 'half_open' | 'quota_limited' | 'unavailable'

export interface ModelHealthRecord {
  modelId: string
  taskId?: string
  status: ModelHealthStatus

  consecutiveSchemaFailures: number
  consecutiveToolArgumentFailures: number
  consecutiveProviderFailures: number

  totalSchemaFailures: number
  totalToolArgumentFailures: number
  totalProviderFailures: number

  timeoutTimestamps: number[]
  loopTimestamps: number[]

  successfulRuns: number
  successCount?: number
  failureCount?: number

  lastSuccessAt?: number
  lastFailureAt?: number

  circuitOpenedAt?: number
  circuitReason?: string

  halfOpenProbeInFlight: boolean
}

export class ModelHealthStore {
  private records = new Map<string, ModelHealthRecord>()
  private readonly maxRecords: number
  private readonly windowMs: number

  constructor(maxRecords = 200, windowMs = 300000) {
    this.maxRecords = maxRecords
    this.windowMs = windowMs
  }

  private key(modelId: string, taskId?: string): string {
    return taskId ? `${modelId}:${taskId}` : modelId
  }

  public getRecord(modelId: string, taskId?: string): ModelHealthRecord {
    const k = this.key(modelId, taskId)
    let record = this.records.get(k)
    if (!record) {
      record = {
        modelId,
        taskId,
        status: 'healthy',
        consecutiveSchemaFailures: 0,
        consecutiveToolArgumentFailures: 0,
        consecutiveProviderFailures: 0,
        totalSchemaFailures: 0,
        totalToolArgumentFailures: 0,
        totalProviderFailures: 0,
        timeoutTimestamps: [],
        loopTimestamps: [],
        successfulRuns: 0,
        halfOpenProbeInFlight: false,
      }
      this.setRecord(k, record)
    }
    this.cleanStaleTimestamps(record)
    return record
  }

  public recordSuccess(modelId: string, taskId?: string): void {
    const rec = this.getRecord(modelId, taskId)
    rec.successfulRuns++
    rec.successCount = rec.successfulRuns
    rec.lastSuccessAt = Date.now()

    // Reset consecutive failures on success
    rec.consecutiveSchemaFailures = 0
    rec.consecutiveToolArgumentFailures = 0
    rec.consecutiveProviderFailures = 0
    rec.halfOpenProbeInFlight = false

    if (rec.status === 'degraded' || rec.status === 'half_open' || rec.status === 'circuit_open') {
      rec.status = 'healthy'
      rec.circuitReason = undefined
    }
  }

  public recordFailure(
    modelId: string,
    type: 'schema' | 'toolArg' | 'timeout' | 'loop' | 'empty' | 'provider' | 'role',
    reason?: string,
    taskId?: string,
  ): void {
    const rec = this.getRecord(modelId, taskId)
    const now = Date.now()
    rec.lastFailureAt = now

    if (type === 'role') {
      // Role policy rejections do NOT penalize model content health
      return
    }

    switch (type) {
      case 'schema':
        rec.consecutiveSchemaFailures++
        rec.totalSchemaFailures++
        break
      case 'toolArg':
        rec.consecutiveToolArgumentFailures++
        rec.totalToolArgumentFailures++
        break
      case 'provider':
      case 'empty':
        rec.consecutiveProviderFailures++
        rec.totalProviderFailures++
        break
      case 'timeout':
        rec.timeoutTimestamps.push(now)
        rec.consecutiveProviderFailures++
        rec.totalProviderFailures++
        break
      case 'loop':
        rec.loopTimestamps.push(now)
        rec.consecutiveToolArgumentFailures++
        rec.totalToolArgumentFailures++
        break
    }

    rec.failureCount =
      (rec.totalSchemaFailures || 0) +
      (rec.totalToolArgumentFailures || 0) +
      (rec.totalProviderFailures || 0)

    if (rec.status === 'healthy') {
      rec.status = 'degraded'
    }
  }

  public setStatus(
    modelId: string,
    status: ModelHealthStatus,
    reason?: string,
    taskId?: string,
  ): void {
    const rec = this.getRecord(modelId, taskId)
    rec.status = status
    if (status === 'circuit_open') {
      rec.circuitOpenedAt = Date.now()
      rec.circuitReason = reason
      rec.halfOpenProbeInFlight = false
    } else if (status === 'half_open') {
      rec.halfOpenProbeInFlight = true
    }
  }

  public tryAcquireHalfOpenProbe(modelId: string, taskId?: string): boolean {
    const rec = this.getRecord(modelId, taskId)
    if (rec.status === 'half_open' && !rec.halfOpenProbeInFlight) {
      rec.halfOpenProbeInFlight = true
      return true
    }
    return false
  }

  private cleanStaleTimestamps(rec: ModelHealthRecord): void {
    const cutoff = Date.now() - this.windowMs
    rec.timeoutTimestamps = rec.timeoutTimestamps.filter((t) => t >= cutoff)
    rec.loopTimestamps = rec.loopTimestamps.filter((t) => t >= cutoff)
  }

  private setRecord(key: string, record: ModelHealthRecord): void {
    if (this.records.size >= this.maxRecords && !this.records.has(key)) {
      const oldestKey = this.records.keys().next().value
      if (oldestKey) this.records.delete(oldestKey)
    }
    this.records.set(key, record)
  }

  public dispose(): void {
    this.records.clear()
  }
}
