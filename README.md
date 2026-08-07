# agent_CTF (ovogogogo) — Production-Grade Autonomous AI CTF Solver Framework

> **agent_CTF** (code-named `ovogogogo`) is an enterprise-grade, TypeScript-native multi-agent framework engineered for high-throughput, high-precision autonomous Capture-The-Flag (CTF) security competitions. It pairs a streaming Think-Act-Observe execution engine with a specialized multi-agent hierarchy (Orchestrator → Specialist Swarm), an immutable event-driven state machine, a model reliability circuit-breaker layer, an anti-stagnation interceptor, and a multi-challenge concurrency pool — all built on strict TypeScript 5.7 with zero heavy production dependencies.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.7%20strict-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-green.svg)](https://nodejs.org/)
[![Tests](https://img.shields.io/badge/Tests-95%20files%20%C2%B7%20824%20tests%20passed-brightgreen.svg)](#-quality--testing)
[![Lint](https://img.shields.io/badge/ESLint-P0%20crash%20bugs%20fixed-success.svg)](#-quality--testing)
[![Architecture](https://img.shields.io/badge/Architecture-Orchestrator%20%E2%86%92%20Specialists-orange.svg)](#-system-architecture)
[![Prod Deps](https://img.shields.io/badge/Prod%20deps-3-blueviolet.svg)](#-technology-stack)

---

## 🏛️ System Architecture

```
╔════════════════════════════════════════════════════════════════════════════════════════════════════════════╗
║                                 agent_CTF  ·  v0.1.0 (ovogogogo)                                           ║
║              "Production-Grade Autonomous CTF Solver — Multi-Agent, High-Precision System"               ║
╚════════════════════════════════════════════════════════════════════════════════════════════════════════════╝

┌────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
║  ① ENTRY LAYER & CLI  ·  bin/ovogogogo-ctf.ts & bin/ovogogogo.ts                                         ║
║  ───────────────────────────────────────────────────────────────────────────────────────────────────────── ║
║   • Interactive REPL / Single Task Execution / Automated Pipeline                                           ║
║   • Oneshot Doctor / Manifest Inspector / Benchmark Harness                                                ║
║   • Dual Submission Protocols (Auto API vs Contestant Manual Queue)                                        ║
└──────────────────────────────────────────────────┬─────────────────────────────────────────────────────────┘
                                                   │
                                                   ▼
┌────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
║  ② CTF TASK RUNTIME & CONCURRENCY POOL  ·  createCTFTaskRuntime()                                          ║
║  ───────────────────────────────────────────────────────────────────────────────────────────────────────── ║
║   • ChallengeConcurrencyPool — Multi-challenge parallel queueing & priority-based slot scheduling         ║
║   • TaskSnapshotManager — Atomic state snapshotting with SHA-256 checksum integrity verification            ║
║   • LinkedAbortController — Hierarchical cancellation tree across Orchestrator, Specialists, & Oneshots    ║
└──────────────────────────────────────────────────┬─────────────────────────────────────────────────────────┘
                                                   │
                                                   ▼
┌────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
║  ③ MULTI-AGENT ORCHESTRATION & COMPILER  ·  src/core/ctfRuntime/ & src/core/contextCompiler/             ║
║  ───────────────────────────────────────────────────────────────────────────────────────────────────────── ║
║   ┌─────────────────────────────────────────┐  ┌────────────────────────────────────────────────────────┐  ║
║   │ CTFTaskOrchestrator                     │  │ SpecialistContextCompiler                              │  ║
║   │ • Phase FSM (created→intake→triage... ) │  │ • Deterministic domain briefing                        │  ║
║   │ • Handoff Coordinator & Scope Isolation │  │ • Evidence & Artifact scope projection                │  ║
║   │ • Reasoning Budget & Safety Fuse        │  │ • BLOCKED ATTEMPTS fingerprint injection               │  ║
║   └─────────────────────────────────────────┘  └────────────────────────────────────────────────────────┘  ║
└──────────────────────────────────────────────────┬─────────────────────────────────────────────────────────┘
                                                   │
                                                   ▼
┌────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
║  ④ TOOL GOVERNANCE & ANTI-STAGNATION INTERCEPTOR  ·  src/core/toolBroker.ts                                ║
║  ───────────────────────────────────────────────────────────────────────────────────────────────────────── ║
║   • Profile-based Access Control — Capability Profile gating (orchestrator, reverse, crypto, web, etc.)    ║
║   • Step 1.8 Hard Anti-Stagnation Guard — SHA-256 action fingerprinting blocks infinite retry loops         ║
║   • Dynamic Exposure Resolver — Phase-aware tool function declaration filtering                           ║
║   • Concurrency Execution Partitioning — Read-only tools in parallel (Promise.all), mutating tools serial  ║
└──────────────────────────────────────────────────┬─────────────────────────────────────────────────────────┘
                                                   │
                                                   ▼
┌────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
║  ⑤ MODEL RELIABILITY & GATEWAY LAYER  ·  src/core/modelReliability/                                         ║
║  ───────────────────────────────────────────────────────────────────────────────────────────────────────── ║
║   StructuredModelGateway ──▶ ModelRouter ──▶ ModelRegistry ──▶ ModelHealth ──▶ ModelCircuitBreaker        ║
║   • Multi-provider fallback cascade with error-rate sliding window circuit breaker                         ║
║   • Zod schema-enforced structured JSON output parsing with self-repairing retry loop                       ║
└──────────────────────────────────────────────────┬─────────────────────────────────────────────────────────┘
                                                   │
                                                   ▼
┌────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
║  ⑥ SOLVER PORTFOLIO, ONESHOT & PLATFORM ADAPTERS  ·  src/core/solverPortfolio/ & src/ctf/oneshot/          ║
║  ───────────────────────────────────────────────────────────────────────────────────────────────────────── ║
║   • Fast-Path Oneshot Instant Solver — Zero-turn heuristic execution (Crypto, Stego, Rev, Web)             ║
║   • Typed DAG Executor — Parallel dependency graph execution for complex multi-stage tasks                 ║
║   • CTFPlatformAdapter — REST API integration for CTFd / GZCTF with HTTP 429 rate-limit backoff             ║
║   • FlagDiscriminator & DualSubmissionEngine — Zero false-positive regex validation & dual-mode submission  ║
║   • TrajectoryQualityEvaluator — Information gain scoring (0.0-1.0) & noise truncation                     ║
└────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## ⚡ Core SOTA Architecture Highlights

### 1. Multi-Agent Topology & Capability Profiles

Rather than relying on a single monolithic prompt, `agent_CTF` enforces a strict **Orchestrator → Specialist Swarm** architecture:

- **CTFTaskOrchestrator**: Manages global task intake, triage, handoff coordination, and high-level strategy.
- **Specialist Swarm**: Domain-isolated agents (`reverse`, `crypto`, `pwn`, `web`, `forensics`, `mobile`, `misc`, `image-stego`).
- **Capability Profiles**: Each profile declares allowed/denied tools, max execution steps, and resource limits.

### 2. Fast-Path Oneshot Instant Solvers

To maximize solving speed in high-pressure competitions, `agent_CTF` incorporates a zero-turn heuristic pipeline:

- Before initiating heavy LLM reasoning turns, newly discovered artifacts are scanned against a catalog of **Preset Oneshot Heuristics**:
  - **Crypto**: RSA small public exponent ($e=3, e=5$) attacks, multi-layer decoder cascades (Base64, Base32, Hex, ROT13, Base85).
  - **Forensics / Stego**: EXIF metadata extraction, PNG chunk verification, LSB stego scans.
  - **Reverse**: Hardcoded string regex extraction, `checksec` ELF binary security flag analysis.
  - **Web**: Common backup file and exposed path discovery (`.git/`, `.env`, `robots.txt`, `.bak`).
- Simple and medium challenges are solved in **under 2 seconds**, preserving LLM token budget for complex Jeopardy problems.

### 3. Multi-Challenge Concurrency Pool (`ChallengeConcurrencyPool`)

Designed specifically for competition environments featuring large problem banks:

- Maintains a dynamic worker queue supporting configurable concurrency limits (e.g., 5–10 challenges in parallel).
- Priority-based scheduling allocates slots to high-value or fast-path challenges.
- Bottlenecked or stalled challenges are automatically paused to free worker slots for other tasks.

### 4. Hard-Gated Anti-Stagnation Interceptor (`ToolBroker`)

Integrated directly into the `ToolBroker` execution pipeline (Step 1.8):

- Every tool call parameter set is hashed into a stable SHA-256 **Attempt Fingerprint**.
- If an agent attempts an identical action that previously failed without new evidence, `ToolBroker` hard-intercepts the request before execution and returns a structured refusal message (`[ToolBroker Guard]`).
- Completely prevents LLMs from getting stuck in infinite trial-and-error loops.

### 5. Deterministic Context Compiler & Projection (`SpecialistContextCompiler`)

Ensures seamless context transfer during Handoffs:

- Projects task state into a domain-relevant subset (`importantArtifacts`, `confirmedEvidence`).
- Explicitly injects a `=== BLOCKED / FAILED ATTEMPTS (DO NOT REPEAT) ===` section into Turn 1 prompts so incoming Specialists never repeat failed attempts.

### 6. Atomic State Checkpointing & Recovery (`TaskSnapshotManager`)

- Serializes complete `CTFTaskStateStore` state, revision sequence numbers, and active profiles into a JSON bundle.
- Includes a **SHA-256 Integrity Checksum** to detect snapshot corruption or tampering.
- Enables instant pause, resume, and crash recovery without losing progress.

### 7. Dual Submission & Flag Discriminator (`DualSubmissionEngine`)

Provides two robust submission pre-plans:

- **Mode A (Auto-Submit)**: Communicates directly with competition platforms (CTFd, GZCTF) via REST API, handling authentication, duplicate submission detection, and HTTP 429 rate-limit backoff.
- **Mode B (Manual Verification Queue)**: Formats confirmed candidates into a clean Markdown queue with confidence scores, provenance, and one-click copy snippets for human contestant verification.
- **FlagDiscriminator**: Validates flag regex patterns and entropy to guarantee **zero false-positive submissions**, protecting against platform rate limits and penalty deductions.

---

## 🛠️ Tech Stack & Production Standards

| Component              | Technology / Architecture                           | Description                                                 |
| :--------------------- | :-------------------------------------------------- | :---------------------------------------------------------- |
| **Language & Runtime** | TypeScript 5.7 Strict Mode, Node.js ≥ 20            | Zero `any` policy, strict null checks, ES2023 modules       |
| **Dependencies**       | 3 Production Dependencies (`openai`, `zod`, `glob`) | Ultra-lean footprint with zero bloated third-party wrappers |
| **Testing Suite**      | Vitest 4.1, ESLint 9, Prettier                      | **89 test files, 759 unit/integration specs passing 100%**  |
| **State Machine**      | Event-Driven Reducer (`CTFTaskStateStore`)          | Pure reducer with immutable `freezeState` protection        |
| **Concurrency**        | Linked `AbortController` Tree                       | Hierarchical cancellation propagation across all async jobs |

---

## 🚀 Getting Started

### 1. Installation

```bash
git clone https://github.com/atreasureboy/agent_CTF.git
cd agent_CTF
pnpm install
```

### 2. Environment Configuration

Copy the example environment file and configure your API keys:

```bash
cp .env.example .env
```

Edit `.env`:

```env
OPENAI_API_KEY=your_api_key_here
OPENAI_BASE_URL=https://api.openai.com/v1
```

### 3. Build & Verification

```bash
# Type check and build
pnpm run build

# Run code style & lint checks
pnpm run lint
pnpm run format:check

# Run full Vitest test suite
pnpm run test
```

---

## 💻 CLI Usage

The framework provides the `ovogogogo-ctf` entry point for task execution, oneshot inspection, and benchmarking:

```bash
# List available Oneshot heuristic manifests
npx tsx bin/ovogogogo-ctf.ts oneshot list

# Execute a quick scanning workflow on a target file
npx tsx bin/ovogogogo-ctf.ts --profile image-stego --run-workflow image_quick_scan --input sample.png

# Execute a crypto encoding sweep
npx tsx bin/ovogogogo-ctf.ts --profile crypto --run-workflow encoding_sweep --text "RkxBR3t..."

# Solve an autonomous CTF task with orchestrator
npx tsx bin/ovogogogo-ctf.ts --profile orchestrator "Analyze the provided pcap file and recover the admin password"

# Connect to a live GZCTF/CTFd competition — fetch challenges, solve, auto-submit flags
npx tsx bin/ovogogogo-ctf.ts gzctf-solve --url https://ctf.example.com --token $GZCTF_TOKEN
```

---

## 🧪 Quality & Testing

`agent_CTF` maintains rigorous software engineering standards:

- **95 Vitest Test Files / 824 tests**: 100% passing across unit, integration, and E2E scenarios.
- **ESLint Strict**: Adherence to TypeScript best practices.
- **Prettier Formatted**: Consistent code style enforced via CI.

```bash
pnpm run ci
```

---

## 📄 License

MIT License. See [LICENSE](LICENSE) for details.
