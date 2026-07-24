import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import {
  ModelCircuitBreaker,
  ModelHealthStore,
  ModelRolePolicy,
  ModelRouter,
  StructuredModelGateway,
} from '../src/core/modelReliability/index.js'

import { ModelCapabilityRegistry } from '../src/core/modelReliability/modelRegistry.js'

describe('ModelReliability & StructuredGateway', () => {
  it('enforces M3 role permission restrictions strictly', () => {
    const check1 = ModelRolePolicy.validateRolePermission('m3-mini', 'solver_scout', 'expand_scope')
    expect(check1.allowed).toBe(false)
    expect(check1.reason).toContain('prohibited')

    const check2 = ModelRolePolicy.validateRolePermission('high-tier-model', 'competition_coordinator', 'expand_scope')
    expect(check2.allowed).toBe(true)
  })

  it('handles schema failure, repair, fallback, and circuit breaker without collapsing', async () => {
    const registry = new ModelCapabilityRegistry()
    const healthStore = new ModelHealthStore()
    const circuitBreaker = new ModelCircuitBreaker(healthStore, {
      maxConsecutiveSchemaFailures: 2,
    })
    const router = new ModelRouter(registry, healthStore, circuitBreaker)
    const gateway = new StructuredModelGateway(router, healthStore, circuitBreaker)

    const schema = z.object({
      action: z.string(),
      target: z.string(),
    })

    // Mock executor that returns bad JSON for m3-mini, triggering repair & fallback to high-tier-model
    let attempts = 0
    const mockLlmExecutor = async (modelId: string, sys: string, user: string) => {
      attempts++
      if (modelId.includes('m3')) {
        return { rawText: 'invalid json string' }
      }
      return {
        rawText: JSON.stringify({ action: 'inspect', target: 'index.php' }),
        usage: { inputTokens: 50, outputTokens: 20 },
      }
    }

    const res = await gateway.executeStructured({
      role: 'solver_scout',
      preferredModelId: 'm3-low-cost-tier',
      systemPrompt: 'sys',
      userPrompt: 'user',
      outputSchema: schema,
      taskId: 'task-test-1',
      llmExecutor: mockLlmExecutor,
    })

    expect(res.value.action).toBe('inspect')
    expect(res.fallbackUsed).toBe(true)
    expect(res.modelId).toBe('high-tier-model')

    const m3Record = healthStore.getRecord('m3-low-cost-tier', 'task-test-1')
    expect(m3Record.schemaFailures).toBeGreaterThan(0)
  })
})
