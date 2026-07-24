import { ModelHealthRecord, ModelHealthStore } from './modelHealth.js'

export interface ModelCircuitBreakerPolicy {
  maxConsecutiveSchemaFailures: number
  maxConsecutiveToolArgumentFailures: number
  maxTimeoutsPerWindow: number
  maxRepeatedLoops: number
  cooldownMs: number
}

export const DEFAULT_CIRCUIT_BREAKER_POLICY: ModelCircuitBreakerPolicy = {
  maxConsecutiveSchemaFailures: 2,
  maxConsecutiveToolArgumentFailures: 2,
  maxTimeoutsPerWindow: 3,
  maxRepeatedLoops: 5,
  cooldownMs: 60000,
}

export class ModelCircuitBreaker {
  private policy: ModelCircuitBreakerPolicy
  private healthStore: ModelHealthStore

  constructor(
    healthStore: ModelHealthStore,
    policy: Partial<ModelCircuitBreakerPolicy> = {},
  ) {
    this.healthStore = healthStore
    this.policy = { ...DEFAULT_CIRCUIT_BREAKER_POLICY, ...policy }
  }

  public shouldTripCircuit(rec: ModelHealthRecord): boolean {
    if (rec.status === 'circuit_open') {
      if (
        rec.circuitOpenedAt &&
        Date.now() - rec.circuitOpenedAt > this.policy.cooldownMs
      ) {
        // Cooldown passed, allow probe (half-open)
        rec.status = 'degraded'
        return false
      }
      return true
    }

    if (rec.schemaFailures >= this.policy.maxConsecutiveSchemaFailures) {
      this.trip(rec, `Consecutive schema failures (${rec.schemaFailures}) exceeded threshold`)
      return true
    }
    if (rec.toolArgumentFailures >= this.policy.maxConsecutiveToolArgumentFailures) {
      this.trip(rec, `Consecutive tool argument failures (${rec.toolArgumentFailures}) exceeded threshold`)
      return true
    }
    if (rec.timeouts >= this.policy.maxTimeoutsPerWindow) {
      this.trip(rec, `Timeouts count (${rec.timeouts}) exceeded threshold`)
      return true
    }
    if (rec.repeatedActionLoops >= this.policy.maxRepeatedLoops) {
      this.trip(rec, `Repeated action loops (${rec.repeatedActionLoops}) exceeded threshold`)
      return true
    }

    return false
  }

  public trip(rec: ModelHealthRecord, reason: string): void {
    this.healthStore.setStatus(rec.modelId, 'circuit_open', reason, rec.taskId)
  }

  public reset(modelId: string, taskId?: string): void {
    const rec = this.healthStore.getRecord(modelId, taskId)
    rec.status = 'healthy'
    rec.schemaFailures = 0
    rec.toolArgumentFailures = 0
    rec.timeouts = 0
    rec.repeatedActionLoops = 0
    rec.emptyResponses = 0
    rec.providerErrors = 0
  }
}
