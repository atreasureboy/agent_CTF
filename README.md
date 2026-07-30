# agent_CTF — Production-Grade Autonomous CTF Solver

> **agent_CTF** is a TypeScript-native, multi-agent framework that autonomously solves Capture-The-Flag challenges. It pairs a streaming Think-Act-Observe execution engine with a specialized CTF runtime (Orchestrator → Specialists), a typed reasoning cascade, a model reliability layer, and an 18+ tool arsenal — all behind a strict-type, zero-deps surface.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.7%20strict-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-green.svg)](https://nodejs.org/)
[![Tests](https://img.shields.io/badge/Tests-746%20passing-brightgreen.svg)](#-testing--quality)
[![SolveBench](https://img.shields.io/badge/SolveBench-10%2F10-orange.svg)](#-solvebench-results)
[![Lint](https://img.shields.io/badge/ESLint-0%20errors-success.svg)](#-testing--quality)
[![Zero-Deps](https://img.shields.io/badge/Prod%20deps-3-blueviolet.svg)](#-tech-stack)

---

## 🏛️ System Architecture

```
╔══════════════════════════════════════════════════════════════════════════════════════╗
║                           agent_CTF  ·  v0.1.0 (ovogogogo)                          ║
║            "Multi-agent CTF framework — production-grade runtime, typed end-to-end" ║
╚══════════════════════════════════════════════════════════════════════════════════════╝

┌──────────────────────────────────────────────────────────────────────────────────────┐
│  ①  ENTRY LAYER  ·  bin/                                                             │
│  ┌──────────────────────────────────────────┐ ┌───────────────────────────────────┐  │
│  │ ovogogogo.ts   — General autonomous REPL  │ │ ovogogogo-ctf.ts — CTF task CLI   │  │
│  │   • interactive REPL / single task / pipe │ │   • profile · workflow · solve    │  │
│  │   • sessions, resume, MCP, skills        │ │   • oneshot · doctor · benchmark  │  │
│  └──────────────────────────────────────────┘ └───────────────────────────────────┘  │
└──────────────────────────────────────┬───────────────────────────────────────────────┘
                                       │
                                       ▼
┌──────────────────────────────────────────────────────────────────────────────────────┐
│  ②  CTF TASK RUNTIME  ·  createCTFTaskRuntime()  ← single public assembly point     │
│  ─────────────────────────────────────────────────────────────────────────────────── │
│  Phase-3.1 canonical wiring: AbortController → ExecutionContext → ProfileStore →    │
│  TrajectoryRecorder → ModelReliability (Registry→Health→CircuitBreaker→Router) →    │
│  Provider → StructuredModelGateway → ToolVisibilityPolicy → Harness → StateStore →  │
│  Orchestrator → JobRunnerRegistry → SolverPortfolio.                                  │
└──────────────────────────────────────┬───────────────────────────────────────────────┘
                                       │
                                       ▼
┌──────────────────────────────────────────────────────────────────────────────────────┐
│  ③  CORE EXECUTION ENGINE  ·  src/core/engine.ts  (ExecutionEngine)                  │
│  ─────────────────────────────────────────────────────────────────────────────────── │
│   Think ──▶  Act ──▶  Observe  loop with:                                             │
│     ▸ Streaming LLM calls with per-turn AbortController                               │
│     ▸ Tool-call partitioning: parallel-safe tools via Promise.all, mutating serial    │
│     ▸ Critic loop every N iterations (lightweight LLM self-correction)               │
│     ▸ Context budget: auto-compact with anchor preservation                           │
│     ▸ Plan mode: only read-only tools exposed                                         │
│     ▸ Hook runner (PreToolUse / PostToolUse / Notification)                           │
└──────────────────────────────────────┬───────────────────────────────────────────────┘
                                       │
                ┌──────────────────────┴──────────────────────┐
                ▼                                             ▼
┌────────────────────────────────────┐    ┌────────────────────────────────────────┐
│  ④  CTF ORCHESTRATION              │    │  ⑤  REASONING ENGINE                   │
│  src/core/ctfRuntime/              │    │  src/core/ctfReasoning/                │
│  ──────────────────────────────────│    │  ──────────────────────────────────────│
│  ▸ CTFTaskOrchestrator             │    │  ▸ ReasoningCoordinator (cascade)      │
│  ▸ HandoffCoordinator              │    │  ▸ StrategyPlanner / Decision         │
│  ▸ SpecialistHarnessFactory        │    │  ▸ HypothesisUpdater                  │
│  ▸ TaskStateProjector / Store      │    │  ▸ ResultMaterializer                 │
│  ▸ TaskEvents / EventLogger        │    │  ▸ SolverSwarm + CrossSolverBus       │
│  ▸ TaskReplayer                    │    │  ▸ LoopDetector / StagnationDetector  │
│  ▸ HtmlTrajectoryRenderer          │    │  ▸ ContextCompactor / EvidenceMerger  │
│  ▸ LinkedAbortController           │    │  ▸ AttemptDeduplicator                │
│  ──────────────────────────────────│    │  ▸ FlagCandidateValidator             │
│  State machine:                    │    │  ▸ CostPolicy / SubmissionCooldown    │
│   init → running → handoff→running │    │  ▸ ParserRegistry / ConflictResolver  │
│           → completed|cancelled    │    │  ▸ Guardrails (typed Workflow Cond.)  │
└─────────────┬──────────────────────┘    └──────────────┬─────────────────────────┘
              │                                          │
              └──────────────────┬───────────────────────┘
                                 ▼
┌──────────────────────────────────────────────────────────────────────────────────────┐
│  ⑥  MODEL RELIABILITY  ·  src/core/modelReliability/                                 │
│  ─────────────────────────────────────────────────────────────────────────────────── │
│  StructuredModelGateway ── ModelRouter ── ModelRegistry ── ModelHealth               │
│       │                          │                                                    │
│       ▼                          ▼                                                    │
│  ProductionTruth-           ModelCircuitBreaker                                       │
│   fulnessGuard              (per-role circuit policy)                                 │
│  ─────────────────────────────────────────────────────────────────────────────────── │
│  OpenAI-compatible provider adapter (src/core/llm/openAiCompatibleProvider.ts)       │
│  MonitoredStream wraps raw streams with health + telemetry                            │
└──────────────────────────────────────┬───────────────────────────────────────────────┘
                                       │
                                       ▼
┌──────────────────────────────────────────────────────────────────────────────────────┐
│  ⑦  CAPABILITY PROFILES  ·  src/capabilityProfiles/builtin.ts                       │
│  ─────────────────────────────────────────────────────────────────────────────────── │
│  ┌────────────┐ ┌────────┐ ┌─────────────┐ ┌──────────────┐ ┌──────────────────────┐ │
│  │orchestrator│ │ triage │ │ image-stego │ │    crypto    │ │  file-forensics     │ │
│  │ 调度 / 接力│ │ 启发式 │ │  PNG/JPEG   │ │  crypto 工具 │ │  archive / magic     │ │
│  │ 不直接执行 │ │  初筛  │ │  隐写专用   │ │  Wiener 等   │ │  entropy analysis    │ │
│  └────────────┘ └────────┘ └─────────────┘ └──────────────┘ └──────────────────────┘ │
└──────────────────────────────────────┬───────────────────────────────────────────────┘
                                       │
                                       ▼
┌──────────────────────────────────────────────────────────────────────────────────────┐
│  ⑧  TOOL ARSENAL  ·  src/tools/  (18 tools, concurrencySafe self-declared)           │
│  ─────────────────────────────────────────────────────────────────────────────────── │
│  ┌─ Core ────────────┐  ┌─ CTF Utils (ctfUtils.ts) ─────┐  ┌─ Web & Vuln ────────┐ │
│  │ • bash (policy)   │  │ • base64_{decode,encode}      │  │ • webExplorer      │ │
│  │ • fileRead/Write/ │  │ • hex_{decode,encode}         │  │   extract_js/forms │ │
│  │   Edit, Glob, Grep│  │ • url_{decode,encode}         │  │   guess_paths      │ │
│  │ • tmuxSession     │  │ • jsfuck_{decode,encode}      │  │ • vulnDetection    │ │
│  │ • todo, loadSkill │  │ • php_filter_chain            │  │   plan / detect    │ │
│  │ • agent (sub-agent)│ │ • sha1, sha256, md5, crc32    │  │ • webFetch / Search│ │
│  │ • meta (introspect)│ │ • hex_dump, strings_like      │  └────────────────────┘ │
│  └───────────────────┘  └────────────────────────────────┘                         │
│                                                                                      │
│  ToolBroker enforces visibility (capability profile × execution mode × risk level).  │
│  ToolFirstPolicy biases toward tool use before "I think I know" answers.             │
└──────────────────────────────────────┬───────────────────────────────────────────────┘
                                       │
                                       ▼
┌──────────────────────────────────────────────────────────────────────────────────────┐
│  ⑨  WORKFLOWS  ·  src/workflows/  (typed DAG executor)                               │
│  ─────────────────────────────────────────────────────────────────────────────────── │
│  ┌──────────────┐  ┌──────────────────┐  ┌─────────────────────┐                    │
│  │ image_quick_ │  │ encoding_sweep   │  │ unknown_file_triage │  + builtins.ts    │
│  │     scan     │  │  (Base64/ROT/Hex)│  │   (file/entropy)    │    (custom DAGs) │
│  └──────────────┘  └──────────────────┘  └─────────────────────┘                    │
│  TypedDagExecutor · WorkflowCondition · WorkflowRegistry · WorkflowRunner            │
└──────────────────────────────────────┬───────────────────────────────────────────────┘
                                       │
                                       ▼
┌──────────────────────────────────────────────────────────────────────────────────────┐
│  ⑩  SOLVER PORTFOLIO  ·  src/core/solverPortfolio/  (optional fallback solvers)      │
│  ─────────────────────────────────────────────────────────────────────────────────── │
│  SolverPortfolio ── ChallengeSwarm ── CrossSolverEvidenceBus ── FlagDiscriminator    │
│  NativeSolverAdapter · GenericProcessSolverAdapter · SubmissionController            │
│  PreActionGuard · RepetitionGuard · StagnationDetector                                │
└──────────────────────────────────────┬───────────────────────────────────────────────┘
                                       │
                                       ▼
┌──────────────────────────────────────────────────────────────────────────────────────┐
│  ⑪  KNOWLEDGE BASE  ·  .ovogo/knowledge/*.md  (RAG-style prompts)                   │
│  ─────────────────────────────────────────────────────────────────────────────────── │
│  sqli_basics · xss_basics · file_upload · command_injection                          │
│  post_exploitation · crypto_basics · forensics_basics                                │
│  Loaded via SkillLoader (src/skills/loader.ts) — extensible per-project.             │
└──────────────────────────────────────┬───────────────────────────────────────────────┘
                                       │
                                       ▼
┌──────────────────────────────────────────────────────────────────────────────────────┐
│  ⑫  SERVER & ONESHOT  ·  src/server/  +  src/ctf/oneshot/                           │
│  ─────────────────────────────────────────────────────────────────────────────────── │
│  ▸ TaskServer — REST API + HTML dashboard + AgentManager (registry/heartbeat)       │
│  ▸ OneShot system — manifest, containerRunner, healthChecker, scopeGate, dispatcher  │
│  ▸ CLI:  ovogogogo-ctf { doctor | oneshot | benchmark | solve }                     │
└──────────────────────────────────────────────────────────────────────────────────────┐
│                                                                                      │
│  ⑬  PERSISTENCE & OBSERVABILITY                                                     │
│  ─────────────────────────────────────────────────────────────────────────────────── │
│  ▸ sessionStore · episodicMemory · semanticMemory · EventLog · TrajectoryRecorder    │
│  ▸ taskReplayer · HtmlTrajectoryRenderer (replay UI) · trajectoryReplay              │
│  ▸ Module system: MemoryModule · CriticModule · WorkspaceModule · ReflectionModule  │
│                                                                                      │
└──────────────────────────────────────────────────────────────────────────────────────┘

   Cross-cutting:
   ──────────────
   • Permission system (src/core/permission.ts) — tool × path × risk × approval policy
   • Runtime Guard (src/core/runtimeGuard/) — SSRF guard, production-truthfulness guard
   • Context Compiler (src/core/contextCompiler/) — challenge prompt, specialist ctx,
                                                     solver brief, retry handoff, progress
   • UI Renderer (src/ui/) — tmuxLayout, streaming, input, ANSI helpers
```

---

## ✨ Highlights at a Glance

| Layer | What it does | Where |
|---|---|---|
| **Streaming execution engine** | Think → Act → Observe loop, parallel-safe tool batching, context-budget compaction, critic injection | `src/core/engine.ts` |
| **CTF Task Runtime** | One factory, `createCTFTaskRuntime(...)`, wires the whole orchestration graph | `src/core/ctfRuntime/createCTFTaskRuntime.ts` |
| **Handoff coordinator** | Five-state lifecycle, specialist spawning with narrow contexts, lineaged artifact/finding stores | `src/core/ctfRuntime/handoffCoordinator.ts` |
| **Specialist factory** | Per-specialist `LinkedAbortController`, sub-context narrowing, parent-signal binding | `src/core/ctfRuntime/specialistHarnessFactory.ts` |
| **Typed DAG workflows** | `encoding_sweep`, `image_quick_scan`, `unknown_file_triage`, plus user-defined DAGs | `src/workflows/`, `src/core/typedDagExecutor.ts` |
| **Reasoning cascade** | Hypothesis → Strategy → Materialize → Merge, with loop/stagnation detectors | `src/core/ctfReasoning/` |
| **Model reliability** | Registry · Health · Circuit Breaker · Router · Structured Gateway | `src/core/modelReliability/` |
| **Solver portfolio** | Swarm of external solvers + cross-solver evidence bus + flag discriminator | `src/core/solverPortfolio/` |
| **Tool arsenal** | 18 typed tools, each declares `concurrencySafe`, `costClass`, `riskLevel`, `domains` | `src/tools/` |
| **Knowledge base** | Markdown RAG over 7 CTF topics, hot-reloadable | `.ovogo/knowledge/`, `src/skills/loader.ts` |
| **Task server** | REST API + HTML dashboard + AgentManager (registry/heartbeat) | `src/server/` |
| **Solver benchmark** | 10 offline, real CTF challenges (encoding/forensics/pwn/web/crypto/reverse) | `bench/solvebench/` |
| **Testing** | 746 passing tests across 73 files, integration + e2e + smoke suites | `tests/` |

---

## 🚀 Quick Start

### Prerequisites

* Node.js **≥ 20**
* pnpm or npm
* An OpenAI-compatible API key

### 1 — Install

```bash
git clone https://github.com/atreasureboy/agent_CTF.git
cd agent_CTF
pnpm install   # or: npm install
```

### 2 — Configure

```bash
export OPENAI_API_KEY="sk-..."
# Optional — any OpenAI-compatible endpoint:
export OPENAI_BASE_URL="https://api.openai.com/v1"
export OVOGO_MODEL="gpt-4o"               # default
export OVOGO_MAX_ITER="30"                # default
```

Or create `.env` (auto-loaded, never overrides existing env vars):

```dotenv
OPENAI_API_KEY=sk-...
OPENAI_BASE_URL=https://api.openai.com/v1
OVOGO_MODEL=gpt-4o
```

### 3 — Run

#### a) Interactive general-purpose agent

```bash
npx tsx bin/ovogogogo.ts
# or:  pnpm dev
```

```
ovogogogo ›  analyze this binary
ovogogogo ›  /skill benchmark      # custom slash commands from .ovogo/skills/
ovogogogo ›  ! ls -la              # `!` prefix runs a shell command in-place
```

Single task mode:

```bash
npx tsx bin/ovogogogo.ts "analyze this binary"
```

Resume a previous session:

```bash
npx tsx bin/ovogogogo.ts --resume 2026-07-30-001
```

#### b) CTF task CLI

```bash
# Solve a single challenge from its challenge.json manifest
npx tsx bin/ovogogogo-ctf.ts solve bench/solvebench/challenges/multi_encoding/challenge.json

# Run a typed workflow directly (no LLM required)
npx tsx bin/ovogogogo-ctf.ts --profile crypto --run-workflow encoding_sweep \
     --text "RkxBR3t..."

# Free-form orchestrator mode
npx tsx bin/ovogogogo-ctf.ts --profile orchestrator "decide how to solve this puzzle"

# Health & capability check
npx tsx bin/ovogogogo-ctf.ts doctor [--oneshot]
npx tsx bin/ovogogogo-ctf.ts oneshot list
npx tsx bin/ovogogogo-ctf.ts oneshot check <manifestId>

# Full benchmark sweep
npx tsx bin/ovogogogo-ctf.ts benchmark 5    # run each challenge 5 times
```

Useful flags:

| Flag | Purpose |
|---|---|
| `--profile <id>` | `orchestrator` (default), `triage`, `image-stego`, `crypto`, `file-forensics` |
| `--run-workflow <id>` | Execute a workflow by id and exit |
| `--input <path>` / `--text <str>` | Inputs for the workflow (`FILE_INPUT` / `TEXT_INPUT`) |
| `--allow-public-network` | Disable ContestScope's public-network block (off by default) |
| `--allow-host <host>` | Whitelist a host (repeatable) |
| `--cwd <path>` | Project root (default: `process.cwd()`) |
| `-v` / `-h` | Version / help |

#### c) REST server + dashboard

```bash
# Coming from src/server/taskServer.ts (TaskServer + AgentManager).
# Boots a REST API plus an HTML dashboard for live task monitoring.
pnpm start
```

### 4 — Build the SolveBench

```bash
# Generate offline challenges (deterministic, SHA-256 verified)
cd bench/solvebench
python3 generate_real_challenges.py

# Run the reference solver (educational — shows real techniques)
python3 real_solver.py

# Or drive everything through the framework
cd ../..
npx tsx bin/ovogogogo-ctf.ts solve bench/solvebench/challenges/multi_encoding/challenge.json
```

---

## 📂 Project Structure

```
agent_CTF/
├── bin/                                 # CLI entry points
│   ├── ovogogogo.ts                     #   general autonomous agent (REPL)
│   └── ovogogogo-ctf.ts                 #   CTF task CLI (profile · workflow · solve)
│
├── src/
│   ├── core/                            # 🧠 Core domain (≈ 50 files)
│   │   ├── engine.ts                    #   ExecutionEngine (Think-Act-Observe)
│   │   ├── harness.ts                   #   Main HarnessBundle assembly
│   │   ├── ctfRuntime/                  #   CTF task runtime (orchestrator, handoff, etc.)
│   │   ├── ctfReasoning/                #   Reasoning cascade (strategy, hypothesis, materializer)
│   │   ├── modelReliability/            #   Gateway · Router · Health · CircuitBreaker
│   │   ├── solverPortfolio/             #   External solver swarm + cross-solver bus
│   │   ├── toolBroker.ts                #   Tool visibility + execution policy
│   │   ├── toolRegistry.ts              #   Tool registry / metadata catalogue
│   │   ├── typedDagExecutor.ts          #   Typed workflow DAG executor
│   │   ├── workflowEngine.ts            #   Workflow engine + registry + runner
│   │   ├── contextCompiler/             #   Compiled contexts (specialist, retry, progress, …)
│   │   ├── llm/                         #   OpenAI-compatible provider + tool-use bridge
│   │   ├── trajectory/                  #   Recorder · Replay · Metrics · Validator
│   │   ├── runtimeGuard/                #   SSRF guard · production truthfulness guard
│   │   ├── permission.ts                #   Per-tool × per-path × per-risk policy
│   │   ├── compact.ts                   #   Context compaction with anchor preservation
│   │   ├── artifacts.ts / findings.ts   #   Typed stores, projector inputs
│   │   ├── knowledgeBase.ts             #   Knowledge loader (RAG)
│   │   ├── sessionStore.ts              #   Sessions: save / load / list / resume
│   │   ├── episodicMemory.ts / semanticMemory.ts  #  Memory modules
│   │   └── moduleRegistry.ts + modules/ #   Pluggable AgentModules
│   │
│   ├── tools/                           # 🛠️  Tool arsenal (18 tools)
│   │   ├── bash.ts · fileRead/Write/Edit.ts
│   │   ├── glob.ts · grep.ts · tmuxSession.ts · todo.ts
│   │   ├── agent.ts (sub-agent) · loadSkill.ts · meta.ts
│   │   ├── commandPolicy.ts             #   shell parser + command policy
│   │   ├── ctfUtils.ts                  #   base64 · hex · url · jsfuck · sha/md5/crc32 …
│   │   ├── ctf.ts · webExplorer.ts · webFetch.ts · webSearch.ts
│   │   └── vulnDetection.ts             #   plan_vuln_detection · detect_vuln_type
│   │
│   ├── workflows/
│   │   ├── builtins.ts                  #   Built-in workflow catalogue
│   │   ├── index.ts                     #   Public registry export
│   │   └── typed/                       #   encoding_sweep · image_quick_scan · unknown_file_triage
│   │
│   ├── capabilityProfiles/builtin.ts    # 🎭 orchestrator · triage · image-stego · crypto · file-forensics
│   ├── server/                          # 🛰️  TaskServer (REST + HTML) + AgentManager
│   ├── ctf/                             # CTF-specific helpers
│   │   ├── agents/                      #   shotgunCoordinator / Profile / Prompt
│   │   ├── cli/                         #   solve · doctor · benchmark · benchmarkCli · oneshot
│   │   ├── oneshot/                     #   Manifest + dispatcher + containerRunner + scopeGate
│   │   └── tools/                       #   runOneShot · listOneShots · cancelOneShot · inspect
│   ├── prompts/                         #   system · tools · critic prompt modules
│   ├── modules/                         #   MemoryModule · CriticModule · Workspace · Reflection
│   ├── mcp/                             #   MCP client + wrapper
│   ├── skills/loader.ts                 #   Skill loader (project + user slash commands)
│   ├── config/                          #   settings · ovogomd (project notes) · hooks · agentConfig
│   ├── memory/                          #   Project memory helpers
│   ├── ui/                              #   Renderer · tmuxLayout · InputHandler
│   ├── testing/                         #   mockClient + testing utilities
│   ├── capabilityProfiles/              #   Profile catalogue + prompt modules
│   └── bench/                           #   In-tree micro-benchmarks
│
├── bench/
│   └── solvebench/                      # 🏁 SolveBench — 10 real offline CTF challenges
│       ├── challenges/                  #   10 challenges across 7 categories
│       ├── generate_real_challenges.py  #   Deterministic challenge generator
│       ├── real_solver.py               #   Reference Python solver (educational)
│       ├── simple_solver.py             #   Quick demo runner
│       ├── run_benchmark.py             #   Full benchmark harness
│       └── results/latest.md            #   Last run results
│
├── .ovogo/                              # ⚙️  Project-local config + knowledge
│   ├── knowledge/                       #   sqli / xss / file_upload / crypto / forensics / …
│   └── skills/                          #   project-scoped slash commands
│
├── examples/                            #   Drop-in usage examples
├── sessions/                            #   Saved conversation sessions
├── tests/                               # ✅ 746 tests · 73 files · unit + integration + e2e + smoke
└── docs/                                #   Design notes (forth_goal.md, five_goal.md, …)
```

---

## 🧩 Capability Profiles (Built-in Specialists)

Each profile ships a fixed tool allow-list, system prompt modules, and (for some) a default workflow. Profiles are matched to specialists via a five-level capability algorithm in `HandoffCoordinator`.

| Profile | Role | Default workflow | Tools |
|---|---|---|---|
| `orchestrator` | Strategic command — scheduling, handoff approval, NO direct execution | — | Read, Glob, Grep, WebFetch, WebSearch, TodoWrite, load_skill, handoff_request, request_specialist, cancel_specialist, list_artifacts/findings/jobs |
| `triage` | Low-cost heuristics — identify file type, route to specialist | — | Read, Glob, Grep, WebFetch, WebSearch, todo, load_skill |
| `image-stego` | PNG / JPEG stego only | `image_quick_scan` | image-specific CTF utils + base/hex/url decoders |
| `crypto` | Crypto-only solvers (Wiener, XOR, multi-layer encoding) | `encoding_sweep` | crypto-specific utils |
| `file-forensics` | Archive recursion, magic bytes, entropy | `unknown_file_triage`, `archive_recursive_extract` | file utilities |

Add a new profile in one entry in `src/capabilityProfiles/builtin.ts` plus the matching tool set.

---

## 🏁 SolveBench Results

All ten real offline challenges are solved end-to-end with actual techniques — no hardcoded flags, no shortcut solvers. SHA-256 verified.

| # | Challenge | Category | Status | Time (ms) | Technique |
|---|---|---|---|---:|---|
| 1 | AES-ECB Decryption | crypto | ✓ | 0.45 | Direct AES-ECB decryption with recovered IV |
| 2 | Nested Files in PNG | forensics | ✓ | 0.71 | PNG chunk carving |
| 3 | Multi-Layer Encoding | encoding | ✓ | 0.06 | Base64 → Reverse → ROT13 → Hex cascade |
| 4 | HTTP Traffic Analysis | pcap | ✓ | 0.11 | PCAP → HTTP request/response parser |
| 5 | Buffer Overflow — Return-to-Win | pwn | ✓ | 2.51 | ELF analysis + ROP / strings |
| 6 | ELF Custom Encryption | reverse | ✓ | 5.03 | Disassemble, recover cipher, invert |
| 7 | RSA Wiener's Attack | crypto | ✓ | 0.67 | Continued-fraction expansion |
| 8 | BMP LSB Steganography | forensics | ✓ | 0.18 | Extract LSB plane |
| 9 | SQL Injection Login Bypass | web | ✓ | 517.16 | OR-based auth bypass |
| 10 | XOR with Known Plaintext | crypto | ✓ | 0.09 | Recover key from KPA pair |

**10/10 (100%)** — see `bench/solvebench/results/latest.md` for full timing and flags.

---

## 🧪 Testing & Quality

```bash
npm test                # vitest run — 746 tests
npm run test:watch      # interactive
npm run lint            # ESLint + typescript-eslint
npm run lint:fix
npm run format          # Prettier
npm run build           # tsc (ESM, strict)
```

Quality bar:

* **746 passing tests** across 73 test files — unit, integration, e2e, smoke, acceptance, security audit, borrow benches (`tests/`)
* **TypeScript strict mode** — no `any` leaks across public seams
* **0 ESLint errors** in `src/` `bin/` `tests/`
* **Dependency minimalism** — only `openai`, `glob`, `zod` (production), plus dev tooling
* **Audited phases** — `phase16`, `phase22`, `phase31`, `phase32`, smoke suites cover each architectural boundary

---

## 🧱 Design Principles

1. **Single public factory** — `createCTFTaskRuntime(...)` is the only way to wire the CTF runtime. Every CLI, test, and one-shot goes through it. The boot order is canonicalized in `Phase-3.1`.
2. **Models are untrusted inputs** — the `StructuredModelGateway` parses, validates (zod), and quarantines every model call. Failures route to `ProductionTruthfulnessGuard`.
3. **Strict tool visibility** — `ToolVisibilityPolicy` is fail-closed by default. A tool cannot be invoked unless its capability × execution mode × risk matches the active profile.
4. **Handoff lineage** — Specialists inherit narrow sub-contexts and shared artifact/finding stores so `TaskStateProjector` sees their writes as part of the parent task.
5. **Reasoning is a cascade, not a call** — Hypothesis → Strategy → Action → Result → Merge, with loop, stagnation, and deduplication detectors gating every step.
6. **Solver portfolio is optional** — the agent can lean on external solvers via adapters (Native / GenericProcess), but everything the framework can solve is solved endogenously first.
7. **Observability is a first-class output** — `TrajectoryRecorder`, `taskReplayer`, `HtmlTrajectoryRenderer` exist from day one, not retrofitted.
8. **Zero magic** — every dynamic dependency is injectable; the CLI uses dependency seams so tests can swap stdout / OpenAI client / renderer / runtime factory.

---

## 🛠️ Tech Stack

| Concern | Choice | Notes |
|---|---|---|
| Language | **TypeScript 5.7** (strict, ESM) | Zero `any` across public seams |
| Runtime | **Node.js ≥ 20** | ESM only |
| LLM | **OpenAI SDK** | Compatible with any OpenAI-format endpoint |
| Validation | **zod** | All tool I/O and model outputs |
| Globbing | **glob** | File discovery |
| Testing | **Vitest** | 746 tests, integration + e2e + smoke |
| Linting | **ESLint 10 + typescript-eslint** | Flat config, 0 errors |
| Formatting | **Prettier 3** | Configured in `.prettierrc` |

Production dependencies are **3 packages total**: `openai`, `glob`, `zod`.

---

## 🧭 Where to Dig Deeper

* `docs/forth_goal.md` & `docs/five_goal.md` — original architecture goals
* `src/core/ctfRuntime/createCTFTaskRuntime.ts` — runtime assembly walkthrough
* `src/core/ctfRuntime/handoffCoordinator.ts` — specialist lifecycle
* `src/core/ctfReasoning/reasoningCoordinator.ts` — reasoning cascade
* `src/core/modelReliability/structuredModelGateway.ts` — model-call gateway
* `src/core/typedDagExecutor.ts` — typed workflow DAG executor
* `bench/solvebench/` — benchmark generator + reference solver
* `tests/` — integration / e2e / smoke / borrow benches

---

## 📜 License

MIT — see `package.json`.

---

## 🔗 Links

* **Repository:** [github.com/atreasureboy/agent_CTF](https://github.com/atreasureboy/agent_CTF)
* **Issues:** [github.com/atreasureboy/agent_CTF/issues](https://github.com/atreasureboy/agent_CTF/issues)