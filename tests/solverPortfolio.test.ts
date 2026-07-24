import { describe, expect, it } from 'vitest'
import {
  ChallengeSwarm,
  CrossSolverEvidenceBus,
  FlagDiscriminator,
  GenericProcessSolverAdapter,
  GuidanceCompiler,
  NativeSolverAdapter,
  SolverPortfolio,
  SolverResultNormalizer,
  StagnationDetector,
  SubmissionController,
} from '../src/core/solverPortfolio/index.js'

describe('Solver Portfolio & Swarm Suite', () => {
  it('normalizes external solver results cleanly', () => {
    const norm = SolverResultNormalizer.normalize({
      runId: 'run_1',
      solverId: 'mock-solver',
      status: 'completed',
      observations: [{ summary: '  found open port 80  ', confidence: 0.9 }],
      artifacts: [],
      flagCandidates: [{ value: ' flag{test_123} ' }],
      metrics: { durationMs: 100 },
    })

    expect(norm.validObservations[0].summary).toBe('found open port 80')
    expect(norm.validCandidates[0].value).toBe('flag{test_123}')
  })

  it('handles cross-solver evidence bus and cursors', () => {
    const bus = new CrossSolverEvidenceBus()
    bus.publish({
      id: 'msg_1',
      taskId: 'task_1',
      sourceSolverRunId: 'run_A',
      evidenceIds: ['ev_1'],
      observationIds: [],
      artifactIds: [],
      summary: 'SQLi confirmed in /api/v1/user',
      priority: 'high',
      createdAt: Date.now(),
    })

    const unread = bus.getUnreadMessages('task_1', 'run_B', 1)
    expect(unread.length).toBe(1)
    expect(unread[0].summary).toContain('SQLi confirmed')

    const guidance = GuidanceCompiler.compileGuidance(unread, 'm3-mini')
    expect(guidance).toContain('SQLi confirmed')
  })

  it('triggers escalation on stagnation detection', () => {
    const stag = StagnationDetector.evaluate({
      cyclesWithoutNewEvidence: 4,
      millisecondsWithoutNewEvidence: 5000,
      repeatedAttemptFingerprints: 0,
      repeatedActionFamilies: 0,
      consecutiveToolFailures: 0,
      contextCompactions: 0,
      hypothesisProgressDelta: 0,
    })

    expect(stag.action).toBe('switch_model')
  })

  it('discriminates flags and enforces submission controller boundaries', async () => {
    const disc = FlagDiscriminator.discriminate({ candidateValue: 'flag{valid_ctf_format}' })
    expect(disc.valid).toBe(true)

    const controller = new SubmissionController(true)
    const m3Sub = await controller.submitFlag({
      taskId: 't1',
      solverId: 's1',
      candidateValue: 'flag{valid_ctf_format}',
      modelId: 'm3-mini',
    })
    expect(m3Sub.accepted).toBe(false)
    expect(m3Sub.message).toContain('REJECTED')

    const highTierSub = await controller.submitFlag({
      taskId: 't1',
      solverId: 's1',
      candidateValue: 'flag{valid_ctf_format}',
      modelId: 'high-tier-model',
    })
    expect(highTierSub.status).toBe('simulated_accepted')
  })

  it('runs challenge swarm successfully', async () => {
    const bus = new CrossSolverEvidenceBus()
    const swarm = new ChallengeSwarm(bus)
    swarm.registerAdapter(
      new NativeSolverAdapter({
        async runMainAgent() {
          return { summary: 'Swarm test done' }
        },
      }),
    )

    const input = {
      taskId: 'task_swarm',
      challengeId: 'chal_1',
      compiledContext: {
        id: 'ctx_1',
        taskId: 'task_swarm',
        compilerType: 'challenge_prompt' as const,
        compilerVersion: '3.0',
        stateRevision: 1,
        stateSnapshotHash: 'hash',
        targetModelId: 'high-tier-model',
        targetRole: 'solver_scout' as const,
        objective: 'Test swarm',
        scopeSummary: '127.0.0.1',
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
      scopeSummary: '127.0.0.1',
    }

    const swarmRes = await swarm.runSwarm(input)
    expect(swarmRes.allResults.length).toBeGreaterThan(0)
  })
})
