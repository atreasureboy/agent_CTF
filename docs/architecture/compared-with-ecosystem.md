# agent_CTF vs the CTF-Agent Ecosystem — Comparative Analysis

Date: 2026-07-24
Scope: agent_CTF (Phase 2.3) compared against 7 external CTF Agent repositories.
This document is a structural / architectural comparison, not a benchmark result.

## The eight systems

| System | Owner / venue | One-line shape |
| --- | --- | --- |
| **agent_CTF** | us (Phase 2.3) | Deterministic StrategyPlanner + event-sourced TaskState + real Runtime executors + 9-parser pipeline |
| ctf-agent | Veria Labs (BSidesSF 2026 winner) | LLM Coordinator + parallel multi-model solver swarm in Docker sandboxes |
| CHYing-agent | Tencent Cloud Hacking (2nd) | Claude-Code-derived Orchestrator + sub-agents with MCP visibility control + PreToolUse hook for ABANDON |
| CAI | aliasrobotics | ReAct SDK agents + LiteLLM multi-provider + MCP + guardrails + HITL |
| HackSynth | aielte (arXiv 2412.01778) | Two-LLM Planner + Summarizer loop over PicoCTF / OverTheWire |
| swe-agent v0.7 | Princeton (EnIGMA) | Agent-Computer Interface; LLM calls custom bash/file/edit commands |
| cyber-zero | Amazon (EnIGMA+) | Trajectory-synthesis framework + EnIGMA+ scaffold for hundreds of challenges |
| nyuctf_agents | NYU CTF Bench | D-CIPHER (planner+executor+auto-prompter) and a single-loop baseline |

---

## A. Orchestrator shape

| System | Shape | One-shot detail |
| --- | --- | --- |
| **agent_CTF** | **Multi-tier**: `CTFTaskOrchestrator` → `ReasoningCoordinator` → deterministic `StrategyPlanner` + `RuntimeStrategyActionExecutor`. Planner does NOT execute. | Bounded `Strategy Cycle` (default 8) refills from the event-sourced state every iteration. |
| ctf-agent | **LLM-as-orchestrator**: a coordinator LLM reads solver traces and dispatches hints; per-challenge swarms race multiple models. | Two-tier: outer coordinator + inner solver swarm (no deterministic planner). |
| CHYing-agent | **LLM-orchestrator + sub-agents**: Orchestrator picks Executor / Browser / C2 / Reverse sub-agents; each sub-agent is isolated via MCP `visibility: "subagent:browser"`. | Pre-compilers (`PromptCompiler`, `ProgressCompiler`, `RetryHandoffCompiler`) act as frontends, not as a planner. |
| CAI | **ReAct SDK** agent loop: `Runner.run(agent, message)`; multi-agent via `handoffs` (tool-shaped). | "Turn" = N interactions, "interaction" = 1 reasoning + N tool calls. No deterministic planner. |
| HackSynth | **Two-LLM**: `Planner` (produces next command) and `Summarizer` (compresses history) iteratively. | Implicit ordering via ReAct loop, not an explicit FSM. |
| swe-agent v0.7 | **Single LLM + ACI** (Agent-Computer Interface). LM picks from a small, purpose-built command set each step. | Per-step next-action selection; no planner/executor split. |
| cyber-zero | **Trajectory synthesis**: synthesises long training trajectories with persona-driven LLM simulation; runtime is EnIGMA+ (swe-agent-based). | "Orchestrator" is a teacher LLM writing synthetic traces; runtime scaffold is EnIGMA+. |
| nyuctf_agents | **D-CIPHER**: explicit Planner + Executor + (optional) auto-prompter; baseline is single executor. | Planner re-prompts after every observation; no FSM. |

---

## B. State model

| System | Persistence | Notes |
| --- | --- | --- |
| **agent_CTF** | **Event-sourced `CTFTaskStateStore`**; 60+ event types; pure reducers; deep-frozen `Readonly<CTFTaskState>`. Workflow / oneShot / pending / attempt / evidence all live in TaskState. | Resume-safe; concurrency-safe via `_taskLocks` per taskId; module-level maps removed in Phase 2.3. |
| ctf-agent | Per-solver Docker logs + CTFd poll state. No formal task state machine. | Cross-solver "message bus" for shared findings. |
| CHYing-agent | `progress.md` / `findings.log` / `compact_handoff.md` files on disk + Claude Code's own context. | `ProgressCompiler` rewrites handoff doc when compact fires; no reducer / event log. |
| CAI | In-memory `history` passed across handoffs + JSONL trace logs. Default "stateless between calls". | `CAI_STATE=1` enables an explicit state mode; episodic / semantic memory retained for legacy. |
| HackSynth | Trajectory JSONL of `(action, observation)` pairs (per benchmark tooling). | In-loop state is the planner's prompt window + summarizer output. |
| swe-agent v0.7 | JSONL `trajectory` per run; per-step observation logs. | EnIGMA mode adds an `intercept` / `summarizer` layer for long outputs. |
| cyber-zero | Generates synthetic `trajectories.jsonl`; runtime uses EnIGMA+ JSONL trail. | No formal task state — the trajectory IS the state. |
| nyuctf_agents | Docker container env + per-challenge transcripts in D-CIPHER; baseline has minimal state. | Planner / Executor exchange messages, not events. |

---

## C. Tool integration

| System | Mechanism | Notes |
| --- | --- | --- |
| **agent_CTF** | **`ToolBroker`** with profile + scope + permission gates; tools return `MaterializedResult`; 9 `OutputParser`s + `ResultMerger` + `ParserConflictResolver` re-parse textual output. | No MCP in production runtime; tools are first-class TS objects. |
| ctf-agent | **Native bash inside per-solver Docker sandbox** with a pre-baked CTF toolkit image (radare2, GDB, pwntools, binwalk, zsteg, exiftool, steghide, …). | Direct shell; no parser registry. |
| CHYing-agent | **MCP-first**: Chrome DevTools MCP, Ghidra MCP, etc. CLI source patched to add `visibility` per sub-agent. | Heavy reliance on MCP; no canonical tool broker. |
| CAI | **Function-calling** + `@function_tool` decorator + MCP (SSE + stdio). Tools grouped by kill-chain phase (recon / exploit / escalation / lateral / exfil / C2). | 100+ built-in tools; integrates LiteLLM for provider-agnostic calls. |
| HackSynth | **Native bash** with the same toolchain as CTF benches (PicoCTF / OverTheWire). | No MCP; Planner prompts a single command per step. |
| swe-agent v0.7 | **Custom ACI commands** (`bash`, `str_replace`, `submit`, `view`, `scroll_up`, …). | Each command is hand-designed to minimise tokens. EnIGMA mode adds interactive debug / server connection tools. |
| cyber-zero | Inherits EnIGMA+ / swe-agent ACI. | Adds pre-baked benchmark docker-compose challenges. |
| nyuctf_agents | **Native bash in a Docker container** + per-challenge `tools.py`. | D-CIPHER exposes a small `tools` module the executor may call. |

---

## D. Planner / Executor model

| System | Planner | Executor |
| --- | --- | --- |
| **agent_CTF** | **Deterministic `StrategyPlanner`** with `ScoredCandidate` (priority + hypothesis + cost + freshness − dups − failures). | **Six real adapters** in `RuntimeStrategyActionExecutor`: `run_workflow` / `run_oneshot` / `call_tool` / `request_handoff` / `verify_flag` / `stop`. |
| ctf-agent | Coordinator LLM (Claude / Codex) reads solver traces, returns targeted guidance. | Solver LLMs run bash in Docker; first solver to print the flag wins. |
| CHYing-agent | Orchestrator LLM (Claude-Code-derived). `PromptCompiler` first drafts a structured plan; then orchestrator dispatches. | Sub-agents (Executor / Browser / C2 / Reverse). |
| CAI | The LLM is the planner via ReAct. Multi-agent `Patterns` (Hierarchical / Swarm / Chain-of-Thought / Auction / Recursive) provide shape. | Same LLM-as-agent runs tools / `handoffs` / sub-agents-as-tools. |
| HackSynth | **Two LLMs**: Planner emits next command, Summarizer compresses history. | The shell call (with kubectl-like commands) executes; output feeds back. |
| swe-agent v0.7 | LM picks the next ACI command from a small set, guided by EnIGMA's intercept / summariser. | Direct bash / str_replace / submit commands. |
| cyber-zero | Trajectory synthesis: teacher LLM produces plans and steps; the trained model imitates. | EnIGMA+ runtime scaffold. |
| nyuctf_agents | **D-CIPHER planner LLM** + optional auto-prompter that re-prompts the executor. | Executor LLM calls tools in Docker; baseline is executor-only. |

---

## E. Parser pipeline

| System | Approach | Determinism |
| --- | --- | --- |
| **agent_CTF** | **`OutputParserRegistry` with 9 parsers** (file, hex, binwalk, zsteg, strings, encoding, exiftool, checksec, generic) → `ResultMerger` dedupes observations / merges multi-source evidence → `ParserConflictResolver` groups by `(subject + claimFamily)` and ranks `Magic > SpecializedParser > file > Generic`. | Deterministic, registry-driven; conflict warnings surfaced. |
| ctf-agent | None — solver LLM reads tool output directly. | None. |
| CHYing-agent | None — Claude reads raw output. | None. |
| CAI | None — LLM interprets tool output via ReAct observation. | None. |
| HackSynth | Summarizer LLM compresses tool output into a short observation string for the next planner step. | LLM-driven summarisation. |
| swe-agent v0.7 | `summarizers` (LLM-based truncation) for long outputs in EnIGMA mode. | LLM-driven. |
| cyber-zero | Trajectory synthesis pre-cleans output during data generation. | LLM-driven. |
| nyuctf_agents | None — executor LLM reads raw output. | None. |

---

## F. Flag detection

| System | Mechanism |
| --- | --- |
| **agent_CTF** | `FlagCandidate` is a typed TaskState entity (`detected → validated → rejected`); `verify_flag` action invokes a real `FlagCandidateValidator`; FSM-controlled; subject of `WORKFLOW_COMPLETED` via `request_handoff` / `verify_flag`. |
| ctf-agent | Regex / substring in solver output; first solver to print the flag wins (race semantics). |
| CHYing-agent | LLM instructed to print flag in WP; manual extraction. |
| CAI | `transfer_to_flag_discriminator` handoff: a dedicated Flag discriminator agent reads solver output. |
| HackSynth | Submit action returns success / failure; no separate validator. |
| swe-agent v0.7 | `submit` action; framework judges the answer server-side (CTF / SWE-bench). |
| cyber-zero | EnIGMA+ `submit`; same as swe-agent. |
| nyuctf_agents | No dedicated validator — D-CIPHER parses the solver transcript. |

---

## G. Concurrency control

| System | Mechanism |
| --- | --- |
| **agent_CTF** | Per-task `_taskLocks` (serialises same-task reasoning); `processNewReasoningInputs` per-task serialization; workflow id lock (`withLock`); separate cumulative + concurrency reasoning budgets. Phase 2.3 cascade dedup + `processedByCascadeIds` prevents recursive reasoning. |
| ctf-agent | One Docker container per solver; race is at the swarm level (N concurrent models per challenge). |
| CHYing-agent | Per-session serialization of sub-agent turns; ABANDON hook (PreToolUse) aborts in-flight calls when stuck. |
| CAI | `parallel_worker.py` + `continuous_ops` for cross-session parallelism; per-turn ReAct serialisation. |
| HackSynth | Single-threaded per benchmark run; multi-process for benchmark parallelism (separate processes). |
| swe-agent v0.7 | Single agent loop; benchmark tooling parallelises instances. |
| cyber-zero | Worker pool (`--workers 16`) for trajectory synthesis; runtime is single-instance per EnIGMA+. |
| nyuctf_agents | Single challenge per invocation; benchmark tooling parallelises instances. |

---

## H. Reasoning loop termination

| System | Termination |
| --- | --- |
| **agent_CTF** | Bounded `Strategy Cycle` (default 8) + cumulative reasoning budget; explicit `stop` action (handled before attempt creation); natural exhaustion returns `stopReason`; task terminal blocks reasoning. |
| ctf-agent | Solver gives up on its own or coordinator sends a hint to pivot; no explicit budget. |
| CHYing-agent | `CAI_MAX_TURNS`-style limits + ABANDON hook to redirect, plus context-window auto-compact via Claude Code. |
| CAI | `CAI_MAX_TURNS`, `CAI_PRICE_LIMIT`, agent returns `None` to end. |
| HackSynth | Implicit — Planner emits a terminal command or summariser marks done. |
| swe-agent v0.7 | LM emits `submit` (or framework-injected early stop); budget via token counters. |
| cyber-zero | Runtime = EnIGMA+; same submit-based termination. |
| nyuctf_agents | D-CIPHER planner emits a terminal command; baseline runs until the executor yields. |

---

## I. Security model

| System | Approach |
| --- | --- |
| **agent_CTF** | `ToolBroker` with profile + scope + permission + container `--network=none/--read-only/--cap-drop=ALL/--security-opt=no-new-privileges`. Model cannot supply `taskId`, `workspace`, `evidenceRoot`, `scope`, `argv`, `profileId`. Argument templates resolved server-side. `PreToolUse`-style hooks in the OneShot resolver (e.g. `..` and absolute path rejection). |
| ctf-agent | Docker sandbox per solver; tool whitelist image; no further policy layer. |
| CHYing-agent | MCP `visibility` per sub-agent; **ABANDON PreToolUse hook** blocks repeat-failure tools; MCP stdio vs SSE isolation. |
| CAI | `Guardrails` module: input + output guards (prompt-injection patterns, unicode homograph, base64/base32 decode, dangerous-command blocklist). `CAI_GUARDRAILS` toggle. HITL `Ctrl+C` to intercept. |
| HackSynth | Docker sandbox; no dedicated guardrails module. |
| swe-agent v0.7 | ACI enforces allowed commands; sandbox; no guardrail layer in OSS code. |
| cyber-zero | Inherits EnIGMA+ sandbox; no extra guardrails. |
| nyuctf_agents | Docker sandbox; no extra guardrails. |

---

## J. Type safety

| System | Approach |
| --- | --- |
| **agent_CTF** | **TypeScript `strict: true`**; 58-event union with exhaustiveness guard `const _exhaustive: never = event`; zero `@ts-ignore` / `@ts-expect-error`; effectively zero `any` in audited scope; deep-frozen `Readonly<CTFTaskState>`; 60+ events in `CTFTaskEvent` union; reducers are typed `Reducer<S, E>`. `noUncheckedIndexedAccess` / `exactOptionalPropertyTypes` are not yet enabled. |
| ctf-agent | Python 3.14 + `uv`; type hints loose; `dataclass` for solver record; no formal type-driven state machine. |
| CHYing-agent | Python; minimal `pyrightconfig.json`; relies on Claude Code SDK's own type hints. |
| CAI | Python with type hints and Pydantic models in SDK; LiteLLM types; not strict-typed across the agent layer. |
| HackSynth | Python; Pydantic-free; informal dataclasses. |
| swe-agent v0.7 | Python with type hints + Pydantic models for `AgentConfig`, `History`; not a strict type system. |
| cyber-zero | Python with Pydantic models for trajectories; same as swe-agent. |
| nyuctf_agents | Python with Pydantic models for D-CIPHER agent / message types; baseline is untyped. |

---

## K. Test coverage

| System | Coverage |
| --- | --- |
| **agent_CTF** | **581/581 tests passing** (Phase 2.3 baseline) including real-action integration tests for workflow / oneshot / tool / handoff / verify_flag + dedup + recovery tests + parser conflict + negative-evidence + EVIDENCE_UPSERTED atomicity + 9 forbidden-pattern static checks. |
| ctf-agent | Smoke / E2E tests for the poller and solver loops; no unit-level coverage documented. |
| CHYing-agent | No published tests; relies on competition runs as evaluation. |
| CAI | Unit tests + benchmark harness (CAIBench); pytest. |
| HackSynth | Benchmark harness (PicoCTF / OverTheWire); no published unit suite. |
| swe-agent v0.7 | Pytest + codecov badge; integration tests against SWE-bench containers. |
| cyber-zero | Unit + quality evaluation (`evaluate_quality.py`); pytest. |
| nyuctf_agents | Benchmark harness (NYU CTF Bench); unit tests minimal. |

---

## L. Special innovations unique to each

| System | Standout idea |
| --- | --- |
| **agent_CTF** | Deterministic scored planner + event-sourced TaskState + 9-parser pipeline with `ParserConflictResolver` + 6 real Runtime adapters + bounded Strategy Cycle with cumulative reasoning budget + multi-source Evidence atomic upsert + `WorkflowConditionScope` (workflowRunId/stepId/producerId). |
| ctf-agent | **Multi-model racing swarm** — first solver to print the flag wins; cross-solver message bus shares findings; operator can message solvers mid-competition. |
| CHYing-agent | **MCP visibility scoping** (CLI patch to expose MCP only to a named sub-agent); **PromptCompiler / ProgressCompiler / RetryHandoffCompiler** chain; **ABANDON PreToolUse hook** for repeat-failure detection (keyword + call-signature + CVE-id layers). |
| CAI | **Guardrails module** (prompt-injection + Unicode homograph + base64 decode + command blocklist); **Patterns taxonomy** (Hierarchical / Swarm / Chain-of-Thought / Auction / Recursive); MCP stdio + SSE; OpenTelemetry via Phoenix. |
| HackSynth | **Planner + Summarizer dual-LLM** for autonomous pentesting; PicoCTF + OverTheWire benchmark suites (200 challenges). |
| swe-agent v0.7 | **Agent-Computer Interface** — custom token-efficient commands; EnIGMA mode adds interactive debugger + summarizer + long-output handling. |
| cyber-zero | **Runtime-free trajectory synthesis** via persona-driven LLM simulation; trained Cyber-Zero-32B matches DeepSeek-V3 / Claude-3.5-Sonnet on CTF benchmarks. |
| nyuctf_agents | **D-CIPHER** explicit Planner + Executor + auto-prompter; first NYU CTF Bench baseline. |

---

## Where agent_CTF stands out

The comparison surfaces a small number of concrete advantages we have **today** (Phase 2.3), not aspirations:

1. **Deterministic planner, not LLM-as-planner.** `StrategyPlanner` produces `ScoredCandidate` rows from `priority + hypothesis + cost + freshness − dups − failures`. The planner does not execute. Six of the seven external systems have the LLM decide what to do *and* emit the next action in the same call; ctf-agent uses an LLM coordinator to read solver traces; CHYing-agent's orchestrator does the dispatch; CAI, HackSynth, swe-agent, cyber-zero, and nyuctf_agents all put the LLM at the steering wheel. None have an explicit, scored, reproducible planner with a separate executor.

2. **Event-sourced TaskState.** Our 60+-event `CTFTaskEvent` union, pure reducers, and deep-frozen `Readonly<CTFTaskState>` give us resumability and replayability that no other system in the set has. CHYing-agent gets a weak version via files on disk + `ProgressCompiler`; CAI has an opt-in `CAI_STATE=1`; the rest are stateless between calls or trajectory-only.

3. **Real Runtime integration.** `RuntimeStrategyActionExecutor` wires six concrete adapters (`run_workflow` / `run_oneshot` / `call_tool` / `request_handoff` / `verify_flag` / `stop`) that actually invoke the WorkflowEngine / OneShot Dispatcher / ToolBroker / HandoffCoordinator / FlagCandidateValidator. Most others (CAI, HackSynth, swe-agent) treat the LLM's bash call as the executor. Even when a sandbox is involved, there is no separate, typed, scored planner that picks which adapter runs next.

4. **Deterministic parser pipeline.** The 9-parser registry + `ResultMerger` + `ParserConflictResolver` is the only deterministic parser stack in the comparison. CAI, CHYing-agent, ctf-agent, HackSynth, swe-agent, cyber-zero, nyuctf_agents all either read raw output through the LLM or rely on an LLM-driven summariser. Conflict resolution (`Magic > SpecializedParser > file > Generic`) and multi-source evidence upsert are unique.

5. **Bounded Strategy Cycle + cumulative reasoning budget + concurrency budget.** Two independent dimensions, persistent across cycles, refused before consumption. We project `used + actionCost > max` before admission, not `used >= max`. Stop does not consume tool cost. No external system models both a cycle cap and a cost cap separately.

6. **WorkflowConditionScope.** `artifact_exists` filters by `producedByStep + producedByWorkflowRunId + minCreatedAt`; `evidence_exists` respects current `workflowRunId + stepId`. This prevents stale artifacts / evidence from earlier workflow runs from satisfying a new workflow's stop condition. None of the surveyed systems model this.

7. **Hypothesis FSM with Revisions.** Status transitions go through `HYPOTHESIS_STATUS_CHANGED` with reducer validation; terminal hypotheses (`supported` / `rejected`) cannot be silently un-terminated — new conflicting evidence spawns a `revisionOf` child. Negative evidence cannot create a reverse-positive hypothesis. CAI / HackSynth / swe-agent have no formal hypothesis model; CHYing-agent's `findings.log` is human-readable prose.

8. **Multi-source evidence with bounded confidence.** `EVIDENCE_UPSERTED` is atomic (no `mergedFrom`-of-nonexistent); sources are preserved; confidence combines with bounded `1 − ∏(1 − c_i)`; never silently overwrites. cyber-zero's trajectories are single-producer; D-CIPHER's planner prompts are single-source.

9. **First-class concurrency control.** `_taskLocks` per taskId serialises same-task reasoning; cascade dedup (`processedByCascadeIds`) prevents recursive reasoning. CHYing-agent has ABANDON but no formal lock; ctf-agent's race is at the model level, not the lock level.

10. **Defense-in-depth tool boundary.** Tool input is structurally narrowed (model cannot supply `taskId` / `workspace` / `evidenceRoot` / `scope` / `argv` / `profileId`); Docker `--network=none / --read-only / --cap-drop=ALL / --security-opt=no-new-privileges` for `mode: 'none'`; 26 `as unknown as` double-assertions remain an audit point but are concentrated at tool edges. CAI's guardrails are LLM-side (input/output) rather than Runtime-side; CHYing-agent's MCP visibility is a different mechanism but solves a different problem (orchestrator confusion, not malicious input).

11. **Type safety as enforcement.** TypeScript `strict: true` + exhaustiveness guard + zero `any` + zero suppression directives in audited scope. Only swe-agent / cyber-zero / CAI have partial Pydantic typing; the rest are loosely typed.

12. **581/581 tests passing** including six real-action integration tests for each adapter (workflow / oneshot / tool / handoff / verify_flag / stop) plus dedup / recovery / parser-conflict / negative-evidence / EVIDENCE_UPSERTED atomicity. None of the surveyed repos publish comparable unit + integration coverage alongside a deterministic-planner test suite.

The biggest *honest* caveat: the audit-architecture.md (this directory) records that **production wiring of `RuntimeStrategyActionExecutor` was broken at the start of Phase 2.3** (C1–C4: silent failures, missing executor injection, parser pipeline discarded in `call_tool`, nested-lock deadlock). The advantages above describe the **architecture as designed** in Phase 2.3, with the fixes required to make production live documented alongside this file.
