import { describe, it, expect, vi } from 'vitest'
import { TaskSnapshotManager } from '../src/core/ctfRuntime/taskSnapshotManager.js'
import { CTFTaskStateStore } from '../src/core/ctfRuntime/taskStateStore.js'
import { CTFPlatformAdapter } from '../src/core/ctfPlatform/ctfPlatformAdapter.js'
import { TrajectoryQualityEvaluator } from '../src/core/trajectory/trajectoryQualityEvaluator.js'

function createBlankState(taskId: string): any {
  return {
    taskId,
    phase: 'exploration',
    activeProfileId: 'crypto',
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

describe('Heavy-Duty Flagship Mechanisms (CAI, BUUCTF, Cyber-Zero)', () => {
  describe('Mechanism 1: TaskSnapshotManager (CAI-style Checkpointing)', () => {
    it('serializes and deserializes CTFTaskStateStore losslessly', () => {
      const initial = createBlankState('task_snapshot_1')
      const store = new CTFTaskStateStore(initial)

      const json = TaskSnapshotManager.exportSnapshotJSON(store)
      expect(json).toContain('task_snapshot_1')
      expect(json).toContain('snapshotId')

      const restoredStore = TaskSnapshotManager.restoreStoreFromJSON(json)
      expect(restoredStore.getState().taskId).toBe('task_snapshot_1')
      expect(restoredStore.getState().phase).toBe('exploration')
    })
  })

  describe('Mechanism 2: CTFPlatformAdapter (BUUCTF/CTFd-style Platform API Adapter)', () => {
    it('handles CTFd correct flag submission API response', async () => {
      const adapter = new CTFPlatformAdapter({
        baseUrl: 'https://ctf.example.com',
        apiToken: 'test_token',
        challengeId: 42,
      })

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ data: { status: 'correct', message: 'Flag is correct!' } }),
        }),
      )

      const result = await adapter.submitToCTFd({
        taskId: 'task_ctfd_1',
        solverId: 'solver_1',
        candidateValue: 'flag{correct_flag_123}',
        modelId: 'gpt-4o',
      })

      expect(result.verdict).toBe('accepted')
      expect(result.message).toContain('Flag is correct!')

      const response = CTFPlatformAdapter.mapToSubmissionResponse(result)
      expect(response.status).toBe('accepted')
      expect(response.accepted).toBe(true)

      vi.unstubAllGlobals()
    })

    it('handles CTFd rate limited HTTP 429 response', async () => {
      const adapter = new CTFPlatformAdapter({
        baseUrl: 'https://ctf.example.com',
        apiToken: 'test_token',
        challengeId: 42,
      })

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 429,
          statusText: 'Too Many Requests',
        }),
      )

      const result = await adapter.submitToCTFd({
        taskId: 'task_ctfd_2',
        solverId: 'solver_1',
        candidateValue: 'flag{test}',
        modelId: 'gpt-4o',
      })

      expect(result.verdict).toBe('rate_limited')
      expect(result.message).toContain('Rate limited')

      vi.unstubAllGlobals()
    })
  })

  describe('Mechanism 3: TrajectoryQualityEvaluator (Cyber-Zero-style Quality Scoring & Pruning)', () => {
    it('scores low-gain error output and prunes it', () => {
      const step = TrajectoryQualityEvaluator.evaluateStep({
        toolId: 'Bash',
        input: { command: 'invalid_cmd' },
        output: 'bash: command not found: invalid_cmd',
        exitCode: 127,
      })

      expect(step.informationGainScore).toBe(0.1)
      expect(step.isPruned).toBe(true)
      expect(step.processedOutput).toContain('[Pruned Low-Gain Output]')
    })

    it('assigns maximum score (1.0) when flag pattern is detected in output', () => {
      const step = TrajectoryQualityEvaluator.evaluateStep({
        toolId: 'Python',
        input: { script: 'solve.py' },
        output: 'Successfully extracted flag{super_secret_flag_xyz}!',
        exitCode: 0,
      })

      expect(step.informationGainScore).toBe(1.0)
      expect(step.isPruned).toBe(false)
      expect(step.processedOutput).toContain('flag{super_secret_flag_xyz}')
    })

    it('truncates oversized output noise', () => {
      const longOutput = 'A'.repeat(3000)
      const step = TrajectoryQualityEvaluator.evaluateStep({
        toolId: 'Read',
        input: { path: 'dump.bin' },
        output: longOutput,
      })

      expect(step.informationGainScore).toBe(0.6)
      expect(step.isPruned).toBe(false)
      expect(step.processedOutput).toContain('Truncated 2000 bytes of noise')
    })
  })
})
