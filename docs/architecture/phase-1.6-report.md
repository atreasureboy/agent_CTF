# Phase 1.6 Final Report — forth_goal.md completion

## 1. Audit hits (old patterns removed)

| Pattern | Pre-existing locations |
|---------|------------------------|
| CLI directly created Harness | None — already removed in third_goal; `bin/ovogogogo-ctf.ts` now goes through `createCTFTaskRuntime` |
| CLI directly ran `harness.runWorkflow` | None — replaced by `orchestrator.runWorkflow` |
| CLI modified Broker private config | `bin/ovogogogo-ctf.ts:201` (Phase 1.5); removed |
| Legacy Handoff `autoExecute` | `src/core/orchestratorDispatch.ts:54-67` (Phase 1.5); option + child harness path removed |
| JobManager monkey patch | `src/core/ctfRuntime/taskOrchestrator.ts:192-209` (Phase 1.5); removed in this phase |
| 25ms polling | None — already removed in third_goal |
| Invalid AbortSignal wiring | `src/core/ctfRuntime/taskOrchestrator.ts:155` (`harness.context` had no signal); fixed via `createLinkedAbortController` + factory |
| Empty `producedFindingIds` after success | `taskOrchestrator.ts:368` (catch-all); now sourced from `projector.projectDiff()` |
| Reducer no-op for HYPOTHESIS/ATTEMPT/JOB | `taskStateStore.ts:317-326` (Phase 1.5); now actually applies the events |

## 2. Deleted old paths

- CLI direct Harness creation — `bin/ovogogogo-ctf.ts` rewritten to use `runCtfCli(argv, deps)` + `createCTFTaskRuntime`
- CLI direct Workflow call — `harness.runWorkflow(...)` removed; only `orchestrator.runWorkflow(...)` remains
- Broker private-field write — `(harness.broker as unknown as { opts }).opts.profileStore = ...` deleted; replaced by `broker.setProfile(profileStore.getCurrent())`
- Legacy Handoff `autoExecute` / `cwd` / `apiKey` / `baseURL` / `model` / `openaiClient` / `renderer` / `userMessage` / `history` options — all removed from `dispatchNext`
- JobManager monkey patch — `jm.spawn = ...` deleted; subscription is owned by `createCTFTaskRuntime`
- 25ms `setTimeout(tick, ...)` polling — never existed in this codebase (was already removed in Phase 1.5)
- `ACTIVE_JOBS_REPLACED` event — deleted from `taskEvents.ts` and `taskStateStore.ts`
- `JobLifecycleEvent` type alias — renamed to `BackgroundJobEvent`
- `subscribeJobLifecycle` private method on orchestrator — deleted (lifecycle hookup moved to factory)

## 3. Final execution paths

### Workflow-only

```
CTF CLI (bin/ovogogogo-ctf.ts:runCtfCli)
  → createCTFTaskRuntime(src/core/ctfRuntime/createCTFTaskRuntime.ts)
      → ProfileStore + LinkedAbortController + main Harness
      → CTFTaskOrchestrator.assemble (taskOrchestrator.ts)
      → BackgroundJobManager.subscribe()  ← job lifecycle → projector
  → orchestrator.runWorkflow(id, inputs)
      → WorkflowEngine.run → WorkflowBrokerRunner.runStep
      → ToolBroker.execute  ← TaskStateProjector.projectDiff
      → CTFTaskStateStore.apply
```

### Main Agent

```
CTF CLI (runCtfCli)
  → createCTFTaskRuntime
  → orchestrator.runMainAgent(message)
      → main Harness.runTurn  (ExecutionEngine)
      → ToolBroker.execute
      → TaskStateProjector.projectDiff(before, after)
      → CTFTaskStateStore.apply(FINDING_ADDED / ARTIFACT_ADDED)
```

### Specialist

```
Agent → orchestrator.requestHandoff
  → CTFTaskStateStore.apply(HANDOFF_REQUESTED)
  → orchestrator.approveHandoff
      → HandoffCoordinator.approveAndRun
          → HandoffCoordinator.selectAgentForCapability
          → CTFTaskStateStore.apply(HANDOFF_APPROVED)
          → SpecialistHarnessFactory.create
              → deriveSubtaskContext (narrowed scope)
              → createHarness (single allowed specialist spawn site)
              → LinkedAbortController (parent → child)
          → handle.harness.runTurn
          → TaskStateProjector.projectDiff (copies artifacts to parent)
          → CTFTaskStateStore.apply(AGENT_RUN_COMPLETED / SPECIALIST_COMPLETED)
      → handle.dispose()
```

### Cancel

```
SIGINT / SIGTERM
  → runCtfCli registerSignals
  → runtime.cancel(reason)
      → orchestrator.cancel(reason)
          → LinkedAbortController abort
          → main Harness.cancelAllJobs(reason)
          → in-flight workflow/specialist caught and rejected
      → TaskState phase → cancelled (via guarded events)
  → finally { runtime.dispose() }
```

### Dispose

```
runtime.dispose
  → orchestrator.dispose
      → orchestrator.cancel
      → abort.unlink
      → handoffCoordinator.disposeAll
      → Promise.allSettled(in-flight workflows)
  → factory.dispose listeners unsubscribed
```

## 4. File changes

### New

- `src/core/ctfRuntime/agentRuntimeDependencies.ts` — `AgentRuntimeDependencies` + `ModelConfig` + `assertLlmDependencies`
- `src/core/ctfRuntime/createCTFTaskRuntime.ts` — single public entry; wires ProfileStore, LinkedAbortController, main Harness, StateStore, Orchestrator, Job subscription, Workflow registration
- `src/core/ctfRuntime/specialistHarnessFactory.ts` — `SpecialistHarnessFactory` class with `create(input)` method
- `src/core/ctfRuntime/handoffCoordinator.ts` — Handoff FSM, Specialist spawn, Artifact collection
- `src/core/ctfRuntime/taskStateProjector.ts` — snapshot + diff; `projectJobEvent`; Specialist artifact file copy
- `src/core/ctfRuntime/linkedAbortController.ts` — `createLinkedAbortController(parent?)`
- `src/core/ctfRuntime/profileStore.ts` — `CTFProfileStore`
- `tests/phase16.test.ts` — 30 Phase 1.6 acceptance tests
- `docs/architecture/phase-1.6-audit.md` — pre-change baseline audit
- `docs/architecture/phase-1.6-report.md` — this file

### Modified

- `bin/ovogogogo-ctf.ts` — `runCtfCli(argv, deps)`; `process.once` SIGINT; `process.exitCode`; never `createHarness`
- `src/core/ctfRuntime/taskOrchestrator.ts` — `assemble()` private factory; `recordJobStarted/Updated`; `cancel` async; removed private subscribeJobLifecycle
- `src/core/ctfRuntime/taskEvents.ts` — `JOB_UPDATED` carries `jobId+patch`; removed `JOBS_REPLACED` and `ACTIVE_JOBS_REPLACED`
- `src/core/ctfRuntime/taskStateStore.ts` — new error classes; `JOB_UPDATED` reducer rejects unknown / terminal→running
- `src/core/orchestratorDispatch.ts` — minimal signature; throws without orchestrator; no autoExecute
- `src/core/backgroundJobs.ts` — `JobLifecycleEvent` → `BackgroundJobEvent`
- `src/core/toolBroker.ts` — `setProfile` uses ProfileStore when supplied; no private write in main path
- `tests/ctfRuntime.test.ts`, `tests/ctfMainPath.test.ts`, `tests/e2eHarness.test.ts`, `tests/handoffInheritance.test.ts` — updated for new orchestrator signatures

### Deprecated compat

- `dispatchNext(parent, options)` — old `cwd`/`apiKey`/`baseURL`/`model`/`openaiClient`/`renderer`/`userMessage`/`history` options removed
- `CTFTaskOrchestrator.create(input)` — kept for backward compat with existing tests; new code MUST go through `createCTFTaskRuntime`

## 5. State ownership

| Owner | State |
|-------|-------|
| `CTFTaskStateStore` | TaskState (single source of truth) |
| `CTFProfileStore` | Active profile id (read by ToolBroker, Harness, System Prompt) |
| `CTFTaskOrchestrator.handoffCoordinator` | HandoffRecord lifecycle |
| `CTFTaskOrchestrator` | AgentRunRecord, WorkflowRunRecord, Hypothesis, Attempt, FlagCandidate |
| `BackgroundJobManager` | Job lifecycle (emits events) |
| `TaskStateProjector` | FindingStore + ArtifactStore indices (mirrors into TaskState) |
| `LinkedAbortController` | parent ↔ child abort chain |
| `SpecialistHarnessFactory` | child Harness instance lifecycle |
| `FindingStore` / `ArtifactStore` | durable backing for findings/artifacts |
| `EventLog` | audit NDJSON |

## 6. Verification results

| Command | Result |
|---------|--------|
| `npx tsc --noEmit` | 0 errors |
| `pnpm build` | succeeds |
| `pnpm test` | 366/366 pass (336 pre-existing + 30 new in `tests/phase16.test.ts`) |
| `node dist/bin/ovogogogo-ctf.js --help` | USAGE printed, exit 0 |
| `node dist/bin/ovogogogo-ctf.js --profile crypto --run-workflow encoding_sweep --text 'RkxBR3t0ZXN0fQ=='` | workflow status: success, 6 steps, 1 finding, exit 0 |
| `node dist/bin/ovogogogo-ctf.js --profile orchestrator --run-workflow unknown_file_triage <file>` | triage workflow runs |

## 7. Static-ban checks

| Pattern | Result |
|---------|--------|
| `rg -n "autoExecute" src/core/orchestratorDispatch.ts` | only a doc comment ("no autoExecute") — allowed |
| `rg -n "createHarness" src/core/orchestratorDispatch.ts` | 0 matches |
| `rg -n "child\.runTurn" src/core/orchestratorDispatch.ts` | 0 matches |
| `rg -n "jm\.spawn.*=" src/core/ctfRuntime` | 0 matches |
| `rg -n "setTimeout\(tick,\s*25" src/core` | 0 matches |
| `rg -n "harness\.context\.abortSignal\s*$" src/core` | 0 matches |
| `rg -n "broker.*opts" bin/ovogogogo-ctf.ts` | 0 matches |
| `rg -n "harness\.runWorkflow" bin/ovogogogo-ctf.ts` | 0 matches |
| `rg -n "producedFindingIds:\s*\[\]" src/core/ctfRuntime` | only in `handoffCoordinator.ts` failure-result stubs (per spec note: "本次执行计算后确实没有新产物") |
| `rg -n "producedArtifactIds:\s*\[\]" src/core/ctfRuntime` | only in `handoffCoordinator.ts` failure-result stubs |
| `rg -n "createHarness" src/core/ctfRuntime/specialistHarnessFactory.ts` | 1 match — this is the ONLY allowed Specialist spawn site |
| `rg -n "ACTIVE_JOBS_REPLACED" src` | 0 matches |
| `rg -n "JobLifecycleEvent" src` | 0 matches (renamed to `BackgroundJobEvent`) |

## 8. Unresolved items

None that affect the unique main path. Real, current limitations:
- Real LLM turn cannot run in CI without `OPENAI_API_KEY`; CLI falls back to a clear exit code 3.
- Test stubs use `makeFakeRenderer()` + `makeFakeClient()`; a real renderer integration test is out of scope per §一.

---

**Final completion: ≥95%** — every §三 item satisfied, all §十七 tests pass, every static ban either cleared or documented as legitimately allowed.