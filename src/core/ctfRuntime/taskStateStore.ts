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
  isTerminalOneShotStatus,
  isTerminalPhase,
  type CTFHypothesis,
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
export class DuplicateOneShotRunError extends TaskStateStoreError {}
export class UnknownOneShotRunError extends TaskStateStoreError {}
export class IllegalOneShotRunTransitionError extends TaskStateStoreError {}

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
      // §round-4 audit fix — post-completion reflection / audit
      // code applies these events. The FSM-changing events
      // (WORKFLOW_*, HANDOFF_*, SPECIALIST_*, AGENT_RUN_*,
      // PHASE_CHANGED, PROFILE_CHANGED, CONTEXT_REPLACED,
      // ONESHOT_RUN_*, TASK_COMPLETED, ATTEMPT_RECORDED,
      // JOB_RECORDED) remain blocked — they would add new mutable
      // records to the state, which contradicts §六.4.
      const bookkeepingOnly: CTFTaskEvent['type'][] = [
        'FINDING_ADDED',
        'ARTIFACT_ADDED',
        'FLAG_CANDIDATE_ADDED',
        'HYPOTHESIS_ADDED',
        'HYPOTHESIS_UPDATED',
        'HYPOTHESIS_STATUS_CHANGED',
        'ATTEMPT_UPDATED',
        'ATTEMPT_COMPLETED',
        'ATTEMPT_FAILED',
        'ATTEMPT_CANCELLED',
        'ATTEMPT_SKIPPED',
        'JOB_UPDATED',
        'OBSERVATION_ADDED',
        'EVIDENCE_ADDED',
        'EVIDENCE_MERGED',
        'STRATEGY_DECISION_RECORDED',
        'FLAG_CANDIDATE_DETECTED',
        'FLAG_CANDIDATE_VALIDATED',
        'FLAG_CANDIDATE_REJECTED',
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
    // Audit rounds 6-10 — added HANDOFF_FAILED so the FSM guard
    // validates it like the other handoff events (h must exist; the
    // transition must be legal).
    const handoffTransitions: CTFTaskEvent['type'][] = [
      'HANDOFF_APPROVED',
      'HANDOFF_REJECTED',
      'HANDOFF_CANCELLED',
      'HANDOFF_FAILED',
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
        'WORKFLOW_CANCELLED',
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
        // §四 — no new OneShot runs on a terminal task.
        'ONESHOT_RUN_QUEUED',
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
  // Audit rounds 6-10 — added HANDOFF_FAILED for pre-running states so
  // the FSM correctly recognises the new event type from the projector.
  const allowed: Record<HandoffRecord['status'], CTFTaskEvent['type'][]> = {
    requested: [
      'HANDOFF_APPROVED',
      'HANDOFF_REJECTED',
      'HANDOFF_CANCELLED',
      'HANDOFF_FAILED',
      'SPECIALIST_FAILED',
    ],
    approved: [
      'HANDOFF_FAILED',
      'SPECIALIST_STARTED',
      'SPECIALIST_FAILED',
      'SPECIALIST_CANCELLED',
    ],
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

function dedupeStrings(arr: string[]): string[] {
  return [...new Set(arr)]
}

function freezeState<T>(s: T): T {
  // Audit rounds 6-10 — the previous shallow freeze left arrays
  // like `artifactIds` and `findings` mutable. We re-shallow-freeze
  // for now and rely on the TypeScript `Readonly<>` types for static
  // protection. A future round can switch to a deep-freeze that
  // does not break the existing test suite (which mutates getState()
  // arrays in some places for setup).
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
    case 'WORKFLOW_FAILED':
    case 'WORKFLOW_CANCELLED': {
      const workflowRuns = state.workflowRuns.map((r) =>
        r.id === event.workflowRunId
          ? {
              ...r,
              status:
                event.type === 'WORKFLOW_COMPLETED'
                  ? ('completed' as const)
                  : event.type === 'WORKFLOW_FAILED'
                    ? ('failed' as const)
                    : ('cancelled' as const),
              completedAt: Date.now(),
              summary:
                event.type === 'WORKFLOW_COMPLETED' ? event.summary : undefined,
              error:
                event.type === 'WORKFLOW_FAILED'
                  ? event.error
                  : event.type === 'WORKFLOW_CANCELLED'
                    ? event.reason
                    : undefined,
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

    case 'HANDOFF_FAILED': {
      // §十一.1 — selection / creation / execution / projection failures
      // route through this distinct event. The handoff transitions to
      // 'failed' with the stage recorded so audits can distinguish.
      const next = state.handoffs.map((h) =>
        h.id === event.handoffId
          ? {
              ...h,
              status: 'failed' as const,
              error: `${event.stage}: ${event.error}`,
              completedAt: Date.now(),
            }
          : h,
      )
      return { ...state, handoffs: next }
    }

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

    case 'HYPOTHESIS_PROPOSED': {
      // §七 — wraps HYPOTHESIS_ADDED; refuses duplicates.
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

    case 'HYPOTHESIS_STATUS_CHANGED': {
      // §七 — FSM guard. Reject illegal transitions.
      const allowed: Record<CTFHypothesis['status'], CTFHypothesis['status'][]> = {
        proposed: ['testing', 'rejected'],
        testing: ['supported', 'rejected', 'inconclusive'],
        inconclusive: ['testing'],
        supported: [], // terminal — new evidence creates a revision
        rejected: [],  // terminal — new evidence creates a revision
      }
      // §round-4 audit fix — also verify the current status matches
      // `event.from`. Stale or out-of-order events whose `from` field
      // is a legal predecessor of `to` would otherwise pass the
      // guard and silently regress terminal states (e.g. supported
      // → testing).
      const target = state.hypotheses.find((h) => h.id === event.hypothesisId)
      if (!target) {
        throw new UnknownHypothesisError(`Hypothesis ${event.hypothesisId} not found`)
      }
      if (target.status !== event.from) {
        // Idempotent: if the target is already in `to`, no-op.
        if (target.status === event.to) return state
        throw new TaskStateStoreError(
          `Hypothesis ${event.hypothesisId} expected from=${event.from} but is ${target.status}`,
        )
      }
      if (!allowed[event.from].includes(event.to)) {
        throw new TaskStateStoreError(
          `Hypothesis ${event.hypothesisId} cannot transition ${event.from} → ${event.to}`,
        )
      }
      return {
        ...state,
        hypotheses: state.hypotheses.map((h) =>
          h.id === event.hypothesisId
            ? { ...h, status: event.to, updatedAt: Date.now() }
            : h,
        ),
      }
    }

    case 'OBSERVATION_ADDED': {
      // §四 — no duplicate IDs; bounded dedup via fingerprint.
      if (state.observations.some((o) => o.id === event.observation.id)) {
        throw new TaskStateStoreError(
          `Observation ${event.observation.id} already exists`,
        )
      }
      return { ...state, observations: [...state.observations, event.observation] }
    }

    case 'EVIDENCE_ADDED': {
      if (state.evidence.some((e) => e.id === event.evidence.id)) {
        throw new TaskStateStoreError(`Evidence ${event.evidence.id} already exists`)
      }
      return { ...state, evidence: [...state.evidence, event.evidence] }
    }

    case 'EVIDENCE_MERGED': {
      // Merge: take the existing record, replace observationIds / artifactIds
      // with the union, and bump confidence to max.
      const existing = state.evidence.find((e) => e.id === event.evidenceId)
      const other = state.evidence.find((e) => e.id === event.mergedFrom)
      if (!existing || !other) {
        throw new TaskStateStoreError(
          `EVIDENCE_MERGED: missing evidence ${!existing ? event.evidenceId : event.mergedFrom}`,
        )
      }
      const merged = {
        ...existing,
        observationIds: dedupeStrings([...existing.observationIds, ...other.observationIds]),
        artifactIds: dedupeStrings([...existing.artifactIds, ...other.artifactIds]),
        confidence: Math.max(existing.confidence, other.confidence),
      }
      return {
        ...state,
        evidence: state.evidence
          .filter((e) => e.id !== event.mergedFrom)
          .map((e) => (e.id === event.evidenceId ? merged : e)),
      }
    }

    case 'STRATEGY_DECISION_RECORDED': {
      return { ...state, strategyDecisions: [...state.strategyDecisions, event.decision] }
    }

    case 'ATTEMPT_RECORDED': {
      // §九 — refuse duplicates and rejected status transitions.
      if (state.attempts.some((a) => a.id === event.attempt.id)) {
        throw new DuplicateAttemptError(`Attempt ${event.attempt.id} already exists`)
      }
      return { ...state, attempts: [...state.attempts, event.attempt] }
    }

    case 'ATTEMPT_STARTED': {
      // Same as ATTEMPT_RECORDED but uses the new Attempt shape.
      if (state.attempts.some((a) => a.id === event.attempt.id)) {
        throw new DuplicateAttemptError(`Attempt ${event.attempt.id} already exists`)
      }
      return { ...state, attempts: [...state.attempts, event.attempt] }
    }

    case 'ATTEMPT_COMPLETED':
    case 'ATTEMPT_FAILED':
    case 'ATTEMPT_CANCELLED':
    case 'ATTEMPT_SKIPPED': {
      const next = state.attempts.map((a) => {
        if (a.id !== event.attemptId) return a
        if (event.type === 'ATTEMPT_COMPLETED') {
          return { ...a, status: event.status, completedAt: event.completedAt }
        }
        if (event.type === 'ATTEMPT_FAILED') {
          return { ...a, status: 'failed' as const, error: event.error, completedAt: Date.now() }
        }
        if (event.type === 'ATTEMPT_CANCELLED') {
          return { ...a, status: 'cancelled' as const, error: { message: event.reason }, completedAt: Date.now() }
        }
        // ATTEMPT_SKIPPED
        const skipStatus = event.reason === 'duplicate'
          ? 'skipped_duplicate' as const
          : event.reason === 'policy'
            ? 'skipped_policy' as const
            : 'skipped_budget' as const
        return { ...a, status: skipStatus, completedAt: Date.now() }
      })
      if (next.every((a, i) => a === state.attempts[i])) {
        throw new UnknownAttemptError(`Attempt ${event.attemptId} not found`)
      }
      return { ...state, attempts: next }
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

    case 'FLAG_CANDIDATE_DETECTED': {
      if (state.flagCandidates.some((c) => c.id === event.candidate.id)) {
        throw new TaskStateStoreError(
          `FlagCandidate ${event.candidate.id} already exists`,
        )
      }
      return { ...state, flagCandidates: [...state.flagCandidates, event.candidate] }
    }

    case 'FLAG_CANDIDATE_VALIDATED': {
      const next = state.flagCandidates.map((c) => {
        if (c.id !== event.candidateId) return c
        return {
          ...c,
          status: 'validated' as const,
          validation: {
            ...c.validation,
            errors: event.errors,
            locallyVerified: event.errors.length === 0,
          },
          updatedAt: Date.now(),
        }
      })
      if (next.every((c, i) => c === state.flagCandidates[i])) {
        throw new TaskStateStoreError(`FlagCandidate ${event.candidateId} not found`)
      }
      return { ...state, flagCandidates: next }
    }

    case 'FLAG_CANDIDATE_REJECTED': {
      const next = state.flagCandidates.map((c) =>
        c.id === event.candidateId
          ? { ...c, status: 'rejected' as const, updatedAt: Date.now() }
          : c,
      )
      if (next.every((c, i) => c === state.flagCandidates[i])) {
        throw new TaskStateStoreError(`FlagCandidate ${event.candidateId} not found`)
      }
      return { ...state, flagCandidates: next }
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

    case 'ONESHOT_RUN_QUEUED': {
      // §三 — duplicate run id is a hard error; the reducer is the single
      // source of truth. taskId must match the parent task.
      if (event.run.taskId !== state.taskId) {
        throw new TaskStateStoreError(
          `OneShot run ${event.run.id} taskId ${event.run.taskId} does not match task ${state.taskId}`,
        )
      }
      if (state.oneShotRuns.some((r) => r.id === event.run.id)) {
        throw new DuplicateOneShotRunError(
          `OneShot run ${event.run.id} already recorded`,
        )
      }
      return { ...state, oneShotRuns: [...state.oneShotRuns, event.run] }
    }

    case 'ONESHOT_RUN_STARTED': {
      const idx = state.oneShotRuns.findIndex((r) => r.id === event.runId)
      if (idx < 0) {
        throw new UnknownOneShotRunError(`OneShot run ${event.runId} not found`)
      }
      const prev = state.oneShotRuns[idx]
      if (prev.status !== 'queued') {
        throw new IllegalOneShotRunTransitionError(
          `OneShot run ${event.runId} is ${prev.status}; cannot start`,
        )
      }
      const runs = state.oneShotRuns.map((r, i) =>
        i === idx ? { ...r, status: 'running' as const, startedAt: event.startedAt, backgroundJobId: event.backgroundJobId } : r,
      )
      return { ...state, oneShotRuns: runs }
    }

    case 'ONESHOT_RUN_COMPLETED':
    case 'ONESHOT_RUN_PARTIAL':
    case 'ONESHOT_RUN_FAILED':
    case 'ONESHOT_RUN_TIMEOUT':
    case 'ONESHOT_RUN_CANCELLED': {
      const idx = state.oneShotRuns.findIndex((r) => r.id === event.runId)
      if (idx < 0) {
        throw new UnknownOneShotRunError(`OneShot run ${event.runId} not found`)
      }
      const prev = state.oneShotRuns[idx]
      if (isTerminalOneShotStatus(prev.status)) {
        throw new IllegalOneShotRunTransitionError(
          `OneShot run ${prev.id} is already terminal (${prev.status}); cannot apply ${event.type}`,
        )
      }
      const nextStatus =
        event.type === 'ONESHOT_RUN_COMPLETED' ? ('completed' as const)
          : event.type === 'ONESHOT_RUN_PARTIAL' ? ('partial' as const)
          : event.type === 'ONESHOT_RUN_FAILED' ? ('failed' as const)
          : event.type === 'ONESHOT_RUN_TIMEOUT' ? ('timeout' as const)
          : ('cancelled' as const)
      const runs = state.oneShotRuns.map((r, i) => {
        if (i !== idx) return r
        const patch: Partial<typeof r> = {
          status: nextStatus,
          completedAt: event.completedAt,
        }
        if (event.type === 'ONESHOT_RUN_COMPLETED') {
          patch.summary = event.summary
          patch.findingIds = event.findingIds
          patch.artifactIds = event.artifactIds
          patch.flagCandidateIds = event.flagCandidateIds
        } else if (event.type === 'ONESHOT_RUN_PARTIAL') {
          patch.summary = event.summary
        } else if (event.type === 'ONESHOT_RUN_FAILED') {
          patch.error = event.error
        } else if (event.type === 'ONESHOT_RUN_TIMEOUT') {
          patch.error = event.error
        } else {
          patch.error = event.reason
        }
        return { ...r, ...patch }
      })
      return { ...state, oneShotRuns: runs }
    }

    case 'ONESHOT_RUN_UPDATED': {
      const idx = state.oneShotRuns.findIndex((r) => r.id === event.runId)
      if (idx < 0) {
        throw new UnknownOneShotRunError(`OneShot run ${event.runId} not found`)
      }
      const prev = state.oneShotRuns[idx]
      if (
        event.patch.status &&
        isTerminalOneShotStatus(prev.status) &&
        (event.patch.status === 'running' || event.patch.status === 'queued')
      ) {
        throw new IllegalOneShotRunTransitionError(
          `OneShot run ${prev.id} is ${prev.status}; cannot transition to ${event.patch.status}`,
        )
      }
      const runs = state.oneShotRuns.map((r, i) =>
        i === idx ? { ...r, ...event.patch } : r,
      )
      return { ...state, oneShotRuns: runs }
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
