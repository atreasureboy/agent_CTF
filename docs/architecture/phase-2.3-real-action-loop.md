# Phase 2.3 — Real Action Loop Audit

## Pre-fix Baseline

**Tests passing:** 586/586
**Typecheck:** clean

### Identified breaks (§一)

1. **Noop Executor fallback** — `processNewReasoningInputs` falls back to
   a noop executor when none is supplied, allowing actions to be
   recorded as succeeded without real execution.
2. **No production Executor** — No concrete `RuntimeStrategyActionExecutor`
   wired into `createCTFTaskRuntime` / `CTFTaskOrchestrator`. The
   plan-time adapters only know how to emit decisions; execution is
   a stub.
3. **Auto-trigger missing in production paths** — `runWorkflow` /
   `runMainAgent` invoke `processReasoningInput`, but the inputs are
   empty (no suggested actions / observations carried back) and there
   is no dedup against the same Cascade.
4. **Module-level `_internals` Map** — `reasoningCoordinator.ts` keeps a
   long-lived `Map<taskId, CoordinatorInternals>` for pending store /
   selected action ids, which is not part of TaskState and breaks
   resume.
5. **Evidence atomic merge absent** — `EVIDENCE_MERGED { mergedFrom:
   <new id> }` requires the caller to first construct an Evidence id
   that's not in the state; if no matching fingerprint exists the
   reducer throws "missing evidence".
6. **Single-producer EvidenceDraft** — `ResultMerger` keeps only the
   existing draft's `producer`; second parser source is dropped at
   the merger before `Evidence` is built.
7. **Conflict resolver uses `kind+claim` as key** —
   `resolveParserConflicts` collapses all evidence of the same kind
   and lower-cased claim into one row, missing the subject/family
   dimension.
8. **Negative Evidence creates reverse-positive Hypothesis** —
   `ruleFor(evidence.kind === 'negative_result' && has zsteg keyword)`
   proposes `image-stego` category with status `proposed`; this is a
   POSITIVE hypothesis ("image has stego payload") supported by a
   NEGATIVE observation.
9. **Budget check uses `>=` not projection** — `evaluateReasoningBudget`
   rejects when `state.actionsExecuted >= limits.maxActions` instead of
   `state.actionsExecuted + 1 > limits.maxActions`. The first action
   over the cap is admitted before being rejected, and the rejection is
   performed before the existing attempt-counter increment, leading to
   possible off-by-one over-runs.
10. **`options.state` snapshot** — `runCycles` reads `options.state`
    once at function entry; everything in the loop body sees the
    pre-cycle state (hypotheses, attempts, flag candidates, budget),
    not the live `store.getState()`.
11. **Workflow partial/failed mapping** — `runWorkflow` collapses both
    `partial` and `failed` into `WORKFLOW_COMPLETED` (with a summary
    note). Phase 2.3 requires distinct `WORKFLOW_PARTIAL` and
    `WORKFLOW_FAILED` events, plus the projector treats them
    differently.
12. **PendingAction dual ownership** — `PendingActionStore` is in
    `_internals` (memory) AND `TaskState.pendingActions` (persisted).
    The planner reads from one and the events go to the other.
13. **Missing Six Adapters** — No concrete adapters for the six action
    types; the spec's `RuntimeStrategyActionExecutorDependencies`
    (runWorkflow / runOneShot / callTool / requestHandoff / verifyFlag)
    is not defined.

### Target call chain (§三十三)

```text
Run Output
  → StructuredOutputHandler.handle(...)
  → ReasoningCoordinator.processNewReasoningInputs
    ↳ Live state (per cycle)
    ↳ Cascade ctx (depth, parent, dedup)
    ↳ StrategyPlanner (reads latest hypotheses)
    ↳ RuntimeStrategyActionExecutor (no Noop fallback)
      ↳ runWorkflow / runOneShot / callTool / requestHandoff / verifyFlag
    ↳ EVIDENCE_UPSERTED / OBSERVATION_ADDED / ARTIFACT_ADDED / FLAG_CANDIDATE_DETECTED
    ↳ HYPOTHESIS_UPSERTED (with claim-family + subject keys)
    ↳ HYPOTHESIS_STATUS_CHANGED (with FSM + Revision)
    ↳ PENDING_ACTION_* (TaskState-only)
    ↳ REASONING_BUDGET_CONSUMED (projection)
  → Attempt bound by id (products only set ONCE on completion)
  → State listener errors surfaced (onListenerError)
```

### Files to change

- New: `runtimeStrategyActionExecutor.ts`,
  `structuredOutputHandler.ts`, `reasoningCascade.ts`
- Modified: `reasoningCoordinator.ts`, `taskState.ts`, `taskEvents.ts`,
  `taskStateStore.ts`, `resultMerger.ts`, `parserConflictResolver.ts`,
  `evidence.ts`, `hypothesisUpdater.ts`, `reasoningBudget.ts`,
  `taskOrchestrator.ts`, `createCTFTaskRuntime.ts`
- Removed: module-level `_internals` Map; executor `?? noop` fallback.

### Forbidden patterns (§二十九)

After implementation the following must be clean:

```bash
rg "createNoopStrategyActionExecutor" src/core/ctfRuntime src/core/ctfReasoning
rg "executor\s*\?\?" src/core/ctfReasoning
rg "_internals" src/core/ctfReasoning
rg "new Map.*PendingAction" src/core/ctfReasoning
rg "mergedFrom" src/core/ctfReasoning src/core/ctfRuntime
rg "taskState:\s*options\.state" src/core/ctfReasoning
rg "claim\.toLowerCase.*conflict" src/core/ctfReasoning
rg "negative_result.*image-stego" src/core/ctfReasoning
```

`createNoopStrategyActionExecutor` is permitted only inside the
`strategyActionExecutor.ts` and in test files, never imported by
production modules.