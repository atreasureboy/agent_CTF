import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ProgressCompiler } from '../src/core/contextCompiler/index.js'
import {
  ModelCircuitBreaker,
  ModelHealthStore,
  ModelRouter,
  StructuredModelGateway,
} from '../src/core/modelReliability/index.js'

import { ModelCapabilityRegistry } from '../src/core/modelReliability/modelRegistry.js'
import {
  CrossSolverEvidenceBus,
  FlagDiscriminator,
  GuidanceCompiler,
  StagnationDetector,
} from '../src/core/solverPortfolio/index.js'
import { ToolVisibilityPolicy } from '../src/core/toolVisibility/index.js'

describe('Phase 3.0 Smoke Tests (Smoke 1 - 6)', () => {
  it('Smoke 1: M3 Reliability (Fake M3 invalid JSON -> Repair fail -> Fallback -> High-tier model succeeds)', async () => {
    const registry = new ModelCapabilityRegistry()
    const healthStore = new ModelHealthStore()
    const circuitBreaker = new ModelCircuitBreaker(healthStore)
    const router = new ModelRouter(registry, healthStore, circuitBreaker)
    const gateway = new StructuredModelGateway(router, healthStore, circuitBreaker)

    const schema = z.object({ result: z.string() })

    const mockLlmExecutor = async (modelId: string) => {
      if (modelId.includes('m3')) {
        return { rawText: '{ invalid_json }' }
      }
      return { rawText: JSON.stringify({ result: 'action_executed' }) }
    }

    const res = await gateway.executeStructured({
      role: 'solver_scout',
      preferredModelId: 'm3-low-cost-tier',
      systemPrompt: 'sys',
      userPrompt: 'user',
      outputSchema: schema,
      taskId: 'smoke_1',
      llmExecutor: mockLlmExecutor,
    })

    expect(res.fallbackUsed).toBe(true)
    expect(res.modelId).toBe('high-tier-model')
    expect(res.value.result).toBe('action_executed')
  })

  it('Smoke 2: Tool Visibility (M3 Scout receives limited tools -> fake call blocked)', () => {
    const policy = new ToolVisibilityPolicy()
    policy.addRule({ toolId: 'admin_exec', visibleTo: ['specialist:admin'] })

    const m3Visible = policy.isToolVisible('admin_exec', { modelId: 'm3-mini', role: 'solver_scout' })
    expect(m3Visible).toBe(false)
  })

  it('Smoke 3: Progress Compiler (Independent compact context brief)', () => {
    const progress = ProgressCompiler.compileProgress(
      {
        taskId: 'smoke_3',
        stateRevision: 2,
        stateSnapshotHash: 'hash',
        objective: 'Objective',
        scopeSummary: '127.0.0.1',
        evidences: [{ id: 'e1', title: 'ev', factSummary: 'fact', confidence: 0.9, confirmed: true }],
        hypotheses: [],
        attempts: [],
        artifacts: [],
        allowedToolIds: ['http'],
      },
      'm3-mini',
    )
    expect(progress.renderedText).toContain('PROGRESS BRIEF')
    expect(progress.sourceIds).toContain('e1')
  })

  it('Smoke 4: Solver Escalation (M3 Scout no evidence -> Stagnation -> Escalates to strong model)', () => {
    const stag = StagnationDetector.evaluate({
      cyclesWithoutNewEvidence: 4,
      millisecondsWithoutNewEvidence: 12000,
      repeatedAttemptFingerprints: 0,
      repeatedActionFamilies: 0,
      consecutiveToolFailures: 0,
      contextCompactions: 0,
      hypothesisProgressDelta: 0,
    })
    expect(stag.action).toBe('switch_model')
    if (stag.action === 'switch_model') {
      expect(stag.targetModelId).toBe('high-tier-model')
    }
  })

  it('Smoke 5: Cross-solver Evidence (Solver A evidence -> Bus -> Solver B guidance with Source ID)', () => {
    const bus = new CrossSolverEvidenceBus()
    bus.publish({
      id: 'm1',
      taskId: 'smoke_5',
      sourceSolverRunId: 'run_A',
      evidenceIds: ['ev_A1'],
      observationIds: [],
      artifactIds: [],
      summary: 'Secret directory /admin_backup found',
      priority: 'high',
      createdAt: Date.now(),
    })

    const unread = bus.getUnreadMessages('run_B', 1)
    const guidance = GuidanceCompiler.compileGuidance(unread, 'm3-mini')
    expect(guidance).toContain('/admin_backup')
    expect(guidance).toContain('ev_A1')
  })

  it('Smoke 6: Candidate (M3 fake candidate -> Discriminator rejects -> Swarm continues)', () => {
    const fakeCand = 'not_a_flag_string'
    const disc = FlagDiscriminator.discriminate({ candidateValue: fakeCand })
    expect(disc.valid).toBe(false)
  })
})
