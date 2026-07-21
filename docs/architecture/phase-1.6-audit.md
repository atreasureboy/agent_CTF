# Phase 1.6 Audit — forth_goal.md baseline

Recorded before any code change. `rg` results from `forth_goal.md` §二.

## Git baseline

```
5bd1956 refactor(ctf-runtime): close audit gaps — job mirror, binary check, path guard, error.cause
85c06a8 docs: update REFACTOR_REPORT with hardened audit + per-section checklist
abfb5fd refactor(ctf-runtime): harden event names, FSM, capability matching, profile sync
917a8dc refactor(ctf-runtime): unify TaskExecutionContext + StateStore + Orchestrator
8825df8 feat(ctf): finalize harness — 10 agents, 21 tools, §十八 final report, .loop docs
```

Working tree:
- Modified: `bin/ovogogogo-ctf.ts`, `src/core/backgroundJobs.ts`,
  `src/core/ctfRuntime/{taskEvents,taskOrchestrator,taskState,taskStateStore}.ts`,
  `src/core/orchestratorDispatch.ts`, `src/core/toolBroker.ts`,
  three test files.
- New: `src/core/ctfRuntime/{handoffCoordinator,linkedAbortController,profileStore,specialistHarnessFactory,taskStateProjector}.ts`,
  `tests/ctfMainPath.test.ts`.

## Pattern audit

### `createHarness` / `harness.runWorkflow` / `dispatchNext` / `autoExecute`

Found in tests only (orchestrator + harness factory tests). No CLI usage.
The CLI was already migrated in Phase 1.5 (third_goal.md). One remaining
fallback in `orchestratorDispatch.ts` accepts `autoExecute` historically
— must be removed (§六).

### `jm.spawn` / `setTimeout(tick, 25)` / `ACTIVE_JOBS_REPLACED`

No matches. Already replaced by `BackgroundJobManager.subscribe()` in Phase 1.5.

### `broker.opts` / `as unknown as { opts }` private-field writes

```
src/core/ctfRuntime/taskOrchestrator.ts:145:    ;(harness.broker as unknown as { opts: { profileStore: CTFProfileStore } }).opts.profileStore = profileStore
```

This is the ProfileStore wire-up — must be removed per §四 (Runtime
factory should construct the broker with the store, not patch it after).

### `producedFindingIds: []` / `producedArtifactIds: []`

```
src/core/ctfRuntime/handoffCoordinator.ts:124: failed-result stub
src/core/ctfRuntime/handoffCoordinator.ts:283: terminal-result stub
src/core/ctfRuntime/handoffCoordinator.ts:387: terminal-result stub
src/core/ctfRuntime/taskOrchestrator.ts:341: main-agent stub
src/core/ctfRuntime/taskOrchestrator.ts:368: catch-all
```

Spec allows empty arrays when there really are no new products (failed
runs, terminal-result stubs). These are all error/terminal paths, not
success. **No production-path empty array** — verified.

### `process.cwd()` / `sessionDir: undefined`

Only matches are:
- `bin/ovogogogo.ts` (legacy CLI — out of scope)
- `bin/ovogogogo-ctf.ts` CLI default for `--cwd`
- doc comments in `workflowRunner.ts`, `harness.ts`,
  `contestConfig.ts`, `taskExecutionContext.ts` warning against it
- `contestConfig.ts:85` `opts.cwd ?? process.cwd()` — CLI entry boundary

No instance inside the ctfRuntime or workflowRunner actually uses these.
The orchestrator + harnesses derive every path from TaskExecutionContext.

## Current execution path

```
CLI (bin/ovogogogo-ctf.ts)
  → CTFTaskOrchestrator.create()
      → CTFProfileStore
      → CTFTaskStateStore
      → TaskStateProjector
      → BackgroundJobManager.subscribe()
      → LinkedAbortController
      → HandoffCoordinator
          → SpecialistHarnessFactory
              → child Harness (with full deps)
```

## Items still to enforce per forth_goal.md

1. `createCTFTaskRuntime.ts` does not yet exist as a separate file —
   currently inlined inside `CTFTaskOrchestrator.create`.
2. `dispatchNext` still lists `cwd`, `apiKey`, `baseURL`, `model`,
   `openaiClient`, `renderer`, `userMessage`, `history` in its options.
3. CLI: `runCtfCli(argv, deps)` and `process.once` SIGINT handler
   do not yet exist (CLI uses ad-hoc signal handler).
4. CLI: `process.exit(0)` called inside workflow path — must be
   replaced with `process.exitCode = …` + return.
5. CLI: chat mode (`--task`) silently exits with "LLM-backed turn is
   reserved…" — must attempt the LLM turn or refuse with exit code.
6. `agentRuntimeDependencies.ts` does not yet exist as a separate
   module (interface is inside `specialistHarnessFactory.ts`).
7. `SpecialistHarnessFactory` is currently a function, not a class
   with a `create()` method.
8. `Orchestrator.cancel` is sync, not async.
9. `BackgroundJobEvent` was named `JobLifecycleEvent` — must rename.
10. Artifact file copy from Specialist → Parent artifactDir not yet
    implemented (§十三).
11. README not yet updated.

These will be fixed in subsequent tasks.