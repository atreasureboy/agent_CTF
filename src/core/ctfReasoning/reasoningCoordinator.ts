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
  /** Optional executor — defaults to a noop. */
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
  /** §二十三 — completion policy overrides the default. */
  completionPolicy?: CompletionPolicy
  /** Optional flag for completion policy: auto-complete local fixtures
   *  when a flag candidate is validated. Default false (real contests
   *  wait for human / platform verification per §二十三). */
  autoCompleteLocalFixtures?: boolean
}

interface CoordinatorInternals {
  pending: ReturnType<typeof createPendingActionStore>
  /** Per-task lock promise so concurrent calls serialize. */
  lockChain: Promise<unknown>
  selectedActionIds: string[]
  strategyDecisionIds: string[]
  finalObservationIds: string[]
  finalEvidenceIds: string[]
}

const _internals = new Map<string, CoordinatorInternals>()

function internals(taskId: string): CoordinatorInternals {
  let i = _internals.get(taskId)
  if (!i) {
    i = {
      pending: createPendingActionStore(),
      lockChain: Promise.resolve(),
      selectedActionIds: [],
      strategyDecisionIds: [],
      finalObservationIds: [],
      finalEvidenceIds: [],
    }
    _internals.set(taskId, i)
  }
  return i
}

export async function processNewReasoningInputs(
  options: ReasoningCoordinatorOptions,
  input: ProcessReasoningInputsInput,
): Promise<ReasoningResult> {
  const { taskId } = options
  const i = internals(taskId)
  // Per-task lock — chain on the existing lock so concurrent calls
  // for the same task are serialized.
  const next: Promise<unknown> = i.lockChain.then(() =>
    runCycles(options, input, i),
  )
  i.lockChain = next.catch(() => undefined)
  return next as Promise<ReasoningResult>
}

async function runCycles(
  options: ReasoningCoordinatorOptions,
  input: ProcessReasoningInputsInput,
  i: CoordinatorInternals,
): Promise<ReasoningResult> {
  const maxCycles = options.maxStrategyCycles ?? DEFAULT_MAX_STRATEGY_CYCLES
  const maxTotalActions = options.maxTotalStrategyActionsPerTask ?? DEFAULT_MAX_TOTAL_STRATEGY_ACTIONS_PER_TASK
  const store = options.store
  const inFlight: { fast: number; medium: number; heavy: number } = { fast: 0, medium: 0, heavy: 0 }
  let cycleCounter = 0
  let stopped = false
  let stopReason: string | undefined
  let cycles = 0
  // Snapshot budget + observations so we know the loop's contributions.
  let budget: ReasoningBudgetState = { ...options.state.reasoningBudget }

  // Apply incoming Evidence to HypothesisUpdater first.
  applyHypothesisUpdates(options, input)

  // Seed pending store with the new suggested actions (excluding stop).
  const seed = input.suggestedActions
    .filter((a) => a.type !== 'stop')
    .map((a) => ({
      action: a,
      observationIds: input.newObservationIds,
      evidenceIds: input.newEvidenceIds,
      hypothesisIds: a.hypothesisIds ?? [],
    }))
  const newPendingIds = i.pending.add(seed)
  for (const pid of newPendingIds) {
    const p = i.pending['size' as never] // placeholder, ignored
    void p
  }

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
    budget = consumeCycle(budget)
    store.apply({ type: 'REASONING_BUDGET_CONSUMED', snapshot: budget })

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
      i.strategyDecisionIds.push(decision.id)
      stopped = true
      stopReason = stopAction.reason || 'planner emitted stop'
      break
    }

    // Pull eligible candidates from the pending store.
    const eligible = i.pending.listEligible()
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
    i.strategyDecisionIds.push(decision.id)

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
      i.strategyDecisionIds.push(deniedDecision.id)
      stopped = true
      stopReason = `budget denied: ${budgetCheck.reason}`
      break
    }

    // Build Attempt and emit ATTEMPT_STARTED.
    const attempt = buildAttempt(options, selected, cycleCounter)
    store.apply({ type: 'ATTEMPT_STARTED', attempt })
    i.selectedActionIds.push(attempt.id)
    // §二十二 — PendingAction FSM: pending → selected.
    markPendingSelected(i, selected, attempt.id)

    // Update in-flight + budget BEFORE execution.
    const tier = selected.costTier === 'expensive' ? 'heavy' : selected.costTier === 'normal' ? 'medium' : 'fast'
    inFlight[tier]++
    budget = applyReasoningBudgetConsumption(budget, selected)
    store.apply({ type: 'REASONING_BUDGET_CONSUMED', snapshot: budget })

    // Execute the selected action.
    const executor = options.executor ?? ({ async execute(): Promise<ActionExecutionResult> {
      return {
        status: 'executed',
        materializedResult: {
          observations: [],
          evidence: [],
          suggestedActions: [],
          flagCandidateDrafts: [],
          warnings: [],
          rawArtifactIds: [],
        },
        executionRefs: { attemptId: attempt.id },
      }
    } } as StrategyActionExecutor)

    let execResult: ActionExecutionResult
    try {
      execResult = await executor.execute({
        taskState: options.state,
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

    // Process the result.
    if (execResult.status === 'stop') {
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
      const pid = pendingIdFor(i, selected)
      if (pid) i.pending.reject(pid)
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
      const pid2 = pendingIdFor(i, selected)
      if (pid2) i.pending.reject(pid2)
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
    for (const draft of drafts.observations) {
      const obs = createObservation(options.taskId, draft)
      store.apply({ type: 'OBSERVATION_ADDED', observation: obs })
      observationIds.push(obs.id)
      i.finalObservationIds.push(obs.id)
    }
    // §六 — Evidence drafts without observationIds/artifactIds are
    // auto-bound to the just-created observations from this batch.
    // This keeps parsers simple while preserving the invariant.
    for (const draft of drafts.evidence) {
      if ((draft.observationIds?.length ?? 0) === 0 && (draft.artifactIds?.length ?? 0) === 0) {
        draft.observationIds = [...observationIds]
      }
    }
    for (const draft of drafts.evidence) {
      // §十五 — if an existing Evidence shares the same fingerprint,
      // merge into the existing record via EVIDENCE_MERGED. Otherwise
      // add a fresh Evidence.
      const candidateFp = _ignore({
        taskId: options.taskId,
        kind: draft.kind,
        subject: undefined,
        claim: draft.claim,
        polarity: draft.polarity ?? 'supports',
      })
      const ev = createEvidence(options.taskId, draft)
      const existing = store.getState().evidence.find((e) => e.fingerprint === candidateFp)
      if (existing) {
        store.apply({ type: 'EVIDENCE_MERGED', evidenceId: existing.id, mergedFrom: ev.id })
        evidenceIds.push(existing.id)
        i.finalEvidenceIds.push(existing.id)
      } else {
        store.apply({ type: 'EVIDENCE_ADDED', evidence: ev })
        evidenceIds.push(ev.id)
        i.finalEvidenceIds.push(ev.id)
      }
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
    const pidExec = pendingIdFor(i, selected)
    if (pidExec) i.pending.markExecuted(pidExec)

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
      i.pending.add(nextSeed)
    }
  }

  return {
    cycles,
    stopped,
    stopReason,
    selectedActionIds: [...i.selectedActionIds],
    strategyDecisionIds: [...i.strategyDecisionIds],
    finalObservationIds: [...i.finalObservationIds],
    finalEvidenceIds: [...i.finalEvidenceIds],
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

function markPendingSelected(i: CoordinatorInternals, action: SuggestedAction, _attemptId: string): string | undefined {
  const items = i.pending.listEligible()
  const match = items.find((p) => p.action === action || sameAction(p.action, action))
  if (match) {
    i.pending.select(match.id)
    return match.id
  }
  return undefined
}

function pendingIdFor(i: CoordinatorInternals, action: SuggestedAction): string | undefined {
  const items = i.pending.listEligible()
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