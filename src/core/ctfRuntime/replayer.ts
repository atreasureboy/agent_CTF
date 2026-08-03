/**
 * Replayer — Phase borrow-plan Phase D.
 *
 * Inspired by swe-agent v0.7's `tests/test_replay.py` and cyber-zero's
 * trajectory JSONL trail. We read the event log from a task's
 * `events.ndjson`, re-apply reducer steps, and emit a structured
 * timeline grouped by cycle.
 *
 * Pure: the replayer does not mutate any state; it walks the
 * event log and renders.
 */

import { readFile } from 'fs/promises'
import type { CTFTaskEvent } from './taskEvents.js'
import { reduceInternal } from './taskStateStore.js'
import type { CTFTaskState } from './taskState.js'

export interface ReplayAttempt {
  attemptId: string
  cycle: number
  action: string
  status:
    | 'pending'
    | 'running'
    | 'succeeded'
    | 'failed'
    | 'cancelled'
    | 'skipped'
    | 'skipped_duplicate'
    | 'skipped_policy'
    | 'skipped_budget'
  startedAt: number
  completedAt?: number
  observationIds: string[]
  evidenceIds: string[]
  artifactIds: string[]
  flagCandidateIds: string[]
  error?: string
}

export interface ReplayCycle {
  index: number
  budgetAfter: number
  strategyDecisions: Array<{
    selectedAction?: string
    rejected: Array<{ action: string; reason: string }>
    reason: string
    basedOnHypothesisIds: string[]
  }>
  attempts: ReplayAttempt[]
}

export interface ReplayError {
  /** 0-based event index within the source event list. */
  index: number
  /** Event.type string for diagnostics. */
  eventType: string
  /** Reducer throw message. */
  message: string
}

export interface ReplayOutput {
  taskId: string
  startedAt?: number
  completedAt?: number
  stoppedReason?: string
  cycles: ReplayCycle[]
  /**
   * §11 F10 — events that the reducer rejected. The reducer throws
   * for known illegal transitions (e.g. ATTEMPT terminal→running);
   * we previously swallowed these silently (`catch { continue }`) which
   * made replay output look clean even when the underlying state was
   * broken. These are now surfaced for the auditor / on-call to inspect.
   */
  errors: ReplayError[]
  /** Final state summary. */
  finalState: {
    totalObservations: number
    totalEvidence: number
    totalArtifacts: number
    totalFlagCandidates: number
    validatedFlagCandidates: number
    acceptedStrategies: number
  }
}

export async function replayFromEventLog(file: string): Promise<ReplayOutput> {
  const text = await readFile(file, 'utf-8')
  return replayFromJsonl(text)
}

export function replayFromJsonl(jsonl: string): ReplayOutput {
  const lines = jsonl.split('\n').filter((l) => l.trim().length > 0)
  const events: CTFTaskEvent[] = []
  for (const line of lines) {
    try {
      events.push(JSON.parse(line) as CTFTaskEvent)
    } catch {
      /* skip malformed lines */
    }
  }
  return replayFromEvents(events)
}

export function replayFromEvents(events: ReadonlyArray<CTFTaskEvent>): ReplayOutput {
  let state: CTFTaskState | null = null
  const cycles: ReplayCycle[] = []
  let currentCycle: ReplayCycle | null = null
  let cycleIndex = 0
  let taskId = ''
  let startedAt: number | undefined
  let completedAt: number | undefined
  let stoppedReason: string | undefined
  const errors: ReplayError[] = []
  for (let i = 0; i < events.length; i++) {
    const event = events[i]
    if (event === undefined) continue
    if (event.type === 'TASK_CREATED') {
      taskId = event.taskId
      state = event.initial
      startedAt = state.createdAt
      cycleIndex = 0
      currentCycle = newCycle(0, state.reasoningBudget.actionsExecuted)
      continue
    }
    if (event.type === 'TASK_COMPLETED') {
      completedAt = state?.updatedAt
      stoppedReason = event.reason
    }
    if (!state) continue
    try {
      state = reduceInternal(state, event)
    } catch (err) {
      // §11 F10 — record the error so callers can audit replay quality.
      // The previous `catch { continue }` hid reducer bugs behind a clean
      // ReplayOutput; surface them now via `errors[]`.
      errors.push({
        index: i,
        eventType: event.type,
        message: err instanceof Error ? err.message : String(err),
      })
      continue
    }
    if (event.type === 'STRATEGY_DECISION_RECORDED') {
      // A new strategy decision closes the previous cycle (which
      // by then has its attempt bound) and starts a fresh one.
      if (
        currentCycle &&
        (currentCycle.attempts.length > 0 || currentCycle.strategyDecisions.length > 0)
      ) {
        cycles.push(currentCycle)
        cycleIndex += 1
      }
      currentCycle = newCycle(cycleIndex, state.reasoningBudget.actionsExecuted)
      currentCycle.strategyDecisions.push({
        selectedAction: event.decision.selectedAction?.type,
        rejected: event.decision.rejectedActions.map((r) => ({
          action: r.action.type,
          reason: r.reason,
        })),
        reason: event.decision.reason,
        basedOnHypothesisIds: event.decision.basedOnHypothesisIds,
      })
    }
    if (event.type === 'ATTEMPT_STARTED') {
      const a = event.attempt
      if (!currentCycle) currentCycle = newCycle(cycleIndex, state.reasoningBudget.actionsExecuted)
      currentCycle.attempts.push({
        attemptId: a.id,
        cycle: cycleIndex,
        action: `${a.kind}:${a.targetId}`,
        status: a.status,
        startedAt: a.createdAt,
        observationIds: [],
        evidenceIds: [],
        artifactIds: [],
        flagCandidateIds: [],
      })
    }
    if (event.type === 'ATTEMPT_COMPLETED' && currentCycle) {
      const att = currentCycle.attempts.find((x) => x.attemptId === event.attemptId)
      if (att) {
        att.status = 'succeeded'
        att.completedAt = event.completedAt
        att.observationIds = [...event.observationIds]
        att.evidenceIds = [...event.evidenceIds]
        att.artifactIds = [...event.artifactIds]
        att.flagCandidateIds = [...event.flagCandidateIds]
      }
    }
    if (event.type === 'ATTEMPT_FAILED' && currentCycle) {
      const att = currentCycle.attempts.find((x) => x.attemptId === event.attemptId)
      if (att) {
        att.status = 'failed'
        att.completedAt = event.completedAt
        att.error = event.error.message
      }
    }
    if (event.type === 'ATTEMPT_CANCELLED' && currentCycle) {
      const att = currentCycle.attempts.find((x) => x.attemptId === event.attemptId)
      if (att) {
        att.status = 'cancelled'
        att.completedAt = event.completedAt
      }
    }
    if (event.type === 'ATTEMPT_SKIPPED' && currentCycle) {
      const att = currentCycle.attempts.find((x) => x.attemptId === event.attemptId)
      if (att) {
        att.status = 'skipped'
        att.completedAt = event.completedAt
      }
    }
    if (event.type === 'REASONING_BUDGET_CONSUMED' && currentCycle) {
      currentCycle.budgetAfter = event.snapshot.actionsExecuted
    }
  }
  if (currentCycle) cycles.push(currentCycle)

  if (!state) {
    return {
      taskId: '',
      cycles: [],
      errors,
      finalState: emptyFinalState(),
    }
  }
  return {
    taskId,
    startedAt,
    completedAt,
    stoppedReason,
    cycles,
    errors,
    finalState: {
      totalObservations: state.observations.length,
      totalEvidence: state.evidence.length,
      totalArtifacts: state.artifactIds.length,
      totalFlagCandidates: state.flagCandidates.length,
      validatedFlagCandidates: state.flagCandidates.filter((c) => c.status === 'validated').length,
      acceptedStrategies: state.strategyDecisions.length,
    },
  }
}

function newCycle(index: number, budgetAfter: number): ReplayCycle {
  return {
    index,
    budgetAfter,
    strategyDecisions: [],
    attempts: [],
  }
}

function emptyFinalState() {
  return {
    totalObservations: 0,
    totalEvidence: 0,
    totalArtifacts: 0,
    totalFlagCandidates: 0,
    validatedFlagCandidates: 0,
    acceptedStrategies: 0,
  }
}
