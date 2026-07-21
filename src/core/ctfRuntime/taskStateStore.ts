/**
 * CTFTaskStateStore — single authoritative state holder for one CTF task.
 *
 * Usage:
 *   const store = new CTFTaskStateStore(initialState)
 *   store.subscribe((event, state) => { ... })
 *   store.apply({ type: 'PHASE_CHANGED', from: 'intake', to: 'triage' })
 *
 * Invariants enforced by the store:
 *   1. Every state change goes through `apply(event)` — direct mutation is
 *      impossible because the public surface only exposes `getState()`.
 *   2. `updatedAt` is refreshed on every event.
 *   3. Phase transitions are validated against `ALLOWED_PHASE_TRANSITIONS`.
 *   4. A task in a terminal phase (`solved|blocked|failed|cancelled`) cannot
 *      accept new workflow / specialist / handoff events.
 *   5. The same Handoff cannot be approved / started twice.
 *   6. After `TASK_COMPLETED`, the task is frozen.
 */

import {
  canTransitionPhase,
  isActiveAgentRun,
  isActiveJob,
  isActiveWorkflowRun,
  isTerminalPhase,
  type CTFTaskPhase,
  type CTFTaskState,
  type HandoffRecord,
} from './taskState.js'
import type { CTFTaskEvent, TaskStateListener, Unsubscribe } from './taskEvents.js'

export class TaskStateStoreError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TaskStateStoreError'
  }
}

export class IllegalPhaseTransitionError extends TaskStateStoreError {}
export class TaskAlreadyCompletedError extends TaskStateStoreError {}
export class DuplicateHandoffTransitionError extends TaskStateStoreError {}
export class UnknownHandoffError extends TaskStateStoreError {}
export class DuplicateHypothesisError extends TaskStateStoreError {}
export class UnknownHypothesisError extends TaskStateStoreError {}
export class DuplicateAttemptError extends TaskStateStoreError {}
export class UnknownAttemptError extends TaskStateStoreError {}
export class IllegalAttemptTransitionError extends TaskStateStoreError {}
export class DuplicateJobError extends TaskStateStoreError {}
export class UnknownJobError extends TaskStateStoreError {}
export class IllegalJobTransitionError extends TaskStateStoreError {}

export class CTFTaskStateStore {
  private state: CTFTaskState
  private readonly listeners = new Set<TaskStateListener>()
  /** Monotonically increasing sequence number for subscribers to detect gaps. */
  private seq = 0
  /** Map<event-type, count> for diagnostics. */
  private readonly eventCounts = new Map<string, number>()

  constructor(initial: CTFTaskState) {
    this.state = freezeState(initial)
  }

  getState(): Readonly<CTFTaskState> {
    return this.state
  }

  /** Diagnostic: how many of each event type have been applied. */
  getEventCounts(): Readonly<Record<string, number>> {
    return Object.fromEntries(this.eventCounts)
  }

  subscribe(listener: TaskStateListener): Unsubscribe {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  apply(event: CTFTaskEvent): Readonly<CTFTaskState> {
    this.guardAcceptsEvent(event)

    const next = reduce(this.state, event)
    this.state = freezeState({ ...next, updatedAt: Date.now() })
    this.seq++
    this.eventCounts.set(event.type, (this.eventCounts.get(event.type) ?? 0) + 1)

    for (const l of this.listeners) {
      try {
        l(event, this.state)
      } catch {
        // Listeners must not break the store — best-effort.
      }
    }
    return this.state
  }

  private guardAcceptsEvent(event: CTFTaskEvent): void {
    // §6.7 — once TASK_COMPLETED has fired, no other completion event is
    // allowed. Bookkeeping events (findings / artifacts / flag candidates /
    // hypotheses) remain legal because they enrich the audit trail.
    if (event.type === 'TASK_COMPLETED') {
      if (this.state.completion) {
        throw new TaskAlreadyCompletedError(
          `Task ${this.state.taskId} already completed as ${this.state.completion.status}; ` +
            `refusing to overwrite with ${event.status}.`,
        )
      }
    } else if (this.state.completion) {
      const bookkeepingOnly: CTFTaskEvent['type'][] = [
        'FINDING_ADDED',
        'ARTIFACT_ADDED',
        'FLAG_CANDIDATE_ADDED',
        'HYPOTHESIS_ADDED',
      ]
      if (!bookkeepingOnly.includes(event.type)) {
        throw new TaskAlreadyCompletedError(
          `Task ${this.state.taskId} is already ${this.state.completion.status}; cannot apply ${event.type}.`,
        )
      }
    }

    // Handoff-related guards — the handoff must exist and be in a state that
    // permits this transition. Specialist events drive the same handoff FSM
    // because the lifecycle is `requested → approved → running → completed`.
    const handoffTransitions: CTFTaskEvent['type'][] = [
      'HANDOFF_APPROVED',
      'HANDOFF_REJECTED',
      'HANDOFF_CANCELLED',
      'SPECIALIST_STARTED',
      'SPECIALIST_COMPLETED',
      'SPECIALIST_FAILED',
      'SPECIALIST_CANCELLED',
    ]
    if (handoffTransitions.includes(event.type)) {
      const handoffId = (event as { handoffId?: string }).handoffId
      if (!handoffId) {
        throw new TaskStateStoreError(`${event.type} requires handoffId`)
      }
      const h = this.findHandoff(handoffId)
      if (!h) throw new UnknownHandoffError(`Handoff ${handoffId} not found.`)
      assertHandoffTransition(h, event.type)
    }

    // Phase guards for workflow / specialist events.
    if (isTerminalPhase(this.state.phase)) {
      const blockInTerminal: CTFTaskEvent['type'][] = [
        'WORKFLOW_STARTED',
        'WORKFLOW_COMPLETED',
        'WORKFLOW_FAILED',
        'AGENT_RUN_STARTED',
        'AGENT_RUN_COMPLETED',
        'AGENT_RUN_FAILED',
        'AGENT_RUN_CANCELLED',
        'HANDOFF_REQUESTED',
        'HANDOFF_APPROVED',
        'SPECIALIST_STARTED',
        'SPECIALIST_COMPLETED',
        'SPECIALIST_FAILED',
        'SPECIALIST_CANCELLED',
        'PHASE_CHANGED',
        'PROFILE_CHANGED',
        'CONTEXT_REPLACED',
        'TASK_COMPLETED',
      ]
      if (blockInTerminal.includes(event.type)) {
        throw new TaskAlreadyCompletedError(
          `Task ${this.state.taskId} is in terminal phase ${this.state.phase}; cannot ${event.type}.`,
        )
      }
    }
  }

  private findHandoff(id: string): HandoffRecord | null {
    return this.state.handoffs.find((h) => h.id === id) ?? null
  }
}

function assertHandoffTransition(h: HandoffRecord, type: CTFTaskEvent['type']): void {
  // §八 — a Handoff can be failed by the orchestrator at any pre-running
  // state (no agent available, configuration error). Once a Specialist has
  // started, only the Specialist events can move it forward.
  const allowed: Record<HandoffRecord['status'], CTFTaskEvent['type'][]> = {
    requested: [
      'HANDOFF_APPROVED',
      'HANDOFF_REJECTED',
      'HANDOFF_CANCELLED',
      'SPECIALIST_FAILED',
    ],
    approved: ['SPECIALIST_STARTED', 'SPECIALIST_FAILED', 'SPECIALIST_CANCELLED'],
    rejected: [],
    running: ['SPECIALIST_COMPLETED', 'SPECIALIST_FAILED', 'SPECIALIST_CANCELLED'],
    completed: [],
    failed: [],
    cancelled: [],
  }
  if (!allowed[h.status].includes(type)) {
    throw new DuplicateHandoffTransitionError(
      `Handoff ${h.id} is in status ${h.status}; cannot apply ${type}.`,
    )
  }
}

function freezeState<T>(s: T): T {
  // We expose the state as readonly via the type; a deep-freeze would be
  // expensive. Shallow freeze is enough to catch casual misuse in dev.
  return Object.freeze(s)
}

function reduce(state: CTFTaskState, event: CTFTaskEvent): CTFTaskState {
  switch (event.type) {
    case 'TASK_CREATED':
      return event.initial

    case 'PHASE_CHANGED': {
      if (state.phase === event.to) return state
      if (!canTransitionPhase(state.phase, event.to)) {
        throw new IllegalPhaseTransitionError(
          `Phase transition ${state.phase} → ${event.to} is not allowed.`,
        )
      }
      return { ...state, phase: event.to }
    }

    case 'PROFILE_CHANGED': {
      if (state.activeProfileId === event.profileId) return state
      return {
        ...state,
        activeProfileId: event.profileId,
        context: { ...state.context, profileId: event.profileId },
      }
    }

    case 'CONTEXT_REPLACED':
      return { ...state, context: event.context }

    case 'WORKFLOW_STARTED': {
      const workflowRuns = [...state.workflowRuns, event.workflowRun]
      return {
        ...state,
        workflowRuns,
        activeWorkflowRunIds: workflowRuns.filter(isActiveWorkflowRun).map((r) => r.id),
      }
    }

    case 'WORKFLOW_COMPLETED':
    case 'WORKFLOW_FAILED': {
      const workflowRuns = state.workflowRuns.map((r) =>
        r.id === event.workflowRunId
          ? {
              ...r,
              status: event.type === 'WORKFLOW_COMPLETED' ? 'completed' as const : 'failed' as const,
              completedAt: Date.now(),
              summary: event.type === 'WORKFLOW_COMPLETED' ? event.summary : undefined,
              error: event.type === 'WORKFLOW_FAILED' ? event.error : undefined,
            }
          : r,
      )
      return {
        ...state,
        workflowRuns,
        activeWorkflowRunIds: workflowRuns.filter(isActiveWorkflowRun).map((r) => r.id),
      }
    }

    case 'HANDOFF_REQUESTED':
      return { ...state, handoffs: [...state.handoffs, event.handoff] }

    case 'HANDOFF_APPROVED':
    case 'HANDOFF_REJECTED':
    case 'HANDOFF_CANCELLED':
    case 'SPECIALIST_STARTED':
    case 'SPECIALIST_COMPLETED':
    case 'SPECIALIST_FAILED':
    case 'SPECIALIST_CANCELLED':
      return {
        ...state,
        handoffs: state.handoffs.map((h) =>
          h.id === event.handoffId ? applyHandoffEvent(h, event) : h,
        ),
      }

    case 'AGENT_RUN_STARTED': {
      const agentRuns = [...state.agentRuns, event.agentRun]
      return {
        ...state,
        agentRuns,
        activeAgentRunIds: agentRuns.filter(isActiveAgentRun).map((r) => r.id),
      }
    }

    case 'AGENT_RUN_COMPLETED':
    case 'AGENT_RUN_FAILED':
    case 'AGENT_RUN_CANCELLED': {
      const agentRuns = state.agentRuns.map((r) =>
        r.id === event.agentRunId
          ? {
              ...r,
              status:
                event.type === 'AGENT_RUN_COMPLETED'
                  ? ('completed' as const)
                  : event.type === 'AGENT_RUN_FAILED'
                    ? ('failed' as const)
                    : ('cancelled' as const),
              completedAt: Date.now(),
              summary:
                event.type === 'AGENT_RUN_COMPLETED'
                  ? event.summary
                  : event.type === 'AGENT_RUN_FAILED'
                    ? undefined
                    : undefined,
              error:
                event.type === 'AGENT_RUN_FAILED'
                  ? event.error
                  : event.type === 'AGENT_RUN_CANCELLED'
                    ? event.reason
                    : undefined,
            }
          : r,
      )
      return {
        ...state,
        agentRuns,
        activeAgentRunIds: agentRuns.filter(isActiveAgentRun).map((r) => r.id),
      }
    }

    case 'AGENT_RUN_OUTPUT_RECORDED': {
      const agentRuns = state.agentRuns.map((r) =>
        r.id === event.agentRunId
          ? {
              ...r,
              producedFindingIds: [...new Set([...r.producedFindingIds, ...event.producedFindingIds])],
              producedArtifactIds: [...new Set([...r.producedArtifactIds, ...event.producedArtifactIds])],
            }
          : r,
      )
      return { ...state, agentRuns }
    }

    case 'FINDING_ADDED':
      return {
        ...state,
        findings: [...state.findings, event.finding],
      }

    case 'ARTIFACT_ADDED':
      if (state.artifactIds.includes(event.artifactId)) return state
      return { ...state, artifactIds: [...state.artifactIds, event.artifactId] }

    case 'FLAG_CANDIDATE_ADDED':
      return { ...state, flagCandidates: [...state.flagCandidates, event.candidate] }

    case 'HYPOTHESIS_ADDED': {
      // §九 — refuse duplicate IDs so the reducer is the single source of
      // truth. Each hypothesis is stored verbatim; update via HYPOTHESIS_UPDATED.
      if (state.hypotheses.some((h) => h.id === event.hypothesis.id)) {
        throw new DuplicateHypothesisError(
          `Hypothesis ${event.hypothesis.id} already exists`,
        )
      }
      return { ...state, hypotheses: [...state.hypotheses, event.hypothesis] }
    }

    case 'HYPOTHESIS_UPDATED': {
      const next = state.hypotheses.map((h) =>
        h.id === event.hypothesisId ? { ...h, ...event.patch, updatedAt: Date.now() } : h,
      )
      if (next.every((h, i) => h === state.hypotheses[i])) {
        throw new UnknownHypothesisError(`Hypothesis ${event.hypothesisId} not found`)
      }
      return { ...state, hypotheses: next }
    }

    case 'ATTEMPT_RECORDED': {
      // §九 — refuse duplicates and rejected status transitions.
      if (state.attempts.some((a) => a.id === event.attempt.id)) {
        throw new DuplicateAttemptError(`Attempt ${event.attempt.id} already exists`)
      }
      return { ...state, attempts: [...state.attempts, event.attempt] }
    }

    case 'ATTEMPT_UPDATED': {
      const next = state.attempts.map((a) => {
        if (a.id !== event.attemptId) return a
        // §九 — completed attempts cannot return to running/pending.
        if (
          (a.status === 'succeeded' || a.status === 'failed' || a.status === 'cancelled') &&
          event.patch.status &&
          (event.patch.status === 'running' || event.patch.status === 'pending')
        ) {
          throw new IllegalAttemptTransitionError(
            `Attempt ${a.id} cannot move from ${a.status} to ${event.patch.status}`,
          )
        }
        return { ...a, ...event.patch }
      })
      if (next.every((a, i) => a === state.attempts[i])) {
        throw new UnknownAttemptError(`Attempt ${event.attemptId} not found`)
      }
      return { ...state, attempts: next }
    }

    case 'JOB_RECORDED': {
      if (state.jobs.some((j) => j.id === event.job.id)) {
        throw new DuplicateJobError(`Job ${event.job.id} already recorded`)
      }
      const jobs = [...state.jobs, event.job]
      return {
        ...state,
        jobs,
        activeJobIds: jobs.filter(isActiveJob).map((j) => j.id),
      }
    }

    case 'JOB_UPDATED': {
      const idx = state.jobs.findIndex((j) => j.id === event.jobId)
      if (idx < 0) {
        throw new UnknownJobError(`Job ${event.jobId} not found`)
      }
      const prev = state.jobs[idx]
      // §十一 — terminal jobs (success/failed/cancelled) cannot return to
      // pending/running.
      const prevTerminal =
        prev.status === 'success' || prev.status === 'failed' || prev.status === 'cancelled'
      const patchStatus = event.patch.status
      if (
        prevTerminal &&
        patchStatus &&
        (patchStatus === 'pending' || patchStatus === 'running')
      ) {
        throw new IllegalJobTransitionError(
          `Job ${prev.id} is ${prev.status}; cannot transition to ${patchStatus}`,
        )
      }
      const jobs = state.jobs.map((j, i) =>
        i === idx ? { ...j, ...event.patch } : j,
      )
      return {
        ...state,
        jobs,
        activeJobIds: jobs.filter(isActiveJob).map((j) => j.id),
      }
    }

    case 'TASK_COMPLETED':
      return {
        ...state,
        completion: {
          status: event.status,
          reason: event.reason,
          flagCandidateId: event.flagCandidateId,
          decidedAt: Date.now(),
        },
        phase: phaseForCompletion(event.status),
      }

    default: {
      // Exhaustiveness guard — any new event type added to the union that
      // does not match a case above triggers a compile-time error here.
      const _exhaustive: never = event
      void _exhaustive
      return state
    }
  }
}

function phaseForCompletion(status: 'solved' | 'blocked' | 'failed' | 'cancelled'): CTFTaskPhase {
  return status
}

function applyHandoffEvent(
  h: HandoffRecord,
  event: Extract<
    CTFTaskEvent,
    {
      type:
        | 'HANDOFF_APPROVED'
        | 'HANDOFF_REJECTED'
        | 'HANDOFF_CANCELLED'
        | 'SPECIALIST_STARTED'
        | 'SPECIALIST_COMPLETED'
        | 'SPECIALIST_FAILED'
        | 'SPECIALIST_CANCELLED'
    }
  >,
): HandoffRecord {
  switch (event.type) {
    case 'HANDOFF_APPROVED':
      return {
        ...h,
        status: 'approved',
        selectedAgentId: event.selectedAgentId,
        approvedAt: Date.now(),
      }
    case 'HANDOFF_REJECTED':
      return { ...h, status: 'rejected', rejectionReason: event.reason, completedAt: Date.now() }
    case 'HANDOFF_CANCELLED':
      return { ...h, status: 'cancelled', completedAt: Date.now(), error: event.reason }
    case 'SPECIALIST_STARTED':
      return { ...h, status: 'running', startedAt: Date.now() }
    case 'SPECIALIST_COMPLETED':
      return { ...h, status: 'completed', completedAt: Date.now() }
    case 'SPECIALIST_FAILED':
      return { ...h, status: 'failed', completedAt: Date.now(), error: event.error }
    case 'SPECIALIST_CANCELLED':
      return { ...h, status: 'cancelled', completedAt: Date.now(), error: event.reason }
  }
}
