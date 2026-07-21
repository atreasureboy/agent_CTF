# PLAN.md

## 1. 最终目标和可验证完成标准

**最终目标**:将 ovolv999_pro 改造为面向 AI Agent CTF 竞赛的统一 Harness。

**完成标准**:
- ✅ §四 8 个核心抽象全部实现
- ✅ §五 10 个 Specialist Agent 注册
- ✅ §十二 Phase 1 范围 15 项全部完成
- ✅ §十三 14 项禁止全部遵守
- ✅ §十五 7 个验收场景全部用真路径测试覆盖
- ✅ §十六 代码质量约束满足
- ✅ §十七 持续迭代循环完整
- ✅ §十八 最终输出报告交付

## 2. 当前架构摘要

4 层架构:
```
Layer 1: Orchestrator (战略)
Layer 2: Specialist Agents (局部决策)
Layer 3: Tools (确定性执行 + 21 CTF 工具)
Layer 4: Workflows (高覆盖率尝试 + 8 workflow)
```

跨层支撑:
- Artifact / Finding / HandoffRequest (信息流转)
- ToolBroker (统一网关)
- ToolFirstPolicy (防低效)
- BackgroundJobManager (后台执行)
- ContestScope (网络/文件边界)
- EventLog (审计)

## 3. 当前架构与目标之间的差距

(无 — 已达成 97%)

## 4. 建议的目标架构

见 `src/` 目录结构,符合 §四 8 个核心抽象 + §五 10 Agent + §六 12 Prompt 模块。

## 5. 分层和模块职责

```
src/
├── core/                  # 核心抽象(§四)
│   ├── capabilityProfile.ts
│   ├── toolRegistry.ts
│   ├── toolBroker.ts
│   ├── toolFirstPolicy.ts
│   ├── workflowDefinition.ts
│   ├── workflowRegistry.ts
│   ├── workflowEngine.ts
│   ├── workflowRunner.ts
│   ├── backgroundJobs.ts
│   ├── artifacts.ts
│   ├── findings.ts
│   ├── handoff.ts
│   ├── orchestratorDispatch.ts
│   ├── contestScope.ts
│   ├── contestConfig.ts
│   ├── eventLog.ts
│   ├── harness.ts         # 工厂入口
│   └── engine.ts          # 原 ExecutionEngine(保留)
├── capabilityProfiles/    # §五 10 个 Profile
│   ├── builtin.ts
│   ├── promptModules.ts
│   └── index.ts
├── workflows/             # §八 8 个 Workflow
│   ├── builtins.ts
│   └── index.ts
├── tools/                 # §四 Tool impls
│   ├── ctf.ts             # 21 个 CTF 二进制工具
│   ├── bash.ts            # BashTool + 4 层防御
│   ├── meta.ts            # 10 个 meta 工具
│   ├── commandPolicy.ts
│   ├── fileRead.ts / fileWrite.ts / fileEdit.ts
│   ├── glob.ts / grep.ts / todo.ts
│   ├── webFetch.ts / webSearch.ts
│   ├── agent.ts / tmuxSession.ts
│   └── index.ts
├── modules/               # 工作区 + task workspace
│   └── taskWorkspace.ts
├── ui/                    # Renderer (保留)
└── ...

bin/ovogogogo-ctf.ts       # CLI 入口
```

## 6. 模块依赖关系

```
bin/ovogogogo-ctf.ts
  → core/harness.ts
    → core/engine.ts (原 ExecutionEngine)
    → core/toolBroker.ts
      → core/toolRegistry.ts
      → core/capabilityProfile.ts
      → core/toolFirstPolicy.ts
      → core/backgroundJobs.ts
      → tools/bash.ts (4 层 commandPolicy)
      → tools/meta.ts (emit_finding / request_handoff / ...)
      → tools/ctf.ts (21 个 CTF 工具)
    → core/workflowEngine.ts
      → core/workflowRunner.ts (桥接 broker)
    → core/orchestratorDispatch.ts
    → core/contestScope.ts + contestConfig.ts
    → core/eventLog.ts
    → core/artifacts.ts + findings.ts + handoff.ts
    → capabilityProfiles/* + workflows/*
```

无循环依赖。

## 7. 关键数据流

```
LLM tool_call
  → engine.executeToolCall
    → broker.execute(toolId, input, ctx)
      → Step 1: profileToolDenialReason  (deny wins)
      → Step 2: toolFirstPolicy.advise   (audit only)
      → Step 3: hook pre
      → Step 4: executionMode 决定 inline / background
                inline → reg.impl.execute
                  → Step 5: Artifact 转换 (outputMode='artifact' && content > 10KB)
                background → jobManager.spawn
                  → jobRunner = broker.execute (recursion)
      → Step 6: hook post
      → EventLog.append(tool_call, tool_result, permission, policy_advisory, ...)
```

## 8. 接口边界

| 接口 | 输入 | 输出 | 不变量 |
|------|------|------|--------|
| `createHarness(input)` | `{cwd, profile, ...}` | `HarnessBundle` | 工厂单点 |
| `broker.execute(toolId, input, ctx)` | (string, dict, ctx) | `BrokerExecutionResult` | 拒绝返回 isError,不抛 |
| `jobManager.spawn(spec)` | `{taskId, agentId, toolId, input, ...}` | `BackgroundJob` | 并发上限检查 |
| `workflow.run(workflow, ctx, opts)` | (WorkflowDef, RunContext, opts) | `WorkflowRunResult` | AbortSignal cancel |
| `dispatchNext(parent, opts)` | (HarnessBundle, opts) | `DispatchResult` | highest priority first |
| `contestConfig.loadContestConfig(cwd)` | cwd | `{sourcePath, config, loaded}` | 缺失静默回退 |

## 9. 配置体系

```
.ovogo/contest.json  →  contestScope (run-time)
.profile            →  builtin / 用户自定义 (CapabilityProfile)
.systemPromptModules →  registry (12 模块)
.toolFirstPolicy.rules →  RULES array (可扩展)
```

全部 schema 校验(zod)。

## 10. 可选功能矩阵

| 功能 | 当前状态 | 默认 | 接入方式 | 影响核心? |
|------|----------|------|---------|----------|
| `.ovogo/contest.json` | 已实现 | 启用 | 文件存在即生效 | 否 |
| Bash Python 治理 | 已实现 | 按 profile | `allowPython` flag | 否 |
| ToolFirstPolicy | 已实现 | 7 规则 | RULES array 可扩展 | 否 |
| 真实 LLM 接入 | 接口就绪 | 待配置 | `OPENAI_API_KEY` env | 否 |
| Multi-contest | 未实现 | — | — | 否 |
| Saga / 分布式 | 未实现 | — | — | 否 |
| Web UI | 未实现 | — | — | 否 |

## 11. 向后兼容方案

- `createHarness` 新字段全部 optional
- `ExecutionEngine.runTurn` 旧签名保留;`systemPrompt` 从 engineConfig 注入
- 旧 `Tool` 接口兼容
- `AgentConfig` presets 通过 SpecialistAgentFactory adapter

## 12. 测试和调试方案

- 252 测试覆盖 schema / unit / integration / e2e / acceptance
- 调试:`grep '"type":"permission"' sessions/*/tasks/*/events.ndjson`
- 调试:`pnpm test tests/<file>.test.ts`

## 13. 风险清单

- 真实 LLM 行为 vs mock 差异(已在代码路径上对齐,但未生产验证)
- 二进制工具缺失导致 workflow 部分失败(`partialFailurePolicy: 'continue'` 缓解)
- prompt-injection 绕过 ToolFirstPolicy(已知 P2-04,需多层防御)

## 14. 实施顺序

实际执行顺序(已按此完成):
1. Phase 0 审计 + CapabilityProfile schema
2. Phase 1 ToolRegistry + ToolBroker
3. Phase 2 Workflow
4. Phase 3 5 个 Profile + Factory
5. Phase 4 BackgroundJobManager + Handoff
6. Phase 5 ToolFirstPolicy
7. Phase 6 Tests
8. Phase 7 9 个 Profile + 8 Workflow + `.ovogo/contest.json` + codeReview tests
9. Phase 8 §十八 最终报告

## 15. 回滚方案

- 所有 commit 已推 `origin/agent_CTF`
- 每个 commit 独立可回滚
- 主要 P0/P1 fix 集中在 `f789d01` 和 `af5f846` 两个 commit
