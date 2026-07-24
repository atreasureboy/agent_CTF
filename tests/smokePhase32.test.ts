import { describe, expect, it } from 'vitest'
import {
  StructuredModelGateway,
  ModelRouter,
  ModelHealthStore,
  ModelCircuitBreaker,
  ModelCapabilityRegistry,
  MissingModelProviderError,
  ModelCapabilityProfile,
} from '../src/core/modelReliability/index.js'
import type {
  ModelProvider,
  ProviderAgentTurnInput,
  ProviderStructuredInput,
  ProviderStructuredResult,
} from '../src/core/modelReliability/providers/modelProvider.js'
import {
  DefaultToolExposureResolver,
  ToolVisibilityPolicy,
} from '../src/core/toolVisibility/index.js'
import {
  FlagDiscriminator,
  ChallengeSwarm,
  NativeSolverAdapter,
} from '../src/core/solverPortfolio/index.js'
import {
  TrajectoryRecorder,
  TrajectoryReplay,
} from '../src/core/trajectory/index.js'
import { computeCanonicalSnapshotHash } from '../src/core/contextCompiler/canonicalSnapshot.js'
import type OpenAI from 'openai'
import * as fs from 'node:fs'
import * as path from 'node:path'

class FakeTestProvider implements ModelProvider {
  public id: string
  public streamCalls: string[] = []

  constructor(id: string) {
    this.id = id
  }

  public async streamAgentTurn(
    model: ModelCapabilityProfile,
    input: ProviderAgentTurnInput,
  ): Promise<AsyncIterable<OpenAI.Chat.ChatCompletionChunk>> {
    this.streamCalls.push(model.id)
    async function* gen() {
      yield { choices: [{ delta: { content: 'chunk1' } }] } as any
      yield { choices: [{ delta: { content: 'chunk2' } }] } as any
    }
    return gen()
  }

  public async executeStructured(
    model: ModelCapabilityProfile,
    input: ProviderStructuredInput,
  ): Promise<ProviderStructuredResult> {
    return {
      rawText: JSON.stringify({ result: 'ok' }),
    }
  }
}

class FailingMidStreamProvider implements ModelProvider {
  public id = 'failing-provider'

  public async streamAgentTurn(
    model: ModelCapabilityProfile,
    input: ProviderAgentTurnInput,
  ): Promise<AsyncIterable<OpenAI.Chat.ChatCompletionChunk>> {
    async function* gen() {
      yield { choices: [{ delta: { content: 'chunk1' } }] } as any
      throw new Error('Mid-stream network drop')
    }
    return gen()
  }

  public async executeStructured(): Promise<ProviderStructuredResult> {
    throw new Error('Not implemented')
  }
}

describe('Phase 3.2 Smoke Tests', () => {
  it('Smoke 1: Provider routing based on ModelProfile.providerId', async () => {
    const registry = new ModelCapabilityRegistry()
    registry.registerProfile({
      id: 'model-a',
      providerId: 'provider-a',
      providerModelName: 'model-a-remote',
      provider: 'provider-a',
      model: 'model-a',
      trustLevel: 'standard',
      reliabilityClass: 'standard',
      contextWindow: 32000,
      capabilities: { toolCalling: true, structuredOutput: true, vision: false, longContext: false, codeExecutionPlanning: false },
      reliability: { structuredOutput: 0.9, toolArguments: 0.9, longHorizonPlanning: 0.8, summarization: 0.9, instructionFollowing: 0.9 },
      economics: {},
      allowedRoles: ['deep_solver'],
      limits: { maxVisibleTools: 10, maxIterations: 10, maxRepairAttempts: 1, maxConsecutiveFailures: 2 },
      fallbackModelIds: [],
    })

    const pA = new FakeTestProvider('provider-a')
    const pB = new FakeTestProvider('provider-b')

    const healthStore = new ModelHealthStore()
    const breaker = new ModelCircuitBreaker(healthStore)
    const router = new ModelRouter(registry, healthStore, breaker)
    const gateway = new StructuredModelGateway(router, healthStore, breaker, registry)

    gateway.registerProvider(pA)
    gateway.registerProvider(pB)

    const stream = await gateway.streamAgentTurn({
      taskId: 'smoke_1',
      role: 'deep_solver',
      preferredModelId: 'model-a',
      messages: [{ role: 'user', content: 'hello' }],
    })

    const chunks = []
    for await (const chunk of stream) {
      chunks.push(chunk)
    }

    expect(pA.streamCalls).toContain('model-a')
    expect(pB.streamCalls).toHaveLength(0)
    expect(chunks).toHaveLength(2)
  })

  it('Smoke 2: Mid-stream failure handling in MonitoredAgentTurnStream', async () => {
    const registry = new ModelCapabilityRegistry()
    registry.registerProfile({
      id: 'fail-model',
      providerId: 'failing-provider',
      providerModelName: 'fail-model',
      provider: 'failing-provider',
      model: 'fail-model',
      trustLevel: 'standard',
      reliabilityClass: 'standard',
      contextWindow: 32000,
      capabilities: { toolCalling: true, structuredOutput: true, vision: false, longContext: false, codeExecutionPlanning: false },
      reliability: { structuredOutput: 0.9, toolArguments: 0.9, longHorizonPlanning: 0.8, summarization: 0.9, instructionFollowing: 0.9 },
      economics: {},
      allowedRoles: ['deep_solver'],
      limits: { maxVisibleTools: 10, maxIterations: 10, maxRepairAttempts: 1, maxConsecutiveFailures: 2 },
      fallbackModelIds: [],
    })

    const failingP = new FailingMidStreamProvider()
    const healthStore = new ModelHealthStore()
    const breaker = new ModelCircuitBreaker(healthStore)
    const router = new ModelRouter(registry, healthStore, breaker)
    const gateway = new StructuredModelGateway(router, healthStore, breaker, registry)

    gateway.registerProvider(failingP)

    const stream = await gateway.streamAgentTurn({
      taskId: 'smoke_2',
      role: 'deep_solver',
      preferredModelId: 'fail-model',
      messages: [{ role: 'user', content: 'test' }],
    })

    await expect(async () => {
      for await (const _chunk of stream) {
        /* consume */
      }
    }).rejects.toThrow('Mid-stream network drop')

    const record = healthStore.getRecord('fail-model', 'smoke_2')
    expect(record.totalProviderFailures).toBeGreaterThan(0)
    expect(record.successfulRuns).toBe(0)
  })

  it('Smoke 3: Tool Exposure Assertion fail-closed on hidden tool', () => {
    const policy = new ToolVisibilityPolicy([], 'deny')
    policy.addRule({ toolId: 'allowed_scout_tool', visibleTo: ['solver'] })

    const resolver = new DefaultToolExposureResolver(policy)

    const identity = {
      taskId: 'smoke_3',
      modelRole: 'solver_scout' as const,
      capabilityProfileId: 'auxiliary',
      modelId: 'm3-scout',
      solverId: 'scout-1',
      isOrchestrator: false,
      isWorkflow: false,
      isOneShot: false,
    }

    expect(() => {
      resolver.assertExecutable({
        identity,
        tool: { name: 'hidden_mcp_tool' },
      })
    }).toThrow('ToolExecutionDenied')

    expect(() => {
      resolver.assertExecutable({
        identity,
        tool: { name: 'allowed_scout_tool' },
      })
    }).not.toThrow()
  })

  it('Smoke 4: Canonical Context Snapshot Hash changes with state content', () => {
    const hash1 = computeCanonicalSnapshotHash({
      taskId: 'smoke_4',
      stateRevision: 1,
      evidence: [{ id: 'ev1', confidence: 0.9 }],
      hypotheses: [{ id: 'h1', status: 'testing' }],
      attempts: [],
      artifacts: [],
      pendingActions: [],
      toolExposureHash: 'toolA,toolB',
      compilerVersion: '3.2.0',
    })

    const hash2 = computeCanonicalSnapshotHash({
      taskId: 'smoke_4',
      stateRevision: 1,
      evidence: [{ id: 'ev1', confidence: 0.9 }, { id: 'ev2', confidence: 0.95 }],
      hypotheses: [{ id: 'h1', status: 'testing' }],
      attempts: [],
      artifacts: [],
      pendingActions: [],
      toolExposureHash: 'toolA,toolB',
      compilerVersion: '3.2.0',
    })

    expect(hash1).not.toBe(hash2)
    expect(hash1).toHaveLength(64)
  })

  it('Smoke 5: Swarm live event consumption', async () => {
    const swarm = new ChallengeSwarm()
    const nativeAdapter = new NativeSolverAdapter({
      async runMainAgent() {
        return { summary: 'Native solver done', observations: [{ summary: 'Obs 1', confidence: 0.9 }] }
      },
    })
    swarm.registerAdapter(nativeAdapter)

    const result = await swarm.runSwarm({
      taskId: 'smoke_5',
      challengeId: 'c5',
      compiledContext: {
        id: 'ctx1',
        taskId: 'smoke_5',
        compilerType: 'challenge_prompt',
        compilerVersion: '3.2.0',
        stateRevision: 1,
        stateSnapshotHash: 'hash',
        targetModelId: 'm1',
        targetRole: 'deep_solver',
        objective: 'test',
        scopeSummary: 'scope',
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
        estimatedTokens: 100,
        createdAt: Date.now(),
      },
      workspaceDir: '/tmp',
      artifactIds: [],
      scopeSummary: 'scope',
    })

    expect(result.allResults).toHaveLength(1)
    expect(result.allResults[0].status).toBe('completed')
  })

  it('Smoke 6: Candidate validation distinguishes syntax_match vs locally_validated', () => {
    const syntaxMatch = FlagDiscriminator.discriminate({
      candidateValue: 'flag{syntax_only}',
    })
    expect(syntaxMatch.status).toBe('syntax_match')
    expect(syntaxMatch.canCancelOtherSolvers).toBe(false)

    const locallyValidated = FlagDiscriminator.discriminate({
      candidateValue: 'flag{local_val}',
      locallyVerified: true,
    })
    expect(locallyValidated.status).toBe('locally_validated')
    expect(locallyValidated.canCancelOtherSolvers).toBe(true)
  })

  it('Smoke 7: Trajectory recording and replay', async () => {
    const tmpFile = path.join('/tmp', `traj_smoke_${Date.now()}.jsonl`)
    const recorder = new TrajectoryRecorder(tmpFile)

    recorder.record('smoke_7', 'tool_call', { toolId: 'test_tool', attemptFingerprint: 'fp1' }, 1)
    recorder.record('smoke_7', 'suggested_action', { actionName: 'test_action' }, 2)
    await recorder.flush()

    const replay = new TrajectoryReplay()
    const res = await replay.replay({
      trajectoryPath: tmpFile,
      mode: 'validate-only',
    })

    expect(res.success).toBe(true)
    expect(res.eventsCount).toBe(2)

    if (fs.existsSync(tmpFile)) {
      fs.unlinkSync(tmpFile)
    }
  })
})
