# Plan: Borrow Practical Capabilities from the CTF-Agent Ecosystem

Date: 2026-07-24
Companion to:
- `gap-analysis.md` — the 12 capability gaps
- `compared-with-ecosystem.md` — the 7-repo comparison

## Guiding principle

> Keep agent_CTF's engineering depth, layer practical capabilities on top.

Concretely:
- **Engineering depth we preserve** — TypeScript strict, event-sourced `CTFTaskStateStore`, deterministic `StrategyPlanner`, `ParserConflictResolver`, FSM enforcement, deep-frozen state.
- **Practical capabilities we add** — multi-model swarm, runtime safety guardrails, MCP extension, benchmark harness, trajectory replay.

The borrowed capabilities must NOT regress the depth. Every new subsystem is:
1. **Adapter-shaped** — implements a clean interface the Coordinator calls.
2. **Reducer-shaped** — any state change goes through events.
3. **FSM-shaped** — safety-critical transitions enforced in the reducer.

---

## Phase ordering

Eight phases. Each phase leaves the repo green (typecheck + tests pass + a small smoke test).

### Phase A — Defense in depth (Tier 1, 1 week total)

**Goal:** close the loop-detection / SSRF / submission-cooldown holes; add a prompt-injection guardrail.

A1. **Submission cooldown** — `src/core/ctfReasoning/submissionCooldown.ts` + `FlagSubmissionAttempts` TaskState record. Maps from `candidateId + value-fingerprint → { lastTriedAt, retryCount }`. The `RuntimeStrategyActionExecutor.verifyFlag` adapter checks the cooldown before calling `validateFlag`. Throws / skips with reason `submission_cooldown` when rate is exceeded. Add `Cooldown` event type for audit.

A2. **SSRF blocklist** — `src/core/runtimeGuard/ssrfGuard.ts`. Resolves URL → IP via `dns.lookup`, blocks `loopback` / `RFC1918` / `link-local` / `metadata` IPs. Wire into any `fetchUrl` / `webFetch` adapter. CIDR list configurable.

A3. **Loop detector** — `src/core/ctfReasoning/loopDetector.ts`. Sliding 12-call window keyed on `(action.type, action.input fingerprint)`. Records counts in `CTFTaskState.loopHistory[]`. After 5 repeated calls, the planner rejects with reason `repeated_action_exhausted`. Wired into `StrategyPlanner`.

A4. **Prompt-injection guardrail** — `src/core/ctfReasoning/guardrails/inputSanitizer.ts` + `outputSanitizer.ts`. Three layers:
- input layer: Unicode homograph normalisation (NFKD), regex pattern whitelist, dangerous `curl|bash` / `wget|sh` / encoded payload detection.
- output layer: filter `rm -rf /`, fork bombs, base64-decoded payloads in tool return values.
- external-content fence: wrap untrusted source / web / PDF content with `============EXTERNAL CONTENT START============`.
Add `GUARDRAIL_TRIPPED` event for audit. Disabled in tests / dry-run mode.

### Phase B — Multi-model swarm (Tier 2, 2 weeks)

**Goal:** when the planner is confident enough, fan the action out to multiple model adapters; first correct answer wins.

B1. **`SolverSwarm`** — `src/core/ctfReasoning/solverSwarm.ts`. Holds N model adapters (Pydantic-AI / Claude Agent SDK / Codex App Server). A `dispatchToSwarm` executor adapter:
- For each model: spawn a worker that issues the same suggested action + emits an `Observation`/`Evidence` set.
- Deduplicate by `Evidence.fingerprint`. First `validateFlag` with a non-empty `flag_candidate_source` Evidence wins.
- `asyncio.Event` cancels the rest.

B2. **`MultiModelCoordinates`** — review per-cycle in the Reasoning loop:
- Cycle 1-3: planner picks one action → executor runs single model.
- Cycle 4+: planner picks one action → executor runs swarm of N models (configurable; default 3).

B3. **`SolverCompleted` event** with `{ bestFingerprint, modelIds: string[], winnerModelId }`.

### Phase C — MCP (Tier 2, 2 weeks)

**Goal:** accept community MCP servers without writing TS adapters for each.

C1. **`MCPClient`** — `src/core/mcp/mcpClient.ts`. Spawns `npx mcp-server-...` over stdio, exchanges `initialize` / `tools/list` / `tools/call` JSON-RPC. Wraps each remote tool as a local `ToolBroker` entry.

C2. **Adapters** — `chrome-devtools`, `ghidra-mcp`, `filesystem-mcp` (subset). Each adapter implements the `CallTool` interface and binds its remote schema to local observation/evidence types.

C3. **Visibility scoping** — per-subagent tool surface (`chrome-devtools` only visible to a `browser` sub-agent). Bridges the CHYing-agent pattern into our agent scope.

### Phase D — Trajectory replay (Tier 2, 1.5 weeks)

**Goal:** operator can replay any past task from its event log.

D1. **`Replayer`** — `src/core/ctfRuntime/replayer.ts`. Reads `events.ndjson` from a task workspace. Streams reducer steps into a `ReplayState`. Emits a structured timeline (events grouped by cycle: `OBSERVATION_ADDED`, `ATTEMPT_STARTED`, `STRATEGY_DECISION_RECORDED`, `ATTEMPT_COMPLETED`).

D2. **HTML render** — `src/cli/replay.html.ts`. A self-contained HTML timeline viewer with collapsible attempt trees and a legend per event type.

D3. **CLI command** — `bin/agent_CTF replay <taskId> [--format=json|html]`. Adds a binary entry.

### Phase E — Benchmark harness (Tier 3, 3 weeks)

**Goal:** empirically defend any claim of "we lead on X".

E1. **`bench/`** — sub-package with `package.json` and `Dockerfile`. Hosts challenge manifests (`bench/<dataset>/<category>/<challenge>/challenge.json` + `docker-compose.yml`).

E2. **`BenchRunner`** — `src/bench/runner.ts`. Spins up the docker challenge, runs `processReasoningInputs` against a fixture executor + scoring adapter. Records `attempts`, `evidence`, `strategyDecisions`, `submittedFlag` per challenge. Compares to the expected flag.

E3. **Run summary** — `bench/<run-id>/summary.md` with:
- Win-rate per category.
- Time to first submission.
- Token spend per attempt.
- Best run trajectory (linked to D1's replay).

E4. **CI integration** — `bench/quick.json` runs on every PR; `bench/full.json` is opt-in.

### Phase F — Structured-output contract (Tier 3, 2 weeks)

**Goal:** LLM emits a typed JSON shape pre-execution. Removes the slow error path when LLM hallucinates a malformed action.

F1. **`StructuredActionSchema`** — `src/core/ctfReasoning/actionSchema.ts`. One Zod (or hand-rolled) schema per `SuggestedAction` type. The `PlanStrategyActionExecutor` uses provider tool-call / function-calling to force the LLM to emit the schema. Falls back to free-form parsing on providers that don't support constrained decoding.

F2. **Validation pipeline** — pre-execution: parse + validate → if invalid, surface structured error to the LLM in a re-prompt. Counter in TaskState: `LLM_REQUEST_INVALID_ACTION` event.

F3. **Provider adapters** — `claude` uses `tool_use`; `openai` uses `response_format` + `tools`; raw completion falls back.

### Phase G — Context compaction (G4, 2 weeks)

**Goal:** long-running tasks stay within context.

G1. **`Observation`** has an `attr: { tokenEstimate?: number }` field. The Reasoning loop tracks sum-of-tokens.

G2. **`CompactReasoningContext` action** — when `observationTokenSum > 0.5 * contextBudget`, dispatch a dedicated `CompactAction` that runs an LLM summariser over the older observations, replaces them with a `Findings`-keyed summary + token pointer.

G3. **`COMPACTION_APPLIED` event** with `{ removedObservationIds[], summaryObservationId }`.

### Phase H — HITL pause (G12, 1 week)

**Goal:** operator can pause and inject commands.

H1. **`pause` event** with `{ at, pausedBy: 'user' | 'system', reason: string }`. After a `pause`, the next cycle's `processNewReasoningInputs` returns without picking actions.

H2. **`RESUME` event** with optional injected observation / evidence / hypothesis events applied before the next Strategy Cycle.

H3. **CLI** — `bin/agent_CTF pause <taskId>` writes the pause event; `bin/agent_CTF resume <taskId>` writes resume + optional JSON payload.

---

## Critical path

```
Week 1-2:   Phase A (defense in depth)  ── closes 4 real holes
Week 3-4:   Phase B (multi-model swarm)  ── first visible capability lift
Week 5-6:   Phase C (MCP)               ── tool ecosystem ready
Week 7:     Phase D (replay)            ── operator visibility
Week 8-10:  Phase E (benchmark)        ── empirical evidence
Week 11-12: Phase F (structured out)   ── LLM contract
Week 13-14: Phase G (compact)          ── long-task stamina
Week 15:    Phase H (HITL)             ── operator control
```

Approximately 15 weeks of focused engineering. After phase E we can publish "agent_CTF wins category X on benchmark Y" with hard data.

---

## What we **deliberately do not borrow**

- **Veria's per-solver Docker logs as the only persistence** — we keep event-sourced TaskState. Multi-model swarm gets its OWN lives; they share findings into the state.
- **CAI's 4-layer guardrails as sole defence** — we keep Runtime-side tool boundaries (Docker / network / caps / argv / profileId) which CAI lacks. Guardrails supplement, not replace.
- **HackSynth's no-typed-harness** — TypeScript strict + Pydantic-style schemas stay.
- **swe-agent's hard command blocklist** — we keep argv / profileId server-side injection which makes the model unable to mis-scope. Blocklist supplements.
- **cyber-zero's LLM-as-Linux-user for synthetic data generation** — out of scope; empirical benchmarks come from real Docker challenges.
- **CHYing-agent's MCP `visibility` CLI patch** — we provide a typed Tool scope instead of leaking subprocess flags.
- **NYU CTF Bench's per-category Toolsets as the tool-discriminator** — we keep the per-attempt `Attempt.kind = 'tool'|'workflow'|'oneshot'|'handoff'|'verification'|'manual'` discriminator and pass through reasoning-driven `priority`.

---

## Success criteria

After all 8 phases:

1. **Typecheck + 581+ tests** still pass.
2. **A benchmark run** can defend any "X is better than Y" claim with hard numbers.
3. **Replaying a past task** produces a single HTML file a reviewer can share.
4. **A new MCP server** can be enabled with one CLI flag — no code change required.
5. **A multi-model swarm** runs in parallel; first solver to print the flag wins.
6. **The TaskState remains event-sourced** — every borrowed capability writes through events.

The repo signature stays: deterministic planner, event-sourced state, multi-source evidence, real runtime executors. New capabilities layer on top, never underneath.
