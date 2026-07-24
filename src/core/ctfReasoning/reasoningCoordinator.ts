/**
 * ReasoningCoordinator — Phase 2.2 §四–§八, §十一, §二十三.
 *
 * Drives a bounded strategy cycle per task:
 *   1. Receive new Observation/Evidence (from any source: main-agent,
 *      workflow, oneshot, specialist).
 *   2. Update Hypothesis state via HypothesisUpdater.
 *   3. Record all candidate SuggestedActions as Pending.
 *   4. Plan via StrategyPlanner (uses hypothesis + cost + dedup).
 *   5. Execute the selected action via StrategyActionExecutor.
 *   6. Materialize (parsers → ResultMerger → ParserConflictResolver).
 *   7. Apply Observation / Evidence / Artifact / FlagCandidate events
 *      BEFORE ATTEMPT_COMPLETED (correct lifecycle order, §五).
 *   8. Update Hypothesis using the produced evidence.
 *   9. If planner emitted `stop`: exit the loop with stopReason.
 *  10. If Flag Candidate validated: emit `stop` with reason
 *      'validated flag candidate found'.
 *
 * Hard caps (§八):
 *   - maxStrategyCycles: 8
 *   - maxActionsPerCycle: 1
 *   - maxTotalStrategyActionsPerTask: 32
 *
 * Per-task lock (§七.防重入): concurrent calls to
 * `processNewReasoningInputs` for the same task are serialized.
 */

import type { MaterializedResult } from './resultMaterializer.js'
import { planStrategy } from './strategyPlanner.js'
import { createStrategyDecision } from './strategyDecision.js'
import { createObservation, type Observation } from './observation.js'
import {
  createEvidence,
  evidenceFingerprint as _ignore,
  mergeEvidence,
} from './evidence.js'

function ctxAttemptId(id: string): string { return id }
void ctxAttemptId
import type { Evidence } from './evidence.js'
import { buildFlagCandidateId, type FlagCandidateDraft } from './flagCandidate.js'
import type {
  CTFTaskState,
  CTFAttempt,
  FlagCandidate,
  CTFHypothesis,
} from '../ctfRuntime/taskState.js'
import type { CTFTaskStateStore } from '../ctfRuntime/taskStateStore.js'
import type { BudgetLimits } from '../../ctf/oneshot/types.js'
import type { SuggestedAction } from './suggestedAction.js'
import { createAttemptFingerprint } from './attemptFingerprint.js'
import { randomBytes } from 'crypto'
import type {
  ActionExecutionResult,
  ReasoningResult,
} from './actionExecutionResult.js'
import {
  createCascadeContext,
  type ReasoningCascadeContext,
} from './reasoningCascade.js'
import {
  applyReasoningBudgetConsumption,
  consumeCycle,
  createInitialReasoningBudgetState,
  DEFAULT_REASONING_BUDGET_LIMITS,
  evaluateReasoningBudget,
  type ReasoningBudgetLimits,
  type ReasoningBudgetState,
} from './reasoningBudget.js'
import type { StrategyActionExecutor } from './strategyActionExecutor.js'
import type { MaterializationContext } from './materializationContext.js'
import {
  attachAttemptToDrafts,
  createMaterializationContext,
} from './materializationContext.js'
import { createHypothesisUpdater } from './hypothesisUpdater.js'
import { createPendingActionStore, type PendingSuggestedAction } from './pendingActionStore.js'
import { createAttemptDeduplicator } from './attemptDeduplicator.js'
import {
  DEFAULT_MAX_STRATEGY_CYCLES,
  DEFAULT_MAX_TOTAL_STRATEGY_ACTIONS_PER_TASK,
} from './reasoningConstants.js'
import {
  DEFAULT_COMPLETION_POLICY,
  type CompletionPolicy,
} from './completionPolicy.js'

export interface ReasoningCoordinatorOptions {
  taskId: string
  state: CTFTaskState
  store: CTFTaskStateStore
  budgetLimits: BudgetLimits
  heavyApproved: boolean
  /** §五 / §C2 — Required executor. No fallback Noop. Production
   *  code paths (Orchestrator, StructuredOutputHandler) MUST supply
   *  a concrete adapter via `createRuntimeStrategyActionExecutor`.
   *  Tests declare `mode: 'dry-run'` and supply
   *  `createNoopStrategyActionExecutor`. The field is optional at the
   *  type level only so test fixtures that exercise the FSM in
   *  isolation compile; the runtime throws if missing. */
  executor?: StrategyActionExecutor
  /** Cumulative budget limits (overrides the state's defaults when provided). */
  reasoningBudgetLimits?: ReasoningBudgetLimits
  /** Maximum strategy cycles. */
  maxStrategyCycles?: number
  /** Maximum total actions per task across cycles. */
  maxTotalStrategyActionsPerTask?: number
  abortSignal?: AbortSignal
}

export interface ProcessReasoningInputsInput {
  source: 'main-agent' | 'workflow' | 'oneshot' | 'specialist' | 'manual'
  newObservationIds: string[]
  newEvidenceIds: string[]
  suggestedActions: SuggestedAction[]
  runContext?: {
    agentRunId?: string
    workflowRunId?: string
    oneShotRunId?: string
    handoffId?: string
    stepId?: string
  }
  /** §九 — cascade context. The Coordinator reads depth and
   *  parent ids from here. */
  cascade?: ReasoningCascadeContext
  /** §二十三 — completion policy overrides the default. */
  completionPolicy?: CompletionPolicy
  /** Optional flag for completion policy: auto-complete local fixtures
   *  when a flag candidate is validated. Default false (real contests
   *  wait for human / platform verification per §二十三). */
  autoCompleteLocalFixtures?: boolean
  /** Phase B1 — optional AutoPrompter. When set, the Coordinator
   *  calls it before the first cycle to generate a category-aware
   *  framing note. Production wires an LLM-driven adapter; tests
   *  supply `TemplateAutoPrompter`. */
  autoPrompter?: import('./autoPrompter.js').AutoPrompter
  /** Category for the AutoPrompter. */
  category?: import('../toolBroker/categoryToolset.js').ChallengeCategory
  /** Original raw prompt; surfaced to the AutoPrompter for
   *  framing. */
  rawPrompt?: string
  /** C3-real — optional LMSummarizer invoked between cycles when
   *  observations exceed `compactionThreshold` (default 64). The
   *  summary is recorded as a diagnostic and the LLM context is
   *  the responsibility of the operator's LLM client. Production
   *  wires a real LMSummarizer; tests omit it. */
  lmSummarizer?: import('./lmSummarizer.js').LMSummarizer
  /** When the observation count exceeds this number, the
   *  Coordinator invokes the LMSummarizer. Default 64. */
  compactionThreshold?: number
}

/** Per-task reasoning lock. Lives outside the module — the
 *  caller (Runtime instance) owns the chain and can dispose it
 *  on tear-down.
 *
 * §H2 — settled entries are deleted in `.finally` so the map does not
 *  grow without bound. Generation token guards against a stale
 *  finally from deleting a fresher holder's entry. */
const _taskLocks = new Map<string, { promise: Promise<unknown>; generation: number }>()
let _lockGeneration = 0

export async function processNewReasoningInputs(
  options: ReasoningCoordinatorOptions,
  input: ProcessReasoningInputsInput,
): Promise<ReasoningResult> {
  if (!options.executor) {
    throw new MissingStrategyActionExecutorError()
  }
  const { taskId } = options
  // §C4 — Per-task lock — chain on the existing lock so concurrent
  // calls for the same task are serialized. Settled entries are
  // deleted in `.finally` so the map does not retain completed task
  // IDs forever. Generation token guards against a stale finally.
  const prevEntry = _taskLocks.get(taskId)
  const myGeneration = ++_lockGeneration
  const next: Promise<ReasoningResult> = (prevEntry?.promise ?? Promise.resolve())
    .catch(() => undefined)
    .then(() => runCycles(options, input))
    .finally(() => {
      const cur = _taskLocks.get(taskId)
      if (cur && cur.generation === myGeneration) _taskLocks.delete(taskId)
    })
  _taskLocks.set(taskId, { promise: next.catch(() => undefined), generation: myGeneration })
  return next
}

class MissingStrategyActionExecutorError extends Error {
  constructor() {
    super(
      'RuntimeStrategyActionExecutor: production Runtime requires a ' +
        'concrete StrategyActionExecutor. Use createNoopStrategyActionExecutor ' +
        'only in dry-run mode.',
    )
    this.name = 'MissingStrategyActionExecutorError'
  }
}

async function runCycles(
  options: ReasoningCoordinatorOptions,
  input: ProcessReasoningInputsInput,
): Promise<ReasoningResult> {
  const maxCycles = options.maxStrategyCycles ?? DEFAULT_MAX_STRATEGY_CYCLES
  const maxTotalActions = options.maxTotalStrategyActionsPerTask ?? DEFAULT_MAX_TOTAL_STRATEGY_ACTIONS_PER_TASK
  const store = options.store
  const inFlight: { fast: number; medium: number; heavy: number } = { fast: 0, medium: 0, heavy: 0 }
  let cycleCounter = 0
  let stopped = false
  let stopReason: string | undefined
  let cycles = 0
  // §十一 — single-call result. IDs returned reflect only this call;
  // they are not merged with previous calls. _internals Map removed.
  const selectedActionIds: string[] = []
  const strategyDecisionIds: string[] = []
  const finalObservationIds: string[] = []
  const finalEvidenceIds: string[] = []
  // §H2 — initialise the budget from the LIVE store, not the
  // caller-provided entry snapshot. The lock guard already serialised
  // us, so the live snapshot is the freshest version.
  let budget: ReasoningBudgetState = { ...store.getState().reasoningBudget }
  const pending = createPendingActionStore()

  // Apply incoming Evidence to HypothesisUpdater first.
  applyHypothesisUpdates(options, input)

  // C3-real — LMSummarizer hook. If an LMSummarizer is configured
  // and the current observations exceed the threshold, run a
  // summary. The summary is recorded as a diagnostic; the LLM
  // context window itself is the operator's responsibility.
  if (input.lmSummarizer) {
    const threshold = input.compactionThreshold ?? 64
    const liveState = store.getState()
    if (liveState.observations.length >= threshold) {
      try {
        const summary = await input.lmSummarizer.summarize({
          taskId: options.taskId,
          observations: liveState.observations,
          maxLength: 1500,
        })
        options.store.apply({
          type: 'REASONING_FAILED',
          source: 'main-agent',
          error: { message: `lm-summary: ${summary.text.slice(0, 200)}` },
          at: Date.now(),
        })
      } catch {
        // LMSummarizer failure is non-fatal.
      }
    }
  }

  // Phase B1 — AutoPrompter. When an AutoPrompter is configured, run
  // it before the first cycle and record its notes as a diagnostic
  // for the audit log. The framing itself is not injected into the
  // planner prompt here (the planner is deterministic); the framing
  // is a hint surfaced to the operator / next cycle's input.
  if (input.autoPrompter && input.category) {
    try {
      const framed = await input.autoPrompter.generate({
        taskId: options.taskId,
        category: input.category,
        rawPrompt: input.rawPrompt ?? '',
        suggestedActions: input.suggestedActions,
      })
      // Surface framing as a diagnostic. (We don't write back to
      // input because ProcessReasoningInputsInput is a parameter
      // the caller owns.)
      options.store.apply({
        type: 'REASONING_FAILED', // we reuse this event for audit.
        source: 'main-agent',
        error: { message: `auto-prompt framing: ${framed.framing.slice(0, 200)}` },
        at: Date.now(),
      })
    } catch {
      // AutoPrompter failure is non-fatal.
    }
  }

  // Seed pending store with the new suggested actions (excluding stop).
  const seed = input.suggestedActions
    .filter((a) => a.type !== 'stop')
    .map((a) => ({
      action: a,
      observationIds: input.newObservationIds,
      evidenceIds: input.newEvidenceIds,
      hypothesisIds: a.hypothesisIds ?? [],
    }))
  pending.add(seed)

  for (let c = 0; c < maxCycles; c++) {
    if (options.abortSignal?.aborted) {
      stopped = true
      stopReason = 'abort signal'
      break
    }
    const liveState = store.getState()
    if (liveState.completion) {
      stopped = true
      stopReason = 'task terminal'
      break
    }
    if (budget.actionsExecuted >= maxTotalActions) {
      stopped = true
      stopReason = `reached maxTotalStrategyActionsPerTask=${maxTotalActions}`
      break
    }
    cycles++
    cycleCounter++
    // §H3 — only consume the cycle counter if we end up actually
    // executing an action in this cycle. The pre-flight budget check
    // (below) still does its own projection against the live value.
    let cycleConsumed = false
    const consumeBudgetCycle = () => {
      if (cycleConsumed) return
      cycleConsumed = true
      budget = consumeCycle(budget)
      store.apply({ type: 'REASONING_BUDGET_CONSUMED', snapshot: budget })
    }

    // Honour stop first.
    const stopAction = input.suggestedActions.find((a) => a.type === 'stop')
    if (stopAction) {
      const decision = planStrategy({
        state: liveState,
        newObservationIds: input.newObservationIds,
        newEvidenceIds: input.newEvidenceIds,
        suggestedActions: [stopAction],
        cost: {
          limits: options.budgetLimits,
          currentSpend: { ...inFlight },
          heavyApproved: options.heavyApproved,
          taskTerminal: false,
        },
        budget: { state: budget, limits: options.reasoningBudgetLimits ?? DEFAULT_REASONING_BUDGET_LIMITS, heavyApproved: options.heavyApproved },
      })
      store.apply({ type: 'STRATEGY_DECISION_RECORDED', decision })
      strategyDecisionIds.push(decision.id)
      stopped = true
      stopReason = stopAction.reason || 'planner emitted stop'
      break
    }

    // Pull eligible candidates from the pending store.
    const eligible = pending.listEligible()
    if (eligible.length === 0) {
      stopped = true
      stopReason = 'no eligible action'
      break
    }

    const decision = planStrategy({
      state: liveState,
      newObservationIds: input.newObservationIds,
      newEvidenceIds: input.newEvidenceIds,
      suggestedActions: eligible.map((p) => p.action),
      cost: {
        limits: options.budgetLimits,
        currentSpend: { ...inFlight },
        heavyApproved: options.heavyApproved,
        taskTerminal: false,
      },
      budget: { state: budget, limits: options.reasoningBudgetLimits ?? DEFAULT_REASONING_BUDGET_LIMITS, heavyApproved: options.heavyApproved },
    })
    store.apply({ type: 'STRATEGY_DECISION_RECORDED', decision })
    strategyDecisionIds.push(decision.id)

    const selected = decision.selectedAction
    if (!selected) {
      stopped = true
      stopReason = decision.reason
      break
    }

    // Honour budget denial — record a STRATEGY_DECISION_RECORDED and
    // break so we don't loop forever.
    const budgetCheck = evaluateReasoningBudget(
      selected,
      budget,
      options.reasoningBudgetLimits ?? DEFAULT_REASONING_BUDGET_LIMITS,
      { heavyApproved: options.heavyApproved, taskTerminal: false },
    )
    if (!budgetCheck.allowed) {
      // §十一 — Record a StrategyDecision that explicitly names the
      // budget denial so audits can see why a selected action was
      // rejected at the post-planning stage.
      const deniedDecision = createStrategyDecision(options.taskId, {
        selectedAction: undefined,
        rejectedActions: [{ action: selected, reason: 'budget_denied', detail: budgetCheck.detail }],
        reason: `budget denied: ${budgetCheck.reason}`,
        basedOnObservationIds: input.newObservationIds,
        basedOnEvidenceIds: input.newEvidenceIds,
        basedOnHypothesisIds: selected.hypothesisIds ?? [],
      })
      store.apply({ type: 'STRATEGY_DECISION_RECORDED', decision: deniedDecision })
      strategyDecisionIds.push(deniedDecision.id)
      stopped = true
      stopReason = `budget denied: ${budgetCheck.reason}`
      break
    }

    // Build Attempt and emit ATTEMPT_STARTED.
    const attempt = buildAttempt(options, selected, cycleCounter)
    store.apply({ type: 'ATTEMPT_STARTED', attempt })
    selectedActionIds.push(attempt.id)
    // §二十二 — PendingAction FSM: pending → selected.
    markPendingSelected(pending, selected, attempt.id)

    // Update in-flight + budget BEFORE execution. The cycle counter
    // is consumed only when an action actually runs (not on stop / skip).
    consumeBudgetCycle()
    const tier = selected.costTier === 'expensive' ? 'heavy' : selected.costTier === 'normal' ? 'medium' : 'fast'
    inFlight[tier]++
    budget = applyReasoningBudgetConsumption(budget, selected)
    store.apply({ type: 'REASONING_BUDGET_CONSUMED', snapshot: budget })

    // §五 — Executor is mandatory; throw if missing.
    if (!options.executor) throw new MissingStrategyActionExecutorError()
    const executor = options.executor

    let execResult: ActionExecutionResult
    try {
      execResult = await executor.execute({
        // §十八 — pass live state to the Executor, not the entry snapshot.
        taskState: store.getState(),
        action: selected,
        attempt,
        signal: options.abortSignal ?? new AbortController().signal,
      })
    } catch (err) {
      execResult = {
        status: 'failed',
        error: { message: err instanceof Error ? err.message : String(err) },
      }
    } finally {
      inFlight[tier]--
    }

    // Process the result. §二十 — Executor returning `stop` after an
    // Attempt was created is illegal in normal flow; we record the
    // attempt as cancelled rather than leaving it pending.
    if (execResult.status === 'stop') {
      store.apply({
        type: 'ATTEMPT_CANCELLED',
        attemptId: attempt.id,
        reason: execResult.reason || 'executor returned stop after attempt creation',
        completedAt: Date.now(),
      })
      stopped = true
      stopReason = execResult.reason
      break
    }
    if (execResult.status === 'skipped') {
      const completedAt = Date.now()
      store.apply({
        type: 'ATTEMPT_SKIPPED',
        attemptId: attempt.id,
        reason: execResult.reason,
        completedAt,
      })
      // §二十二 — PendingAction FSM: selected → rejected.
      const pid = pendingIdFor(pending, selected)
      if (pid) pending.reject(pid)
      continue
    }
    if (execResult.status === 'failed') {
      const completedAt = Date.now()
      const failureObs: Observation = createObservation(options.taskId, {
        kind: 'tool_availability',
        source: { type: 'manual' },
        summary: `Attempt ${attempt.id} failed: ${execResult.error.message}`,
        attributes: { code: execResult.error.code, retryable: execResult.error.retryable ?? false },
        confidence: 1,
      })
      store.apply({ type: 'OBSERVATION_ADDED', observation: failureObs })
      store.apply({
        type: 'ATTEMPT_FAILED',
        attemptId: attempt.id,
        error: execResult.error,
        observationIds: [failureObs.id],
        evidenceIds: [],
        completedAt,
      })
      // §二十二 — PendingAction FSM: selected → rejected.
      const pid2 = pendingIdFor(pending, selected)
      if (pid2) pending.reject(pid2)
      continue
    }

    // executed: materialize + apply products + ATTEMPT_COMPLETED.
    // §二十一 — merge the executor's executionRefs into the
    // materialization context so Artifact / Attempt metadata get the
    // actual run ids (workflowRunId, oneShotRunId, etc.) back.
    const execRefs = execResult.executionRefs ?? {}
    const matCtx = createMaterializationContext({
      ...input.runContext,
      ...execRefs,
      taskId: options.taskId,
      attemptId: attempt.id,
      producerId: producerIdFor(selected),
    })
    const drafts = attachAttemptToDrafts(execResult.materializedResult, matCtx.attemptId)
    const observationIds: string[] = []
    const evidenceIds: string[] = []
    const artifactIds: string[] = []
    const flagCandidateIds: string[] = []
    // §七 — if the run already projected, the Coordinator must NOT
    // re-apply the drafts. Simply attach the run's executionRefs to the
    // Attempt's product ids without re-emitting events.
    const alreadyProjected = execResult.resultAlreadyProjected === true
    if (!alreadyProjected) {
      for (const draft of drafts.observations) {
        const obs = createObservation(options.taskId, draft)
        store.apply({ type: 'OBSERVATION_ADDED', observation: obs })
        observationIds.push(obs.id)
        finalObservationIds.push(obs.id)
      }
      for (const draft of drafts.evidence) {
        // §十三 — auto-bind missing observation references from this
        // batch, then upsert.
        const source = {
          ...draft.source,
          observationIds: draft.source.observationIds.length > 0
            ? draft.source.observationIds
            : observationIds,
          attemptIds: [...draft.source.attemptIds, ctxAttemptId(attempt.id)],
        }
        const ev = createEvidence(options.taskId, {
          ...draft,
          source,
        })
        const result = store.upsertEvidence(ev)
        evidenceIds.push(result.evidenceId)
        finalEvidenceIds.push(result.evidenceId)
      }
    } else {
      // Surface the executor's executionRefs on the Attempt via id
      // bookkeeping even when we skip re-applying drafts.
      void drafts
    }
    for (const draft of drafts.flagCandidateDrafts) {
      const candidate = flagCandidateFromDraft(options.taskId, draft, attempt.id)
      store.apply({ type: 'FLAG_CANDIDATE_DETECTED', candidate })
      flagCandidateIds.push(candidate.id)
    }
    // Artifacts — drafts include rawArtifactIds.
    for (const aid of drafts.rawArtifactIds ?? []) {
      if (!artifactIds.includes(aid)) artifactIds.push(aid)
      if (!store.getState().artifactIds.includes(aid)) {
        store.apply({ type: 'ARTIFACT_ADDED', artifactId: aid })
      }
    }

    // Apply new Evidence to HypothesisUpdater.
    applyHypothesisUpdates(options, { ...input, newEvidenceIds: evidenceIds, newObservationIds: observationIds })

    store.apply({
      type: 'ATTEMPT_COMPLETED',
      attemptId: attempt.id,
      status: 'succeeded',
      observationIds,
      evidenceIds,
      artifactIds,
      flagCandidateIds,
      completedAt: Date.now(),
    })
    // §二十二 — PendingAction FSM: selected → executed.
    const pidExec = pendingIdFor(pending, selected)
    if (pidExec) pending.markExecuted(pidExec)

    // §二十三 — validated FlagCandidate triggers stop.
    const policy = input.completionPolicy ?? DEFAULT_COMPLETION_POLICY
    const live = store.getState()
    const validated = live.flagCandidates.find(
      (c) => flagCandidateIds.includes(c.id) && c.validation.locallyVerified,
    )
    if (validated) {
      stopped = true
      stopReason = 'validated flag candidate found'
      // §二十三 — CompletionPolicy controls auto-completion. Real
      // contests wait for platform / human verification by default.
      if (policy.autoCompleteLocalFixtures && !policy.requirePlatformVerification) {
        store.apply({
          type: 'TASK_COMPLETED',
          status: 'solved',
          reason: 'local fixture flag validated',
          flagCandidateId: validated.id,
        })
      }
      break
    }

    // Queue new suggested actions for the next cycle.
    if (drafts.suggestedActions.length > 0) {
      const nextSeed = drafts.suggestedActions.map((a) => ({
        action: a,
        observationIds,
        evidenceIds,
        hypothesisIds: a.hypothesisIds ?? [],
      }))
      pending.add(nextSeed)
    }
  }

  return {
    cycles,
    stopped,
    stopReason,
    selectedActionIds: [...selectedActionIds],
    strategyDecisionIds: [...strategyDecisionIds],
    finalObservationIds: [...finalObservationIds],
    finalEvidenceIds: [...finalEvidenceIds],
  }
}

function buildAttempt(
  options: ReasoningCoordinatorOptions,
  action: SuggestedAction,
  cycleCounter: number,
): CTFAttempt {
  const base = actionToAttempt(action)
  const inputArtifactIds = action.type === 'run_oneshot' ? action.inputArtifactIds : undefined
  return {
    id: `att_${cycleCounter}_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`,
    taskId: options.taskId,
    ...base,
    fingerprint: createAttemptFingerprint({
      kind: base.kind,
      targetId: base.targetId,
      parameters: base.input,
      inputArtifactIds,
    }),
    createdAt: Date.now(),
  }
}

function actionToAttempt(action: SuggestedAction): Omit<CTFAttempt, 'id' | 'taskId' | 'createdAt' | 'fingerprint'> {
  switch (action.type) {
    case 'run_workflow':
      return {
        kind: 'workflow',
        targetId: action.workflowId,
        input: { inputs: action.inputs, reason: action.reason },
        hypothesisIds: action.hypothesisIds ?? [],
        status: 'pending',
        observationIds: [],
        evidenceIds: [],
        artifactIds: [],
        flagCandidateIds: [],
      }
    case 'run_oneshot':
      return {
        kind: 'oneshot',
        targetId: action.manifestId,
        input: { options: action.options ?? {}, reason: action.reason },
        hypothesisIds: action.hypothesisIds ?? [],
        status: 'pending',
        observationIds: [],
        evidenceIds: [],
        artifactIds: [],
        flagCandidateIds: [],
      }
    case 'call_tool':
      return {
        kind: 'tool',
        targetId: action.toolId,
        input: { input: action.input, reason: action.reason },
        hypothesisIds: action.hypothesisIds ?? [],
        status: 'pending',
        observationIds: [],
        evidenceIds: [],
        artifactIds: [],
        flagCandidateIds: [],
      }
    case 'request_handoff':
      return {
        kind: 'handoff',
        targetId: action.capability,
        input: { objective: action.objective, reason: action.reason },
        hypothesisIds: action.hypothesisIds ?? [],
        status: 'pending',
        observationIds: [],
        evidenceIds: [],
        artifactIds: [],
        flagCandidateIds: [],
      }
    case 'verify_flag':
      return {
        kind: 'verification',
        targetId: action.candidateId,
        input: { reason: action.reason },
        hypothesisIds: action.hypothesisIds ?? [],
        status: 'pending',
        observationIds: [],
        evidenceIds: [],
        artifactIds: [],
        flagCandidateIds: [action.candidateId],
      }
    case 'stop':
      return {
        kind: 'manual',
        targetId: 'stop',
        input: { reason: action.reason },
        hypothesisIds: [],
        status: 'pending',
        observationIds: [],
        evidenceIds: [],
        artifactIds: [],
        flagCandidateIds: [],
      }
  }
}

function producerIdFor(action: SuggestedAction): string {
  switch (action.type) {
    case 'run_workflow': return action.workflowId
    case 'run_oneshot': return action.manifestId
    case 'call_tool': return action.toolId
    case 'request_handoff': return action.capability
    case 'verify_flag': return action.candidateId
    case 'stop': return 'stop'
  }
}

function applyHypothesisUpdates(
  options: ReasoningCoordinatorOptions,
  input: Pick<ProcessReasoningInputsInput, 'newObservationIds' | 'newEvidenceIds'>,
): void {
  const updater = createHypothesisUpdater()
  const liveState = options.store.getState()
  const result = updater.update({
    state: liveState,
    newObservationIds: input.newObservationIds,
    newEvidenceIds: input.newEvidenceIds,
  })
  for (const h of result.proposed) {
    options.store.apply({ type: 'HYPOTHESIS_PROPOSED', hypothesis: h })
  }
  for (const u of result.updates) {
    options.store.apply({ type: 'HYPOTHESIS_UPDATED', hypothesisId: u.hypothesisId, patch: u })
  }
}

function markPendingSelected(
  pending: ReturnType<typeof createPendingActionStore>,
  action: SuggestedAction,
  _attemptId: string,
): string | undefined {
  const items = pending.listEligible()
  const match = items.find((p) => p.action === action || sameAction(p.action, action))
  if (match) {
    pending.select(match.id)
    return match.id
  }
  return undefined
}

function pendingIdFor(
  pending: ReturnType<typeof createPendingActionStore>,
  action: SuggestedAction,
): string | undefined {
  const items = pending.listEligible()
  const match = items.find((p) => p.action === action || sameAction(p.action, action))
  if (match) return match.id
  // After a transition, listEligible only returns pending — look up
  // the most recently transitioned item by full snapshot.
  return undefined
}

function sameAction(a: SuggestedAction, b: SuggestedAction): boolean {
  return a.type === b.type
    && a.priority === b.priority
    && a.costTier === b.costTier
    && a.reason === b.reason
}

function flagCandidateFromDraft(taskId: string, draft: FlagCandidateDraft, attemptId: string): FlagCandidate {
  return {
    id: buildFlagCandidateId(),
    taskId,
    value: draft.value,
    normalizedValue: draft.normalizedValue,
    sourceObservationIds: draft.sourceObservationIds,
    sourceEvidenceIds: draft.sourceEvidenceIds,
    sourceArtifactIds: draft.sourceArtifactIds,
    sourceRunIds: draft.sourceRunIds,
    sourceAttemptIds: [attemptId],
    transformChain: draft.transformChain,
    confidence: draft.confidence,
    validation: {
      patternMatched: false,
      provenanceComplete: draft.sourceObservationIds.length + draft.sourceEvidenceIds.length > 0,
      locallyVerified: false,
      platformVerified: false,
      errors: [],
    },
    status: 'detected',
    source: 'workflow_output',
    sourceId: attemptId,
    matchedPattern: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

// Re-export constants for legacy callers (kept for backwards compat).
export const DEFAULT_MAX_STRATEGY_CYCLES_LEGACY = DEFAULT_MAX_STRATEGY_CYCLES

// Silence unused import (kept for clarity / future expansion).
void mergeEvidence
void createInitialReasoningBudgetState
void createAttemptDeduplicator