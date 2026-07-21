# PLAN — 目标架构

## 1. 最终目标

将 ovolv999_pro（TypeScript 统一 Agent Harness）改造为面向 **AI Agent CTF 竞赛** 的统一 Harness：

- **主 Agent / Strategist**：全局判断、任务拆分、资源调度、优先级、结果汇总
- **专业子 Agent**：领域局部规划、工具选择、结果解释、接力
- **专业工具**：确定性原子操作
- **一把梭 Workflow**：高覆盖率批量操作
- **核心循环可运行** + **7 个验收场景通过** + **P0/P1 = 0**

## 2. 当前架构摘要

```text
bin/ovogogogo.ts
  → ExecutionEngine (单循环 Think-Act-Observe)
      ├─ Tool 子系统 (src/tools/* Tool classes)
      │  └─ AgentTool ──┐
      ├─ ModuleRegistry ├─→ AgentModule [Memory / Critic / Workspace / Reflection]
      ├─ PermissionChecker
      ├─ EventLog (NDJSON)
      ├─ HookRunner (Pre/Post/... hooks)
      └─ SystemPrompt (system.ts + OVOGO.md + 任务上下文)
```

## 3. 当前架构与目标的差距

| 维度 | 当前 | 目标 | 差距 |
|------|------|------|------|
| Tool 抽象 | `Tool` 类 | `ToolDefinition` 带 domain/executionMode/costClass/outputMode/riskLevel/requiredBinaries + 注册表 | 缺元数据，缺注册器 |
| 工具调用入口 | 直接 `tool.execute` | ToolBroker：命令解析 + Profile 过滤 + 超时 + Artifact + 审计 + 摘要 | 缺统一网关 |
| Agent 身份 | AgentConfig（preset + modules + tools） | CapabilityProfile（id/displayName/systemPromptModules/allowedTools/deniedTools/allowedWorkflows/deniedWorkflows/allowedCommands/deniedCommands/allowShell/allowPython/allowBackgroundJobs/allowAgentHandoff/limits） | 缺细粒度 Profile |
| 子 Agent | 现有 4 个通用 preset | OrchestratorAgent / TriageAgent / ImageStegoAgent / CryptoAgent / FileForensicsAgent | 缺领域身份 |
| 工作流 | 无 | sequential/parallel/dag + requiredTools + stopConditions | 新增 |
| 后台任务 | Bash.run_in_background 字符串 + 临时日志文件 | BackgroundJobManager（spawn/status/wait/cancel/collect/list） | 新增 |
| Artifact | 无 | 落盘 + sha256 + 摘要 + 归属 taskId/agentId | 新增 |
| Finding | 无 | category/title/summary/confidence/evidence/artifactIds/suggestedAgent | 新增 |
| HandoffRequest | 无 | 标准化接力请求 + Findings/Artifact 继承 | 新增 |
| ToolFirstPolicy | 无 | 规则 + Hook，提醒"用成熟工具而不要手写" | 新增 |
| ContestScope | 无 | allowedHosts / Cidrs / Ports / FilesRoot | 新增 |
| 工作区隔离 | sessions/session_*/（每 CLI 会话） | sessions/<contestId>/tasks/<taskId>/{input,workspace,artifacts,findings,agents,jobs,events.ndjson} | 改造 |
| 4 个示例 Workflow | 无 | unknown_file_triage / image_quick_scan / encoding_sweep / rsa_common_attacks 骨架 | 新增 |

## 4. 建议的目标架构

```text
ContestScope ─┐
              │
User Prompt ──┴→ OrchestratorAgent (主 Agent / Strategist)
                  │
                  ├─ list_tasks / spawn_specialist / inspect_finding / approve_handoff / cancel_agent / update_priority
                  │
                  └─→ SpecialistAgent (Profile 工厂)
                       ├─ TriageAgent          ─→ unknown_file_triage Workflow
                       ├─ ImageStegoAgent     ─→ image_quick_scan, png_stego_sweep
                       ├─ CryptoAgent         ─→ encoding_sweep, classical_cipher_sweep, xor_key_search, rsa_common_attacks
                       ├─ FileForensicsAgent  ─→ archive_recursive_extract, magic_header_repair_candidates
                       └─ (WebAgent/Reverse/Pwn/Traffic 后续扩展)
                       
                       工具调用统一经过：
                       ToolBroker(profile, registry)
                         ├─ Profile.allowedTools/deniedTools/allowedCommands/deniedCommands 决策
                         ├─ 后台工具 → BackgroundJobManager
                         ├─ 长输出落盘为 Artifact，仅返回摘要
                         ├─ 命中 ToolFirstPolicy 规则 → 提醒
                         └─ 调用 EventLog + Hook

三道治理：
  1. CapabilityProfile + Tool/WF Registry — Agent 不可见未授权
  2. ToolBroker + PermissionChecker + Bash 策略 — 拒绝绕过
  3. Findings + Artifacts + Handoff — 信息流和接力

工作区隔离：
sessions/
  <contestId>/
    tasks/<taskId>/
      input/        题目原文（只读）
      workspace/    当前 Agent/Job 工作目录
      artifacts/    长输出/提取文件/sha256 摘要
      findings/     结构化 findings.jsonl
      agents/<runId>/
      jobs/
      events.ndjson
```

## 5. 分层和模块职责

| 模块 | 位置 | 职责 |
|------|------|------|
| Tool Registry | `src/core/toolRegistry.ts` | 单例工具目录，按 id 索引，提供 list/get/query |
| Tool Definition | `src/core/toolDefinition.ts` | domain、executionMode、costClass、outputMode、riskLevel、requiredBinaries 元数据 |
| Tool Broker | `src/core/toolBroker.ts` | Profile 决策、命令策略、超时、长输出→Artifact、审计、并发上限 |
| Workflow Registry | `src/core/workflowRegistry.ts` | 步骤定义、依赖、执行模式、超时、状态、部分失败 |
| Workflow Engine | `src/core/workflowEngine.ts` | 运行 WorkflowStep，处理 step 状态、产物传递、停止条件 |
| Workflow Steps | `src/core/workflowSteps/` | 工具调用、shell、条件、并行、汇合 |
| BackgroundJobManager | `src/core/backgroundJobs.ts` | spawn/status/wait/cancel/collect/list，并发上限 |
| Artifact Store | `src/core/artifacts.ts` | 写入、sha256、摘要、归属 |
| Finding | `src/core/findings.ts` | 类型 + JSONL 落地 |
| HandoffRequest | `src/core/handoff.ts` | 标准化接力 schema |
| CapabilityProfile | `src/core/capabilityProfile.ts` | Profile 类型 + zod schema + 校验 |
| ContestScope | `src/core/contestScope.ts` | 网络/文件范围策略 |
| SpecialistAgentFactory | `src/core/specialistAgent.ts` | 根据 profile 拼装 prompt + tools + 引擎 |
| ToolFirstPolicy | `src/core/toolFirstPolicy.ts` | 规则引擎（pretool-call + plan-review） |
| TaskWorkspace | `src/modules/taskWorkspace.ts` | 任务工作区与产物目录管理（替换 WorkspaceModule） |
| Agents (built-in) | `src/agents/{orchestrator,triage,imageStego,crypto,fileForensics}.ts` | 5 个示例 |
| Workflows (built-in) | `src/workflows/{unknownFileTriage,imageQuickScan,encodingSweep,rsaCommonAttacks}.ts` | 4 个示例 |

## 6. 模块依赖关系

```text
Tools ──→ ToolDefinition ──→ ToolRegistry ──→ ToolBroker ──→ ExecutionEngine
                                                       │
                                                       ├──→ Profile / ContestScope
                                                       ├──→ BackgroundJobManager
                                                       ├──→ Artifact Store
                                                       └──→ EventLog / HookRunner

Workflows ──→ WorkflowRegistry ──→ WorkflowEngine ──→ ToolBroker
                                                  │
                                                  ├──→ BackgroundJobManager
                                                  └──→ Findings / Artifacts

Agents ──→ CapabilityProfile + SpecialistAgentFactory ──→ ExecutionEngine
                                                    │
                                                    ├──→ ToolRegistry
                                                    ├──→ WorkflowRegistry
                                                    └──→ BackgroundJobManager

Orchestrator ──→ HandoffRequest ──→ Specialist Agents
```

**依赖方向约束**：
- Tool/Workflow 不可依赖具体 Agent
- Specialist Agents 不可依赖 Orchestrator（保持对等）
- 核心抽象（registry/broker/jobManager）不依赖 UI/存储具体实现（接口可注入）

## 7. 关键数据流

### 7.1 工具调用流

```text
model.tool_call(tool, args)
  → Engine.executeToolCall(tool, args)
    → ToolBroker.execute(tool, args)
      → Profile 决策（allowedTools / deniedTools / allowedCommands / deniedCommands）
      → ToolFirstPolicy.advise(tool, args) [返回 reason + 是否 override]
      → 超时 + 并发（BackgroundJobManager）
      → 实际执行（可能后台）：tool.execute(args, context)
      → Artifact 化：若 content > N 字节 → 写入 Artifact，content 替换为摘要 + artifact_id
      → EventLog.append('tool_call') + HookRunner.runPreToolCall
      → 完成后 EventLog.append('tool_result') + HookRunner.runPostToolCall
    → 返回 ToolResult 给 Engine
```

### 7.2 工作流执行流

```text
执行 Workflow:
  → WorkflowEngine.run(workflow, input, ctx)
    → 拓扑/串行执行 WorkflowStep[]
    → 每步 → ToolBroker.execute
    → 状态机：pending → running → success/failed/skipped
    → 满足 stopConditions → 提前终止
    → 部分失败：默认继续，可配置终止
    → 输出 = { findings, artifacts, status }
```

### 7.3 接力流

```text
专业 Agent 决定接力：
  → 构造 HandoffRequest（taskId, fromAgent, suggestedAgent, reason, objective, artifactIds, findingIds, constraints, priority）
  → 写入 artifacts/handoffs/req_<id>.json + EventLog
  → 返回 Finding { recommendedNextActions: ['request_handoff'] } 给 Orchestrator

Orchestrator 决策：
  → 读 HandoffRequest + 已有 Findings + Artifacts
  → approve_handoff → 实例化接手的 SpecialistAgentFactory.create(suggestedAgent, ...)
    → 继承 Findings + Artifacts（注入其 prompt 上下文）
    → 限制只能访问当前 taskId 工作区
```

### 7.4 后台任务流

```text
Specialist Agent：
  → ToolBroker 决定 executionMode='background' → BackgroundJobManager.spawn(tool, args)
    → 返回 Job { id, status:'running', pid, startedAt, artifactPath }
    → Agent 后续调用 query_background_job({id}) → JobManager.status(id)
    → 完成后 Agent 通过 collect_background_result({id}) 拿结果
```

## 8. 接口边界

### 8.1 CapabilityProfile

```ts
interface CapabilityProfile {
  id: string
  displayName: string
  description?: string
  systemPromptModules: string[]
  allowedTools?: string[]            // undefined = 全部
  deniedTools?: string[]
  allowedWorkflows?: string[]
  deniedWorkflows?: string[]
  allowedCommands?: string[]         // 可执行文件一级（shell 命令策略）
  deniedCommands?: string[]
  allowShell: boolean
  allowPython: boolean
  allowBackgroundJobs: boolean
  allowAgentHandoff: boolean
  preferredAgentsForHandoff?: string[]
  limits?: { maxIterations?: number; maxParallelJobs?: number; maxExecutionSeconds?: number; maxToolCalls?: number }
}
```

### 8.2 ToolDefinition（增强版）

```ts
interface ToolDefinition {
  id: string                         // 'Bash' 等
  name: string
  description: string
  domains: string[]                  // ['forensics', 'crypto', 'image', ...]
  inputSchema: unknown
  executionMode: 'foreground' | 'background' | 'either'
  costClass: 'cheap' | 'medium' | 'expensive'
  outputMode: 'inline' | 'artifact' | 'structured'
  riskLevel?: 'low' | 'medium' | 'high'
  requiredBinaries?: string[]        // 适配 availability detection
  parameters: ToolParameters         // LLM 暴露
}
```

### 8.3 WorkflowDefinition

```ts
interface WorkflowDefinition {
  id: string
  name: string
  description: string
  domains: string[]
  acceptedInputs: string[]
  outputSchema: unknown
  steps: WorkflowStep[]
  executionMode: 'sequential' | 'parallel' | 'dag'
  stopConditions?: WorkflowCondition[]
  requiredTools: string[]
}
```

### 8.4 Artifact / Finding / Handoff

如 goal.md §四·7、§四·8。

### 8.5 BackgroundJob

```ts
interface BackgroundJob {
  id: string
  taskId: string
  agentId: string
  toolId: string                     // 'Bash' / workflow id
  status: 'pending' | 'running' | 'success' | 'failed' | 'cancelled'
  startedAt: string
  endedAt?: string
  timeoutMs: number
  artifactPath?: string
  summary?: string
  error?: string
  cancelReason?: string
}
```

## 9. 配置体系

### 9.1 扩展 `.ovogo/agent.json`

```ts
{
  // 现有字段保留
  // ...
  // 新增
  capabilityProfiles?: Record<string, CapabilityProfile>
  defaultContestScope?: ContestScope
  tasksDir?: string                  // 默认 'sessions'
  workflowTimeoutDefaultMs?: number  // 默认 60_000
  backgroundJobs?: { maxPerAgent?: number; maxPerTask?: number }
}
```

### 9.2 比赛范围配置

`.ovogo/contest.json`：

```ts
{
  contestId: string
  scope: { allowedHosts?: string[]; allowedCidrs?: string[]; allowedPorts?: number[]; allowedDomains?: string[]; allowedFilesRoot: string }
  primaryModel?: string
  maxIterations?: number
}
```

## 10. 可选功能矩阵

| 功能 | 当前状态 | 默认状态 | 接入方式 | 是否影响核心 |
|------|----------|----------|----------|--------------|
| ToolFirstPolicy 提示 | 未实现 | 开启 | 内置于 ToolBroker | 否 |
| Artifact 化 | 未实现 | 开启（>10KB 自动） | 内置于 ToolBroker | 否 |
| Background Jobs | 部分（`run_in_background` 字符串） | 开启 | BackgroundJobManager | 否 |
| HandoffRequest 强制 | 未实现 | 开启 | Tool + 协议 | 是 |
| Workflow Registry | 未实现 | 开启 | 新模块 | 是 |
| ContestScope 网关 | 未实现 | 关闭（保守默认） | 配置项 | 否 |
| 工作区隔离 | 部分（sessions/session_*） | 开启 | TaskWorkspace 模块替换 | 否 |
| Reflection 模块 | 存在（可选） | opt-in | agent.json | 否 |
| Critic 模块 | 存在（可选） | opt-in | agent.json | 否 |
| Hooks | 存在 | 开启 | settings.json | 否 |

## 11. 向后兼容方案

- 保留所有现有预设（explore/plan/code-reviewer/general-purpose）通过 CapabilityProfile 适配器包装，输出仍兼容 AgentConfig。
- 保留所有现有工具类（Bash/Read/Write/...），追加元数据（domain、executionMode、costClass、outputMode 等），保持 Tool 接口。
- 保留 EventLog NDJSON，向前追加 CTF EventType（artifact_created、finding_emitted、handoff_requested、job_state 等）。
- 保留 PermissionChecker 行为，仅在其之前并行执行 ToolBroker 决策。
- 保留 hooks，添加 hook 类型而非破坏现有 hook。

## 12. 测试和调试方案

- 单元测试：每个核心抽象（Profile/Registry/Broker/JobManager/Workflow）单独 mock 测试。
- 集成测试：OrchestratorAgent → TriageAgent → ImageStegoAgent → CryptoAgent 全链路；用本地 fixture PNG（必要时 stub 工具输出）。
- 验收：tests/acceptance/ 下 7 个场景文件，逐项跑通。
- 调试：EventLog NDJSON 永远是单一可信来源；ToolFirstPolicy 命中写入 `policy_violation` 事件。

## 13. 风险清单

| 风险 | 缓解 |
|------|------|
| 大量 Tool 元数据补全工作量 | 先为 4 个示例 Workflow 用到的工具补全，其余渐进 |
| 后台任务生命周期与子 Agent 并发相互干扰 | JobManager 用 taskId 命名空间隔离，并显式提供 cancel |
| Bash 策略误伤合法命令 | allowlist 仅作用于 deny 时强制；优先模式匹配 |
| 工作区隔离破坏现有 sessions 数据 | sessions/ 旧结构保留（向下兼容读取），新结构在 sessions/<contestId>/tasks/<taskId>/ |
| LLM 自行选择手写而非调专业工具 | ToolFirstPolicy 提供 reminder + override 审计，不强制阻塞 |

## 14. 实施顺序（Phase 4 实现循环）

> 每一个"步"为一个 commit，目标是任意一步可独立运行。

### 阶段 A：核心抽象（无 LLM 改动）

1. ToolDefinition + ToolRegistry + CapabilityProfile 类型与 zod schema
2. ToolBroker：Profile 决策、命令策略、超时、Artifact 化、EventLog
3. WorkflowDefinition + WorkflowRegistry + WorkflowSteps + WorkflowEngine
4. BackgroundJobManager（spawn/status/wait/cancel/collect/list）
5. Artifact Store + sha256 + 摘要 + Artifact 化集成入 Broker
6. Finding 类型 + JSONL 持久化
7. HandoffRequest 类型 + 协议 + EventLog
8. ContestScope 类型与基本策略
9. Shell/Python 治理：把 BashTool 接入 ToolBroker 的命令策略

### 阶段 B：能力与策略

10. SpecialistAgentFactory + CapabilityProfile 拼装引擎 prompt
11. 5 个示例 Agent profile：Orchestrator / Triage / ImageStego / Crypto / FileForensics
12. 4 个示例 Workflow：unknown_file_triage / image_quick_scan / encoding_sweep / rsa_common_attacks
13. ToolFirstPolicy 规则引擎：4 个起步规则 + override 审计
14. ContestScope → Bash 适配器（仅 Bash 网络工具受范围策略）

### 阶段 C：工作区与隔离

15. TaskWorkspace 模块：sessions/<contestId>/tasks/<taskId>/... 路径解析、文件落盘
16. Agent 受限工作目录：在 BashTool 内加入 profile.taskWorkspaceCwd 强制

### 阶段 D：验收

17. tests/acceptance/ 7 个场景
18. .ovogo/contest.json 配置示例
19. README 更新为 CTF 框架定位

## 15. 回滚方案

每个 PR 单独立即可回滚（旧实现保留直到新实现测试通过）。工作区命名向下兼容旧 sessions 目录读取。

## 16. 阶段 0-3 完成检查

- ✅ 已审计全部 src/core
- ✅ 已审计全部 tools（含 Bash、Agent）
- ✅ 已审计 modules（memory/workspace）
- ✅ 已审计 config（settings/agentConfig/ovogomd）
- ✅ 已审计 bin/ovogogogo.ts 入口
- ✅ 目标适配度文件 `.loop/STATE.md` 已写
- ✅ 审计文件 `.loop/AUDIT.md` 已写
- ✅ 计划 `.loop/PLAN.md` 已写
