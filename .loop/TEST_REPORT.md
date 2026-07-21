# TEST_REPORT.md

测试命令、结果、失败原因和最终结论。

## 测试命令

```bash
pnpm test                # 全部
pnpm test <pattern>      # 单独文件
pnpm run build           # tsc strict 类型检查
```

## 测试矩阵(25 文件 / 252 测试)

| 文件 | 测试数 | 类型 | 覆盖维度 |
|------|--------|------|---------|
| `tests/capabilityProfile.test.ts` | 14 | unit | schema / deny precedence / overlap / parse |
| `tests/toolRegistry.test.ts` | 8 | unit | register / resolveFor / availability / metadata |
| `tests/toolFirstPolicy.test.ts` | 6 | unit | 7 规则 / override audit |
| `tests/toolBroker.test.ts` | 12 | integration | profile deny / artifact convert / job spawn / event audit |
| `tests/commandPolicy.test.ts` | 11 | unit | 4 层 bash 防御 / first-executable |
| `tests/backgroundJobs.test.ts` | 9 | unit | spawn / wait / cancel / task cancel / timeout |
| `tests/artifactFindingHandoff.test.ts` | 12 | integration | store / 持久化 / 跨 agent 引用 |
| `tests/workflow.test.ts` | 18 | integration | 8 workflow / dag / partial failure / sequence / parallel / if |
| `tests/e2eHarness.test.ts` | 14 | e2e | broker→workflow→meta tools 全链路 |
| `tests/e2eEngine.test.ts` | 4 | e2e | 真实 Engine.runTurn + mock LLM |
| `tests/acceptance.test.ts` | 7 | acceptance | §十五 7 验收场景 |
| `tests/codeReview.test.ts` | 11 | acceptance | §十六 代码审查视角 |
| `tests/contestConfig.test.ts` | 13 | integration | .ovogo/contest.json 自动加载 + merge |
| `tests/handoffInheritance.test.ts` | 5 | acceptance | 子 Agent 真注入继承 |
| `tests/workflowDag.test.ts` | 4 | unit | executionMode='dag' 真并发 |
| `tests/eventLog.test.ts` | 4 | unit | append / readAll / 防丢 |
| `tests/specialistAgent.test.ts` | 6 | unit | composeSystemPrompt / prompt modules |
| `tests/findingStore.test.ts` | 5 | unit | append / list / formatForPrompt |
| `tests/artifactStore.test.ts` | 4 | unit | writeSync / sha256 / summary |
| `tests/handoffStore.test.ts` | 5 | unit | submit / decide / list / pending |
| `tests/orchestratorDispatch.test.ts` | 4 | unit | inspect / decide / 优先级 |
| 其他 | ~ 75 | misc | engine / renderer / 工具 impl / taskWorkspace |

## 测试结果(2026-07-21)

```
$ pnpm test
Test Files  25 passed (25)
Tests       252 passed (252)
Duration    1.02s

$ pnpm run build
> ovogogogo@0.1.0 build /project/agent_CTF/ovolv999_pro
> tsc
(0 errors)
```

## 失败历史(已修)

| # | 失败原因 | 修复 |
|---|---------|------|
| 1 | `commandPolicy` 正则不识别 `-i VAR=` 形式 | 加 `env -i VAR=...` 跳过 |
| 2 | `BackgroundJobManager.spawn` 并发上限在 task cancel 后未恢复 | cleanup hook |
| 3 | `ToolFirstPolicy.image-stego` 触发条件太宽,误报 | 收紧正则,加 image ext 检测 |
| 4 | `WorkflowRegistry.register` 重复注册抛错而非 upsert | 改为 upsert + 测试适配 |
| 5 | `mockOpenAIClient` `finish_reason='stop'` 含 tool_calls | 强制覆盖 |
| 6 | `mockOpenAIClient` tool_call 全部 index:0 | 递增 ordinal |
| 7 | `contestScope.splitHostPort` 贪婪匹配 | 排除 `:` |
| 8 | `codeReview.test.ts` 多个 `tags?.includes` 类型 | 加 `?? false` |
| 9 | `orchestratorDispatch` 没真注入继承 | buildInheritedContextAddon |
| 10 | `workflowEngine` 'dag' mode 实际是 sequential | 顶层 Promise.allSettled |

## 已知未修

详见 `.loop/AUDIT.md` 的 P2 表(P2-01 ~ P2-10)。

## 结论

- **测试通过率**: 252 / 252 = 100%
- **类型检查**: tsc strict 0 error
- **核心路径覆盖**: §十五 7 验收场景全部用真路径测试
- **代码审查视角**: §十六 11 case 覆盖每条拒绝路径
- **真实 LLM**: 未在生产 endpoint 验证(P2-08),但 Engine→Broker→Tools→Findings 链路已通过 mock LLM 跑通
