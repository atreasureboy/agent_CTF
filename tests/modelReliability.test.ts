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
    const registry = new ModelCapabilityRegistry([
      {
        id: 'high-tier-model',
        providerId: 'test-provider',
        providerModelName: 'gpt-4o',
        provider: 'test-provider',
        model: 'gpt-4o',
        trustLevel: 'privileged',
        reliabilityClass: 'privileged',
        contextWindow: 128000,
        capabilities: { toolCalling: true, structuredOutput: true, vision: true, longContext: true, codeExecutionPlanning: true },
        reliability: { structuredOutput: 0.98, toolArguments: 0.95, longHorizonPlanning: 0.92, summarization: 0.95, instructionFollowing: 0.96 },
        economics: {},
        allowedRoles: ['competition_coordinator', 'task_planner', 'solver_scout', 'deep_solver', 'context_compiler', 'progress_summarizer', 'specialist', 'flag_discriminator', 'reporter'],
        limits: { maxVisibleTools: 50, maxIterations: 30, maxRepairAttempts: 2, maxConsecutiveFailures: 3 },
        fallbackModelIds: [],
      },
      {
        id: 'm3-low-cost-tier',
        providerId: 'test-provider',
        providerModelName: 'm3-mini',
        provider: 'test-provider',
        model: 'm3-mini',
        trustLevel: 'auxiliary',
        reliabilityClass: 'auxiliary',
        contextWindow: 32768,
        capabilities: { toolCalling: true, structuredOutput: true, vision: false, longContext: false, codeExecutionPlanning: false },
        reliability: { structuredOutput: 0.8, toolArguments: 0.75, longHorizonPlanning: 0.6, summarization: 0.85, instructionFollowing: 0.8 },
        economics: {},
        allowedRoles: ['solver_scout', 'progress_summarizer', 'context_compiler', 'specialist'],
        limits: { maxVisibleTools: 12, maxIterations: 10, maxRepairAttempts: 1, maxConsecutiveFailures: 2 },
        fallbackModelIds: ['high-tier-model'],
      },
    ])
    const healthStore = new ModelHealthStore()
    const circuitBreaker = new ModelCircuitBreaker(healthStore, {
      maxConsecutiveSchemaFailures: 2,
    })
    const router = new ModelRouter(registry, healthStore, circuitBreaker)
    const fakeProvider = {
      id: 'test-provider',
      async streamAgentTurn() {
        async function* gen() { yield { choices: [{ delta: { content: 'chunk' } }] } as any }
        return gen()
      },
      async executeStructured() { return { rawText: 'ok' } },
    }
    const gateway = new StructuredModelGateway({
      router,
      healthStore,
      circuitBreaker,
      registry,
      providers: [fakeProvider],
    })

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
    expect(m3Record.consecutiveSchemaFailures).toBeGreaterThan(0)
  })
})
