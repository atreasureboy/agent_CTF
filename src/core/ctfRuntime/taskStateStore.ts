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
  type CTFAttempt,
  type CTFHypothesis,
  type CTFTaskPhase,
  type CTFTaskState,
  type HandoffRecord,
} from './taskState.js'
import { combineIndependentConfidences } from '../ctfReasoning/evidence.js'
import type { CTFTaskEvent, TaskStateListener, Unsubscribe } from './taskEvents.js'
import type { Evidence } from '../ctfReasoning/evidence.js'
import { createInitialReasoningBudgetState } from '../ctfReasoning/reasoningBudget.js'

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

export interface StateListenerError {
  listenerId: string
  eventType: CTFTaskEvent['type']
  error: unknown
  timestamp: number
  critical: boolean
}

export interface StateStoreOptions {
  /** Hook for listener errors. Receives the StateListenerError. The
   *  default logs via console.warn when NODE_ENV !== 'test'. */
  onListenerError?: (err: StateListenerError) => void
}

/** Listeners can be tagged critical — when a critical listener
 *  throws, the store still applies the event but the orchestrator
 *  should observe and may mark the runtime as degraded. */
export interface TaggedListener {
  id: string
  critical?: boolean
  listener: TaskStateListener
}

export class CTFTaskStateStore {
  private state: CTFTaskState
  private readonly listeners = new Set<TaggedListener>()
  /** Monotonically increasing sequence number for subscribers to detect gaps. */
  private seq = 0
  /** Map<event-type, count> for diagnostics. */
  private readonly eventCounts = new Map<string, number>()
  /** Critical-listener failures observed so far (audit trail). */
  readonly listenerErrors: StateListenerError[] = []
  private readonly opts: StateStoreOptions
  /** When set, the store is considered degraded (a critical listener
   *  has failed). */
  private degraded = false

  constructor(initial: CTFTaskState, opts: StateStoreOptions = {}) {
    this.state = freezeState({
      ...initial,
      reasoningBudget: initial.reasoningBudget ?? createInitialReasoningBudgetState(),
    })
    this.opts = opts
  }

  getState(): Readonly<CTFTaskState> {
    return this.state
  }

  isDegraded(): boolean {
    return this.degraded
  }

  /** Diagnostic: how many of each event type have been applied. */
  getEventCounts(): Readonly<Record<string, number>> {
    return Object.fromEntries(this.eventCounts)
  }

  subscribe(listener: TaskStateListener, opts?: { id?: string; critical?: boolean }): Unsubscribe {
    const tagged: TaggedListener = {
      id: opts?.id ?? `lsn_${this.listeners.size + 1}`,
      listener,
      critical: opts?.critical,
    }
    this.listeners.add(tagged)
    return () => {
      this.listeners.delete(tagged)
    }
  }

  apply(event: CTFTaskEvent): Readonly<CTFTaskState> {
    this.guardAcceptsEvent(event)

    const next = reduce(this.state, event)
    this.state = freezeState({ ...next, updatedAt: Date.now() })
    this.seq++
    this.eventCounts.set(event.type, (this.eventCounts.get(event.type) ?? 0) + 1)

    for (const tagged of this.listeners) {
      try {
        tagged.listener(event, this.state)
      } catch (err) {
        // §十九 — listeners must NOT roll back the store. Errors are
        // surfaced via onListenerError and (for critical listeners)
        // mark the runtime degraded.
        const listenerErr: StateListenerError = {
          listenerId: tagged.id,
          eventType: event.type,
          error: err,
          timestamp: Date.now(),
          critical: !!tagged.critical,
        }
        this.listenerErrors.push(listenerErr)
        if (tagged.critical) this.degraded = true
        if (this.opts.onListenerError) {
          try {
            this.opts.onListenerError(listenerErr)
          } catch {
            /* handler failure is swallowed */
          }
        } else {
          // Default — log so the failure is visible in dev/test. Tests
          // can install their own onListenerError to assert.
          // eslint-disable-next-line no-console
          console.warn(
            `[CTFTaskStateStore] listener ${tagged.id} threw on ${event.type}:`,
            err,
          )
        }
      }
    }
    return this.state
  }

  /** §十三 — atomic Evidence upsert. Computes the fingerprint,
   *  applies EVIDENCE_UPSERTED, and returns the canonical
   *  evidenceId. */
  upsertEvidence(evidence: Evidence): { state: Readonly<CTFTaskState>; evidenceId: string; created: boolean } {
    const stateBefore = this.state
    this.apply({ type: 'EVIDENCE_UPSERTED', evidence, created: false })
    const stateAfter = this.state
    const existing = stateBefore.evidence.find((e) => e.fingerprint === evidence.fingerprint)
    return {
      state: stateAfter,
      evidenceId: existing?.id ?? evidence.id,
      created: !existing,
    }
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
        'PENDING_ACTION_ADDED',
        'PENDING_ACTION_STATUS_CHANGED',
        'REASONING_BUDGET_CONSUMED',
        'REASONING_FAILED',
        'FLAG_CANDIDATE_DETECTED',
        'FLAG_CANDIDATE_VALIDATED',
        'FLAG_CANDIDATE_REJECTED',
        'TASK_PAUSED',
        'TASK_RESUMED',
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
    if ((handoffTransitions as ReadonlyArray<CTFTaskEvent['type']>).includes(event.type)) {
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

const ATTEMPT_TERMINAL: ReadonlySet<CTFAttempt['status']> = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'skipped_duplicate',
  'skipped_policy',
  'skipped_budget',
])

function freezeState<T>(s: T): T {
  // §十八 — deep freeze the state tree. The reducer still returns
  // new objects so external mutation isn't possible. Tests that
  // mutated the state from getState() must now construct a fresh
  // state via `createTestTaskState` or by applying events.
  return deepFreeze(s, new WeakSet()) as T
}

function deepFreeze<T>(v: T, seen: WeakSet<object>): T {
  if (v === null || typeof v !== 'object') return v
  if (seen.has(v as unknown as object)) return v
  // Skip native objects that are not safe to freeze (AbortSignal, Date,
  // RegExp, Map, Set, Promise, Buffer, etc.). Recursing into them can
  // break invariants like the AbortController's internal kAborted flag.
  if (
    (typeof AbortSignal !== 'undefined' && v instanceof AbortSignal)
    || v instanceof Date
    || v instanceof RegExp
    || v instanceof Map
    || v instanceof Set
    || v instanceof Promise
    || v instanceof Error
    || (typeof Buffer !== 'undefined' && v instanceof Buffer)
    || v instanceof ArrayBuffer
  ) {
    return v
  }
  seen.add(v as unknown as object)
  if (Array.isArray(v)) {
    for (const item of v) deepFreeze(item, seen)
    return Object.freeze(v)
  }
  // Plain object — recurse.
  for (const k of Object.keys(v as Record<string, unknown>)) {
    deepFreeze((v as Record<string, unknown>)[k], seen)
  }
  return Object.freeze(v)
}

function reduce(state: CTFTaskState, event: CTFTaskEvent): CTFTaskState {
  return reduceInternal(state, event)
}

/** Public reducer for the replayer. */
export function reduceInternal(state: CTFTaskState, event: CTFTaskEvent): CTFTaskState {
  switch (event.type) {
    case 'TASK_CREATED':
      return event.initial

    case 'TASK_PAUSED': {
      // §borrow H1 — pause does not change state but is recorded
      // for audit. Future Strategy Cycles check this flag and skip
      // planning.
      return {
        ...state,
        diagnostics: [
          ...state.diagnostics,
          {
            kind: 'task_degraded',
            source: 'main-agent',
            message: `paused: ${event.reason}`,
            at: event.at,
          },
        ],
      }
    }

    case 'TASK_RESUMED': {
      return {
        ...state,
        diagnostics: [
          ...state.diagnostics,
          {
            kind: 'task_degraded',
            source: 'main-agent',
            message: `resumed: ${event.reason}`,
            at: event.at,
          },
        ],
      }
    }


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
      // §H4 — `status` MUST be changed via HYPOTHESIS_STATUS_CHANGED
      // so the FSM is enforced. Strip it from the patch payload here.
      const { status: _s, ...safePatch } = event.patch as { status?: unknown } & Record<string, unknown>
      const next = state.hypotheses.map((h) =>
        h.id === event.hypothesisId ? { ...h, ...safePatch, updatedAt: Date.now() } : h,
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

    case 'EVIDENCE_UPSERTED': {
      // §十三 — atomic upsert: if a record with the same fingerprint
      // exists, migrate the new source into it; otherwise create a new
      // record from the supplied Evidence.
      const incoming = event.evidence
      const existing = state.evidence.find((e) => e.fingerprint === incoming.fingerprint)
      if (existing) {
        const sources = [...existing.sources, ...incoming.sources]
        const combined = combineIndependentConfidences(sources)
        const merged = {
          ...existing,
          subject: existing.subject ?? incoming.subject,
          sources,
          confidence: combined,
          updatedAt: Date.now(),
        }
        return {
          ...state,
          evidence: state.evidence.map((e) => (e.id === existing.id ? merged : e)),
        }
      }
      return { ...state, evidence: [...state.evidence, incoming] }
    }

    case 'EVIDENCE_MERGED': {
      // §十五 — multi-source merge: union the sources and recompute
      // confidence via bounded 1−∏(1−c), capped at 0.99. Producer info
      // is preserved across sources so the audit can replay each
      // witness.
      const existing = state.evidence.find((e) => e.id === event.evidenceId)
      const other = state.evidence.find((e) => e.id === event.mergedFrom)
      if (!existing || !other) {
        throw new TaskStateStoreError(
          `EVIDENCE_MERGED: missing evidence ${!existing ? event.evidenceId : event.mergedFrom}`,
        )
      }
      const sources = [...existing.sources, ...other.sources]
      const combined = combineIndependentConfidences(sources)
      const merged = {
        ...existing,
        subject: existing.subject ?? other.subject,
        sources,
        confidence: combined,
        updatedAt: Date.now(),
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

    case 'PENDING_ACTION_ADDED': {
      // §二十二 — pending actions are deduplicated by id (fingerprint).
      if (state.pendingActions.some((p) => p.id === event.pending.id)) return state
      return { ...state, pendingActions: [...state.pendingActions, event.pending] }
    }

    case 'PENDING_ACTION_STATUS_CHANGED': {
      const next = state.pendingActions.map((p) =>
        p.id === event.pendingId ? { ...p, status: event.status, updatedAt: event.at } : p,
      )
      if (next.every((p, i) => p === state.pendingActions[i])) return state
      return { ...state, pendingActions: next }
    }

    case 'REASONING_BUDGET_CONSUMED': {
      return { ...state, reasoningBudget: event.snapshot }
    }

    case 'REASONING_FAILED': {
      // §六 / Audit-C1 — reasoning failure is a structured event
      // recorded into TaskState. The runtime's degraded flag is
      // always flipped; downstream subsystems can observe the event.
      return {
        ...state,
        diagnostics: [
          ...state.diagnostics,
          {
            kind: 'reasoning_failed',
            source: event.source,
            attemptId: event.attemptId,
            runId: event.runId,
            message: event.error.message,
            at: event.at,
          },
        ],
        degraded: true,
      }
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

    case 'ATTEMPT_COMPLETED': {
      const next = state.attempts.map((a) => {
        if (a.id !== event.attemptId) return a
        // §五 — ATTEMPT_COMPLETED writes the produced ids once.
        // Re-completing a terminal attempt is rejected.
        if (a.status === 'succeeded' || a.status === 'failed' || a.status === 'cancelled'
          || a.status === 'skipped_duplicate' || a.status === 'skipped_policy'
          || a.status === 'skipped_budget') {
          throw new IllegalAttemptTransitionError(
            `Attempt ${a.id} is already terminal (${a.status}); cannot apply ATTEMPT_COMPLETED.`,
          )
        }
        return {
          ...a,
          status: event.status,
          observationIds: dedupeStrings([...a.observationIds, ...event.observationIds]),
          evidenceIds: dedupeStrings([...a.evidenceIds, ...event.evidenceIds]),
          artifactIds: dedupeStrings([...a.artifactIds, ...event.artifactIds]),
          flagCandidateIds: dedupeStrings([...a.flagCandidateIds, ...event.flagCandidateIds]),
          completedAt: event.completedAt,
        }
      })
      if (next.every((a, i) => a === state.attempts[i])) {
        throw new UnknownAttemptError(`Attempt ${event.attemptId} not found`)
      }
      return { ...state, attempts: next }
    }

    case 'ATTEMPT_FAILED': {
      const next = state.attempts.map((a) => {
        if (a.id !== event.attemptId) return a
        if (a.status === 'succeeded' || a.status === 'failed' || a.status === 'cancelled'
          || a.status === 'skipped_duplicate' || a.status === 'skipped_policy'
          || a.status === 'skipped_budget') {
          throw new IllegalAttemptTransitionError(
            `Attempt ${a.id} is already terminal (${a.status}); cannot apply ATTEMPT_FAILED.`,
          )
        }
        return {
          ...a,
          status: 'failed' as const,
          error: event.error,
          observationIds: dedupeStrings([...a.observationIds, ...event.observationIds]),
          evidenceIds: dedupeStrings([...a.evidenceIds, ...event.evidenceIds]),
          completedAt: event.completedAt,
        }
      })
      if (next.every((a, i) => a === state.attempts[i])) {
        throw new UnknownAttemptError(`Attempt ${event.attemptId} not found`)
      }
      return { ...state, attempts: next }
    }

    case 'ATTEMPT_CANCELLED': {
      const next = state.attempts.map((a) => {
        if (a.id !== event.attemptId) return a
        if (ATTEMPT_TERMINAL.has(a.status)) {
          throw new IllegalAttemptTransitionError(
            `Attempt ${a.id} is already terminal (${a.status}); cannot apply ATTEMPT_CANCELLED.`,
          )
        }
        return {
          ...a,
          status: 'cancelled' as const,
          error: { message: event.reason },
          completedAt: event.completedAt,
        }
      })
      if (next.every((a, i) => a === state.attempts[i])) {
        throw new UnknownAttemptError(`Attempt ${event.attemptId} not found`)
      }
      return { ...state, attempts: next }
    }

    case 'ATTEMPT_SKIPPED': {
      const next = state.attempts.map((a) => {
        if (a.id !== event.attemptId) return a
        if (ATTEMPT_TERMINAL.has(a.status)) {
          throw new IllegalAttemptTransitionError(
            `Attempt ${a.id} is already terminal (${a.status}); cannot apply ATTEMPT_SKIPPED.`,
          )
        }
        const skipStatus = event.reason === 'duplicate'
          ? 'skipped_duplicate' as const
          : event.reason === 'policy' || event.reason === 'profile' || event.reason === 'scope' || event.reason === 'unavailable' || event.reason === 'approval'
            ? 'skipped_policy' as const
            : 'skipped_budget' as const
        return { ...a, status: skipStatus, completedAt: event.completedAt }
      })
      if (next.every((a, i) => a === state.attempts[i])) {
        throw new UnknownAttemptError(`Attempt ${event.attemptId} not found`)
      }
      return { ...state, attempts: next }
    }

    case 'ATTEMPT_UPDATED': {
      const next = state.attempts.map((a) => {
        if (a.id !== event.attemptId) return a
        // §H4 — patch cannot move a terminal attempt back to
        // running/pending. ALL 6 terminal statuses are guarded.
        if (
          ATTEMPT_TERMINAL.has(a.status) &&
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
      // §十八 — shallow-clone so the caller's local copy remains
      // mutable; deepFreeze will lock down the store's copy only.
      return { ...state, oneShotRuns: [...state.oneShotRuns, { ...event.run }] }
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
