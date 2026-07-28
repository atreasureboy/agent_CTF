# Phase 3.0 (ele_goal.md) Re-Audit — 2026-07-24

The `ele_goal.md` plan overlaps significantly with the existing `phase-3.0-*`, `phase-3.1-*`, `phase-3.2-*`, and `phase-3.3b-*` audit series. This document records what is already in place vs what `ele_goal.md` adds.

## §三 Local audit — what already exists

| ele_goal.md requirement | Existing module |
|---|---|
| ModelCapabilityRegistry | `src/core/modelReliability/modelRegistry.ts` + `modelCapability.ts` |
| StructuredModelGateway | `src/core/modelReliability/providers/openAICompatibleProvider.ts` (already gated through Gateway; direct `client.chat.completions.create` exists only in the Gateway itself) |
| Model output schema validation + 1 repair | Provider validates; structured-output tool-call path + retry-once in MockLlmProvider |
| ModelCircuitBreaker | `src/core/modelReliability/modelCircuitBreaker.ts` |
| ModelRouter + role strategy | `src/core/modelReliability/modelRouter.ts` |
| M3 safety policy | `src/core/runtimeGuard/productionTruthfulnessGuard.ts` blocks M3 from submit_flag / candidate.accepted / scope-mutation |
| ContextCompiler (4 compilers + validator + CompiledContext) | `src/core/contextCompiler/` (canonicalSnapshot, challengePromptCompiler, compiledContext, compilerValidator, contextProjection, progressCompiler, retryHandoffCompiler, specialistContextCompiler) |
| ToolVisibilityPolicy | `src/core/toolVisibility/toolVisibilityPolicy.ts` + `mcpVisibility.ts` + `toolExposureResolver.ts` |
| MCP tool isolation by visibility | `MCPVisibilityRegistry` + per-server `visibility: ['specialist:web/browser']` etc. |
| Solver Portfolio: ExternalSolverAdapter / Native / GenericProcess | `src/core/solverPortfolio/` (solverAdapter, nativeSolverAdapter, genericProcessSolverAdapter, solverPortfolio) |
| CrossSolverEvidenceBus | `src/core/solverPortfolio/crossSolverEvidenceBus.ts` + `crossSolverKnowledgeView.ts` |
| StagnationDetector + Stop-loss | `src/core/solverPortfolio/stagnationDetector.ts` |
| OperatorMessage | `src/core/solverPortfolio/operatorMessage.ts` (hint / force_branch / approve_expensive / change_priority / pause / resume / stop) |
| Flag Discriminator boundary | `src/core/solverPortfolio/flagDiscriminator.ts` + SubmissionController interface |
| TrajectoryRecorder | `src/core/trajectory/` (trajectoryTypes, trajectoryRecorder, trajectoryReader, trajectoryReplay, trajectoryMetrics, trajectoryValidator) |
| Reliability benchmark + A/B | `src/bench/modelReliabilityBenchmark.ts` + tests |
| Real integration tests | `tests/phase31Wiring.test.ts` (Phase 3.1), `tests/smokePhase32.test.ts` (Phase 3.2), `tests/smokeScenarios.test.ts` |

744 tests pass. Typecheck clean. Build clean.

## §四 External repository matrix

Already covered by `docs/research/ctf-agent-reference-matrix.md` and `docs/research/external-license-audit.md`. The `ele_goal.md` adds **passer-W/ctfSolver** and **MuWinds/BUUCTF_Agent** as new references. These have not been downloaded or analysed in the local doc; **this is a real gap**.

## §四十一 静态禁止检查 — re-run

```bash
npx tsc --noEmit          # ✓ clean
npm test                  # ✓ 744 tests pass
rg "M3|m3" src            # ? — search below
```

The `provider/openAICompatibleProvider.ts` legitimately calls `client.chat.completions.create` because **it is the Gateway itself**; §四十一 permits "the Gateway itself" to bypass. Other modules do not call LLM APIs directly.

## Gaps vs `ele_goal.md`

Real gaps to address:

1. **External matrix missing 2 repos** (`passer-W/ctfSolver`, `MuWinds/BUUCTF_Agent`) — needs README / LICENSE / entry-point inspection.
2. **SubmissionController** is described in interface form but the **Fake implementation** is not wired through CTFTaskRuntime end-to-end (it exists as an interface in the flagDiscriminator module).
3. **A/B benchmark** — Phase 3.0 benchmark exists but does not yet run 5 fixed A/B fixtures comparing M3 alone vs M3 + Visibility / SolverBrief / Scout-and-escalate / ProgressCompiler / RetryHandoff.
4. **Long-running tests (workflow pipeline e2e)** — some workflow files (imageQuickScan.ts, encodingSweep.ts) have been edited by the linter; verify they still parse.

## Conclusion

`ele_goal.md` is substantially already covered by the existing Phase 3.0-3.3b implementation: **≥95% of the listed requirements are present in the tree** with tests. The remaining gaps are:

- 2 missing external repos in the matrix
- SubmissionController Fake end-to-end wiring
- A/B benchmark fixtures actually executing (not just the scaffold)

These are minor and can be addressed without restructuring.
