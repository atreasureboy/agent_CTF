# Phase 1.7 Baseline — Runtime Correctness Audit

**Pre-change state.** Captures exactly what is wrong with the Phase 1.6
runtime before any five_goal.md edits.

## 1. Baseline commands (2026-07-21 15:26 UTC)

| Command | Result |
|---------|--------|
| `git status --short` | clean (`five_goal.md` untracked, no other changes) |
| `git branch --show-current` | `main` |
| `git log -10 --oneline` | head `5672a5f fix(ctf-runtime): cancel convergence + dynamic profile + §17 gap tests` |
| `git diff --stat` | (clean) |
| `pnpm test` | **378/378 passed** |
| `npx tsc --noEmit` | **0 errors** |
| `pnpm lint` | **113 errors** (legacy lint debt — not blocking this audit) |
| `pnpm build` | succeeds |

## 2. Real findings (pre-change)

### §三 Context 后置覆盖 (3 hits)

```
src/core/ctfRuntime/createCTFTaskRuntime.ts:134:  ;(harness as unknown as { context: TaskExecutionContext }).context = ctx
src/core/ctfRuntime/taskOrchestrator.ts:236:    ;(harness as unknown as { context: TaskExecutionContext }).context = ctx
src/core/ctfRuntime/specialistHarnessFactory.ts:125:    ;(harness as unknown as { context: TaskExecutionContext }).context = linkedContext
```

- `createHarness` constructs its own `taskExecutionContext` from the input
  then returns it. Runtime / Orchestrator / Factory overwrite it after the
  fact. The internal `WorkflowRunner`, `WorkflowEngine`, `ToolBroker`,
  `ExecutionEngine` already captured the old `context` reference — they will
  not see the new one.

### §六 ProfileStore 分叉

`ToolBroker` (src/core/toolBroker.ts) still keeps `private readonly opts.profile`
as a static field. `setProfile()` (line 128-141) has two paths:
- with ProfileStore wired → `profileStore.switchTo(next)`
- without ProfileStore → legacy fallback `(this as unknown as { opts: ToolBrokerOptions }).opts = { ...this.opts, profile: next }`

Production code (`createCTFTaskRuntime`) **does not wire profileStore to the
broker**, so every setProfile in the orchestrator takes the legacy fallback
and mutates a `readonly` field with `as unknown as`. Functional today but
violates §十五 and is a foot-gun if anyone adds the wire.

### §七 Runtime 双入口

`CTFTaskOrchestrator.create(input)` (taskOrchestrator.ts:185-269) re-does
the entire assembly: creates profileStore, harness, dependencies, even
renders the `abort` controller, and the StateStore. Used by
`tests/ctfMainPath.test.ts:641`. This is the second assembly path that
five_goal §七 forbids.

### §七 假 Client / 假 apiKey

```
src/core/ctfRuntime/createCTFTaskRuntime.ts:100:    apiKey: process.env['OPENAI_API_KEY'] ?? 'test-key',
src/core/ctfRuntime/taskOrchestrator.ts:214:      client: input.client ?? ({} as OpenAI),
src/core/ctfRuntime/taskOrchestrator.ts:218:        apiKey: input.apiKey ?? process.env['OPENAI_API_KEY'] ?? 'test-key',
```

Production Runtime silently fills in `{} as OpenAI` when no client is
supplied and `'test-key'` when no api key is set. Both make the runtime
appear to work but break at first real LLM call. There is no
`CTFTaskRuntimeMode` discriminator.

### §九 Workflow Lock 缺陷

```ts
// taskOrchestrator.ts:582-592
private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = this.locks.get(key) ?? Promise.resolve()
  let resolve!: () => void
  const next = new Promise<void>((r) => (resolve = r))
  this.locks.set(key, prev.then(() => next))
  try {
    await prev
    return await fn()
  } finally {
    resolve()
    if (this.locks.get(key) === next) this.locks.delete(key)  // ← always false
  }
}
```

The finally clause compares `this.locks.get(key) === next`, but the map
already holds `prev.then(() => next)` — never equal. **Lock Map entries are
never removed.** 100 sequential calls leave 100 entries.

### §九 / §十 dispose 顺序错误

```ts
// taskOrchestrator.ts:553-565
async dispose(): Promise<void> {
  if (this.disposed) return
  this.disposed = true
  await this.cancel('dispose')
  this.abort.unlink()
  await this.handoffCoordinator.disposeAll()
  await Promise.allSettled([...this.inFlightWorkflows.values()])
}
```

- `disposed = true` is set **before** cancel — so a concurrent cancel sees
  `disposed=true` and returns immediately, but `dispose()` itself also
  cancels. Fine for idempotency, but the design conflates `disposed` and
  `cancelled` (only two booleans).
- No distinction between `disposing` / `disposed` / `cancelling` / `cancelled`
  / `active` (five_goal §八 要求 5-state).
- `cancel()` is awaited **before** `unlink()` — wrong: should cancel
  children, then unlink.

### §十 Specialist 共享 Abort Controller

`HandoffCoordinator.cancel(handoffId)` (handoffCoordinator.ts:110-112) only
emits HANDOFF_CANCELLED to the store — does NOT call any abort controller.
The specialist's abort relies on the parent's `LinkedAbortController`
firing. There is **no per-specialist AbortController** — five_goal §五
demands each Specialist owns one.

### §十 Capability 选择不完整

`selectAgentForCapability` (handoffCoordinator.ts:199-233) checks:
- agent exists
- binary availability via `checkRegistryAvailability`

Does NOT check:
- requestedCapability is in the profile's `supportedCapabilities`
- `requiredTools` / `requiredBinaries` are present
- profile is enabled (no `enabled` flag)

When no agent matches, it falls back to returning `null` and the
`approveAndRun` flow synthesizes a SPECIALIST_FAILED with `agentRunId: ''`
and an empty `agentRun` — five_goal §十一.1 says selection failure must
emit a distinct `HANDOFF_FAILED stage='selection'` event and **not**
fabricate an empty AgentRun.

### §十一 Terminal Handoff 重复 approve

`approveAndRun` (handoffCoordinator.ts:128-137) returns a synthetic stub:

```ts
if (this.isTerminal(h.status)) {
  return {
    agentRunId: '',
    profileId: h.selectedAgentId ?? h.requestedAgentId ?? h.requestedCapability,
    status: h.status === 'completed' ? 'completed' : 'failed',
    summary: h.status,
    producedFindingIds: [],
    producedArtifactIds: [],
  }
}
```

five_goal §十一.2: must either return the stored real result OR throw
`HandoffAlreadyTerminalError`. Returning a fake object is forbidden.

### §十二 Specialist Store 隔离

Currently Specialist shares the parent's `artifactStore` / `findingStore`
(specialistHarnessFactory.ts:122-123). five_goal §十二 says each
Specialist must have an **independent** child store, then project back to
parent via Projector with lineage. Tests share too — this hides real
runtime semantics.

### §十三 Projector 错误吞噬 + Run 归属

`taskStateProjector.ts`:
- Uses snapshot diff (before / after) — under concurrent Main + Workflow
  runs, AgentRun A can claim WorkflowRun B's findings.
- No `taskId` / `agentRunId` / `workflowRunId` / `handoffId` injection
  into inner context — diff can't filter by producer.
- No `ProjectionError` class — silent failures on file copy / lineage.

### §十四 CLI 参数解析

```ts
// bin/ovogogogo-ctf.ts:120-141
for (const arg of args) {
  switch (arg) {
    case '--profile': profile = takesValue(args.indexOf(arg)); break
    ...
  }
}
```

- `args.indexOf(arg)` finds the FIRST occurrence of the flag, not the
  current one. Repeating `--profile crypto --profile pwn` always reads the
  first.
- `task` is collected via raw positional push at the end (`args.slice(...)`)
  so any positional `--task "foo"` after a flag will be consumed by the
  flag's `takesValue` if it appears earlier.
- No `--flag=value` form.
- No `--` separator.

### §十五 Signal Handler 清理

```ts
// bin/ovogogogo-ctf.ts:300-315
const register = deps.registerSignals ?? ((h) => {
  process.once('SIGINT', () => h('SIGINT'))
  process.once('SIGTERM', () => h('SIGTERM'))
  return () => {
    process.removeAllListeners('SIGINT')   // ← removes ALL handlers
    process.removeAllListeners('SIGTERM')
  }
})
```

- `process.removeAllListeners('SIGINT')` removes handlers installed by other
  modules (jest workers, telemetry, other tests).
- `process.once` means the handler fires at most once, so 2nd SIGINT after
  dispose falls through to process default.

### §十六 测试是表面而非行为

- `tests/phase16.test.ts:156-172`: only checks `body.toString()` for
  forbidden patterns (static check). No real behavior.
- `tests/phase16.test.ts:184-203` (SIGINT test): manually calls
  `signalHandler('SIGINT')` rather than driving through the CLI's real
  `installSignalHandlers` with a fake process. The test does prove
  cancel→TASK_COMPLETED but bypasses the actual signal handler factory.
- `tests/phase16.test.ts:430-475` (Workflow cancel): tests `store.apply`
  directly, no real `runWorkflow` + mid-flight cancel.
- `tests/phase16E2E.test.ts`: shares parent's stores with specialist —
  production semantics are already mixed, so the test never covers the
  independent-store path.

### §十七 行为测试缺口

Missing per five_goal §十七:
- Context identity (`harness.context === workflowRunner.context === toolContext`)
- switchProfile changes Tool visibility / Tool policy (not just prompt)
- Slow Main Agent cancelled
- Slow Workflow cancelled
- Single Specialist cancelled without killing parent
- 100 calls lock Map is empty afterwards
- Aborted waiter exits
- Concurrent Main + Workflow produceFindingIds attribution
- CLI: duplicate `--profile`, `--` separator, missing value

## 3. Assembly order (pre-change)

```
createCTFTaskRuntime(input):
  1. resolve contestConfig
  2. create ProfileStore
  3. createHarness(input)         ← harness creates its own context internally
  4. ensureWorkflowsRegistered
  5. createLinkedAbortController(undefined)
  6. build AgentRuntimeDependencies
  7. *** overwrite harness.context with new TaskExecutionContext ***   ← late binding
  8. create initial CTFTaskState
  9. create CTFTaskStateStore
 10. emit TASK_CREATED
 11. construct CTFTaskOrchestrator (which wires projector + handoffCoordinator)
 12. subscribe background-job events
```

The flaw is step 7 — at step 3, the Harness already captured
`harness.context` into its `WorkflowRunner`, `WorkflowEngine`, `ToolBroker`,
and the `ExecutionEngine` closure. Step 7 patches `harness.context` but the
internals keep the old reference.

## 4. Lifecycle (pre-change)

| Stage | Behavior |
|-------|----------|
| `cancel(reason)` | async; sets `cancelled=true`; aborts controller; cancelAllJobs; cancelAll handoffs (synthetic); catch in-flight workflows; apply TASK_COMPLETED cancelled |
| `dispose()` | sets `disposed=true` first, then `await cancel`, then `unlink`, then `disposeAll` handoffs, then `allSettled` workflows |
| Specialist cancel | only emits HANDOFF_CANCELLED; relies on parent abort |
| Job cancel | `cancelTask(taskId, reason)` from BackgroundJobManager |
| Lock cleanup | finally compares `locks.get(key) === next` (always false) → leak |

## 5. State ownership (pre-change)

| State | Owner |
|-------|-------|
| Context | createHarness (internal) → overwritten at runtime |
| Profile | ProfileStore (current) ↔ broker.opts.profile (legacy fallback) — drift |
| AbortController | LinkedAbortController at runtime level |
| AgentRun | CTFTaskStateStore |
| WorkflowRun | CTFTaskStateStore |
| Handoff | CTFTaskStateStore |
| Finding | FindingStore + TaskState.findings (no per-Run ID) |
| Artifact | ArtifactStore + TaskState.artifactIds (no per-Run ID) |

## 6. Required deletions

- `(harness as unknown as { context: TaskExecutionContext }).context = ...` (3 hits)
- `({} as OpenAI)` and `'test-key'` fallbacks
- `CTFTaskOrchestrator.create` static method (or replace with delegate)
- `this.opts.profile` reads in ToolBroker
- `process.removeAllListeners('SIGINT'|'SIGTERM')`
- `args.indexOf(arg)` parser
- Lock-map leak in `withLock`
- Empty `catch {}` (none found, but `catch { /* best-effort */ }` should be removed where it hides projection / lifecycle errors)
- Per-specialist shared controller

## 7. Will-change summary

Phase 1.7 will:

1. Construct Context before `createHarness`. Pass it in. Delete the
   `(harness as unknown as { context }).context` mutations.
2. Add `CTFTaskRuntimeMode = 'workflow-only' | 'llm'`. Reject
   `runMainAgent` in workflow-only mode.
3. Remove `({} as OpenAI)` / `'test-key'` fallbacks in production paths.
4. Wire ProfileStore into ToolBroker. Delete `(this as unknown as ...).opts`
   mutation. Use ProfileStore as the single source.
5. Move `CTFTaskOrchestrator.create` test path to a `forTestingOnly` static
   helper or eliminate.
6. Add per-Specialist AbortController in factory. `cancelHandoff` calls it.
7. Add HANDOFF_FAILED event with stage. Selection failure path emits this,
   not SPECIALIST_FAILED with empty agentRunId.
8. Implement `withKeyLock` that actually clears its map entry.
9. Add `disposing`/`disposed`/`cancelling`/`cancelled`/`active` distinction.
10. CLI: index-based parser; `--flag=value`; `--` separator; positional task;
    `--input ./sample.bin`; duplicate strategy; unknown flag error.
11. CLI Signal: track handlers; `process.off(handler)` not
    `removeAllListeners`. Idempotent shutdown via cached promise.
12. Projector: throw `ProjectionError` instead of swallow. Inject
    `agentRunId` / `workflowRunId` / `handoffId` into inner context so
    diff can filter. Add Lineage with `parentTaskId`, `childTaskId`.
13. Specialist store isolation: child findingStore + artifactStore under
    parent's sessionDir, projector copies with streaming read+write.
14. Behavior tests for each §十七 item.