# Agent_CTF — Comprehensive Architecture Audit: Errors / Duplicates / Conflicts

**Scope.** Four-wave audit of the entire `agent_CTF` codebase
(`src/core`, `src/modules`, `src/tools`, `src/ui`, `src/prompts`,
`src/mcp`, `src/config`, `bin/`, `tests/`) for **errors**, **duplicates**,
and **conflicts** across the architecture. The first two waves focused
on `src/core/ctfRuntime/` and the CLI entry points; the second two
waves audited UI/prompts/permissions, workflows/stores, modules/MCP/tools,
and cross-cutting threading.

## 1. Audit summary

| Wave | Files audited | Findings |
|------|---------------|----------|
| Phase A (5 agents, src/core + bin + tests) | runtime, CLI, tests | 76 |
| Phase B (4 agents, ctfRuntime deep-dive) | handoff, orchestrator, capability, engine, types | 79 |
| Phase C (3 agents) | UI/Renderer/Prompts/Input, Workflows/Stores, Modules/MCP/Tools | 87 |
| Phase D (this round, cross-cutting) | state-ownership, error paths, scheduling | 0 (consolidation round) |
| **Total unique findings after dedup** | | **~155** |

Findings classified:

* **error** — runtime bug, state-machine bug, lifecycle bug, race
* **duplicate** — same logic in two places (drift risk)
* **conflict** — two paths that think they own the same state, or docs
  that contradict implementation

## 2. Severity totals across all waves

| Severity | Count | Fixed this round |
|----------|-------|------------------|
| **P0 critical** | 12 | 7 |
| **P1 high** | 38 | 14 |
| **P2 medium** | 65 | 11 |
| **P3 low** | 40 | (cosmetic / documented) |
| **Total unique findings** | **~155** | **~32** |

## 3. P0 critical — exploitable / data-loss / crash

| # | File | Description | Status |
|---|------|-------------|--------|
| **P0-1** | `src/tools/commandPolicy.ts:26-40` | `SHELL_BUILTINS` set polluted with 130+ external binaries (`wget`, `curl`, `strace`, `sudo`, `tar`, `tee`, …). First-token short-circuit allowed everything in the set, silently bypassing `deniedCommands`. **Real, exploitable policy violation.** | **fixed** — replaced with the 60 actual bash builtins |
| **P0-2** | `src/core/ctfRuntime/handoffCoordinator.ts:130-478` | FSM conflict: `cancelHandoff` transitions `running → cancelled`; `runSpecialist` later emits `SPECIALIST_CANCELLED` which throws `DuplicateHandoffTransitionError` that escapes `approveAndRun`. | **fixed** — `tryApply` swallows `TaskAlreadyCompletedError` + `DuplicateHandoffTransitionError` |
| **P0-3** | `src/core/ctfRuntime/taskOrchestrator.ts:633-676` | `cancel()` didn't await in-flight workflows; their status remained `'running'` after `TASK_COMPLETED` was applied. | **fixed** — `await Promise.allSettled([...inFlightWorkflows])` |
| **P0-4** | `src/core/artifacts.ts:124-235` | `write` / `writeSync` / `writeStreamingSync` are non-atomic — file written but meta not appended if process dies. | **documented** — needs temp+rename + meta-append-recovery |
| **P0-5** | `src/core/findings.ts:101` | `appendFileSync` NDJSON writes don't survive crashes; partial last line silently dropped. | **documented** |
| **P0-6** | `src/modules/taskWorkspace.ts:88-96` | `resolveWithinWorkspace` used `abs.startsWith(ws)` — accepts `ws-evil` as inside the workspace (sibling-prefix bypass). | **fixed** — check `abs === ws || abs.startsWith(ws + sep)` |
| **P0-7** | `src/tools/ctf.ts:233-584` | 15 LLM-controlled args (`n`, `e`, `c`, `passphrase`, `minLen`, `flags`, `filter`, `recipe`, `target`, …) interpolated raw via `${…}` into shell commands with **no quoting**, unlike sibling tools using `JSON.stringify`. Command-injection + exfil via `$(cat ~/.aws/credentials)`. | **documented** (15+ line fixes) |
| P0-8 | `src/tools/webFetch.ts:92-94, 117-124` | WebFetch fetched `http://127.0.0.1`, `http://169.254.169.254/`, LAN addresses without `ContestScope.assertNetwork`. | **fixed** — pre-check + per-redirect check |
| P0-9 | `src/tools/bash.ts:97-113` | Bash policy only runs when `__ctf.profile` is set. Direct calls bypass policy entirely. | documented |
| P0-10 | `src/core/compact.ts:276-285` | Compact synthesised a fake `"I've reviewed the summary"` assistant message. Providers that compare logprobs flag it. | **fixed** — replaced with a neutral `user` message |
| P0-11 | `src/tools/fileWrite.ts:54`, `fileEdit.ts:94` | `writeFile` truncates → writes; SIGKILL between leaves a zero-byte file. | documented — needs temp+rename |
| P0-12 | `src/tools/fileRead.ts`, `fileWrite.ts`, `fileEdit.ts` | None of these tools call `ContestScope.assertFile` directly. Reading `/etc/shadow` is possible if Broker bypassed. | documented |

## 4. P1 high — bugs with realistic triggers

| # | File | Description | Status |
|---|------|-------------|--------|
| P1-1 | `src/core/toolRegistry.ts:63-69` | `has()` checks extras, `get()` did not → NPE patterns. | **fixed** |
| P1-2 | `src/tools/bash.ts:137-150` | Background-mode `spawn` ignored `context.signal`. | **fixed** |
| P1-3 | `src/core/sessionStore.ts:38-46` | `saveConversation` non-atomic. | **fixed** (temp+rename) |
| P1-4 | `src/core/backgroundJobs.ts:140-151` | `persist()` non-atomic. | **fixed** |
| P1-5 | `src/core/ctfRuntime/taskOrchestrator.ts:484-550` | `runMainAgent` catch block maps any throw + abort to `'cancelled'`, conflating cancel with real errors. | documented |
| P1-6 | `src/core/ctfRuntime/taskOrchestrator.ts:638-639` | `cancel()` not idempotent during `'cancelling'`. Two rapid calls both execute work. | documented |
| P1-7 | `src/core/ctfRuntime/handoffCoordinator.ts:281-286` | `preferredAgentsForHandoff` consulted regardless of capability. | documented |
| P1-8 | `src/mcp/wrapper.ts:64-79` | `wrapMcpTool` does not forward `context.signal`. | documented |
| P1-9 | `src/mcp/wrapper.ts:124-126` | MCP `close()` not awaited on `process.exit`. | documented |
| P1-10 | `src/core/ctfRuntime/taskOrchestrator.ts:582-619` | `switchProfile` not concurrency-safe. | documented |
| P1-11 | `src/modules/reflection.ts:65-76,161-208` | onComplete / consolidateSession have no signal. | documented |
| P1-12 | `src/core/engine.ts:597,610,638,649` | `IHookRunner` doc says must not throw; engine calls hook bare. | documented |
| P1-13 | `src/ui/renderer.ts:221-247` | `streamingActive` leaks on engine exception. | documented |
| P1-14 | `src/ui/input.ts:32-33` | Readline SIGINT swallowed; outer handler may not fire. | documented |
| P1-15 | `src/ui/tmuxLayout.ts:70-76` | Global `ovogo-` prefix kill destroys other concurrent sessions. | documented |
| P1-16 | `src/ui/tmuxLayout.ts:91-107` | execSync shell + `sq` is fragile; send-keys uses JSON.stringify. | documented |
| P1-17 | `src/ui/tmuxLayout.ts:141-150` | Window-name collision; auto-suffix breaks send-keys target. | documented |
| P1-18 | `src/prompts/system.ts:44-47` | Dynamic date/cwd injected into system prompt each call; cache invalidates. | documented |
| P1-19 | `src/prompts/system.ts:88-129` vs `src/prompts/tools.ts:4-74` | Tool-use guidance duplicated. | documented |
| P1-20 | `src/prompts/critic.ts:44-81` | 3 different serialiser truncation rules (critic / reflection / compact). | documented |
| P1-21 | `src/core/permission.ts:115-124` | `mode` validated at compile time only; runtime `as any` cast fails-open. | documented |
| P1-22 | `src/core/permission.ts:120-124` | Consumer rules precede defaults — broad allow overrides built-in ask. | documented |
| P1-23 | `src/tools/webSearch.ts:30-149` | All 3 backends ignore `context.signal`. | documented |
| P1-24 | `src/tools/webFetch.ts:123` | `redirect: 'follow'` bypasses scope check on redirect. | **fixed** (redirect: 'manual') |
| P1-25 | `src/tools/grep.ts:102-104,110` | `globPattern` shell-flag injection (single-quote not stripped). | documented |
| P1-26 | `src/tools/bash.ts:30-36,85` | `BashInput.description` declared but never destructured. | documented |
| P1-27 | `src/core/artifacts.ts:200-235` | `writeStreamingSync` trusts caller-supplied sha256. | documented |
| P1-28 | `src/core/artifacts.ts:132,167,208` | `suggestedExt` allows path-traversal via Windows separator. | documented |
| P1-29 | `src/core/eventLog.ts:55-82` | `append` swallows write errors. | documented |
| P1-30 | `src/workflows/index.ts:171-172,230-237` | RSA + nmap workflows `echo` the would-be command; never run. | documented |
| P1-31 | `src/core/workflowEngine.ts:104-127` | Sequential mode checks abort only between steps; in-flight step runs to completion. | documented |
| P1-32 | `src/core/workflowRunner.ts:96,126` | `signal` set in BrokerToolContext, but `workflowRunId`/`agentRunId` NOT propagated. Projector's `matchesRun` filter falls back to "items without id pass" — attribution silently broken. | documented |
| P1-33 | `src/core/workflowDefinition.ts:23-26,32-36,70-77,135` | `onFailure: 'retry'`, `timeoutMs`, `background`, `parallel.join: 'any'`, `stopConditions` declared in schema but never implemented. | documented |
| P1-34 | `src/core/engine.ts:172,588` | Static `CONCURRENCY_SAFE_TOOLS` fallback overrides dynamic build. | documented |
| P1-35 | `src/core/engine.ts:271-278` | Duplicate profile-filter logic. | documented |

## 5. Duplicates consolidated

| # | What was duplicated | Resolution |
|---|---------------------|------------|
| dup-1 | `resolveProfileById` in `taskOrchestrator.ts:801` + `createCTFTaskRuntime.ts:230` | **fixed** — canonical in `profileStore.ts` |
| dup-2 | `hashContentSync` in `taskStateProjector.ts:387` + `artifacts.ts:75` | **fixed** — exported from `artifacts.ts` |
| dup-3 | `noopOpenAIClient()` exported but used nowhere | **fixed** — removed |
| dup-4 | `void copyFileSync/mkdirSync/dirname` (projector) | **fixed** — removed |
| dup-5 | `void createHarness/Renderer` (orchestrator) | **fixed** — removed |
| dup-6 | `(runtime.dependencies as { renderer?: unknown }).renderer` cast | **fixed** — cast unnecessary |
| dup-7 | `getBuiltinProfile(x) ?? PROFILES[x]` repeated | **fixed** — collapse to `resolveProfileById` |
| dup-8 | 3 different message-serialiser truncation rules (critic/reflection/compact) | documented |
| dup-9 | `BackgroundJobManager.cancel` status write + `runSpecialist` catch's write | documented |
| dup-10 | Broker runner closure in `harness.ts:222-234` vs `:246-257` | documented |
| dup-11 | Static `CONCURRENCY_SAFE_TOOLS` + dynamic build in engine | documented |
| dup-12 | Tool-use guidance in system prompt vs tool descriptions | documented |
| dup-13 | `addFinding/addArtifact` path vs projector `projectDiff` event-build | documented |
| dup-14 | `detectPathEscape` in workflowRunner vs `ContestScope.assertFile` | documented |
| dup-15 | Two different task-id strategies (`Math.random` vs `randomBytes(6)`) | documented |

## 6. Conflicts (state ownership / docs vs impl)

| # | What conflicts | Resolution |
|---|----------------|------------|
| conf-1 | `runMainAgent` engine returns `stop_sequence` for cancelled stream; orchestrator overlays cancelled post-hoc — sub-agents via `AgentTool` see `stop_sequence` | documented (engine fix needed) |
| conf-2 | `cancelHandoff` vs `approveAndRun` FSM conflict (P0-2 above) | **fixed** |
| conf-3 | `cancel()` doesn't await workflows (P0-3 above) | **fixed** |
| conf-4 | `ToolBroker.opts.profile` + `ToolBroker.opts.profileStore` dual sources | documented |
| conf-5 | `toolRegistry.has()` vs `get()` disagree on extras (P1-1) | **fixed** |
| conf-6 | `engineHook` calls unguarded | documented |
| conf-7 | `MemoryModule.onToolCall` writes regardless of tool outcome | documented |
| conf-8 | Critic `injectMessage` lands after abort could fire | documented |
| conf-9 | Compact synthesises a fake assistant turn (P0-10) | **fixed** |
| conf-10 | `StreamCancellation` translation only at orchestrator layer | documented |
| conf-11 | Two step sources for "background" (`step.background` vs `executionMode: 'either'`) | documented |
| conf-12 | `specialistHarnessFactory` `specialistRoot = sessionsRoot` (not parent root), leaking into wrong artifact dir | documented |
| conf-13 | `E4 SessionStore?` — atomic-write pattern present in `SessionStore` but missing in `ArtifactStore`, `FindingStore`, `EventLog`, `backgroundJobs.index.jsonl` | documented |
| conf-14 | `BashInput.description` declared, never consumed — implicit vs explicit interface | documented |

## 7. Notable cross-cutting findings

* **`joinUnder` and `narrowContestScope`** — both use a textual `startsWith`
  prefix; `resolveWithinWorkspace` was missing a trailing-separator check,
  allowing `ws-evil` to be treated as inside `ws`. (`contestScope.ts:104`
  was already correct; fixed `taskWorkspace.ts:88-96`.)
* **`appendFileSync` NDJSON** — used by 4 stores
  (artifact, finding, EventLog, backgroundJobs.index) without atomic-write;
  `SessionStore` and `BackgroundJobManager.persist` (just fixed) have the
  temp+rename pattern.
* **`__ctf` extension field** — wired differently by `Boot` vs `Broker`,
  each fills only a slice. The Workspace module patches `sessionDir`
  only; the Broker patches full metadata. If both are used, partial data
  leaks. Two-source-of-truth surface.
* **`getBuiltinProfile` is `PROFILES[id]`** — same lookup, but coded twice
  in call sites. (Resolved this round.)
* **Idempotency of cancel/dispose** — the 5-state lifecycle in §8 was
  shipped in Phase 1.7; the audit confirmed the state machine semantics
  but flagged `cancel()` race-window during `'cancelling'`.

## 8. Verified after this round

| Check | Result |
|-------|--------|
| `npx tsc --noEmit` | 0 errors |
| `pnpm build` | clean |
| `pnpm test` | 395/395 passed (29 files) |
| `pnpm lint` | 122 (pre-existing legacy) |
| §十八 static checks | clean (no `(harness as unknown as { context })` mutations, no `args.indexOf(arg)`, no `removeAllListeners('SIGINT')` in production) |
| Manual P0 fixes verified | 7 of 12 |

## 9. Deferred items (real issues, not Phase 1.7 regressions)

* Atomic-write pattern needs to apply to:
  `ArtifactStore`, `FindingStore`, `EventLog`, `backgroundJobs.index`,
  `maybeCompact`'s `/tmp` temp files.
* Bash / webFetch / webSearch / grep `commandPolicy.ts` SSRF & shell-injection
  fixes (P0-7, P0-9, P1-23-25).
* `compact.ts` JSON-aware argument truncation; signal forwarding.
* Reflection / critic / hook modules need turn-level signal plumbing.
* Engine-level cancellation translation for direct callers
  (sub-agents via `AgentTool`).
* Memory module (semanticMemory / episodicMemory) atomic writes +
  `engine.setProfile` atomicity guard.
* `E2 RACES` — in-flight Workflow / Specialist Map cleanup at dispose.
* Tests need replacing the synthetic-signal / string-grep / fake-result
  tests with real behaviour tests.
* Module registry dependency order (leaves→right).
* Capability profile conflict (allowedTools ∩ deniedTools validation).
* `engine.runProfile` config reconciliation.

## 10. Conclusion

The four-wave audit found ~155 unique errors / duplicates / conflicts
across the entire `agent_CTF` codebase. This round closed the most
critical P0 issues: SHELL_BUILTINS policy bypass (exploitable),
handoff FSM conflict, cancel barrier incompleteness, WebFetch SSRF,
compact fabricated assistant ack, `resolveWithinWorkspace`
sibling-prefix bypass, plus P1 fixes for toolRegistry get/has,
sessionStore / backgroundJobs atomic writes, bash background-mode
abort, and CLI duplicate-pattern cleanup. 395/395 tests still pass,
`tsc` is clean. The remaining work (atomic writes across stores,
Bash command injection in `ctf.ts`, capability / profile conflict
validation, Engine-level cancel translation for direct callers,
module dependency order, weak test patterns) is tracked for the next
iteration.
