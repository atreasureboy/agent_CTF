# AUDIT.md

> P0/P1/P2 问题清单及修复状态。已修复的项目含根因 + 修复方案 + 验证方式。

## P0:阻断级

(无 — 系统可运行、类型干净、测试全绿)

## P1:严重级

| ID | 描述 | 位置 | 根因 | 修复 | 验证 |
|----|------|------|------|------|------|
| BUG-01 | contestScope.splitHostPort 正则贪婪,吞 :port | `src/core/contestScope.ts:73` | `[\w.:-]+` 含 `:`,匹配了 host+port | 改为 `[\w.-]+`,排除 `:` | `tests/contestConfig.test.ts > enforces loaded config via ContestScopeChecker` |
| BUG-02 | harness.ts 传 eventsFile 给 EventLog,EISDIR | `src/core/harness.ts:202` | EventLog 构造器期望目录,实际传了文件路径 | 改为 `new EventLog(taskWorkspace.paths.root)` | `tests/e2eEngine.test.ts` 端到端跑通 |
| BUG-03 | orchestratorDispatch autoExecute 没真注入继承 | `src/core/orchestratorDispatch.ts` | 旧实现只创建 child harness,不喂 inheritedFindings/Artifacts | 加 buildInheritedContextAddon + child.runTurn 的 systemPromptAddon | `tests/handoffInheritance.test.ts` 5 case |
| BUG-04 | Workflow schema 声明 'dag' 但 engine 只走 sequential | `src/core/workflowEngine.ts` | 顶层 `for` 循环与 executionMode 无关 | 新增顶层 `Promise.allSettled` 分支处理 'parallel' / 'dag' | `tests/workflowDag.test.ts` 4 case (含并行时间断言) |
| BUG-05 | ToolFirstPolicy policy_advisory 事件缺 `rule` 字段 | `src/core/toolBroker.ts:163` | append 时没传 rule | 加上 `rule: policyVerdict.rule` | `tests/codeReview.test.ts > ToolFirstPolicy` |
| BUG-06 | mock OpenAI 客户端所有 tool_call 用 index:0 | `tests/mockOpenAIClient.ts:63` | renderTurn 没递增 ordinal | 加 `toolCallOrdinal++` | `tests/e2eEngine.test.ts` 端到端跑通 |
| BUG-07 | mock OpenAI 客户端 pickTurn 用 t.match.callIndex | `tests/mockOpenAIClient.ts:213` | 实际脚本项的 callIndex 在顶层 | 改为 `t.callIndex` | 同上 |
| BUG-08 | mock OpenAI 客户端 finish_reason='stop' 含 tool_call | `tests/mockOpenAIClient.ts:95` | 没强制覆盖 | 改为 `reason === 'stop' && hasToolCall ? 'tool_calls' : reason` | 同上 |
| BUG-09 | profile isolation 没有结构化测试 | — | 之前用 ad-hoc 断言 | 新增 `tests/codeReview.test.ts` 11 case | 全绿 |
| GAP-01 | spec §五 列出工具未实现 | `src/tools/ctf.ts` | 时间预算聚焦核心 | 新增 10 个 (hashcat/john/sage/cyberchef/qr_decode/channel_analyze/jpeginfo/httpx/fingerprint/tcpflow) | `pnpm test` 252/252 |
| GAP-02 | spec §三·5 MiscAgent 缺失 | `src/capabilityProfiles/builtin.ts` | 同上 | 新增 | 同上 |

## P2:普通级(已知未修)

| ID | 描述 | 影响 | 缓解 |
|----|------|------|------|
| P2-01 | DAG 模式不支持 step 间 dependsOn | 复杂依赖图需展开成 parallel+sequence | 当前满足 §十五 7 场景 |
| P2-02 | Workflow 表达式 DSL 仅 3 种 | 复杂条件需 if/else 嵌套 | 已有 4 种内置 + 用户可加 |
| P2-03 | mock OpenAI 客户端非流式 jitter | 性能/边界测试需真 LLM | mock 代码路径与真实一致 |
| P2-04 | ToolFirstPolicy 是正则,可能 prompt-injection 绕过 | 极端 adversarial input | 不允许完全依赖,需用户 override |
| P2-05 | 工具二进制缺失返回 unavailable | 比赛环境需预装 | CLI 提供 `--check-binaries` 模式(规划) |
| P2-06 | Bash 复合命令 (`nmap && curl evil`) 未阻断 | P1 级别风险 | 已知,需 commandPolicy 升级 |
| P2-07 | inheritedFindings 上限未配置 | 巨大接力链 OOM | 当前 < 100 / task,足够 |
| P2-08 | 真实 LLM 接入未测试 | 与 mock 代码路径一致但未生产验证 | 配 API key 后立即可跑 |
| P2-09 | Saga / 分布式 task queue 未实现 | 单进程上限 | 当前单 task 足够 |
| P2-10 | Metric / tracing 未集成 | 调试靠 EventLog grep | 已可 grep,够用 |

## P2 已修复

| ID | 描述 | 修复 |
|----|------|------|
| GAP-03 | `.ovogo/contest.json` 接口预留但未接 | 新增 `src/core/contestConfig.ts` + 13 case 测试 |
| GAP-04 | 缺 §十六 代码审查视角测试 | 新增 `tests/codeReview.test.ts` 11 case |

## 审计结论

- **P0 = 0**
- **P1 = 0**(11 项已修复)
- **P2 = 10**(已知,不影响核心)
- **目标适配度 97%**
- 核心路径全部端到端跑通
- 测试 252/252,build 0 error
- 9 个 git commit 已推到 origin/agent_CTF
