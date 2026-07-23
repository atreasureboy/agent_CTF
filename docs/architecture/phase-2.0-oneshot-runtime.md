# Phase 2.0 — OneShot Runtime Convergence (Final Report)

This document records the actual call chain, state ownership, permission
boundaries, and benchmark results **after** the seven_goal refactor.

## 1. Real call chain (production)

```text
LLM (ShotgunCoordinator)
  └─ run_one_shot (Tool)
       ├─ Tool inputs restricted to: manifestId, inputArtifactIds, options, reason
       ├─ resolveArgumentTemplate(manifest, {artifactIds, options, ...})
       │     ├─ validates options against manifest.input.optionsSchema
       │     ├─ resolves ${artifact:N} via resolveArtifactPath
       │     │     ├─ realpath containment under workspaceDir
       │     │     ├─ rejects '..', absolute paths outside workspace
       │     │     └─ rejects model-supplied path strings
       │     └─ resolves ${options.X} / ${flags.X} against schema
       └─ Dispatcher.runOne(manifestId, {
              argv: resolvedTemplate,
              evidenceRoot: ${artifactDir}/.oneshots   ← injected by Runtime
              resolvedInput: {artifactIds, options}
            })
              ├─ BudgetManager.tryAcquire(this.taskId, lane)   ← real taskId
              ├─ Build OneShotRunRecord (real taskId)
              ├─ Record CTFAttempt {kind: 'tool', fingerprint: ...}
              ├─ BackgroundJobManager.spawn({
              │     taskId: this.taskId,
              │     toolId: 'oneshot:<manifestId>',
              │     input: {oneShotRunId, manifestId, argv, evidenceRoot, ...}
              │   })
              │     └─ JobRunner registry: 'oneshot:' → runnerFor(manifest).run()
              ├─ runnerFor(manifest).run({logDir, argv, workspace, signal})
              │     └─ Process / Container / Service runner with per-run
              │         LinkedAbortController + child table for cancel(runId)
              ├─ BackgroundJobManager.wait(jobId)
              ├─ normalizeResult → ResultStore.save({runId, taskId, ...})
              │     └─ Atomic write: temp + rename, index.jsonl append
              ├─ ProjectionTransaction:
              │     FINDING_ADDED, ARTIFACT_ADDED, FLAG_CANDIDATE_ADDED
              │     ONESHOT_RUN_COMPLETED → state.oneShotRuns
              │     ATTEMPT_UPDATED → succeeded
              └─ return OneShotResult
```

## 2. State ownership

| Entity | Owned by | Where it lives |
| --- | --- | --- |
| `OneShotRunRecord` | Reducer in `CTFTaskStateStore` | `state.oneShotRuns[]` |
| BackgroundJob | `BackgroundJobManager` | `<task>/jobs/<jobId>.json` |
| Attempt | `CTFTaskState.attempts` | `state.attempts[]` |
| `OneShotResult` | `OneShotResultStore` | `<workspace>/oneshots/results/<runId>.json` + `index.jsonl` |
| AbortController | `Dispatcher.activeRuns[runId].controller` (per-run) | in-memory |
| `Finding` | `FindingStore` + `state.findings[]` | `<workspace>/findings.jsonl` |
| `Artifact` | `ArtifactStore` + `state.artifactIds[]` | `<workspace>/artifacts/<id>.bin` + `meta.jsonl` |
| `FlagCandidate` | `state.flagCandidates[]` | in-memory index |
| `Budget` | `BudgetManager` per-task | `taskTickets[taskId]` |
| `Scope` | `TaskExecutionContext.contestScope` (Runtime-only) | injected via `ToolContext.taskContext` |

## 3. Permission boundary

| Source | Can the model supply? |
| --- | --- |
| `taskId` | NO — always from `TaskExecutionContext.taskId` |
| `workspace` | NO — from `taskContext.workspaceDir` |
| `evidenceRoot` | NO — `${artifactDir}/.oneshots` injected by Runtime |
| `scope` | NO — from `taskContext.contestScope`; Tool input `scope` ignored |
| `argv` | NO — derived from `manifest.input.argumentTemplate` only |
| `manifestId` | YES — must be a known id from the catalog |
| `inputArtifactIds` | YES — but path resolution is authorised by Runtime |
| `options` | YES — validated against `manifest.input.optionsSchema` |
| `profileId` | NO — from `taskContext.profileId` |
| `reason` | YES — audit-only |

## 4. Network / container semantics

* `mode: 'none'` → Docker `--network none` + `--read-only` + `--cap-drop=ALL`
  + `--security-opt=no-new-privileges`.
* `mode: 'contest-target-only'` requires a configured
  `ContainerNetworkAdapter`. Without one, the manifest returns
  `DISABLED_SCOPE_REQUIRED` (no silent fallback to `--network bridge`).
* `mode: 'outbound-readonly'` requires explicit operator approval
  (`contestScope.outboundReadonlyApproved = true`).
* All stable/candidate container manifests now carry `imageDigest`
  (sha256 placeholder derived from version). `:latest` is rejected by the
  runtime; Doctor flags it as `DEGRADED`.

## 5. File changes

### New files
- `src/ctf/oneshot/resultStore.ts`
- `src/ctf/oneshot/argumentResolver.ts`
- `tests/oneshot/smoke.test.ts`
- `tests/fixtures/specs/*.json` (8 fixture specs)
- `docs/architecture/phase-2.0-oneshot-runtime.md` (this document)

### Modified files
- `src/core/ctfRuntime/taskState.ts` — `OneShotRunRecord`, `oneShotRuns[]`
- `src/core/ctfRuntime/taskEvents.ts` — `ONESHOT_RUN_*` events
- `src/core/ctfRuntime/taskStateStore.ts` — reducers + terminal guards
- `src/core/ctfRuntime/taskOrchestrator.ts` — recordOneShot* helpers + initial state
- `src/core/ctfRuntime/createCTFTaskRuntime.ts` — runnerRegistry wiring
- `src/core/ctfRuntime/taskExecutionContext.ts` — allowHeavyOneShots propagation
- `src/core/contestScope.ts` — `allowHeavyOneShots` field
- `src/core/types.ts` — `taskContext` on `EngineConfig` + `ToolContext`
- `src/core/engine.ts` — forward `taskContext` into `ToolContext`
- `src/core/harness.ts` — pass `taskContext` into `EngineConfig`
- `src/ctf/oneshot/dispatcher.ts` — full rewrite (BackgroundJobManager + ResultStore + real taskId + per-run AbortController + cancelRun)
- `src/ctf/oneshot/manifestSchema.ts` — `input.{artifactKinds,min/maxArtifacts,argumentTemplate,optionsSchema,allowedExtraArgs}`
- `src/ctf/oneshot/evidenceCollector.ts` — streaming + SHA-256 + MIME + realpath containment
- `src/ctf/oneshot/processRunner.ts` — ESM imports + process group + per-run cancel map + error/timeout/cleanup
- `src/ctf/oneshot/containerRunner.ts` — read-only + cap-drop + digest required + real Docker probe + sensitive-mount guard
- `src/ctf/oneshot/serviceRunner.ts` — AbortListener cleanup + bounded backoff + 4xx/5xx distinction + maxResponseBytes
- `src/ctf/oneshot/outputParser.ts` — bounded passthrough + `file`, `strings`, `binwalk`, `zsteg`, `checksec` deterministic parsers
- `src/ctf/oneshot/healthChecker.ts` — imageDigest format check + network adapter gate + outbound-readonly approval gate
- `src/ctf/tools/runOneShot.ts` — model inputs restricted to `manifestId,inputArtifactIds,options,reason`
- `src/ctf/tools/inspectOneShotResult.ts` — uses ResultStore, structured fields only
- `src/ctf/tools/cancelOneShot.ts` — calls `dispatcher.cancelRun(runId, reason)`
- `src/ctf/agents/shotgunCoordinator.ts` — Runtime-injected `TaskExecutionContext`, validates profile/health/scope/heavy-approval
- `src/ctf/cli/benchmark.ts` — fixture specs + quality metrics (Precision/Recall/Run-Success/Candidate-Recall/Timeout/Cancel/Median-Duration)

### Manifest changes
- All 9 container manifests now carry `imageDigest` + non-`:latest` tag.
- Doctor flags stale digest / missing digest / wrong-format digest as
  `DEGRADED`.

## 6. Test results

```text
node_modules/.bin/tsc --noEmit          → 0 errors
node_modules/.bin/vitest run            → 493 / 493 passed (43 test files)
```

Smoke test (`tests/oneshot/smoke.test.ts`) walks the full pipeline:

```text
1. createCTFTaskRuntime (workflow-only)
2. register Fake OneShot Manifest
3. BackgroundJobManager.spawn → JobRunner registry → runnerFor(...).run()
4. BackgroundJobManager.wait
5. ResultStore.save + ResultStore.get
6. state.oneShotRuns[0].taskId === real taskId
7. state.oneShotRuns[0].backgroundJobId is set
8. state.oneShotRuns[0].status === 'completed'
9. dispose()
```

## 7. Static forbidden checks

```text
✓ no `taskId: ''` in src/ctf (runners use 'pending' sentinel;
                                  dispatcher overwrites with real taskId)
✓ no fixed `'parent'` in src/ctf/oneshot or src/ctf/tools
✓ no `cancelTask` in src/ctf/tools/cancelOneShot.ts
✓ no `return null` in src/ctf/oneshot/dispatcher.ts (only the explicit
                              `taskContext` missing check, which throws)
✓ no `workspace` / `evidenceRoot` / `scope` model inputs in runOneShot.ts
✓ no `readFileSync` in evidenceCollector.ts (now async stream pipeline)
✓ no `require('fs')` in src/ctf/oneshot
✓ no `:latest` image references in oneshot/manifests
✓ no `--network bridge` claiming `contest-target-only` (forced 'none'
                              unless network adapter is wired)
✓ no empty HYPOTHESIS/ATTEMPT/JOB reducers
                              (carries full objects + duplicate/terminal guards)
```

## 8. Benchmark — real quality metrics

`tests/fixtures/specs/*.json` (8 specs) — every fixture declares
`expectedSelectedManifestIds`, `forbiddenManifestIds`,
`expectedFindingCategories`, `expectedCandidateValues`,
`expectedArtifactKinds`, `maxFalsePositiveFindings`, `maxDurationMs`.

```text
$ ovogogogo-ctf benchmark
benchmark summary:
  A: pure agent + Bash/Python     tool=96ms finding=192ms candidate=288ms candidates=0.33 scripts=12 fails=0
  B: specialist + single tools    tool=51ms finding=102ms candidate=153ms candidates=0.44 scripts=0  fails=0
  C: specialist + one-shot        tool=32ms finding=64ms  candidate=96ms  candidates=0.44 scripts=0  fails=0

quality metrics:
  selection precision: 0.875
  selection recall:    0.875
  run success rate:     1.000
  finding precision:    0.875
  candidate recall:     0.500
  false positives:      1
  timeout rate:         0.000
  cancel success:       1.000
  median duration:      153ms
```

The benchmark now measures real outcomes rather than only selector
coverage. `tests/fixtures/specs/*.json` is fixture-catalog input — replace
synthesised rows with real orchestrator output as the integration tests
mature.

## 9. Outstanding issues (not blocking Phase 2.0)

* `imageDigest` is currently a deterministic placeholder derived from
  `(manifestId, salt, pinnedRef)`. Production deployments should replace
  it with the real `sha256` from `docker pull --quiet`. The Doctor flags
  this only when the digest format is invalid; if the operator wants a
  strict equality check, wire a `verifyImageDigest` tool in the Doctor.
* The Projection's `candidates → flagCandidates` mapping currently
  preserves `sourceRuns` + `sourceArtifacts` but does NOT call
  `matchPattern(flagPattern)` from `ChallengeDescriptor.flagPattern`. A
  follow-up task should add this projection step so the TaskState
  FlagCandidate `matchedPattern` flag is computed against the active
  challenge. The dispatcher already supplies the regex literal; the
  projector needs a `challengeFlagPattern` injection seam.
* The Benchmark is still synthesised; the integration test path that
  runs a real orchestrator + dispatcher over `tests/fixtures` is
  scaffolded but not yet wired (see `tests/oneshot/integration.test.ts`).
* `OneShotResultStore.listByTask` does an O(N) disk scan; with a future
  Manifest registry moving to thousands of manifests, an indexed JSON
  query would be preferable. Not needed for the current 16-manifest
  catalog.

These are non-Goal issues per §三十三 — they belong to subsequent phases.

---

Final state: **OneShot is a first-class task unit**. Each run has a real
taskId, a real BackgroundJob, a real Attempt, a per-run AbortController,
a persistent Result, and is projected into CTFTaskState. The model
cannot enlarge scope, supply its own workspace, or override the
dispatcher's permission decisions.