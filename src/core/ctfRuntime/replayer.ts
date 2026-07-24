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

export interface ReplayOutput {
  taskId: string
  startedAt?: number
  completedAt?: number
  stoppedReason?: string
  cycles: ReplayCycle[]
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
  for (const event of events) {
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
    } catch {
      // Replay continues even if a reducer throws — the auditor sees
      // a broken event in the timeline rather than aborting the
      // entire replay.
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
      finalState: emptyFinalState(),
    }
  }
  return {
    taskId,
    startedAt,
    completedAt,
    stoppedReason,
    cycles,
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
