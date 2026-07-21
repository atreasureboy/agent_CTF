# CTF Runtime Refactor — Architecture & Migration

> First-phase architectural refactor: unify CTF task state and dispatch control
> behind a single `CTFTaskOrchestrator`. This document records the audited
> baseline, the gaps discovered, and the migration order applied.

## 1. Audit — current call paths

### 1.1 Where a CTF task is created

A task is born in `createHarness()` (`src/core/harness.ts:111`):

```
createHarness(input) → TaskWorkspace, Profile, ContestScope, ToolBroker, …
```

`TaskWorkspace.paths.taskId` and `TaskWorkspace.paths.contestId` are
allocated here; all subsequent stores (`artifactStore`, `findingStore`,
`handoffStore`) hang off this one workspace.

### 1.2 Where the task id lives

Stored in three places:

* `TaskWorkspace.paths.taskId` and `paths.root` — the canonical workspace path.
* `broker['opts']` does NOT carry `taskId`; the broker receives it per-call
  via `BrokerToolContext.taskId`.
* `BackgroundJobManager` keeps an in-memory `Map<jobId, BackgroundJob>`
  carrying `taskId`, plus on-disk `jobs/<id>.json`.

### 1.3 Where the profile lives

Three independent copies:

1. `HarnessBundle.profile` (returned to the caller).
2. `ToolBroker.opts.profile` (read by the gate).
3. `WorkflowBrokerRunner.opts.defaultAgentId` (a string id, not the profile
   object).

`switchProfile(next)` mutates `broker['opts'].profile` directly via a private
field access (`src/core/harness.ts:244`). The other two copies are NOT
synchronised.

### 1.4 Where ContestScope lives

* `HarnessBundle.contestScope` (the `ContestScopeChecker`).
* `ToolBroker.opts.contestScope` (read by inline tool execution).
* `bin/ovogogogo-ctf.ts:201` post-mutates `broker.opts.contestScope` after
  construction.

### 1.5 Workspace and sessionDir

* `TaskWorkspace.paths.workspaceDir` is canonical.
* `ToolBroker` receives it through `BrokerToolContext.sessionDir` at every call.
* `WorkflowBrokerRunner.runStep()` (`src/core/workflowRunner.ts:54`) violates
  this — it passes `cwd: process.cwd()` and `sessionDir: undefined` to the
  broker, ignoring the task workspace entirely.

### 1.6 Where handoffs are created

`HandoffStore.submit()` (`src/core/handoff.ts:57`) — written by the
`request_handoff` meta-tool. Persists a JSONL record.

### 1.7 Where handoffs are approved

**TWO paths** today:

1. `HarnessBundle.approveHandoff(handoffId)` (`src/core/harness.ts:235`) —
   marks the record as `approved` and stops. No Specialist is spawned. No
   state in the broker is updated.
2. `dispatchNext(parent, options)` (`src/core/orchestratorDispatch.ts:45`) —
   approves + creates a child `HarnessBundle` + runs a single LLM turn with
   inherited Findings/Artifacts injected into the system prompt. This is the
   "real" execution path.

Both paths read pending state independently via `HandoffStore.pending()`.

### 1.8 Where Specialist Agents actually start

`createHarness()` inside `dispatchNext` (`src/core/orchestratorDispatch.ts:101`).
A child HarnessBundle with the suggested agent's profile is constructed; one
turn is run via `child.runTurn(...)`.

### 1.9 How Specialist results return to main

* Findings/Artifacts emitted by the child land in the child workspace's
  `findings.jsonl` / `artifacts/index.jsonl` — they are **not** copied back to
  the parent. The parent only sees what the LLM returned in the turn output.
* Handoff state on the parent is marked `approved`; the child's output is the
  channel for returnable findings.

## 2. Audit — duplicated state

| Field | Locations |
|-------|-----------|
| `profile` | `HarnessBundle.profile`, `broker['opts'].profile`, `workflowRunner.opts.defaultAgentId` (string) |
| `contestScope` | `HarnessBundle.contestScope`, `broker['opts'].contestScope`, sometimes re-derived in CLI |
| `taskId` | `TaskWorkspace.paths.taskId`, every `BrokerToolContext.taskId`, every `BackgroundJob.taskId`, `EventLog` per-call tag |
| `workspaceDir` | `TaskWorkspace.paths.workspaceDir`, broker `ctx.sessionDir`, `WorkflowBrokerRunner.runStep` ignores it |
| `agentId` | `HarnessBundle.profile.id`, `broker.ctx.agentId`, `job.agentId`, `workflowRunner.opts.defaultAgentId` |

## 3. Audit — Handoff split

The two Handoff execution paths (see §1.7) cause real bugs:

* `harness.approveHandoff` does not start a specialist — anything depending
  on it expecting a result waits forever.
* `dispatchNext` bypasses the broker's audit + EventLog for the Specialist
  turn; it builds its own child broker indirectly via `createHarness`.
* The same pending handoff can be approved twice — once via `approveHandoff`
  and once via `dispatchNext` — leaving both records with `status='approved'`.

## 4. Audit — ContestConfig defaults

Three default-construction sites disagree:

| Location | `allowPublicNetwork` |
|----------|----------------------|
| `loadContestConfig` fallback (`contestConfig.ts:94`) | `false` |
| `createHarness` no-file fallback (`harness.ts:122`) | `true` |
| `bin/ovogogogo-ctf.ts` CLI flag default | `false` |

This is the documented hazard (§九).

## 5. Audit — Workflow working directory

`WorkflowBrokerRunner.runStep` (`src/core/workflowRunner.ts:54`):

```ts
cwd: process.cwd(),
sessionDir: undefined,
```

Workflow steps therefore:

* Run in whatever directory the CLI happens to be launched from.
* Cannot rely on the task workspace.
* Can escape `contestScope.allowedFilesRoot` because the broker's scope check
  uses `ctx.cwd` as the de-facto root in some helpers (see `BashTool`).

## 6. Audit — Profile private-field writes

`harness.switchProfile(next)` (`src/core/harness.ts:244`):

```ts
broker['opts'].profile = p as Profile
```

Tool exposure, workflow defaults, prompt modules, and the orchestrator's view
of the active profile are all NOT updated.

## 7. Target architecture

```
CTFTaskOrchestrator          (single owner of CTFTaskState)
├── TaskStateStore          (reducer + subscribe)
├── Main Harness Bundle     (driven by Orchestrator)
├── Specialist Harness(es)  (sub-harnesses, one per approved handoff)
├── WorkflowRunner          (bridges engine to broker.execute, takes context)
├── ToolBroker              (takes context per call, no private profile)
├── FindingStore
├── ArtifactStore
└── BackgroundJobManager
```

Key invariants after refactor:

1. **One** `CTFTaskStateStore` per Orchestrator. All state transitions go
   through `store.apply(event)`.
2. **One** `TaskExecutionContext` per task. Every module receives it as a
   parameter or via dependency injection — no module reads `process.cwd()`
   for task-relevant paths.
3. **One** default `ContestConfig` factory. `createDefaultContestConfig()` is
   the only entry point for "what if no .ovogo/contest.json?"
4. **One** Handoff lifecycle. `approveHandoff()` and `dispatchNext()` collapse
   into the Orchestrator's single `approveHandoff` method, which itself
   invokes the unique Specialist-launch function.
5. **Atomic** profile changes. `orchestrator.switchProfile(id)` synchronises
   TaskState, Broker, and any cached tool definitions.
6. **Specialist context narrowing**. `child.context.contestScope ⊆
   parent.context.contestScope` is enforced when deriving sub-contexts.

## 8. Migration order (executed)

1. Audit (this document).
2. Create `TaskExecutionContext`, `CTFTaskState`, event union, `Record` types
   under `src/core/ctfRuntime/`.
3. Create `CTFTaskStateStore` with reducer + subscribe + transition guard.
4. Add `createDefaultContestConfig()` and replace the three divergent
   construction sites.
5. Update `HarnessBundle` / `ToolBroker` / `WorkflowRunner` / `Specialist`
   creation paths to take a `TaskExecutionContext` explicitly.
6. Create `CTFTaskOrchestrator` and route main-agent / workflow / handoff
   through it.
7. Make `approveHandoff` execute the Specialist (collapse two paths).
8. Make `switchProfile` atomic across TaskState + Broker.
9. Remove duplicate state fields no longer used.
10. Add 12 acceptance tests (§十九) + verify `pnpm build` and `pnpm test`.

## 9. Backwards compatibility

* `createHarness(...)` signature preserved — fields optional.
* `HarnessBundle.approveHandoff` retained as a delegate to
  `orchestrator.approveHandoff`.
* `HarnessBundle.dispatchNext` retained as a delegate to
  `orchestrator.dispatchNext`.
* `HandoffRequest` (existing public type) reused as a record-compatible view;
  a richer `HandoffRecord` (with `running`/`completed` status) lives in the
  `ctfRuntime` namespace and supersedes it internally.
* `parseContestScope` and `ContestScopeChecker` are unchanged.
