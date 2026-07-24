import type { ModelHealthRecord } from './modelHealth.js'
import { ModelHealthStore } from './modelHealth.js'

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

  constructor(healthStore: ModelHealthStore, policy: Partial<ModelCircuitBreakerPolicy> = {}) {
    this.healthStore = healthStore
    this.policy = { ...DEFAULT_CIRCUIT_BREAKER_POLICY, ...policy }
  }

  public shouldTripCircuit(rec: ModelHealthRecord): boolean {
    if (rec.status === 'circuit_open') {
      if (rec.circuitOpenedAt && Date.now() - rec.circuitOpenedAt > this.policy.cooldownMs) {
        // Cooldown passed: attempt transition to half_open if no probe in flight
        if (!rec.halfOpenProbeInFlight) {
          this.healthStore.setStatus(rec.modelId, 'half_open', undefined, rec.taskId)
          return false
        }
        // A probe is already in flight, block concurrent requests
        return true
      }
      return true
    }

    if (rec.status === 'half_open') {
      // If probe is currently in flight for half_open, reject additional concurrent requests
      return false
    }

    if (rec.consecutiveSchemaFailures >= this.policy.maxConsecutiveSchemaFailures) {
      this.trip(
        rec,
        `Consecutive schema failures (${rec.consecutiveSchemaFailures}) exceeded threshold`,
      )
      return true
    }
    if (rec.consecutiveToolArgumentFailures >= this.policy.maxConsecutiveToolArgumentFailures) {
      this.trip(
        rec,
        `Consecutive tool argument failures (${rec.consecutiveToolArgumentFailures}) exceeded threshold`,
      )
      return true
    }
    if (rec.timeoutTimestamps.length >= this.policy.maxTimeoutsPerWindow) {
      this.trip(rec, `Timeouts window count (${rec.timeoutTimestamps.length}) exceeded threshold`)
      return true
    }
    if (rec.loopTimestamps.length >= this.policy.maxRepeatedLoops) {
      this.trip(
        rec,
        `Repeated action loops window count (${rec.loopTimestamps.length}) exceeded threshold`,
      )
      return true
    }

    return false
  }

  public trip(rec: ModelHealthRecord, reason: string): void {
    this.healthStore.setStatus(rec.modelId, 'circuit_open', reason, rec.taskId)
  }

  public recordProbeSuccess(modelId: string, taskId?: string): void {
    this.healthStore.recordSuccess(modelId, taskId)
  }

  public reset(modelId: string, taskId?: string): void {
    this.healthStore.recordSuccess(modelId, taskId)
  }
}
