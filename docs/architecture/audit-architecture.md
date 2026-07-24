# Architecture Audit — 2026-07-24

Four parallel agents audited the codebase across four lenses:
1. Module structure, type safety, code quality
2. Event sourcing, reducer purity, FSM enforcement, immutability
3. Runtime, concurrency, lifecycle (abort / locks / dispose)
4. Reasoning loop, planner, executor ↔ coordinator contract

Total findings: **30 distinct issues** ranging from Critical to Informational.

## Severity summary

| Severity | Count | Notes |
|----------|-------|-------|
| Critical | 4 | Production wiring broken or parser pipeline silent |
| High | 5 | Deadlock, FSM bypass, evidence identity loss |
| Medium | 12 | Asymmetric guards, silent failures, lifecycle gaps |
| Low / Info | 9 | Code smell, future-proofing |

## Critical findings

### C1. Reasoning failures are silently discarded on main execution paths

`processReasoningInput()` is called after `runWorkflow()` and `runMainAgent()` succeed, but every failure is swallowed by a bare `} catch {}` block (`taskOrchestrator.ts:458-471, 628-638`).

The structured reasoning loop is documented as the main path, yet it can quietly fail while the workflow / agent result still appears successful. There's no `REASONING_FAILED` event type, no diagnostic retained.

**Fix**: introduce `REASONING_FAILED` event + degraded state marker.

### C2. Production orchestrator does not inject the mandatory executor

`ReasoningCoordinatorOptions.executor` is typed optional but mandatory at runtime (throws `MissingStrategyActionExecutorError`). The orchestrator's `processReasoningInput()` does not wire the production `createRuntimeStrategyActionExecutor`.

Calling `orchestrator.processReasoningInput(...)` in production currently throws.

**Fix**: make `executor` required in the type and inject at runtime assembly.

### C3. Production `call_tool` discards the parser pipeline

`RuntimeSurface.callTool()` returns raw `content` / `isError` / `exitCode`. `executeCallTool()` discards them and returns an empty `MaterializedResult`, never invoking `resultMaterializer.materialize()`. Production tool calls produce no observations, no evidence, no suggested follow-ups from textual output.

The executor → parser → planner feedback loop is broken for tools.

**Fix**: have the executor call `materialize()` (or surface the raw fields so the coordinator owns materialization).

### C4. Reasoning-to-workflow nested-lock deadlock

`processNewReasoningInputs()` serialises calls per task via `_taskLocks`. The cycle:

```text
outer reasoning holds _taskLocks
  → Executor.run_workflow awaits orchestrator.runWorkflow()
    → runWorkflow() holds workflow:<id> via withLock()
      → runWorkflow() awaits processReasoningInput() for the next cycle
        → nested call waits for the existing _taskLocks chain
          → outer cannot resolve → DEADLOCK
```

**Fix**: do not await nested reasoning while still inside the outer cycle. Enqueue the follow-up reasoning pass via the cascade registry.

## High findings

### H1. Projector `matchesRun` leaks items without run-id metadata
`taskStateProjector.ts:179-193` — when run-id metadata is set, items without run-id pass through, allowing cross-run leakage.

### H2. Cumulative budget can be reset from stale state snapshot
`reasoningCoordinator.ts:182` uses the entry-snapshot `options.state.reasoningBudget` instead of `store.getState().reasoningBudget`. Concurrent submissions both capture the old budget and the second one overwrites the first's consumption on apply.

### H3. Cycle budget is projected twice
`consumeCycle()` (line 217) and `evaluateReasoningBudget()` (line 109-114 of reasoningBudget.ts) both increment the cycle counter. With `maxStrategyCycles: 1` the first action is denied; with default `8` at most 7 actions are allowed.

### H4. Hypotheses bypass the FSM via HYPOTHESIS_UPDATED
`HYPOTHESIS_UPDATED` lets callers patch any field including `status`. The coord uses this for status changes — bypassing the explicit `HYPOTHESIS_STATUS_CHANGED` FSM. The updater can set `proposed → inconclusive` which the FSM forbids.

### H5. Negative evidence creates the positive hypothesis it contradicts
`ruleFor(negative_result + zsteg)` returns category `image-stego` with status `proposed`, claiming *"image has steganography payload"* on a NEGATIVE observation.

## Medium findings (12)

- Asymmetric Attempt FSM: `ATTEMPT_CANCELLED` / `SKIPPED` / `UPDATED` don't reject `skipped_*` terminals (only `succeeded`/`failed`/`cancelled`). A `skipped_duplicate` can be re-cancelled or patched back to `running`.
- Executor returns `{status: 'stop'}` leaving a non-terminal pending attempt (no ATTEMPT_COMPLETED/CANCELLED/SKIPPED/FAILED emission).
- Planner dedup uses incompatible fingerprints (planner-only normalised params vs coordinator's full `base.input` with `reason`).
- `shouldRunTool()` rejects any lower-priority alternative — defeating the score formula for any non-maximum-priority candidate.
- `shouldRunTool()` suppresses same-target successful attempts regardless of parameters.
- Conflict resolver drops unrelated same-family evidence with empty subject keys.
- Parser warnings lost — `withPartialWarning` results' warnings are overwritten with empty `[]` before merger runs.
- Evidence upsert doesn't dedupe sources — reprocessing the same evidence appends identical witnesses and doubles confidence.
- `FLAG_CANDIDATE_ADDED` lacks duplicate-id check.
- `EVIDENCE_MERGED` is destructive — irreversibly deletes `mergedFrom` record.
- `isDegraded()` is unreachable (no consumer in `src/` or `tests/`).
- `listenerErrors` unbounded memory growth; no consumer.
- OneShot lifecycle: budget ticket acquired before `try/finally` cleanup; pre-spawn abort race lets jobs start despite cancellation.
- Tool-selection rejection detail lost — `heavy_not_approved` mapped to `budget_denied`.
- Natural cycle exhaustion returns `stopped: false` without `stopReason`.
- Action-type-dependent planner policy — handoff / verify_flag bypass planner checks.
- PendingAction FSM transitions stuck at `selected` because `pendingIdFor()` searches only `listEligible()`.
- `attemptUPDATED` allows patching back to `running` from `skipped_*`.
- Multi-`dispose()` not await-idempotent + failure permanently marks `disposed`.

## Low / Informational findings

- 26 `as unknown as` double-assertions at tool boundaries (`bash.ts`, `fileWrite.ts`, `fileRead.ts`, …).
- Profile switch rollback can fail silently — leaves profile store + state + broker disagreeing.
- 51 silent `catch {}` blocks across `/src` and `/src/ctf` with no common diagnostic sink.
- `core/harness.ts` imports concrete `ensureWorkflowsRegistered` from `workflows/index.ts` — core depends on application workflows.
- Several modules oversized (taskStateStore 1094 lines, taskOrchestrator 948, reasoningCoordinator 701).
- Type hardening incomplete: `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` not enabled.
- `seq` counter private but promised in comment as a gap-detection API.
- `HYPOTHESIS_ADDED`/`HYPOTHESIS_PROPOSED` reducer bodies identical; same for `ATTEMPT_RECORDED`/`ATTEMPT_STARTED`.
- `blockInTerminal` doesn't include `HANDOFF_REJECTED|CANCELLED|FAILED`, `AGENT_RUN_OUTPUT_RECORDED`, `ONESHOT_RUN_*` lifecycle events.
- `_taskLocks` Map and `ProcessedOutputRegistry.processed` Map never delete settled entries.
- `lockGeneration` numeric Map never deletes keys.
- `TASK_COMPLETED` bypasses `canTransitionPhase` — sets phase directly from completion status.

## Positive findings

- TypeScript `strict: true` enabled; effectively zero `any` in audited scope.
- Zero `@ts-ignore` / `@ts-expect-error` suppression directives.
- Exhaustiveness guard `const _exhaustive: never = event` works for the 58-event union.
- Reducer purity preserved — `state.x.push/splice` zero matches; 31 reducer returns use immutable spread.
- `deepFreeze` correctly skips `AbortSignal`/`Date`/`Map`/`Set`/`Promise`/`Buffer`/`ArrayBuffer`.
- Phase / Hypothesis / Handoff FSMs tight.
- `processNewReasoningInputs` per-task lock works for truly parallel tasks; serialized same-task calls.
- `LinkedAbortController` propagates already-aborted parent signal + reason.
- Task cancellation aborts before awaiting workflows / agents / handoffs.

## Recommended fix priority

1. **Wire the production executor + fix the call_tool materializer** (C2/C3) — production wiring is broken.
2. **Break the reasoning/workflow nested-lock deadlock** (C4) — production hangs the moment a workflow action is selected.
3. **Surface reasoning failures** (C1) — silent swallowed main-path errors are a correctness risk.
4. **Hypothesis FSM routing** (H4, H5) — `HYPOTHESIS_UPDATED` is the wrong vehicle for status changes; negative-evidence rule is wrong-side.
5. **Evidence identity** (H3 partial, M7–M9) — source dedup, fingerprint-driven observation dedup, projector leaks.
6. **Memory leaks / unbounded retention** (M11, L12) — `_taskLocks`, `processed`, `listenerErrors`, `lockGeneration`.
7. **Type-safety hardening** (P1 external input, P2 type assertions) — schemas at tool boundaries; enable `noUncheckedIndexedAccess`.
