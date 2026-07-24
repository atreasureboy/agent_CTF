# Phase 3.0 Model Reliability & Solver Portfolio Local Code Audit

## Executive Summary
This audit reviews the codebase state before implementing Phase 3.0 specifications detailed in `ele_goal.md`.
Existing components in `src/core/ctfReasoning/` (e.g. `modelRegistry.ts`, `toolVisibility.ts`, `solverSwarm.ts`) are evaluated for integration or migration into the modular Phase 3.0 directory layout (`modelReliability/`, `contextCompiler/`, `solverPortfolio/`, `trajectory/`, `toolVisibility/`).

## Local Code Verification Status
- `git status --short`: clean working copy (except `ele_goal.md`).
- `pnpm typecheck`: Passed clean with 0 errors.
- `pnpm build`: Built cleanly (`tsc` completed).
- `pnpm test`: 77 test files, 705 tests passing.

## Existing Component Analysis & Integration Strategy
1. **Model Management**:
   - Existing `modelRegistry.ts` in `ctfReasoning` contains basic model definition lookup.
   - Refactoring into `src/core/modelReliability/` with `ModelCapabilityProfile`, `ModelHealth`, `ModelRouter`, `ModelCircuitBreaker`, `StructuredModelGateway`, and `ModelRolePolicy`.
2. **Context Compilation**:
   - Existing `contextCompactor.ts` & `longTrajectoryCompactor.ts` handle simple text compaction.
   - Standardizing into `src/core/contextCompiler/` with two-phase compilation (deterministic `ContextProjection` + optional model rendering), `CompilerValidator`, and 5 distinct compilers (`ChallengePromptCompiler`, `SolverBriefCompiler`, `ProgressCompiler`, `RetryHandoffCompiler`, `SpecialistContextCompiler`).
3. **Tool Visibility**:
   - Existing `toolVisibility.ts` handles profile-level tool filtering.
   - Evolving into `src/core/toolVisibility/` with granular `ToolVisibilityPolicy` supporting roles (`orchestrator`, `solver`, `model:id`, `specialist:id`, `workflow-only`, `oneshot-only`, `operator-only`) and MCP server visibility isolation.
4. **Solver Portfolio & Swarm**:
   - Existing `solverSwarm.ts` contains basic multi-solver dispatch.
   - Standardizing into `src/core/solverPortfolio/` with `ExternalSolverAdapter` interface, `NativeSolverAdapter`, `GenericProcessSolverAdapter`, `SolverRunRecord` integrated with `CTFTaskState`, `CrossSolverEvidenceBus`, `StagnationDetector`, and `OperatorMessage`.
5. **Flag Discriminator & Trajectory**:
   - Existing `flagCandidateValidator.ts` handles candidate regex validation.
   - Extending with `FlagDiscriminator` & fake `SubmissionController` boundary (no auto-submit, M3 banned from submission).
   - Adding `src/core/trajectory/` with structured JSONL event logging and `ModelReliabilityMetrics` calculation.
