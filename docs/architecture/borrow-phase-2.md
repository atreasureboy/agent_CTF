# Phase 2 — What's Still Left to Borrow (2026-07-24)

After Phase A-H, **8 of 12 gaps are closed**. The remaining 4 + several un-scoped ideas are listed below, ordered by ROI.

## Tier A — small effort, high visibility (1-3 days each)

### A1. Per-category toolset groups (NYU D-CIPHER)
- **What they do:** `TOOLSETS['web'] = [FetchURL, RunCommand]`, `TOOLSETS['crypto'] = [..., Decompile]`. The agent's tool surface is category-specific.
- **Our gap:** all 9 parsers + tool adapters are available to every action regardless of category.
- **Borrow shape:** a `CategoryToolScope` in `CTFTaskState` that records which toolIds are visible per category. The `StrategyActionExecutor` consults this and rejects out-of-scope tool calls.
- **Effort:** 1-2 days.
- **Risk:** zero — additive, can be disabled per task.

### A2. Block-unless-regex (swe-agent)
- **What they do:** `block_unless_regex = {'radare2': r'\b(?:radare2)\b.*\s+-c\s+.*'}` — `radare2 -c "..."` allowed, bare `radare2` blocked.
- **Our gap:** our `ToolBroker` has `deniedTools` (a flat block list). No way to allow a tool only when paired with a required subcommand.
- **Borrow shape:** extend `Profile.tools.blockUnlessRegex: Record<toolId, RegExp>`. Wire into the broker.
- **Effort:** 1 day.

### A3. Tool-call signature fingerprinting for loop detection (CHYing ABANDON)
- **What they do:** 3-layer detector — failure-keyword, tool-call-signature, CVE-id repetition. After `MAX_RETRIES` identical failing signatures, inject denial.
- **Our gap:** our `LoopDetector` keys on (action.type, targetId, fingerprint). CHYing-agent goes further — it tracks the call's *output* signature, not just the input fingerprint. So two different `verify_flag` calls with the same value still count as "we tried this 5 times".
- **Borrow shape:** add `loopHistory[].resultSummary` (hashed tool output). The detector matches on (kind, targetId, resultHash) tuple.
- **Effort:** 1 day.

### A4. Trajectory dump to NDJSON (cyber-zero)
- **What they do:** every assistant msg / user msg / tool call / observation is appended to a JSONL file with thread-locking. Auditors can grep the file post-hoc.
- **Our gap:** we have `replayer.ts` that reads an `events.ndjson` but nothing **writes** the events to disk during execution. The CTFTaskStateStore currently keeps events only in memory.
- **Borrow shape:** a `TaskEventLogger` that subscribes to the store's event stream and writes each event to `events.ndjson` immediately. Wire into the Orchestrator at assembly time.
- **Effort:** 2 days.
- **Why this matters:** turns the audit story from "replay works if the log file exists" to "every task has a log file by default".

## Tier B — medium effort, real capability lift (1-2 weeks each)

### B1. AutoPrompter (NYU D-CIPHER)
- **What they do:** a separate LLM that runs *before* the planner, generating a challenge-aware initial user prompt. The planner then starts with category-specific framing baked in.
- **Our gap:** our `processReasoningInputs` always starts with a fresh planner context. The challenge's `category` is recorded but not used to seed the LLM prompt.
- **Borrow shape:** an `AutoPrompter` adapter that takes (challengeCategory, rawInput) → enhancedInput. Inject as a "preamble" applied before the planner sees the input.
- **Effort:** 1-2 weeks.
- **Why this matters:** the planner's first action quality is bound by how well the input is framed. AutoPrompter is the cheapest way to lift first-cycle win rate.

### B2. ApproachContest (CAI)
- **What they do:** `run_dual_approach_contest` spawns two clones of one specialist with opposing framings in parallel. Whichever wins, the other is cancelled.
- **Our gap:** we have `SolverSwarm` (multi-model racing) but we don't have a *framing* race. Sometimes the same model with a different prompt does better.
- **Borrow shape:** `createApproachContestExecutor(specialist, framings: string[])` — wraps a single `StrategyActionExecutor` and dispatches each framing in parallel.
- **Effort:** 1 week.

### B3. Long-trajectory system-prompt compaction (swe-agent)
- **What they do:** when history exceeds `WINDOW` lines, swe-agent swaps a `file_pointer: <line-count> in <file>` for the truncated observations. The LLM is told to read the file if needed.
- **Our gap:** our `ContextCompactor` produces a summary observation and drops the originals. swe-agent's pattern keeps the originals (truncated to a file) so the LLM can re-read them.
- **Borrow shape:** a `CompactedObservation` type that wraps `filePath: string; lineStart: number; lineEnd: number; summary: string`. The LLM is told to read on demand.
- **Effort:** 2 weeks.

### B4. CVE-id aware loop detection (CHYing)
- **What they do:** when an action that references a specific CVE (e.g. `verify_flag` for `CVE-2024-1234`) fails repeatedly, the loop detector gives up faster than for generic loops.
- **Our gap:** the loop detector doesn't know what a "CVE" is.
- **Borrow shape:** extract CVE-like identifiers from action `input` / `evidence.claim`. Track per-identifier retry counts. A 3-strike CVE loop aborts even though the generic limit is 5.
- **Effort:** 1-2 weeks.
- **Why this matters:** CTF challenges have known CVE references; giving up fast on a known-doomed exploit is a big win.

## Tier C — larger effort, structural change (3+ weeks each)

### C1. Subagent tool visibility scoping (CHYing-agent MCP `visibility`)
- **What they do:** every MCP server declares a `visibility: subagent:browser` or `subagent:reverse` flag. The orchestrator sees only ~10 strategic tools; sub-agents see the full 30+. The CLI source is patched to add this field.
- **Our gap:** our orchestrator (CTFTaskOrchestrator) and the SolverSwarm share one tool surface. There's no formal notion of "this tool is only visible to a sub-agent context".
- **Borrow shape:** extend `MCPClient` with a `visibilityScopes: Set<SubagentRole>`. The StrategyActionExecutor checks the current role before allowing a tool call.
- **Effort:** 2-3 weeks.
- **Why this matters:** the more sub-agents we add, the more important tool scoping becomes — without it, the orchestrator's LLM context bloats with irrelevant tool schemas.

### C2. Model registry per-agent (CAI `_MODEL_REGISTRY`)
- **What they do:** each agent type (bug_bounter, red_teamer, web_pentester) is paired with a specific model backend. The `_MODEL_REGISTRY[agent_id]` lookup happens before each turn.
- **Our gap:** all our agents use the same model. Some tasks are best for Claude (long context), others for GPT-4 (precise code) or local Qwen (cost).
- **Borrow shape:** a `ModelRegistry` per task that maps `agentRole: string → model: 'claude' | 'gpt-4' | 'qwen-coder'`. The ReasoningCoordinator picks the model per cycle based on the role in the cycle.
- **Effort:** 2 weeks.

### C3. Persistent trajectory dump in system prompt (swe-agent `LMSummarizer` + cyber-zero persona)
- **What they do:** swe-agent's `LMSummarizer` runs a *separate* LLM to summarise its own context. cyber-zero's user-LLM persona simulates a Linux terminal for synthetic data.
- **Our gap:** our `ContextCompactor` is deterministic. A real LLM-driven summariser would keep more context. The persona-LLM is only useful for training data generation, which is out of scope.
- **Borrow shape:** an `LMSummarizer` adapter that takes a list of observations and produces a structured summary. Wire as an alternative to `ContextCompactor` when LLM API is available.
- **Effort:** 2-3 weeks.

## Tier D — long-horizon (1-2 months)

### D1. Trajectory replay → HTML viewer
- Inspired by swe-agent's Trajectory JSONL + nyuctf_agents' Jinja-templated prompts.
- Render the `ReplayOutput` (cycles, attempts, evidence) as a self-contained HTML file with collapsible attempt trees.
- **Effort:** 1-2 weeks.

### D2. Real Docker challenge harness
- Inspired by every repo's `bench/<dataset>/<challenge>/{challenge.json, docker-compose.yml}`.
- Spawn a real CTF challenge, point the StrategyCoordinator at it, assert flag detection.
- **Effort:** 1-2 months (most of it is benchmark fixture maintenance).

### D3. Per-cycle LLM tool-use protocol
- Inspired by CAI's `AgentOutputSchema` + swe-agent's `JsonParser`.
- Force the LLM to emit a JSON-typed response validated by `ActionSchema` (Phase F). Backed by `tool_use` for Claude, `response_format` for OpenAI, fallback for raw completion.
- **Effort:** 1-2 months.

## Recommended next phases

In priority order:
1. **A4 (Trajectory dump)** — 2 days, makes every other improvement easier to audit.
2. **A1 (Per-category toolset)** — 1-2 days, makes the planner's first action better-targeted.
3. **A2 (Block-unless-regex)** — 1 day, plugs a real tool safety hole.
4. **A3 (CVE-aware loop detection)** — 1 day, sharper stopping.
5. **B1 (AutoPrompter)** — 1-2 weeks, first-cycle quality lift.
6. **B2 (ApproachContest)** — 1 week, dual-perspective planner.

After these 6, the `agent_CTF` Project would have absorbed all the meaningful practical capabilities of the surveyed repos without losing any of its engineering depth.

