# Phase 2.2 — Reasoning Main Path Audit

This document captures the baseline audit at the start of Phase 2.2 and
the target call chain after the fixes are applied.

## 1. ReasoningCoordinator call site

The `ReasoningCoordinator` (`src/core/ctfReasoning/reasoningCoordinator.ts`)
is currently only reachable from tests (`tests/ctfReasoning.test.ts` and
`tests/ctfReasoningAudit.test.ts`). Neither `CTFTaskOrchestrator`
(`src/core/ctfRuntime/taskOrchestrator.ts`) nor the main harness wires
it into the live runtime. The structured reasoning loop is therefore
disconnected from the production main path.

## 2. Current stop Action flow

`executeSelectedAction` in `reasoningCoordinator.ts` maps
`action.type === 'stop'` to `{ skipped: true, skipReason: 'policy' }`
(line ~291). The for-loop in `runStrategyCycle` then `continue`s on the
next iteration, so the loop keeps running with no eligible action until
the planner eventually returns `selectedAction: undefined`. The stop
reason is never recorded, and the planner can keep emitting stop
without forcing an actual exit.

## 3. Current Attempt completion order

`runStrategyCycle` (`reasoningCoordinator.ts`):
1. `store.apply({ type: 'ATTEMPT_STARTED', attempt })`
2. `await executeSelectedAction(options, selected)` (which is just the
   pre-materialized result the caller provides — no real execution)
3. `store.apply({ type: 'ATTEMPT_COMPLETED', attemptId, status, completedAt })`
4. *Then* it iterates the materialized drafts and applies
   `OBSERVATION_ADDED`, `EVIDENCE_ADDED`, `FLAG_CANDIDATE_DETECTED` —
   i.e. observations / evidence / candidates are persisted AFTER the
   Attempt is already marked succeeded. The reducer's `ATTEMPT_COMPLETED`
   reducer does not even know about the produced ids.

## 4. Hypothesis usage

`CTFHypothesis` carries `priority`, `confidence`, `supportingEvidenceIds`
and `contradictingEvidenceIds`, but:

* No code in `src/core/ctfReasoning/` or `src/core/ctfRuntime/`
  creates a `HypothesisUpdater`. `HYPOTHESIS_PROPOSED` is exposed as
  an event but nothing emits it; the only path that produces
  hypotheses is `CTFTaskOrchestrator.addHypothesis` (manual / test
  hook).
* `StrategyPlanner.planStrategy` reads nothing from `state.hypotheses`.
  The `basedOnHypothesisIds` field is always `[]`.
* `SuggestedAction.hypothesisIds` is declared on the type but never
  populated by any parser or workflow.

## 5. Condition query scope

`WorkflowConditionContext.state` is the full task state sliced down to
attempts / hypotheses / observations / evidence / flagCandidates /
artifactIds. There is no `ConditionScope`. The
`evaluateWorkflowCondition` function never filters by
`workflowRunId` / `stepId` / `producerId` /
`producerStepId`. Old artifacts or evidence produced by earlier
workflow runs will satisfy any new workflow's stop condition.

## 6. Evidence fingerprint shape

`evidenceFingerprint(e)` includes `e.producer.type` and `e.producer.id`
in the hash. The ResultMerger / Evidence-merge paths therefore treat
two parsers that produce the same claim with different producer ids
as DIFFERENT evidence. There is no notion of multi-source evidence —
each producer creates its own record, and `mergeEvidence` is wired
through `EVIDENCE_MERGED` but the reducer only unions the observation
ids and artifact ids and bumps confidence to the max — it does not
combine multiple producer-derived records into a coherent claim.

## 7. Parser output merge

`ParserRegistry.parse` (`src/core/ctfReasoning/parserRegistry.ts`)
pushes every parser's output into shared arrays via
`aggregate.observations.push(...)` etc. There is no de-duplication of
observations with the same fingerprint, no merging of equivalent
evidence, no conflict handling when two parsers disagree on the file
type, and no specialisation ordering (magic > specialized > file >
generic).

## 8. Mutable TaskState entry points

`CTFTaskStateStore.getState()` returns
`Readonly<CTFTaskState>`. `freezeState` only does
`Object.freeze(s)` — a shallow freeze. Every array on the state
(`observations`, `evidence`, `attempts`, `findings`, `artifactIds`,
`strategyDecisions`, `flagCandidates`, etc.) is still a plain
mutable array. The reducer is mostly immutable but the surface it
returns is not, and tests like
`tests/typedDagExecutor.test.ts` happily mutate the returned state
(`ctx.attempts.push(...)`).

There is also `state.observations.push` / `state.findings.push` etc.
in tests that use the public surface.

## 9. State-listener exception handling

`taskStateStore.ts` line ~94 wraps every listener call in
`try { l(event, this.state) } catch {}` and silently swallows errors.
There is no `StateListenerError`, no `onListenerError` hook, and no
criticality flag. A misbehaving renderer / projector can fail without
any observable signal.

## 10. Target call chain after Phase 2.2 fixes

```text
Main Agent / Workflow / OneShot / Specialist
  → ResultMaterializer (typed MaterializationContext with attemptId)
  → ParserRegistry (parsers → ResultMerger + ParserConflictResolver)
  → TaskState events (deep-frozen, Reducer pure)
  → HypothesisUpdater (auto-proposes / updates status)
  → ReasoningCoordinator.processNewReasoningInputs
      ↳ Reason budget (cumulative + concurrency)
      ↳ PendingActionStore (only fresh / pending / candidate)
      ↳ StrategyPlanner (uses hypotheses + evidence + cost)
      ↳ StrategyActionExecutor adapters
      ↳ AttemptStarted → execute → Materialize → UpdateHypothesis → ATTEMPT_COMPLETED with full ids
      ↳ if stop: ActionExecutionResult.status='stop', record decision, exit
  → TaskState.events subscribers (listener errors surfaced via onListenerError)
```

## 11. Coverage decisions

* `image_quick_scan` already runs `materialize-image` step then
  `emit_finding`. The new `artifact_exists` stop condition will
  require `producedByStepId: 'binwalk-extract'` /
  `producedByWorkflowRunId: '$current'` /
  `minCreatedAt: '$workflowStartedAt'`.
* `encoding_sweep`'s `noNewOutputs` and `maxDepthReached` are too
  generic. The new condition will require
  `kind: 'negative_result'`, `where: { reason:
  'no_new_unique_output' | 'max_depth_reached' }`, and
  `scope: { workflowRunId: '$current', stepId: 'decode-tree' }`.
* Stop Action: explicit `ActionExecutionResult { status: 'stop' }`
  branch that records a `STRATEGY_DECISION_RECORDED` with
  `basedOnHypothesisIds` and exits the loop on the same cycle.
* Attempt: `ATTEMPT_COMPLETED` / `FAILED` / `CANCELLED` events now
  carry `observationIds`, `evidenceIds`, `artifactIds`,
  `flagCandidateIds`. The reducer writes them in once. The
  ReasoningCoordinator orders: `ATTEMPT_STARTED → execute →
  applyObservation / applyEvidence / applyArtifact /
  applyFlagCandidate → updateHypothesis → ATTEMPT_COMPLETED`.
* State deep-freeze: switch to a deep-freeze that still keeps the
  reducer returning new objects. Update tests that mutate the
  surface to use a `createTestTaskState` helper.
* Listener errors: `StateStoreOptions.onListenerError` plus a
  `critical: true` flag on subscribers. Critical failures push the
  orchestrator into `degraded` mode but never roll back state.