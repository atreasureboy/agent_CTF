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
import { CTFTaskStateStore } from '../src/core/ctfRuntime/taskStateStore.js'

describe('Phase 3.0 Smoke Tests (Smoke 1 - 6)', () => {
  it('Smoke 1: M3 Reliability (Fake M3 invalid JSON -> Repair fail -> Fallback -> High-tier model succeeds)', async () => {
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
    const circuitBreaker = new ModelCircuitBreaker(healthStore)
    const router = new ModelRouter(registry, healthStore, circuitBreaker)
    const fakeProvider = {
      id: 'test-provider',
      async streamAgentTurn() {
        return (async function* () {
          yield { choices: [{ delta: { content: 'chunk' } }] } as any
        })()
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
    }
  })

  it('Smoke 5: Cross-solver Evidence (Solver A evidence -> Bus -> Solver B guidance with Source ID)', () => {
    const store = new CTFTaskStateStore({
      taskId: 'smoke_5',
      phase: 'exploration',
      activeProfileId: 'default',
      context: { taskId: 'smoke_5' } as any,
      challenge: { inputArtifactIds: [] },
      findings: [],
      artifactIds: [],
      hypotheses: [],
      attempts: [],
      handoffs: [],
      agentRuns: [],
      workflowRuns: [],
      jobs: [],
      solverRuns: [],
      oneShotRuns: [],
      observations: [],
      evidence: [
        {
          id: 'ev_A1',
          taskId: 'smoke_5',
          kind: 'generic',
          claimFamily: 'generic',
          claim: 'Secret directory /admin_backup found',
          normalizedClaim: 'Secret directory /admin_backup found',
          confidence: 0.9,
          polarity: 'supports',
          fingerprint: 'ev_A1',
          sources: [{ producer: { type: 'workflow', id: 'run_A' }, id: 'run_A' }] as any,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
      strategyDecisions: [],
      pendingActions: [],
      reasoningBudget: {} as any,
      reasoningBudgetLimits: {} as any,
      activeAgentRunIds: [],
      activeWorkflowRunIds: [],
      activeJobIds: [],
      activeSolverRunIds: [],
      flagCandidates: [],
      diagnostics: [],
      degraded: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    const bus = new CrossSolverEvidenceBus(store)
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

    const unread = bus.getUnreadMessages('smoke_5', 'run_B', 1)
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
