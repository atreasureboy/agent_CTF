import * as fs from 'node:fs'
import type { TrajectoryEventEnvelope } from './trajectoryTypes.js'
import type { TrajectoryValidationResult } from './trajectoryValidator.js'
import { TrajectoryValidator } from './trajectoryValidator.js'
import { CTFTaskStateStore } from '../ctfRuntime/taskStateStore.js'
import type { CTFTaskState } from '../ctfRuntime/taskState.js'
import { computeCanonicalSnapshotHash } from '../contextCompiler/canonicalSnapshot.js'

export interface ReplayInput {
  trajectoryPath: string
  mode: 'validate-only' | 'state-rebuild' | 'mock-execution'
}

export interface ReplayResult {
  mode: string
  success: boolean
  eventsCount: number
  validationResult?: TrajectoryValidationResult
  rebuiltStateHash?: string
  mockExecutionConsistent?: boolean
}

function createBlankState(taskId: string): CTFTaskState {
  return {
    taskId,
    phase: 'created',
    activeProfileId: 'default',
    context: {
      taskId,
      workspaceDir: '/tmp',
      sessionDir: '/tmp',
      artifactDir: '/tmp',
      eventsFile: '/tmp/events.ndjson',
      profileId: 'default',
    } as any,
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
    reasoningBudget: { totalTokens: 0, costUsd: 0, stepsCount: 0 } as any,
    reasoningBudgetLimits: { maxTokens: 100000, maxCostUsd: 10, maxSteps: 100 } as any,
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

export class TrajectoryReplay {
  public async replay(input: ReplayInput): Promise<ReplayResult> {
    if (!fs.existsSync(input.trajectoryPath)) {
      throw new Error(`Trajectory file '${input.trajectoryPath}' does not exist.`)
    }

    const content = await fs.promises.readFile(input.trajectoryPath, 'utf-8')
    const lines = content.split('\n').filter((l) => l.trim().length > 0)
    const envelopes: TrajectoryEventEnvelope[] = lines.map((l) => JSON.parse(l))

    const valResult = TrajectoryValidator.validateEnvelopes(envelopes)

    if (input.mode === 'validate-only') {
      return {
        mode: 'validate-only',
        success: valResult.valid,
        eventsCount: envelopes.length,
        validationResult: valResult,
      }
    }

    if (input.mode === 'state-rebuild') {
      const initialState = createBlankState(envelopes[0]?.taskId || 'task-replayed')
      const store = new CTFTaskStateStore(initialState)

      for (const env of envelopes) {
        if (env.payload && typeof env.payload === 'object') {
          const event = (env.payload as any).taskEvent || env.payload
          if (event && event.type) {
            try {
              store.apply(event)
            } catch {
              // best-effort replay
            }
          }
        }
      }

      const currentState = store.getState()
      const rebuiltHash = computeCanonicalSnapshotHash({
        taskId: currentState.taskId,
        stateRevision: (currentState as any).stateRevision ?? (currentState as any).revision ?? 1,
        evidence: currentState.evidence.map((e: any) => ({
          id: e.id,
          confidence: e.confidence,
          polarity: e.polarity,
        })),
        hypotheses: currentState.hypotheses.map((h: any) => ({
          id: h.id,
          status: h.status,
          confidence: h.confidence,
        })),
        attempts: currentState.attempts.map((a: any) => ({
          id: a.id,
          status: a.status,
          fingerprint: a.fingerprint,
        })),
        artifacts: currentState.artifactIds.map((id: string) => ({ id })),
        pendingActions: (currentState.pendingActions || []).map((p: any) => ({
          id: p.id,
          status: p.status || 'pending',
        })),
        toolExposureHash: 'rebuilt',
        compilerVersion: '3.3.0',
      })

      return {
        mode: 'state-rebuild',
        success: valResult.valid,
        eventsCount: envelopes.length,
        validationResult: valResult,
        rebuiltStateHash: rebuiltHash,
      }
    }

    // mock-execution mode
    return {
      mode: 'mock-execution',
      success: valResult.valid,
      eventsCount: envelopes.length,
      validationResult: valResult,
      mockExecutionConsistent: valResult.valid,
    }
  }
}
