export type ModelHealthStatus =
  | 'healthy'
  | 'degraded'
  | 'circuit_open'
  | 'quota_limited'
  | 'unavailable'

export interface ModelHealthRecord {
  modelId: string
  taskId?: string
  status: ModelHealthStatus

  schemaFailures: number
  toolArgumentFailures: number
  timeouts: number
  repeatedActionLoops: number
  emptyResponses: number
  providerErrors: number

  successfulRuns: number

  lastFailureAt?: number
  circuitOpenedAt?: number
  circuitReason?: string
}

export class ModelHealthStore {
  private records = new Map<string, ModelHealthRecord>()
  private readonly maxRecords: number

  constructor(maxRecords = 200) {
    this.maxRecords = maxRecords
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
        schemaFailures: 0,
        toolArgumentFailures: 0,
        timeouts: 0,
        repeatedActionLoops: 0,
        emptyResponses: 0,
        providerErrors: 0,
        successfulRuns: 0,
      }
      this.setRecord(k, record)
    }
    return record
  }

  public recordSuccess(modelId: string, taskId?: string): void {
    const rec = this.getRecord(modelId, taskId)
    rec.successfulRuns++
    if (rec.status === 'degraded' && rec.schemaFailures === 0 && rec.toolArgumentFailures === 0) {
      rec.status = 'healthy'
    }
  }

  public recordFailure(
    modelId: string,
    type: 'schema' | 'toolArg' | 'timeout' | 'loop' | 'empty' | 'provider',
    reason?: string,
    taskId?: string,
  ): void {
    const rec = this.getRecord(modelId, taskId)
    rec.lastFailureAt = Date.now()
    switch (type) {
      case 'schema':
        rec.schemaFailures++
        break
      case 'toolArg':
        rec.toolArgumentFailures++
        break
      case 'timeout':
        rec.timeouts++
        break
      case 'loop':
        rec.repeatedActionLoops++
        break
      case 'empty':
        rec.emptyResponses++
        break
      case 'provider':
        rec.providerErrors++
        break
    }
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
    }
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
