import { describe, it, expect, vi, afterAll } from 'vitest'
import { ModelCapabilityRegistry } from '../src/core/modelReliability/modelRegistry.js'
import { ModelHealthStore } from '../src/core/modelReliability/modelHealth.js'
import { ModelCircuitBreaker } from '../src/core/modelReliability/modelCircuitBreaker.js'
import { ModelRouter } from '../src/core/modelReliability/modelRouter.js'
import { StructuredModelGateway } from '../src/core/modelReliability/structuredModelGateway.js'
import { ToolVisibilityPolicy } from '../src/core/toolVisibility/toolVisibilityPolicy.js'
import { ContextProjection } from '../src/core/contextCompiler/contextProjection.js'
import { TaskStateProjectionBuilder } from '../src/core/contextCompiler/taskStateProjectionBuilder.js'
import { CompilerValidator } from '../src/core/contextCompiler/compilerValidator.js'
import { NativeSolverAdapter } from '../src/core/solverPortfolio/nativeSolverAdapter.js'
import { GenericProcessSolverAdapter } from '../src/core/solverPortfolio/genericProcessSolverAdapter.js'
import { ChallengeSwarm } from '../src/core/solverPortfolio/challengeSwarm.js'
import { CrossSolverEvidenceBus } from '../src/core/solverPortfolio/crossSolverEvidenceBus.js'
import { SubmissionController } from '../src/core/solverPortfolio/submissionController.js'
import { TrajectoryRecorder } from '../src/core/trajectory/trajectoryRecorder.js'
import type { ModelProvider } from '../src/core/modelReliability/providers/modelProvider.js'
import {NoEligibleModelError} from '../src/core/modelReliability/errors.js'
import { ArtifactStore } from '../src/core/artifacts.js'
import { FindingStore } from '../src/core/findings.js'
import { ToolRegistry } from '../src/core/toolRegistry.js'
import { DefaultToolExposureResolver } from '../src/core/toolVisibility/toolExposureResolver.js'
import { CTFTaskStateStore } from '../src/core/ctfRuntime/taskStateStore.js'
import { z } from 'zod'
import { join } from 'path'
import { rmSync, existsSync } from 'fs'

function createBlankState(taskId: string): any {
  return {
    taskId,
    phase: 'created',
    activeProfileId: 'default',
    context: { taskId } as any,
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
    evidence: [],
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
  }
}

describe('Phase 3.1 Production Wiring & De-mocking Integration Tests', () => {
  it('1. Main Agent requests pass through ModelInvocationGateway & Provider (no mockSuccess)', async () => {
    const registry = new ModelCapabilityRegistry([
      {
        id: 'gpt-4o',
        providerId: 'openai',
        providerModelName: 'gpt-4o',
        provider: 'openai',
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
    ])
    const healthStore = new ModelHealthStore()
    const circuitBreaker = new ModelCircuitBreaker(healthStore)
    const router = new ModelRouter(registry, healthStore, circuitBreaker)

    const fakeProvider: ModelProvider = {
      id: 'openai',
      // eslint-disable-next-line @typescript-eslint/require-await
      async streamAgentTurn() {
        // eslint-disable-next-line @typescript-eslint/require-await
        return (async function* () {
          yield {
            id: 'chunk_1',
            object: 'chat.completion.chunk',
            created: Date.now(),
            model: 'gpt-4o',
            choices: [{ index: 0, delta: { content: 'Test stream response' }, finish_reason: 'stop' }],
          }
        })()
      },
      // eslint-disable-next-line @typescript-eslint/require-await
      async executeStructured() {
        return { rawText: JSON.stringify({ ok: true }) }
      },
    }

    const gateway = new StructuredModelGateway({
      router,
      healthStore,
      circuitBreaker,
      registry,
      providers: [fakeProvider],
    })

    const stream = await gateway.streamAgentTurn({
      taskId: 'task_1',
      role: 'task_planner',
      preferredModelId: 'gpt-4o',
      messages: [{ role: 'user', content: 'Hello' }],
    })

    let text = ''
    for await (const chunk of stream) {
      if (chunk.choices[0]?.delta?.content) {
        text += chunk.choices[0].delta.content
      }
    }

    expect(text).toBe('Test stream response')
    expect(healthStore.getRecord('gpt-4o', 'task_1').status).toBe('healthy')
  })

  it('2. Throws MissingModelProviderError when no provider is registered instead of mockSuccess', async () => {
    const registry = new ModelCapabilityRegistry([
      {
        id: 'gpt-4o',
        providerId: 'openai',
        providerModelName: 'gpt-4o',
        provider: 'openai',
        model: 'gpt-4o',
        trustLevel: 'privileged',
        reliabilityClass: 'privileged',
        contextWindow: 128000,
        capabilities: { toolCalling: true, structuredOutput: true, vision: true, longContext: true, codeExecutionPlanning: true },
        reliability: { structuredOutput: 0.98, toolArguments: 0.95, longHorizonPlanning: 0.92, summarization: 0.95, instructionFollowing: 0.96 },
        economics: {},
        allowedRoles: ['task_planner'],
        limits: { maxVisibleTools: 50, maxIterations: 30, maxRepairAttempts: 2, maxConsecutiveFailures: 3 },
        fallbackModelIds: [],
      },
    ])
    const healthStore = new ModelHealthStore()
    const circuitBreaker = new ModelCircuitBreaker(healthStore)
    const router = new ModelRouter(registry, healthStore, circuitBreaker)
    const gateway = new StructuredModelGateway({ router, healthStore, circuitBreaker, registry })

    await expect(
      gateway.executeStructured({
        taskId: 'task_2',
        role: 'task_planner',
        preferredModelId: 'gpt-4o',
        systemPrompt: 'System',
        userPrompt: 'User',
        outputSchema: z.object({ ok: z.boolean() }),
      }),
    ).rejects.toThrow(NoEligibleModelError)
  })

  it('3. ToolVisibilityPolicy is Fail-Closed and restricts Orchestrator to high-level tools', () => {
    const policy = new ToolVisibilityPolicy([], 'deny')

    expect(
      policy.isToolVisible('Bash', {
        role: 'task_planner',
        isOrchestrator: false,
      }),
    ).toBe(false)

    const orchVisible = policy.resolveVisibleTools({
      tools: [
        { name: 'inspect_task_state', metadata: { visibilityClass: 'orchestrator' } },
        { name: 'Bash' },
      ],
      identity: {
        taskId: 'task_3',
        modelRole: 'competition_coordinator',
        modelProfileId: 'orchestrator',
        providerId: 'openai-compatible',
        capabilityProfileId: 'orchestrator',
        isOrchestrator: true,
        isWorkflow: false,
        isOneShot: false,
      },
    })

    expect(orchVisible.map((t) => t.name)).toEqual(['inspect_task_state'])

    const emptyOrchVisible = policy.resolveVisibleTools({
      tools: [
        { name: 'Bash' },
        { name: 'Read' },
      ],
      identity: {
        taskId: 'task_3',
        modelRole: 'competition_coordinator',
        modelProfileId: 'orchestrator',
        providerId: 'openai-compatible',
        capabilityProfileId: 'orchestrator',
        isOrchestrator: true,
        isWorkflow: false,
        isOneShot: false,
      },
    })

    expect(emptyOrchVisible).toEqual([]) // Fail-closed, no leak to all tools!
  })

  // §H7 fix — Track every `scratch/test_proj_*` directory this suite creates
  // and clean them up after the suite finishes. The previous implementation
  // leaked ~80 such directories on disk, accumulating 1.5 MB of test
  // fixtures with no `afterEach` / `afterAll` hook.
  const scratchDirs: string[] = []
  afterAll(() => {
    for (const d of scratchDirs) {
      try {
        rmSync(d, { recursive: true, force: true })
      } catch {
        /* best-effort */
      }
    }
  })

  it('4. TaskStateProjectionBuilder & CompilerValidator strictly validate TaskState', () => {
    const tmpDir = join(process.cwd(), 'scratch', `test_proj_${Date.now()}`)
    scratchDirs.push(tmpDir)
    const artifactStore = new ArtifactStore(tmpDir)
    const findingStore = new FindingStore(tmpDir)
    const toolRegistry = new ToolRegistry()
    const toolExposureResolver = new DefaultToolExposureResolver()

    const artMeta = artifactStore.writeSync({ taskId: 'task_4', producerAgentId: 'scout', type: 'text' }, 'test content')

    const mockState: any = {
      taskId: 'task_4',
      phase: 'exploration',
      updatedAt: 100,
      stateRevision: 1,
      challenge: { description: 'Find flag' },
      context: { contestScope: { scopeType: 'workspace' } },
      evidence: [{ id: 'ev_1', claim: 'Port 80 open', claimFamily: 'generic', confidence: 0.9, polarity: 'supports', sources: [{ producer: { type: 'workflow', id: 's1' }, observationIds: [], artifactIds: [], attemptIds: [], confidence: 0.9, createdAt: 100 }], createdAt: 100 }],
      hypotheses: [{ id: 'hyp_1', statement: 'Web exploit', status: 'testing', priority: 1, confidence: 0.7, updatedAt: 100 }],
      attempts: [{ id: 'att_1', kind: 'tool', targetId: 'Bash', fingerprint: 'fp1', status: 'failed', createdAt: 100 }],
      artifactIds: [artMeta.id],
      pendingActions: [],
      solverRuns: [],
    }

    const identity: any = {
      taskId: 'task_4',
      modelRole: 'solver_scout',
      capabilityProfileId: 'scout',
      isOrchestrator: false,
      isWorkflow: false,
      isOneShot: false,
    }

    const targetModel: any = { id: 'm1', limits: { maxVisibleTools: 20 } }

    const projInput = TaskStateProjectionBuilder.build({
      state: mockState,
      identity,
      targetModel,
      compilerType: 'solver_brief',
      toolRegistry,
      artifactStore,
      findingStore,
      toolExposureResolver,
    })

    const compiled = ContextProjection.project(projInput, 'solver_brief', 'gpt-4o', 'solver_scout')
    const validation = CompilerValidator.validate(compiled, {
      state: mockState,
      expectedIdentity: identity,
      expectedSnapshotHash: projInput.stateSnapshotHash,
    })

    expect(validation.valid).toBe(true)
    expect(compiled.confirmedEvidence.length).toBe(1)
    expect(compiled.activeHypotheses[0].status).toBe('testing')
  })

  it('5. NativeSolverAdapter delegates to real delegate without hardcoded mock simulation', async () => {
    const mockRunMainAgent = vi.fn().mockResolvedValue({
      summary: 'Real Main Agent Execution',
      observations: [{ summary: 'found path', confidence: 0.9 }],
      artifacts: [{ path: '/tmp/art.txt', description: 'artifact' }],
      flagCandidates: [],
    })
    const adapter = new NativeSolverAdapter({ runMainAgent: mockRunMainAgent })
    const probe = await adapter.probe()
    expect(probe.status).toBe('ready')

    const handle = await adapter.start({
      taskId: 'task_5',
      challengeId: 'chal_5',
      artifactIds: [],
      scopeSummary: 'scope',
      workspaceDir: '/tmp',
      compiledContext: {} as any,
    })

    const result = await handle.wait()
    expect(mockRunMainAgent).toHaveBeenCalledTimes(1)
    expect(result.status).toBe('completed')
    expect(result.observations[0].summary).toBe('found path')
  })

  it('6. GenericProcessSolverAdapter executes process and normalizes result', async () => {
    const adapter = new GenericProcessSolverAdapter('proc-test', {
      executablePath: 'node',
      args: ['-e', 'console.log(JSON.stringify({ type: "observation", summary: "proc obs", confidence: 0.8 }))'],
    })
    const probe = await adapter.probe()
    expect(probe.status).toBe('ready')

    const handle = await adapter.start({
      taskId: 'task_6',
      challengeId: 'chal_6',
      artifactIds: [],
      scopeSummary: 'scope',
      workspaceDir: process.cwd(),
      compiledContext: {} as any,
    })

    await handle.sendGuidance({ type: 'hint', text: 'go' })
    const result = await handle.wait()
    expect(result.observations.length).toBeGreaterThan(0)
    expect(result.observations[0].summary).toBe('proc obs')
  })

  it('7. ChallengeSwarm runs initial solvers in parallel and validates candidate before cancel', async () => {
    const store = new CTFTaskStateStore(createBlankState('task_7'))
    const bus = new CrossSolverEvidenceBus(store)
    const swarm = new ChallengeSwarm(bus, store, {
      maxConcurrentSolvers: 2,
      maxTotalSolvers: 4,
      initialSolverIds: ['s1', 's2'],
      cancelLosersOnValidatedCandidate: true,
    })

    const s1Start = vi.fn().mockResolvedValue({
      runId: 'r1',
      solverId: 's1',
      // eslint-disable-next-line @typescript-eslint/require-await
      async wait() {
        return {
          runId: 'r1',
          solverId: 's1',
          status: 'completed',
          observations: [],
          artifacts: [],
          flagCandidates: [{ value: 'flag{syntax_only}' }],
          metrics: { durationMs: 10 },
        }
      },
      async cancel() {},
      // eslint-disable-next-line @typescript-eslint/require-await
      async inspect() { return {} as any },
    })

    const s2Start = vi.fn().mockResolvedValue({
      runId: 'r2',
      solverId: 's2',
      // eslint-disable-next-line @typescript-eslint/require-await
      async wait() {
        return {
          runId: 'r2',
          solverId: 's2',
          status: 'completed',
          observations: [],
          artifacts: [],
          flagCandidates: [],
          metrics: { durationMs: 10 },
        }
      },
      async cancel() {},
      // eslint-disable-next-line @typescript-eslint/require-await
      async inspect() { return {} as any },
    })

    // eslint-disable-next-line @typescript-eslint/require-await
    swarm.registerAdapter({ id: 's1', probe: async () => ({ status: 'ready', capabilities: [] }), start: s1Start })
    // eslint-disable-next-line @typescript-eslint/require-await
    swarm.registerAdapter({ id: 's2', probe: async () => ({ status: 'ready', capabilities: [] }), start: s2Start })

    const outcome = await swarm.runSwarm({
      taskId: 'task_7',
      challengeId: 'chal_7',
      artifactIds: [],
      scopeSummary: 'workspace',
      workspaceDir: process.cwd(),
      compiledContext: {} as any,
    })

    expect(s1Start).toHaveBeenCalled()
    expect(s2Start).toHaveBeenCalled()
    // flag{syntax_only} is syntax_match, NOT locally_validated/platform_accepted, so swarm completed all solvers
    expect(outcome.allResults.length).toBe(2)
  })

  it('8. CrossSolverEvidenceBus isolates messages by taskId and tracks revision cursors', () => {
    const storeA = new CTFTaskStateStore(createBlankState('task_A'))
    const bus = new CrossSolverEvidenceBus(storeA)

    storeA.apply({
      type: 'EVIDENCE_ADDED',
      evidence: {
        id: 'ev_A',
        taskId: 'task_A',
        kind: 'generic',
        claimFamily: 'generic',
        claim: 'Task A evidence',
        normalizedClaim: 'Task A evidence',
        confidence: 0.9,
        polarity: 'supports',
        fingerprint: 'ev_A',
        sources: [{ producer: { type: 'workflow', id: 's1' }, observationIds: [], artifactIds: [], attemptIds: [], confidence: 0.9, createdAt: Date.now() }],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    })

    bus.publish({
      id: 'm1',
      taskId: 'task_A',
      sourceSolverRunId: 's1',
      evidenceIds: ['ev_A'],
      observationIds: [],
      artifactIds: [],
      summary: 'Task A evidence',
      priority: 'high',
      createdAt: Date.now(),
    })

    const taskAMessages = bus.getUnreadMessages('task_A', 's3', 10)
    expect(taskAMessages.length).toBe(1)
    expect(taskAMessages[0].taskId).toBe('task_A')

    // Second read with same cursor returns no duplicates
    const taskAMessages2 = bus.getUnreadMessages('task_A', 's3', 11)
    expect(taskAMessages2.length).toBe(0)
  })

  it('9. SubmissionController returns simulated_accepted in fake mode and does not falsely accept', async () => {
    const controller = new SubmissionController(true)
    const response = await controller.submitFlag({
      taskId: 'task_9',
      solverId: 's1',
      candidateValue: 'flag{valid_format}',
      modelId: 'gpt-4o',
    })

    expect(response.status).toBe('simulated_accepted')
    expect(response.accepted).toBe(false)
  })

  it('10. TrajectoryRecorder handles async queued writing, redaction, and clean dispose flush', async () => {
    const logPath = join(process.cwd(), 'scratch', 'test_trajectory.jsonl')
    if (existsSync(logPath)) rmSync(logPath)
    scratchDirs.push(join(process.cwd(), 'scratch'))

    const recorder = new TrajectoryRecorder(logPath, () => 5)
    recorder.record('task_10', 'model_routing_decision', {
      apiKey: 'sk-secret123',
      nested: { password: 'my-pass' },
      info: 'normal',
    })

    await recorder.dispose()

    expect(existsSync(logPath)).toBe(true)
    const content = (await import('fs')).readFileSync(logPath, 'utf-8')
    expect(content).toContain('[REDACTED_SECRET]')
    expect(content).not.toContain('sk-secret123')
    expect(content).not.toContain('my-pass')

    if (existsSync(logPath)) rmSync(logPath)
  })
})
