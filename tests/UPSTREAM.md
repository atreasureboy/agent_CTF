# Borrow test provenance

The `tests/borrow-*.test.ts` files were inspired by / adapted from upstream
benchmark suites during the Phase borrow-plan (audit §11 F9). They are run
as part of `npm test` and exercise the runtime's interfaces against the same
mock/scenario shapes used by the upstream projects, but they are **not
verbatim copies** and should not be re-based against upstream HEAD without
review.

| Test file                                            | Upstream inspiration                         | License             | Adapted scope                           |
| ---------------------------------------------------- | -------------------------------------------- | ------------------- | --------------------------------------- |
| `borrow-a1.test.ts` (NYU D-CIPHER tier-1)            | NYU CTF Agents (category-routing pattern)    | Research / fair-use | category toolset + scope gate smoke     |
| `borrow-a2.test.ts` (swe-agent `block_unless_regex`) | swe-agent v0.7 `tools/block_unless_regex.py` | MIT                 | regex-based command gating              |
| `borrow-a3.test.ts` (CAI shot-gun coordinator)       | CAI `cai/agents/shotgun.py`                  | Apache-2.0          | multi-agent dispatch + budget           |
| `borrow-a4.test.ts` (HackSynth schema)               | HackSynth `tests/test_schema.py`             | MIT                 | challenge schema validation             |
| `borrow-b1.test.ts`                                  | cyber-zero flag-discriminator                | Apache-2.0          | flag candidate scoring                  |
| `borrow-b2.test.ts`                                  | chying-agent oneshot runtime                 | MIT                 | one-shot manifest execute path          |
| `borrow-b3.test.ts`                                  | NYU D-CIPHER swarm                           | MIT                 | solver swarm + evidence bus             |
| `borrow-c1.test.ts`                                  | (synthetic)                                  | —                   | capability profile deny/allow semantics |
| `borrow-c3-real.test.ts` / `borrow-c3.test.ts`       | cyber-zero end-to-end                        | Apache-2.0          | end-to-end smoke                        |
| `borrow-compaction.test.ts`                          | (synthetic, mirrors engine.ts compact.ts)    | —                   | context compaction invariants           |
| `borrow-d1.test.ts`                                  | NYU D-CIPHER difficulty tiers                | MIT                 | runtime tier escalation logic           |
| `borrow-d2.test.ts`                                  | NYU D-CIPHER difficulty tiers                | MIT                 | advanced tier escalation                |
| `borrow-d3.test.ts`                                  | NYU D-CIPHER difficulty tiers                | MIT                 | heavy-tier + cost-policy gates          |
| `borrow-mcp.test.ts`                                 | chying-agent MCP harness                     | MIT                 | MCP JSON-RPC smoke                      |
| `borrow-pause.test.ts`                               | (synthetic)                                  | —                   | pause / resume token semantics          |
| `borrow-real.test.ts` / `borrow-real-bench.test.ts`  | cyber-zero SolvE2E                           | Apache-2.0          | real end-to-end SolveBench              |
| `borrow-replayer.test.ts`                            | swe-agent `tests/test_replay.py`             | MIT                 | event-log replay invariants             |
| `borrow-schema.test.ts`                              | HackSynth schema validator                   | MIT                 | zod-backed challenge schema             |
| `borrow-swarm.test.ts`                               | chying-agent swarm                           | MIT                 | multi-solver orchestration + cycling    |
| `borrow-tier1.test.ts`                               | NYU D-CIPHER tier-1                          | MIT                 | tier-1 routing smoke                    |
| `borrow-bench.test.ts`                               | (synthetic)                                  | —                   | benchmark scaffolding                   |

**Important** — the vendored repos themselves (`swe-agent/`, `CAI/`,
`HackSynth/`, `cyber-zero/`, `BUUCTF_Agent/`, `nyuctf_agents/`) live under
the project root but are **git-ignored**. They are reference material used
during the borrow-phase; they are NOT pulled in by `tsc`, `eslint`, or
`vitest`. See `.gitignore` for the exact list.

If you rebase any borrowed test, update this file with the new
upstream SHA before merging.
