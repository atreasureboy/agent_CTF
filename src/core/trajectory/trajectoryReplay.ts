import * as fs from 'node:fs'
import { createHash } from 'node:crypto'
import type { TrajectoryEventEnvelope } from './trajectoryTypes.js'
import type { TrajectoryValidationResult } from './trajectoryValidator.js'
import { TrajectoryValidator } from './trajectoryValidator.js'
import { CTFTaskStateStore } from '../ctfRuntime/taskStateStore.js'
import type { CTFTaskState } from '../ctfRuntime/taskState.js'
import { computeCanonicalSnapshotHash } from '../contextCompiler/canonicalSnapshot.js'
import { SolverResultNormalizer } from '../solverPortfolio/solverResultNormalizer.js'

export interface ReplayInput {
  trajectoryPath: string
  mode: 'validate-only' | 'state-rebuild' | 'mock-execution'
}

export interface ReplayDiffReport {
  observationFingerprints: { recorded: string[]; replayed: string[] }
  evidenceFingerprints: { recorded: string[]; replayed: string[] }
  hypothesisStatus: { recorded: Record<string, string>; replayed: Record<string, string> }
  actionFamily: { recorded: string[]; replayed: string[] }
  candidateStatus: { recorded: string[]; replayed: string[] }
  consistent: boolean
}

export interface ReplayResult {
  mode: string
  success: boolean
  eventsCount: number
  validationResult?: TrajectoryValidationResult
  rebuiltStateHash?: string
  recordedStateHash?: string
  stateHashMatches?: boolean
  reducerErrors?: string[]
  diffReport?: ReplayDiffReport
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

function computeFingerprint(content: string): string {
  return createHash('sha256').update(content.trim()).digest('hex').slice(0, 16)
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
      const reducerErrors: string[] = []

      for (const env of envelopes) {
        if (env.payload && typeof env.payload === 'object') {
          const event = (env.payload as any).taskEvent || env.payload
          if (event && event.type) {
            try {
              store.apply(event)
            } catch (err: any) {
              reducerErrors.push(`Event '${event.type}' apply failed: ${err.message}`)
            }
          }
        }
      }

      const currentState = store.getState()
      const currentRevision = store.getRevision(currentState.taskId)

      const recordedSnapshotEnv = envelopes.find(
        (e) =>
          (e.eventType as string) === 'snapshot_created' ||
          (e.eventType as string) === 'task_snapshot',
      )
      const recordedHash =
        recordedSnapshotEnv?.payloadHash || envelopes[envelopes.length - 1]?.payloadHash
      const recordedToolExposureHash =
        (recordedSnapshotEnv?.payload as any)?.toolExposureHash || 'resolved'

      const rebuiltHash = computeCanonicalSnapshotHash({
        taskId: currentState.taskId,
        stateRevision: currentRevision,
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
        toolExposureHash: recordedToolExposureHash,
        compilerVersion: '3.3.0',
      })

      const stateHashMatches = recordedHash ? rebuiltHash === recordedHash : true

      return {
        mode: 'state-rebuild',
        success: valResult.valid && reducerErrors.length === 0 && stateHashMatches,
        eventsCount: envelopes.length,
        validationResult: valResult,
        rebuiltStateHash: rebuiltHash,
        recordedStateHash: recordedHash,
        stateHashMatches,
        reducerErrors: reducerErrors.length > 0 ? reducerErrors : undefined,
      }
    }

    // mock-execution mode: re-execute parsers, normalizers, and reasoning pipeline over raw recorded outputs
    const initialState = createBlankState(envelopes[0]?.taskId || 'task-mock-execution')
    const store = new CTFTaskStateStore(initialState)

    const mockReducerErrors: string[] = []
    const recordedObsFingerprints: string[] = []
    const recordedEvFingerprints: string[] = []
    const recordedHypotheses: Record<string, string> = {}
    const recordedActionFamilies: string[] = []
    const recordedCandidates: string[] = []

    const replayedObsFingerprints: string[] = []
    const replayedEvFingerprints: string[] = []
    const replayedActionFamilies: string[] = []
    const replayedCandidates: string[] = []

    for (const env of envelopes) {
      if (env.payload && typeof env.payload === 'object') {
        const payload = env.payload as any

        // Record content fingerprints (not raw IDs)
        if (payload.observationSummary || payload.observationContent || payload.observationId) {
          recordedObsFingerprints.push(
            computeFingerprint(
              payload.observationSummary || payload.observationContent || payload.observationId,
            ),
          )
        }
        if (payload.claim || payload.evidenceClaim || payload.evidenceId) {
          recordedEvFingerprints.push(
            computeFingerprint(payload.claim || payload.evidenceClaim || payload.evidenceId),
          )
        }
        if (payload.hypothesisId && payload.status) {
          recordedHypotheses[payload.hypothesisId] = payload.status
        }
        if (payload.actionFamily || payload.actionKind) {
          recordedActionFamilies.push(payload.actionFamily || payload.actionKind)
        }
        if (payload.candidateValue || payload.candidateId) {
          recordedCandidates.push(computeFingerprint(payload.candidateValue || payload.candidateId))
        }

        // Re-execute SolverResultNormalizer for raw solver / tool outputs
        if (payload.rawOutput || payload.observations || payload.flagCandidates) {
          const norm = SolverResultNormalizer.normalize({
            runId: env.agentRunId || (env as any).runId || 'replayed_run',
            solverId: payload.solverId || 'replayed_solver',
            status: 'completed',
            observations:
              payload.observations ||
              (payload.rawOutput ? [{ summary: payload.rawOutput, confidence: 0.8 }] : []),
            artifacts: payload.artifacts || [],
            flagCandidates: payload.flagCandidates || [],
            metrics: { durationMs: 10 },
          })
          for (const obs of norm.validObservations) {
            replayedObsFingerprints.push(computeFingerprint(obs.summary))
          }
          for (const cand of norm.validCandidates) {
            replayedCandidates.push(computeFingerprint(cand.value))
          }
        }

        const event = payload.taskEvent || payload
        if (event && event.type) {
          try {
            store.apply(event)
          } catch (err: any) {
            mockReducerErrors.push(`Mock event '${event.type}' apply failed: ${err.message}`)
          }
        }
      }
    }

    const currentState = store.getState()
    if (replayedObsFingerprints.length === 0) {
      for (const o of currentState.observations) {
        replayedObsFingerprints.push(computeFingerprint(o.summary))
      }
    }
    if (replayedEvFingerprints.length === 0) {
      for (const e of currentState.evidence) {
        replayedEvFingerprints.push(computeFingerprint(e.claim))
      }
    }
    if (replayedActionFamilies.length === 0) {
      for (const a of currentState.attempts) {
        replayedActionFamilies.push(a.kind)
      }
    }
    if (replayedCandidates.length === 0) {
      for (const c of currentState.flagCandidates) {
        replayedCandidates.push(computeFingerprint(c.value))
      }
    }

    const replayedHypotheses: Record<string, string> = {}
    for (const h of currentState.hypotheses) {
      replayedHypotheses[h.id] = h.status
    }

    const obsMatch =
      recordedObsFingerprints.length === replayedObsFingerprints.length &&
      recordedObsFingerprints.every((fp, idx) => replayedObsFingerprints[idx] === fp)
    const evMatch =
      recordedEvFingerprints.length === replayedEvFingerprints.length &&
      recordedEvFingerprints.every((fp, idx) => replayedEvFingerprints[idx] === fp)
    const actionMatch =
      recordedActionFamilies.length === replayedActionFamilies.length &&
      recordedActionFamilies.every((af, idx) => replayedActionFamilies[idx] === af)
    const candMatch =
      recordedCandidates.length === replayedCandidates.length &&
      recordedCandidates.every((fp, idx) => replayedCandidates[idx] === fp)
    const hypMatch = Object.keys(recordedHypotheses).every(
      (k) => replayedHypotheses[k] === recordedHypotheses[k],
    )

    const consistent = obsMatch && evMatch && actionMatch && candMatch && hypMatch

    const diffReport: ReplayDiffReport = {
      observationFingerprints: {
        recorded: recordedObsFingerprints,
        replayed: replayedObsFingerprints,
      },
      evidenceFingerprints: { recorded: recordedEvFingerprints, replayed: replayedEvFingerprints },
      hypothesisStatus: { recorded: recordedHypotheses, replayed: replayedHypotheses },
      actionFamily: { recorded: recordedActionFamilies, replayed: replayedActionFamilies },
      candidateStatus: { recorded: recordedCandidates, replayed: replayedCandidates },
      consistent,
    }

    return {
      mode: 'mock-execution',
      success: valResult.valid && mockReducerErrors.length === 0 && consistent,
      eventsCount: envelopes.length,
      validationResult: valResult,
      diffReport,
      mockExecutionConsistent: consistent,
      reducerErrors: mockReducerErrors.length > 0 ? mockReducerErrors : undefined,
    }
  }
}
