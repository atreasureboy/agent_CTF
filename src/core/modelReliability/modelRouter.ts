import { ModelRole } from './modelCapability.js'

import { ModelCircuitBreaker } from './modelCircuitBreaker.js'
import { ModelHealthStore } from './modelHealth.js'
import { ModelCapabilityRegistry } from './modelRegistry.js'

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

    // Filter by preferred if specified and healthy
    if (input.preferredModelId) {
      const prefProfile = this.registry.getProfile(input.preferredModelId)
      const health = this.healthStore.getRecord(input.preferredModelId, input.taskId)
      const isTripped = this.circuitBreaker.shouldTripCircuit(health)

      if (!isTripped && health.status !== 'unavailable') {
        const fallbacks = prefProfile.fallbackModelIds.filter((id) => id !== input.preferredModelId)
        return {
          selectedModelId: input.preferredModelId,
          fallbackModelIds: fallbacks,
          reason: `Preferred model '${input.preferredModelId}' requested and healthy.`,
          rejectedModels,
        }
      } else {
        rejectedModels.push({
          modelId: input.preferredModelId,
          reason: `Preferred model circuit open or status=${health.status}`,
        })
      }
    }

    // Evaluate candidates
    const eligible: Array<{ modelId: string; score: number }> = []

    for (const prof of profiles) {
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

      // Check required capabilities
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

      // Calculate candidate score
      let score = prof.reliability.structuredOutput * 10
      if (input.estimatedDifficulty === 'easy' && prof.economics.inputCostPerMillion) {
        // Prefer cheaper models for easy tasks
        score += 10 / (prof.economics.inputCostPerMillion + 0.1)
      } else if (input.estimatedDifficulty === 'hard') {
        score += prof.reliability.longHorizonPlanning * 20
      }

      eligible.push({ modelId: prof.id, score })
    }

    if (eligible.length === 0) {
      // Emergency fallback to default conservative profile ID
      const fallbackId = 'high-tier-model'
      return {
        selectedModelId: fallbackId,
        fallbackModelIds: [],
        reason: 'All candidate models rejected or un-routable. Falling back to default high tier.',
        rejectedModels,
      }
    }

    // Sort by score descending
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
}
