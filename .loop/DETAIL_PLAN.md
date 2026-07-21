# DETAIL_PLAN — 实现层细节

## 文件落地清单

### 新增（核心抽象）

```text
src/core/toolDefinition.ts          — ToolDefinition 元数据扩展（domain/executionMode/costClass/outputMode 等）
src/core/toolRegistry.ts            — 集中注册表，默认工具自动注册
src/core/toolBroker.ts              — 工具调用统一网关
src/core/capabilityProfile.ts       — CapabilityProfile + zod schema + 校验
src/core/contestScope.ts            — ContestScope + 网关
src/core/artifacts.ts               — Artifact 类型 + 落盘 + sha256 + 摘要
src/core/findings.ts                — Finding 类型 + JSONL 持久化
src/core/handoff.ts                 — HandoffRequest 类型 + 协议工具
src/core/backgroundJobs.ts          — BackgroundJobManager
src/core/workflowDefinition.ts      — WorkflowDefinition / WorkflowStep
src/core/workflowRegistry.ts        — WorkflowRegistry
src/core/workflowEngine.ts          — WorkflowEngine
src/core/workflowSteps.ts           — 内置 step 工厂（runTool/stepShell/if/parallel）
src/core/specialistAgent.ts         — SpecialistAgentFactory
src/core/toolFirstPolicy.ts         — ToolFirstPolicy 规则引擎
```

### 新增（CTF 内置）

```text
src/agents/orchestrator.ts          — OrchestratorAgent profile
src/agents/triage.ts                — TriageAgent profile
src/agents/imageStego.ts            — ImageStegoAgent profile
src/agents/crypto.ts                — CryptoAgent profile
src/agents/fileForensics.ts         — FileForensicsAgent profile
src/workflows/unknownFileTriage.ts  — Workflow
src/workflows/imageQuickScan.ts     — Workflow
src/workflows/encodingSweep.ts      — Workflow
src/workflows/rsaCommonAttacks.ts   — Workflow skeleton
src/capabilityProfiles/index.ts     — 内置 profile 集合
```

### 新增（工作区与适配）

```text
src/modules/taskWorkspace.ts        — sessions/<contestId>/tasks/<taskId>/... 路径解析
```

### 修改

```text
src/core/types.ts                   — ToolContext 增加 profile/capabilityProfile/contestScope/artifacts/findings/jobManager
src/core/engine.ts                  — 接入 ToolBroker（而非直接 tool.execute），Tool/Workflow 决策点
src/tools/bash.ts                   — 增加命令策略：allowedCommands/deniedCommands + ContestScope 端口检查；输出超过阈值落盘为 Artifact
src/tools/agent.ts                  — 改为 SpecialistAgentFactory.create + 接力协议（接入 HandoffRequest）
src/tools/index.ts                  — createTools → toolRegistry.create()
src/config/agentConfig.ts           — schema 扩展 capabilityProfiles / tasksDir / backgroundJobs / defaultContestScope
src/config/ovogomd.ts               — 不改
src/core/eventLog.ts                — EventType 增 'artifact_created', 'finding_emitted', 'handoff_requested', 'job_state', 'policy_violation', 'profile_loaded'
```

### 兼容性

- 旧 session 目录（sessions/session_*）继续被识别读取
- 现有 tests/ 全保留 + 新增 acceptance 测试
- preset 名称（explore/plan/code-reviewer/general-purpose）通过 adapter 兼容

## 每个文件职责与边界

### src/core/toolDefinition.ts

- `interface CTFToolDefinition extends ToolDefinition { domains, executionMode, costClass, outputMode, riskLevel, requiredBinaries }`
- `function ctfMeta(def): CTFToolDefinition` — 在 createTools 后给基础工具附加元数据
- 不引用其他新模块

### src/core/toolRegistry.ts

- `class ToolRegistry { register(tool, meta); get(id); list(filter); resolveFor(profile): Tool[] }`
- `resolveFor(profile)`：根据 capabilityProfile.allowedTools / deniedTools 过滤；并按 executionMode 决定是否启用后台
- 默认注册：基础工具 + 14 个 CTF 适配工具（TBD minimal set）

### src/core/toolBroker.ts

- `class ToolBroker { constructor(profile, contestScope, jobManager, artifactStore, eventLog, hookRunner); execute(toolId, args, ctx): Promise<ToolResult> }`
- 流程：Profile 决策 → ToolFirstPolicy 提醒（不阻塞，override）→ 后台判定 → JobManager / 直接执行 → 长输出 → Artifact 化 → 摘要回模型
- 输出阈值默认 10KB（命令行 Constant：TOOL_OUTPUT_INLINE_MAX_BYTES，可在 agent.json 调整）

### src/core/capabilityProfile.ts

- `interface CapabilityProfile`（如 PLAN §8.1）
- `capabilityProfileSchema = z.object(...)` — 启动前校验
- `validateCapabilityProfile(raw): CapabilityProfile | null` — 失败抛出 Error
- `builtinProfiles: Record<string, CapabilityProfile>` — 5+ 内置

### src/core/contestScope.ts

- `interface ContestScope { allowedHosts?; allowedCidrs?; allowedPorts?; allowedDomains?; allowedFilesRoot: string }`
- `class ContestScopeChecker { isHostAllowed(h); isPortAllowed(p); isFileAllowed(p); assert(...) 或 throw ScopeViolationError }`

### src/core/artifacts.ts

- `interface Artifact { id, taskId, producerAgentId, type, path, mimeType?, size?, sha256?, summary?, createdAt }`
- `class ArtifactStore { constructor(taskDir); write(type, content, meta): Promise<Artifact>; read(id) }`
- 摘要：超过阈值时，将内容写到 artifacts/<id>.bin，记录 sha256 + head + tail（各 200 bytes）+ length

### src/core/findings.ts

- `interface Finding { id, taskId, producerAgentId, category, title, summary, confidence, evidence, artifactIds, recommendedNextActions?, suggestedAgent? }`
- 持久化：findings/<taskId>.jsonl

### src/core/handoff.ts

- `interface HandoffRequest`（goal §四·8）
- 工具：`handoff_request(to, reason, objective, artifactIds, findingIds, constraints?)`
- 接收：OrchestratorAgent 读 → approve / reject / modify

### src/core/backgroundJobs.ts

- `class BackgroundJobManager { spawn(toolId, args, ctx): Job; status(id); wait(id, opts?); cancel(id); collect(id); list(filterBy?) }`
- 并发上限：tasks/<taskId>/jobs/ 下维护 `active_jobs[]`，spawn 时按 maxPerAgent、maxPerTask 决策排队
- 状态持久化：jobs/<jobId>.json + tasks/<taskId>/jobs/index.jsonl
- 与 BashTool 的 `run_in_background` 集成：bash 执行命令后注册到 JobManager

### src/core/workflowDefinition.ts

- `type WorkflowStep = StepTool | StepShell | StepIf | StepParallel | StepFor | StepSequence`
- `interface WorkflowDefinition { ... }`

### src/core/workflowEngine.ts

- `class WorkflowEngine { run(workflow, input, ctx): WorkflowRunResult }`
- 状态机：pending → running → success / failed / partial
- 支持 cancel、超时、并发步骤、停止条件

### src/core/specialistAgent.ts

- `class SpecialistAgentFactory { create(profile, ctx): AgentConfig }`
- 拼装：profile.systemPromptModules → basePrompt → 输入（如有 findings/artifacts） → 最大迭代、工具白名单

### src/core/toolFirstPolicy.ts

- `class ToolFirstPolicy { constructor(rules); advise(toolId, args, agentProfile): PolicyVerdict }`
- 内置 4 条起步规则 + 可扩展

### src/modules/taskWorkspace.ts

- 替换 WorkspaceModule
- 给出 taskWorkspaceDir、artifactsDir、findingsDir、jobsDir、eventsPath

## 数据流和状态变化

- **Tool 调用前**：Engine.executeToolCall → broker.execute → profile 决策 → policy 提醒 → 异步后台或同步执行
- **Tool 调用后**：Artifact 化（视长度）→ EventLog.append → HookRunner.runPostToolCall → 返回 ToolResult
- **Workflow**：收到 trigger → 解析 steps → 执行 → 收集 findings + artifacts → 返回 WorkflowRunResult
- **Agent 接力**：原 Agent → handoff_request 工具调用 → 写 HandoffRequest 文件 → 返回 Finding { suggestedAgent } → Orchestrator 决策后通过 SpecialistAgentFactory 创建接班 Agent，prompt 注入已收到的 Findings/Artifacts

## 错误处理

- 配置错误：zod 失败 → 启动时 stderr 提示，保留默认
- 工具拒绝：ToolBroker 拒绝 → 返回 ToolResult { isError: true, content: 'Tool X is not allowed by profile Y' }
- 接力失败：Orchestrator 退化为 General-purpose 自主处理
- 工作区越界：ToolBroker 拒绝 + ScopeViolationError + EventLog

## 配置字段

| 字段 | 类型 | 默认 |
|------|------|------|
| capabilityProfiles | Record | builtin |
| defaultContestScope | ContestScope | { allowedFilesRoot: cwd } |
| tasksDir | string | 'sessions' |
| workflowTimeoutDefaultMs | number | 60000 |
| backgroundJobs.maxPerAgent | number | 4 |
| backgroundJobs.maxPerTask | number | 16 |
| toolOutputInlineMaxBytes | number | 10240 |

## 兼容层

- 旧 `WorkspaceModule` 保留，标记 deprecated；新 `TaskWorkspaceModule` 自动启用
- `AGENT_PRESETS` 内部用 `CapabilityProfile` 重新表达，但同名导出继续可用
- `agent.json` 旧字段全部保留；新字段都是 optional
- 工作区同时支持旧 `sessions/session_*` 和新 `sessions/<contestId>/tasks/<taskId>/`

## 迁移过程

不需要外部迁移。运行期间若用户未配置新字段，自动启用 builtin Profile 与默认 ContestScope。

## 测试用例

每个核心模块单独测试（vitest）；集成测试覆盖专业 Agent + Workflow；端到端 fixture 测试覆盖验收场景 1-7。

## 调试方式

- `events.ndjson` 用 `jq` 实时过滤（EventType）
- `findings/<taskId>.jsonl` 用 `jq`
- `artifacts/` 直接读 sha256
- `policy_violation` 事件过滤后即可发现 ToolFirstPolicy 命中
- `agent.json: profileTrace` 模式记录每个 Profile 决策

## 验证命令

```sh
pnpm run build              # tsc
pnpm run lint               # eslint
pnpm test                   # vitest run
pnpm run test:acceptance    # 7 个场景（自定义脚本）
pnpm run dev "solve a sample CTF task"   # 手工跑通
```

## 每步完成的定义

- 代码通过 tsc
- 对应单元测试通过
- 没有破坏现有 tests
- 至少一次 EventLog 写入路径走通（如果有写入）
- 关键 commit message 体现"feature(模块): ..."
