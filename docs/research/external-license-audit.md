# External License Audit & Clean-Room Compliance Report

## Overview
This document records the external project license audit conducted during Phase 3.0 implementation of `agent_CTF`. All reference projects listed below were analyzed solely at the conceptual/behavioral level to design native TypeScript interfaces without copying code, prompts, schemas, or exact variable naming structures.

## Reference Repositories & License Audit

| Repository | License | Files Examined | High-Level Behaviors Analyzed | Code Copied? | Native Implementation File in agent_CTF |
| ---------- | ------- | -------------- | ----------------------------- | ------------ | --------------------------------------- |
| `yhy0/CHYing-agent` | MIT | README, prompt architecture, context manager | Progress brief structures, MCP tool hiding patterns | **No** | `src/core/contextCompiler/*`, `src/core/toolVisibility/*` |
| `verialabs/ctf-agent` | Apache-2.0 | README, solver dispatch, message bus | Multi-solver race handling, operator guidance JSON format | **No** | `src/core/solverPortfolio/*` |
| `aliasrobotics/CAI` | AGPL-3.0 | README, handoff rules, flag validator | Strict discriminator boundaries, tool permission isolation | **No** | `src/core/modelReliability/modelRolePolicy.ts`, `flagDiscriminator.ts` |
| `aielte-research/HackSynth` | MIT | README, benchmark harness | Trajectory metrics, separate summarizer pattern | **No** | `src/core/trajectory/*`, `src/bench/*` |
| `amazon-science/cyber-zero` | MIT | README, docker runner, benchmark specs | `challenge.json` schema layout, trajectory JSONL schema | **No** | `src/bench/challengeBenchmarkAdapter.ts` |
| `passer-W/ctfSolver` | MIT | README | Multi-model role mapping concepts | **No** | `src/core/modelReliability/modelRouter.ts` |
| `MuWinds/BUUCTF_Agent` | GPL-3.0 | README | Platform adapter abstractions | **No** | `src/core/solverPortfolio/submissionController.ts` |

## Compliance Rules & Verification
1. **Zero Code Duplication**: No source code lines, functions, or exact prompt templates were copied from any external repository.
2. **Clean-Room Engineering**: All features are implemented using standard TypeScript, Zod schema validation, and native `CTFTaskState` interfaces.
3. **No Vendoring**: No third-party repository was included as submodules, vendor directories, or direct production dependencies.
