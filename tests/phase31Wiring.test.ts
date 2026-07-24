import { describe, it, expect, vi } from 'vitest'
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
import { FlagDiscriminator } from '../src/core/solverPortfolio/flagDiscriminator.js'
import { SubmissionController } from '../src/core/solverPortfolio/submissionController.js'
import { TrajectoryRecorder } from '../src/core/trajectory/trajectoryRecorder.js'
import { ModelProvider } from '../src/core/modelReliability/providers/modelProvider.js'
import { NoEligibleModelError, MissingModelProviderError } from '../src/core/modelReliability/errors.js'
import { z } from 'zod'
import { join } from 'path'
import { rmSync, existsSync } from 'fs'

describe('Phase 3.1 Production Wiring & De-mocking Integration Tests', () => {
  it('1. Main Agent requests pass through ModelInvocationGateway & Provider (no mockSuccess)', async () => {
    const registry = new ModelCapabilityRegistry()
    const healthStore = new ModelHealthStore()
    const circuitBreaker = new ModelCircuitBreaker(healthStore)
    const router = new ModelRouter(registry, healthStore, circuitBreaker)
    const gateway = new StructuredModelGateway(router, healthStore, circuitBreaker)

    const fakeProvider: ModelProvider = {
      id: 'openai',
      async streamAgentTurn() {
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
      async executeStructured() {
        return { rawText: JSON.stringify({ ok: true }) }
      },
    }

    gateway.registerProvider(fakeProvider)

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
    const registry = new ModelCapabilityRegistry()
    const healthStore = new ModelHealthStore()
    const circuitBreaker = new ModelCircuitBreaker(healthStore)
    const router = new ModelRouter(registry, healthStore, circuitBreaker)
    const gateway = new StructuredModelGateway(router, healthStore, circuitBreaker)

    await expect(
      gateway.executeStructured({
        taskId: 'task_2',
        role: 'task_planner',
        preferredModelId: 'gpt-4o',
        systemPrompt: 'System',
        userPrompt: 'User',
        outputSchema: z.object({ ok: z.boolean() }),
      }),
    ).rejects.toThrow(MissingModelProviderError)
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
      tools: [{ name: 'inspect_task_state' }, { name: 'Bash' }],
      identity: {
        taskId: 'task_3',
        modelRole: 'competition_coordinator',
        capabilityProfileId: 'orchestrator',
        isOrchestrator: true,
        isWorkflow: false,
        isOneShot: false,
      },
    })

    expect(orchVisible.map((t) => t.name)).toEqual(['inspect_task_state'])

    const emptyOrchVisible = policy.resolveVisibleTools({
      tools: [{ name: 'Bash' }, { name: 'Read' }],
      identity: {
        taskId: 'task_3',
        modelRole: 'competition_coordinator',
        capabilityProfileId: 'orchestrator',
        isOrchestrator: true,
        isWorkflow: false,
        isOneShot: false,
      },
    })

    expect(emptyOrchVisible).toEqual([]) // Fail-closed, no leak to all tools!
  })

  it('4. TaskStateProjectionBuilder & CompilerValidator strictly validate TaskState', () => {
    const mockState: any = {
      taskId: 'task_4',
      phase: 'exploration',
      updatedAt: 100,
      challenge: { description: 'Find flag' },
      context: { contestScope: { scopeType: 'workspace' } },
      evidence: [{ id: 'ev_1', claim: 'Port 80 open', confidence: 0.9, createdAt: 100 }],
      hypotheses: [{ id: 'hyp_1', statement: 'Web exploit', status: 'testing', priority: 1, confidence: 0.7, updatedAt: 100 }],
      attempts: [{ id: 'att_1', kind: 'tool', targetId: 'Bash', fingerprint: 'fp1', status: 'failed', createdAt: 100 }],
      artifactIds: ['art_1'],
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

    const projInput = TaskStateProjectionBuilder.build({
      state: mockState,
      identity,
      compilerType: 'solver_brief',
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
      observations: [{ summary: 'Real observation', confidence: 0.95 }],
      flagCandidates: [],
    })

    const adapter = new NativeSolverAdapter({
      runMainAgent: mockRunMainAgent,
    })

    const handle = await adapter.start({
      taskId: 'task_5',
      challengeId: 'chal_5',
      artifactIds: [],
      scopeSummary: 'workspace',
      workspaceDir: '/tmp',
      compiledContext: {
        id: 'ctx_1',
        taskId: 'task_5',
        compilerType: 'solver_brief',
        compilerVersion: '3.0.0',
        stateRevision: 1,
        stateSnapshotHash: 'hash1',
        targetModelId: 'gpt-4o',
        targetRole: 'solver_scout',
        objective: 'Find flag',
        scopeSummary: 'workspace',
        confirmedEvidence: [],
        activeHypotheses: [],
        rejectedHypotheses: [],
        failedAttempts: [],
        importantArtifacts: [],
        recommendedActions: [],
        forbiddenRepeats: [],
        allowedToolIds: ['Read'],
        completionContract: [],
        sourceIds: [],
        estimatedTokens: 100,
        createdAt: Date.now(),
      },
    })

    const result = await handle.wait()
    expect(mockRunMainAgent).toHaveBeenCalledTimes(1)
    expect(result.summary).toBe('Real Main Agent Execution')
    expect(result.observations[0].summary).toBe('Real observation')
  })

  it('6. GenericProcessSolverAdapter buffers JSONL & handles cancel signal', async () => {
    const adapter = new GenericProcessSolverAdapter('proc-test', {
      executablePath: 'node',
      args: ['-e', 'process.stdin.on("data", d => { console.log(JSON.stringify({type:"observation",summary:"proc obs",confidence:0.9})); process.exit(0); });'],
    })

    const handle = await adapter.start({
      taskId: 'task_6',
      challengeId: 'chal_6',
      artifactIds: [],
      scopeSummary: 'workspace',
      workspaceDir: process.cwd(),
      compiledContext: {
        id: 'ctx_6',
        taskId: 'task_6',
        compilerType: 'solver_brief',
        compilerVersion: '3.0.0',
        stateRevision: 1,
        stateSnapshotHash: 'hash6',
        targetModelId: 'gpt-4o',
        targetRole: 'solver_scout',
        objective: 'Test proc',
        scopeSummary: 'workspace',
        confirmedEvidence: [],
        activeHypotheses: [],
        rejectedHypotheses: [],
        failedAttempts: [],
        importantArtifacts: [],
        recommendedActions: [],
        forbiddenRepeats: [],
        allowedToolIds: [],
        completionContract: [],
        sourceIds: [],
        estimatedTokens: 50,
        createdAt: Date.now(),
      },
    })

    await handle.sendGuidance({ type: 'hint', text: 'go' })
    const result = await handle.wait()
    expect(result.observations.length).toBeGreaterThan(0)
    expect(result.observations[0].summary).toBe('proc obs')
  })

  it('7. ChallengeSwarm runs initial solvers in parallel and validates candidate before cancel', async () => {
    const bus = new CrossSolverEvidenceBus()
    const swarm = new ChallengeSwarm(bus, {
      maxConcurrentSolvers: 2,
      maxTotalSolvers: 4,
      initialSolverIds: ['s1', 's2'],
      cancelLosersOnValidatedCandidate: true,
    })

    const s1Start = vi.fn().mockResolvedValue({
      runId: 'r1',
      solverId: 's1',
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
      async inspect() { return {} as any },
    })

    const s2Start = vi.fn().mockResolvedValue({
      runId: 'r2',
      solverId: 's2',
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
      async inspect() { return {} as any },
    })

    swarm.registerAdapter({ id: 's1', probe: async () => ({ status: 'ready', capabilities: [] }), start: s1Start })
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
    const bus = new CrossSolverEvidenceBus()

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

    bus.publish({
      id: 'm2',
      taskId: 'task_B',
      sourceSolverRunId: 's2',
      evidenceIds: ['ev_B'],
      observationIds: [],
      artifactIds: [],
      summary: 'Task B evidence',
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
