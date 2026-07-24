import type { ModelRole } from './modelCapability.js'
import type { ModelCircuitBreaker } from './modelCircuitBreaker.js'
import type { ModelHealthStore } from './modelHealth.js'
import type { ModelCapabilityRegistry } from './modelRegistry.js'
import { NoEligibleModelError } from './errors.js'

export interface ModelRoutingInput {
  role: ModelRole
  challengeCategory?: string
  estimatedDifficulty?: 'easy' | 'medium' | 'hard' | 'unknown'
  requiredCapabilities?: string[]
  budget?: {
    remainingCostUnits: number
  }
  preferredModelId?: string
  taskId?: string
  hasProvider?: (providerId: string) => boolean
}

export interface ModelRoutingDecision {
  selectedModelId: string
  fallbackModelIds: string[]
  reason: string
  rejectedModels: Array<{
    modelId: string
    reason: string
  }>
}

export class ModelRouter {
  private registry: ModelCapabilityRegistry
  private healthStore: ModelHealthStore
  private circuitBreaker: ModelCircuitBreaker

  constructor(
    registry: ModelCapabilityRegistry,
    healthStore: ModelHealthStore,
    circuitBreaker: ModelCircuitBreaker,
  ) {
    this.registry = registry
    this.healthStore = healthStore
    this.circuitBreaker = circuitBreaker
  }

  public route(input: ModelRoutingInput): ModelRoutingDecision {
    const rejectedModels: Array<{ modelId: string; reason: string }> = []
    const profiles = this.registry.listProfiles()

    // 1. Evaluate preferred model if specified
    if (input.preferredModelId) {
      const prefProfile = this.registry.getProfile(input.preferredModelId)
      if (!prefProfile) {
        rejectedModels.push({
          modelId: input.preferredModelId,
          reason: `Preferred model '${input.preferredModelId}' not found in registry`,
        })
      } else {
        const health = this.healthStore.getRecord(input.preferredModelId, input.taskId)
        const isTripped = this.circuitBreaker.shouldTripCircuit(health)

        let rejectReason: string | undefined
        const pId = prefProfile.providerId || prefProfile.provider
        if (isTripped || health.status === 'unavailable') {
          rejectReason = `Circuit open or status=${health.status}`
        } else if (!prefProfile.allowedRoles.includes(input.role)) {
          rejectReason = `Role '${input.role}' not in allowedRoles of preferred model`
        } else if (
          input.hasProvider &&
          !input.hasProvider(pId) &&
          !input.hasProvider(prefProfile.provider)
        ) {
          rejectReason = `Provider '${pId}' not available`
        } else if (input.requiredCapabilities) {
          for (const cap of input.requiredCapabilities) {
            if (!(prefProfile.capabilities as Record<string, boolean>)[cap]) {
              rejectReason = `Missing required capability '${cap}'`
              break
            }
          }
        }

        if (rejectReason) {
          rejectedModels.push({
            modelId: input.preferredModelId,
            reason: rejectReason,
          })
        } else {
          // Re-evaluate fallbacks
          const validFallbacks = this.filterEligibleModels(
            prefProfile.fallbackModelIds,
            input,
            rejectedModels,
          )
          return {
            selectedModelId: input.preferredModelId,
            fallbackModelIds: validFallbacks,
            reason: `Preferred model '${input.preferredModelId}' requested and passed all eligibility checks.`,
            rejectedModels,
          }
        }
      }
    }

    // 2. Evaluate candidate profiles in registry
    const eligible: Array<{ modelId: string; score: number }> = []

    for (const prof of profiles) {
      if (prof.id === input.preferredModelId && rejectedModels.some((r) => r.modelId === prof.id)) {
        continue // Already rejected
      }

      const health = this.healthStore.getRecord(prof.id, input.taskId)
      if (this.circuitBreaker.shouldTripCircuit(health) || health.status === 'unavailable') {
        rejectedModels.push({
          modelId: prof.id,
          reason: `Circuit open or unavailable (status=${health.status})`,
        })
        continue
      }

      if (!prof.allowedRoles.includes(input.role)) {
        rejectedModels.push({
          modelId: prof.id,
          reason: `Role '${input.role}' not in allowedRoles`,
        })
        continue
      }

      const candidatePId = prof.providerId || prof.provider
      if (
        input.hasProvider &&
        !input.hasProvider(candidatePId) &&
        !input.hasProvider(prof.provider)
      ) {
        rejectedModels.push({
          modelId: prof.id,
          reason: `Provider '${candidatePId}' not available`,
        })
        continue
      }

      if (input.requiredCapabilities && input.requiredCapabilities.length > 0) {
        let missingCap = false
        for (const cap of input.requiredCapabilities) {
          if (!(prof.capabilities as Record<string, boolean>)[cap]) {
            missingCap = true
            rejectedModels.push({
              modelId: prof.id,
              reason: `Missing required capability '${cap}'`,
            })
            break
          }
        }
        if (missingCap) continue
      }

      let score = prof.reliability.structuredOutput * 10
      if (input.estimatedDifficulty === 'easy' && prof.economics.inputCostPerMillion) {
        score += 10 / (prof.economics.inputCostPerMillion + 0.1)
      } else if (input.estimatedDifficulty === 'hard') {
        score += prof.reliability.longHorizonPlanning * 20
      }

      eligible.push({ modelId: prof.id, score })
    }

    if (eligible.length === 0) {
      throw new NoEligibleModelError({
        role: input.role,
        requiredCapabilities: input.requiredCapabilities,
        rejectedModels,
      })
    }

    eligible.sort((a, b) => b.score - a.score)
    const selected = eligible[0].modelId
    const fallbacks = eligible.slice(1).map((e) => e.modelId)

    return {
      selectedModelId: selected,
      fallbackModelIds: fallbacks,
      reason: `Routed to '${selected}' based on capability and health scoring (score=${eligible[0].score.toFixed(2)}).`,
      rejectedModels,
    }
  }

  private filterEligibleModels(
    modelIds: string[],
    input: ModelRoutingInput,
    rejectedModels: Array<{ modelId: string; reason: string }>,
  ): string[] {
    const valid: string[] = []
    for (const id of modelIds) {
      const prof = this.registry.getProfile(id)
      if (!prof) continue
      const health = this.healthStore.getRecord(id, input.taskId)
      if (this.circuitBreaker.shouldTripCircuit(health) || health.status === 'unavailable') {
        continue
      }
      if (!prof.allowedRoles.includes(input.role)) continue
      if (input.hasProvider && !input.hasProvider(prof.provider)) continue
      valid.push(id)
    }
    return valid
  }
}
