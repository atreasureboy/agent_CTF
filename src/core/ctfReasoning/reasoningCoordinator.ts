/**
 * ReasoningCoordinator — Phase 2.1 §二十九.
 *
 * Drives a bounded strategy cycle:
 *   1. Receive new Observation/Evidence
 *   2. Update Hypothesis state via the planner
 *   3. Collect SuggestedActions
 *   4. Run StrategyPlanner (with cost / dedup / policy checks)
 *   5. Execute ONE action
 *   6. Materialize
 *   7. Loop
 *
 * Hard caps (per §二十九):
 *   - maxStrategyCycles: 8
 *   - maxActionsPerCycle: 1
 */

import { materialize, type MaterializedResult } from './resultMaterializer.js'
import { planStrategy, type StrategyPlanningInput } from './strategyPlanner.js'
import { createObservation, type Observation } from './observation.js'
import { createEvidence } from './evidence.js'
import { buildFlagCandidateId, type FlagCandidateDraft } from './flagCandidate.js'
import type { CTFTaskState } from '../ctfRuntime/taskState.js'
import type { CTFTaskStateStore } from '../ctfRuntime/taskStateStore.js'
import type { CTFAttempt, FlagCandidate } from '../ctfRuntime/taskState.js'
import type { BudgetLimits } from '../../ctf/oneshot/types.js'
import type { SuggestedAction } from './suggestedAction.js'
import { createAttemptFingerprint } from './attemptFingerprint.js'

export interface ReasoningCoordinatorOptions {
  taskId: string
  state: CTFTaskState
  store: CTFTaskStateStore
  budgetLimits: BudgetLimits
  heavyApproved: boolean
  abortSignal?: AbortSignal
  /** When set, called to execute a workflow (defaults to a stub). */
  executeWorkflow?: (action: Extract<SuggestedAction, { type: 'run_workflow' }>) => Promise<MaterializedResult>
  /** When set, called to execute a oneshot. */
  executeOneshot?: (action: Extract<SuggestedAction, { type: 'run_oneshot' }>) => Promise<MaterializedResult>
  /** When set, called to execute a tool. */
  executeTool?: (action: Extract<SuggestedAction, { type: 'call_tool' }>) => Promise<MaterializedResult>
  /** When set, called to verify a flag candidate. */
  verifyFlag?: (candidateId: string) => Promise<MaterializedResult>
  /** Maximum strategy cycles. */
  maxStrategyCycles?: number
}

export const DEFAULT_MAX_STRATEGY_CYCLES = 8

export async function runStrategyCycle(
  options: ReasoningCoordinatorOptions,
  suggestedActions: SuggestedAction[],
): Promise<{ iterations: number; stopped: boolean; reason: string }> {
  const maxCycles = options.maxStrategyCycles ?? DEFAULT_MAX_STRATEGY_CYCLES
  const state = options.state
  const store = options.store
  const executedObservations: string[] = []
  const executedEvidence: string[] = []
  let iterations = 0
  let actions = suggestedActions
  let stopped = false
  let reason = 'no eligible action'
  // §round-3 audit fix — track in-flight attempts per cost tier so
  // the CostPolicy is actually consulted, not silently always 0/0/0.
  const inFlight: { fast: number; medium: number; heavy: number } = { fast: 0, medium: 0, heavy: 0 }

  for (let i = 0; i < maxCycles; i++) {
    if (options.abortSignal?.aborted) {
      stopped = true
      reason = 'abort signal'
      break
    }
    const liveState = store.getState()
    if (liveState.completion) {
      stopped = true
      reason = 'task terminal'
      break
    }
    iterations++
    const decision = planStrategy({
      state: liveState,
      newObservationIds: executedObservations,
      newEvidenceIds: executedEvidence,
      suggestedActions: actions,
      cost: {
        limits: options.budgetLimits,
        currentSpend: { ...inFlight },
        heavyApproved: options.heavyApproved,
        taskTerminal: false,
      },
    })
    store.apply({ type: 'STRATEGY_DECISION_RECORDED', decision })
    const selected = decision.selectedAction
    if (!selected) {
      stopped = true
      reason = decision.reason
      break
    }
    // Execute the selected action.
    const attemptBase = actionToAttempt(state, selected)
    // §round-3 audit fix — include inputArtifactIds in the fingerprint
    // so the coordinator's persisted Attempt matches the planner's
    // dedup check. Without this, equivalent actions would not be
    // recognised as duplicates across cycles.
    const fingerprintInputArtifactIds =
      selected.type === 'run_oneshot' ? selected.inputArtifactIds : undefined
    const attempt: CTFAttempt = {
      id: `att_${iterations}_${Date.now().toString(36)}`,
      taskId: options.taskId,
      ...attemptBase,
      fingerprint: createAttemptFingerprint({
        kind: attemptBase.kind,
        targetId: attemptBase.targetId,
        parameters: attemptBase.input,
        inputArtifactIds: fingerprintInputArtifactIds,
      }),
      createdAt: Date.now(),
    }
    store.apply({ type: 'ATTEMPT_STARTED', attempt })
    const execResult = await executeSelectedAction(options, selected)
    if (execResult.skipped) {
      store.apply({
        type: 'ATTEMPT_SKIPPED',
        attemptId: attempt.id,
        reason: execResult.skipReason ?? 'policy',
      })
      continue
    }
    if (execResult.error) {
      store.apply({
        type: 'ATTEMPT_FAILED',
        attemptId: attempt.id,
        error: { message: execResult.error },
      })
      continue
    }
    store.apply({
      type: 'ATTEMPT_COMPLETED',
      attemptId: attempt.id,
      status: 'succeeded',
      completedAt: Date.now(),
    })
    // The executor may return either a fully-materialized result or
    // a raw materializable (which we then run through the registry).
    const mat: MaterializedResult = execResult.materialized ?? (execResult.result
      ? await materialize(options.taskId, execResult.result)
      : {
          observations: [],
          evidence: [],
          suggestedActions: [],
          flagCandidateDrafts: [],
          warnings: [],
          rawArtifactIds: [],
        })
    for (const draft of mat.observations) {
      const obs: Observation = createObservation(options.taskId, draft)
      store.apply({ type: 'OBSERVATION_ADDED', observation: obs })
      executedObservations.push(obs.id)
    }
    for (const draft of mat.evidence) {
      const ev = createEvidence(options.taskId, draft)
      store.apply({ type: 'EVIDENCE_ADDED', evidence: ev })
      executedEvidence.push(ev.id)
    }
    for (const draft of mat.flagCandidateDrafts) {
      const candidate = flagCandidateFromDraft(options.taskId, draft)
      store.apply({ type: 'FLAG_CANDIDATE_DETECTED', candidate })
    }
    actions = mat.suggestedActions
  }
  return { iterations, stopped, reason }
}

function actionToAttempt(state: CTFTaskState, action: SuggestedAction): Omit<CTFAttempt, 'id' | 'taskId' | 'createdAt' | 'fingerprint'> {
  switch (action.type) {
    case 'run_workflow':
      return {
        kind: 'workflow',
        targetId: action.workflowId,
        input: { inputs: action.inputs, reason: action.reason },
        hypothesisIds: [],
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
        hypothesisIds: [],
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
        hypothesisIds: [],
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
        hypothesisIds: [],
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
        hypothesisIds: [],
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
  void state
}

interface SelectedExecResult {
  result?: import('./resultMaterializer.js').MaterializableResult
  /** Pre-materialized result — when set, the coordinator skips
   *  re-running the parser registry. */
  materialized?: MaterializedResult
  error?: string
  skipped?: boolean
  skipReason?: 'duplicate' | 'policy' | 'budget'
}

async function executeSelectedAction(
  options: ReasoningCoordinatorOptions,
  action: SuggestedAction,
): Promise<SelectedExecResult> {
  if (action.type === 'stop') {
    return { skipped: true, skipReason: 'policy' }
  }
  if (action.type === 'run_workflow') {
    if (!options.executeWorkflow) return { skipped: true, skipReason: 'policy' }
    const m = await options.executeWorkflow(action)
    return { materialized: m }
  }
  if (action.type === 'run_oneshot') {
    if (!options.executeOneshot) return { skipped: true, skipReason: 'policy' }
    const m = await options.executeOneshot(action)
    return { materialized: m }
  }
  if (action.type === 'call_tool') {
    if (!options.executeTool) return { skipped: true, skipReason: 'policy' }
    const m = await options.executeTool(action)
    return { materialized: m }
  }
  if (action.type === 'verify_flag') {
    if (!options.verifyFlag) return { skipped: true, skipReason: 'policy' }
    const m = await options.verifyFlag(action.candidateId)
    return { materialized: m }
  }
  if (action.type === 'request_handoff') {
    if (!options.executeTool) return { skipped: true, skipReason: 'policy' }
    const m = await options.executeTool({ ...action, type: 'call_tool' as const, toolId: 'handoff', input: { capability: action.capability, objective: action.objective } })
    return { materialized: m }
  }
  return { skipped: true, skipReason: 'policy' }
}

function flagCandidateFromDraft(taskId: string, draft: FlagCandidateDraft): FlagCandidate {
  return {
    id: buildFlagCandidateId(),
    taskId,
    value: draft.value,
    normalizedValue: draft.normalizedValue,
    sourceObservationIds: draft.sourceObservationIds,
    sourceEvidenceIds: draft.sourceEvidenceIds,
    sourceArtifactIds: draft.sourceArtifactIds,
    sourceRunIds: draft.sourceRunIds,
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
    source: 'manual',
    matchedPattern: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}