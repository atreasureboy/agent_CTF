# Phase 3.2 Runtime Truthfulness & Online Coordination Audit Report

## 1. Executive Summary
This document provides the initial baseline audit for Phase 3.2 implementation of `agent_CTF`.
The goal of Phase 3.2 is to eliminate all remaining demo semantics, establish real and verifiable model identity, provider routing, and streaming lifecycles, enable live online Solver event streams and coordination in `ChallengeSwarm`, enforce grounded cross-solver evidence sharing, implement pre-action ABANDON guards, and upgrade trajectories to bounded, versioned, replayable engineering data.

## 2. Current Architecture Baseline Audit

### 2.1 Model Profile & Gateway Routing
- **Current Behavior**: `StructuredModelGateway` synthesizes ad-hoc model profiles on the fly (e.g. constructing `{ id: activeModelId, provider: provider.id, contextWindow: 128000 }`) when resolving models.
- **Issues Identified**:
  - `StructuredModelGateway` does not always retrieve the real, complete `ModelCapabilityProfile` from `ModelCapabilityRegistry`.
  - Fallback logic or default provider fallback lacks strict profile-to-provider binding.
  - Hardcoded string heuristics like `includes('m3')`, `includes('mini')`, or `includes('small')` exist in model reliability.
  - Role casting like `role: profile.id as any` bypasses strict `ModelRole` mapping.

### 2.2 Streaming Lifecycle & Health Accounting
- **Current Behavior**: Streams return early after `provider.streamAgentTurn()` and record success immediately before the stream has been fully consumed to EOF by the caller.
- **Issues Identified**:
  - Interrupted streams or empty streams may be incorrectly marked as successful.
  - Lack of a wrapped stream (`MonitoredAgentTurnStream`) to track `first_token_timeout`, `stream_interrupted`, `empty_response`, or `tool_argument_failure`.
  - Role policy rejections are improperly lumped under schema failures.

### 2.3 Model Call Bypass / Ad-hoc Provider Instances
- **Current Behavior**: `compact.ts`, `critic.ts`, and `reflection.ts` instantiate standalone `OpenAICompatibleProvider` or call API methods directly instead of routing through `StructuredModelGateway`.
- **Issues Identified**:
  - Model metrics, health, circuit breaker state, and role policies are bypassed for compaction, reflection, and critic calls.

### 2.4 Tool Exposure & Visibility
- **Current Behavior**: `ToolVisibilityPolicy` is called piecemeal and does not use a single `ToolExposureResolver` for both tool definition resolution and tool execution assertion.
- **Issues Identified**:
  - Potential divergence between what tools are exposed to the LLM and what the `ToolBroker` permits during execution.
  - Exposure ranking does not properly score tools based on `ModelRole`, hypothesis relevance, availability, and cost before trimming to `maxVisibleTools`.

### 2.5 State Revision & Context Snapshot Hash
- **Current Behavior**: `stateRevision` is hardcoded to `1` in several trajectory and reliability calls. `ContextSnapshot` uses dummy hashes such as `state.updatedAt || 1` or `hash_${revision}_${stringLength}`.
- **Issues Identified**:
  - Context snapshots do not reflect actual canonical state content changes (Evidence, Hypotheses, Attempts, Artifact SHAs, Pending Actions, Tool Visibility).

### 2.6 Solver Portfolio & Swarm Event Coordination
- **Current Behavior**: `SolverPortfolio` automatically registers default mock adapters. `NativeSolverAdapter` reports `ready` even without a delegate configured.
- **Issues Identified**:
  - `ChallengeSwarm` waits for solver completion (`handle.wait()`) and cannot observe live solver events during execution.
  - `CrossSolverEvidenceBus` stores its own ungrounded messages without referencing canonical `TaskState` IDs.
  - Stagnation is computed post-execution rather than continuously on live event streams.

### 2.7 Flag Discriminator & Trajectory Validity
- **Current Behavior**: `FlagDiscriminator` only accepts raw candidate strings and does not analyze complete task provenance. Trajectories are stored as unbounded in-memory arrays.
- **Issues Identified**:
  - `events.push()` can lead to unbounded memory usage.
  - Trajectory entries lack schema versioning, payload verification, action consistency checks, and replay tools (`validate-only`, `state-rebuild`, `mock-execution`).

## 3. Reference Framework Alignments

1. **CHYing-agent**: Pre-tool-use ABANDON guard, role-based tool visibility, planner vs summarizer separation.
2. **Veria CTF Agent**: Live solver streaming, coordinator guidance, grounded cross-solver insights, flag cancellation policy.
3. **CAI**: Handoff as tool, solver vs discriminator separation.
4. **HackSynth**: Summarizer does not make decisions; planner uses structured state.
5. **Cyber-Zero**: Schema versioning, command format validation, action consistency, replay capabilities.

## 4. Phase 3.2 Action Plan & Target State
1. **Model & Provider**: Bind `ModelProfileResolver` in Gateway, require explicit provider matching, remove placeholder models, enforce `ModelRoleResolver` and `ModelTrustLevel`.
2. **Monitored Stream & Failure Taxonomy**: Implement `MonitoredAgentTurnStream` and `ModelInvocationFailureKind`.
3. **Unified Invocation & Revision**: Route all LLM calls through Gateway; inject `StateStore.getRevision()`.
4. **Tool Exposure**: Implement `ToolExposureResolver` for definition and execution assertion with role-based isolation.
5. **Canonical Context Snapshots & Compilers**: Canonical SHA-256 hash, integrate compilers for main, brief, progress, retry, and specialist.
6. **Solver & Live Swarm**: Dependency injection in `SolverPortfolio`, remove default mock adapters, implement `SolverEvent` async streams, live `SolverObserver` guidance, pre-action `RepetitionGuard`, grounded `CrossSolverKnowledgeView`.
7. **Flag Discriminator & Trajectories**: Provenance-based flag discrimination, versioned `TrajectoryEventEnvelope`, bounded ring buffer recorder, `trajectoryValidator`, and `TrajectoryReplay`.
8. **Benchmarking & Testing**: Smoke tests 1-7, Phase 3 A/B benchmark suite, and static anti-pattern check.
