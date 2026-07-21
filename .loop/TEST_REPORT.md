# TEST_REPORT — 测试命令、结果与最终结论

## 测试命令

```sh
pnpm install                 # 安装依赖
pnpm run build               # tsc 编译（zero errors）
pnpm test                    # vitest run（190 tests）
pnpm run lint                # eslint（剩余告警来自既有测试样板，非新增代码）
```

## 测试结果

| 项目 | 数值 | 备注 |
|------|------|------|
| Test Files | **18 passed (18)** | +8 新文件 |
| Tests | **190 passed (190)** | +63 新增 |
| 编译 | **tsc — 0 error** | strict 模式 + ES2022 + NodeNext |
| 既有测试回归 | **127 passed** | baseline 全部保留 |
| 新增测试覆盖 | **63 passed** | 见下表 |

## 新增测试矩阵（与 goal.md 验收一一对应）

| goal.md 验收场景 | 对应测试 | 状态 |
|-----------------|----------|------|
| 场景 1 — 图片专业化 | `tests/acceptance.test.ts > 场景 1` | ✅ 3/3 |
| 场景 2 — 跨领域接力 | `tests/acceptance.test.ts > 场景 2` | ✅ 2/2 |
| 场景 3 — 工具优先策略 | `tests/acceptance.test.ts > 场景 3` | ✅ 3/3 |
| 场景 4 — 工具禁用 | `tests/acceptance.test.ts > 场景 4` | ✅ 2/2 |
| 场景 5 — Bash 绕过 | `tests/acceptance.test.ts > 场景 5` | ✅ 3/3 |
| 场景 6 — 合理手工脚本 | `tests/acceptance.test.ts > 场景 6` | ✅ 2/2 |
| 场景 7 — 后台任务取消 | `tests/acceptance.test.ts > 场景 7` | ✅ 2/2 |
| 集成 — HandoffRequest 与 Orchestrator | `tests/acceptance.test.ts > 集成` | ✅ 1/1 |
| 单元 — CapabilityProfile | `tests/capabilityProfile.test.ts` | ✅ 9/9 |
| 单元 — ToolRegistry | `tests/toolRegistry.test.ts` | ✅ 6/6 |
| 单元 — ToolFirstPolicy | `tests/toolFirstPolicy.test.ts` | ✅ 5/5 |
| 单元 — Workflow Engine + Registry | `tests/workflow.test.ts` | ✅ 7/7 |
| 单元 — Artifact / Finding / Handoff | `tests/artifactFindingHandoff.test.ts` | ✅ 4/4 |
| 单元 — BackgroundJobManager | `tests/backgroundJobs.test.ts` | ✅ 5/5 |
| 单元 — ToolBroker | `tests/toolBroker.test.ts` | ✅ 4/4 |
| 单元 — SpecialistAgentFactory | `tests/acceptance.test.ts` (集成段) | ✅ 1/1 |
| 单元 — TaskWorkspace | `tests/acceptance.test.ts` (集成段) | ✅ 1/1 |
| 集成 — Workflow Run | `tests/acceptance.test.ts` (集成段) | ✅ 1/1 |

总新增：**63 tests**

## 失败 / 修复轨迹

1. `RegisteredTool` 导出 — `toolBroker.ts` 从 `toolDefinition.ts` 而非 `toolRegistry.ts` 导入。
2. `policy_advisory` 不在 EventType — 加入新事件类型 (`policy_advisory`, `artifact_created`, `finding_emitted`, `handoff_requested`, `job_state`, `workflow_run`)。
3. 自引用 schema — `workflowStepSchema` 改为 `z.lazy()` + 顶层手写 `WorkflowStep` 类型。
4. CapabilityProfile schema — 去掉 allowedTools/deniedTools 重叠检查（deny 优先是合法的运行时语义）。
5. WorkflowRegistry.register 抛重名错误 — 提供 `upsert()`，让 `ensureWorkflowsRegistered` 幂等可重入。
6. `BackgroundJobManager` 同步 — 写入类操作全部 `mkdirSync(dirname, { recursive: true })`。
7. workflowEngine status 算法 — 修正 `only-skipped` 视为 success。
8. `ConcurrencyLimitError` 文案 — 测试分别验证 `maxPerAgent` / `maxPerTask` 两条路径。

## 命令复现

```sh
pnpm install
pnpm run build && pnpm test
# expected: 18 files / 190 tests / 0 failures
```
