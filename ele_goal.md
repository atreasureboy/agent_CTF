# Agent_CTF Phase 3.0：模型可靠性层、上下文编译与 Solver Portfolio

你正在当前最新的 `agent_CTF` 仓库中工作。

这是一个仅面向：

* 合法 CTF 比赛
* 本地挑战
* 明确授权靶场
* 用户明确提供的比赛目标

的 CTF Agent 系统。

当前系统已经拥有：

* 统一 Harness
* CTFTaskRuntime
* CTFTaskOrchestrator
* TaskState
* Observation / Evidence
* Hypothesis / Attempt
* StrategyPlanner
* ReasoningCoordinator
* Workflow DAG / Retry / Condition
* OneShot / Shotgun
* Specialist / Handoff
* FlagCandidate Validator
* Scope、权限、预算和取消机制

此前的主要工作集中在“单题内部推理”。

本轮不再增加新的推理状态机，也不继续堆砌 CTF 工具。

本轮核心目标是：

> 针对 M3 等低成本但不稳定模型，建立严格的模型可靠性边界、上下文编译、工具可见性、失败降级和 Solver Portfolio，使不同模型按照能力承担不同职责，并允许同一道题由多个隔离 Solver 协作或竞速。

本轮需要借鉴以下项目的行为机制，但禁止直接复制源代码：

```text
yhy0/CHYing-agent
verialabs/ctf-agent
aliasrobotics/CAI
aielte-research/HackSynth
amazon-science/cyber-zero
passer-W/ctfSolver
MuWinds/BUUCTF_Agent
```

必须先读取这些项目的：

* README
* LICENSE
* 主入口
* Agent/Solver 调度
* 上下文压缩
* 工具暴露
* 多 Solver 通信
* Challenge/Benchmark 格式
* Flag 验证
* 取消与恢复

只进行 Clean-room 行为级借鉴。

不要复制带许可证约束的具体实现。

---

# 一、执行者职责

本任务由 Codex 或当前主编码模型负责整体实现。

M3 可以作为辅助子 Agent，但必须遵守：

## M3 可以执行

* 搜索文件
* 整理接口调用点
* 编写独立单元测试
* 生成 Fixture
* 整理文档
* 执行静态搜索
* 检查重复代码
* 实现边界明确的小型纯函数

## M3 不得负责

* 架构决策
* 状态所有权设计
* 并发模型
* Abort 生命周期
* Scope 和权限边界
* Solver 调度策略
* Flag 提交权限
* 数据持久化语义
* 修改核心状态机
* 决定删除哪些兼容路径
* 根据自己生成的总结宣布任务完成

M3 产出的代码必须经过：

```text
类型检查
→ 单元测试
→ 行为测试
→ 主模型复审
```

不得因为 M3 声称“已完成”而停止。

---

# 二、本轮范围

本轮必须完成：

1. 当前本地增强审计。
2. 外部项目机制对照矩阵。
3. ModelCapabilityRegistry。
4. StructuredModelGateway。
5. 模型输出 Schema 校验与修复。
6. ModelCircuitBreaker。
7. ModelRouter 和角色策略。
8. M3 专用安全策略。
9. ContextCompiler 系列。
10. ToolVisibilityPolicy。
11. ExternalSolverAdapter 协议。
12. NativeSolverAdapter。
13. GenericProcessSolverAdapter。
14. 单题 SolverPortfolio。
15. 受控 ChallengeSwarm。
16. CrossSolverEvidenceBus。
17. StagnationDetector 和 Stop-loss。
18. OperatorMessage。
19. 独立 Flag Discriminator 边界。
20. TrajectoryRecorder。
21. 模型可靠性 Benchmark。
22. 真实集成测试。

本轮不实现：

* 完整 CTFd 自动提交。
* BUUCTF 真实提交。
* 真实比赛账户登录。
* 公网目标自动扫描。
* 无限制多模型并发。
* RL 训练。
* 模型微调。
* 新的 OneShot Manifest。
* 新的 Reverse/Pwn/Web Workflow。
* 新的 Evidence Graph。
* 新的 TaskState 平行实现。
* 新的 MessageBus 真相源。
* 第二套 Orchestrator。
* 第二套 ReasoningCoordinator。

---

# 三、先审计本地真实代码

公开仓库可能落后于当前本地修改。

首先执行：

```bash
git status --short
git branch --show-current
git log -15 --oneline
git remote -v
git diff --stat
git diff
git diff origin/main...HEAD --stat
```

不要 reset。

不要覆盖未提交修改。

随后执行：

```bash
pnpm typecheck
pnpm build
pnpm lint
pnpm test
```

以 `package.json` 的实际脚本为准。

搜索当前是否已经存在本轮类似能力：

```bash
rg -n "ModelRegistry|ModelRouter|ModelCapability|ModelHealth" src tests
rg -n "ContextCompiler|ProgressCompiler|RetryHandoff|SolverBrief" src tests
rg -n "ToolVisibility|visibility.*specialist|visibility.*solver" src tests
rg -n "ExternalSolver|SolverAdapter|SolverPortfolio|SolverSwarm" src tests
rg -n "MessageBus|EvidenceBus|solverCursor|crossSolver" src tests
rg -n "Stagnation|LoopDetector|ABANDON|stop.loss" src tests
rg -n "OperatorMessage|sendGuidance|bumpSolver" src tests
rg -n "Trajectory|Replay|BenchmarkAdapter" src tests
rg -n "client\\.chat|responses\\.create|completions\\.create" src
rg -n "getToolDefinitions|toolNames|tools/list" src/core
```

如果这些能力已经由用户新增：

1. 先审计。
2. 复用已有组件。
3. 修复问题。
4. 不重复创建同义模块。

将审计写入：

```text
docs/architecture/phase-3.0-model-reliability-audit.md
```

---

# 四、建立外部项目机制对照矩阵

通过 GitHub CLI 或现有网络能力读取参考仓库：

```bash
gh repo view yhy0/CHYing-agent
gh repo view verialabs/ctf-agent
gh repo view aliasrobotics/CAI
gh repo view aielte-research/HackSynth
gh repo view amazon-science/cyber-zero
gh repo view passer-W/ctfSolver
gh repo view MuWinds/BUUCTF_Agent
```

需要深入查看时，克隆到仓库外部或被 `.gitignore` 排除的临时目录。

不要添加为生产依赖或 Git Submodule。

生成：

```text
docs/research/ctf-agent-reference-matrix.md
```

格式：

| 参考项目 | 机制 | 解决的问题 | 本项目已有能力 | 借鉴方式 | 不借鉴原因 | License |
| ---- | -- | ----- | ------- | ---- | ----- | ------- |

至少分析：

## CHYing-agent

* PromptCompiler
* ProgressCompiler
* RetryHandoffCompiler
* MCP Tool Visibility
* 分支探索
* 失败路线继承

## Veria CTF Agent

* 多模型竞速
* Solver 抽象
* Challenge Poller
* Cross-solver Message Bus
* Loop Detect
* Coordinator Guidance
* Operator Messaging
* Solver Cancel

## CAI

* Handoff as Tool
* Flag Discriminator
* 权限和职责隔离
* Trace

## HackSynth

* Planner / Summarizer 分离
* 有界 Observation
* Benchmark

## Cyber-Zero / EnIGMA+

* challenge.json
* docker-compose Challenge
* 统一 Benchmark
* Trajectory
* 批量运行

## 国内项目

* 比赛平台 Adapter
* 附件下载
* 交互/自动模式
* Skill 组织
* 模型路由

矩阵必须区分：

```text
值得吸收的机制
已有能力无需重复
不适合当前项目的机制
因许可证不能复制的实现
```

---

# 五、核心原则：M3 不是决策权威

为模型角色建立明确权限。

建议角色：

```ts
export type ModelRole =
  | 'competition_coordinator'
  | 'task_planner'
  | 'solver_scout'
  | 'deep_solver'
  | 'context_compiler'
  | 'progress_summarizer'
  | 'specialist'
  | 'flag_discriminator'
  | 'reporter'
```

默认职责：

## 强模型，例如 Codex

可以承担：

* competition_coordinator
* task_planner
* deep_solver
* 复杂 specialist
* 架构性复盘

## M3

默认只允许：

* solver_scout
* progress_summarizer
* context_compiler 的可选渲染阶段
* 低成本题目 Solver
* 已有证据上的候选路线扩展

## M3 默认禁止

* 扩大 ContestScope
* 改变安全策略
* 批准 expensive Action
* 宣布 Task solved
* 验证最终 Flag
* 提交 Flag
* 终止其他 Solver
* 修改 Competition 优先级
* 覆盖确定性 Evidence
* 删除已记录 Attempt
* 直接写 TaskState
* 查看不属于其职责的底层工具

禁止通过 Prompt 约定实现这些权限。

必须通过代码检查和 Tool Visibility 强制执行。

---

# 六、建立 ModelCapabilityRegistry

建议创建：

```text
src/core/modelReliability/
├── modelCapability.ts
├── modelRegistry.ts
├── modelRouter.ts
├── modelHealth.ts
├── modelCircuitBreaker.ts
├── structuredModelGateway.ts
└── modelRolePolicy.ts
```

定义：

```ts
export interface ModelCapabilityProfile {
  id: string
  provider: string
  model: string

  contextWindow: number

  capabilities: {
    toolCalling: boolean
    structuredOutput: boolean
    vision: boolean
    longContext: boolean
    codeExecutionPlanning: boolean
  }

  reliability: {
    structuredOutput: number
    toolArguments: number
    longHorizonPlanning: number
    summarization: number
    instructionFollowing: number
  }

  economics: {
    inputCostPerMillion?: number
    outputCostPerMillion?: number
    expectedLatencyMs?: number
  }

  allowedRoles: ModelRole[]

  limits: {
    maxVisibleTools: number
    maxIterations: number
    maxRepairAttempts: number
    maxConsecutiveFailures: number
  }

  fallbackModelIds: string[]
}
```

要求：

* 不将 M3、Codex 名称散落硬编码在各模块。
* 所有模型通过 Registry 解析。
* 未知模型使用保守能力。
* Model Profile 可通过配置覆盖。
* 配置经过 Zod 校验。
* Reliability 是路由信号，不作为事实真相。
* 运行指标可更新 Health，但不得自动改写静态能力声明。

---

# 七、建立 ModelHealth

定义：

```ts
export type ModelHealthStatus =
  | 'healthy'
  | 'degraded'
  | 'circuit_open'
  | 'quota_limited'
  | 'unavailable'

export interface ModelHealthRecord {
  modelId: string
  status: ModelHealthStatus

  schemaFailures: number
  toolArgumentFailures: number
  timeouts: number
  repeatedActionLoops: number
  emptyResponses: number
  providerErrors: number

  successfulRuns: number

  lastFailureAt?: number
  circuitOpenedAt?: number
  circuitReason?: string
}
```

记录到正式 Runtime State 或 ModelHealthStore。

不要使用模块级无界 Map。

支持：

* 每模型
* 每任务
* 每角色

三个维度，但第一轮可以先实现每任务+模型。

---

# 八、建立 StructuredModelGateway

所有 CTF 业务模型调用必须逐步经过统一 Gateway。

接口：

```ts
export interface StructuredModelRequest<T> {
  role: ModelRole

  preferredModelId?: string

  systemPrompt: string
  userPrompt: string

  outputSchema: z.ZodType<T>

  tools?: ToolDefinition[]

  taskId: string
  agentRunId?: string

  signal: AbortSignal
}

export interface StructuredModelResponse<T> {
  modelId: string
  value: T

  repaired: boolean
  fallbackUsed: boolean

  usage?: TokenUsage
  durationMs: number

  rawResponseArtifactId?: string
}
```

流程：

```text
ModelRouter
→ ModelRolePolicy
→ ToolVisibilityPolicy
→ 调用模型
→ Schema Parse
→ 一次受控修复
→ Fallback Model
→ CircuitBreaker
```

## 失败策略

M3 输出非法结构：

```text
第一次：
返回精确 Schema 错误并允许一次修复

第二次：
本次调用失败
→ 更新 ModelHealth
→ 使用 Fallback

连续达到阈值：
打开 Circuit
```

禁止：

* 无限要求模型修 JSON。
* 自动将自由文本强行猜成成功结构。
* Schema 失败后仍执行工具。
* 将错误 Tool 参数交给 ToolBroker。
* M3 修复自己超过一次。
* Fallback 后又回到已打开 Circuit 的模型。

## Noop 禁止

生产模式不得在 Model 调用失败时返回空成功结果。

必须返回明确失败或 Fallback。

---

# 九、ModelCircuitBreaker

建议规则：

```ts
export interface ModelCircuitBreakerPolicy {
  maxConsecutiveSchemaFailures: number
  maxConsecutiveToolArgumentFailures: number
  maxTimeoutsPerWindow: number
  maxRepeatedLoops: number

  cooldownMs: number
}
```

M3 默认可以设置更严格阈值：

```text
连续 Schema Failure：2
连续 Tool Argument Failure：2
重复路线 Warning：3
重复路线 Break：5
```

Circuit 打开后：

* 当前 Solver 标记 degraded。
* 未执行动作不能记录 succeeded。
* Planner 获得明确 unavailable 原因。
* ModelRouter 尝试 Fallback。
* 无 Fallback 时暂停 Solver。
* 不自动终止整个 Challenge。

---

# 十、ModelRouter

定义：

```ts
export interface ModelRoutingInput {
  role: ModelRole

  challengeCategory?: string
  estimatedDifficulty?: 'easy' | 'medium' | 'hard' | 'unknown'

  requiredCapabilities: string[]

  taskState: Readonly<CTFTaskState>

  budget: {
    remainingCostUnits: number
  }

  preferredModelId?: string
}
```

基本路由：

## Easy / 初筛

```text
M3 Scout
→ 低成本 Workflow / OneShot
```

## 普通任务

```text
M3 Scout
→ 若获得新 Evidence，继续
→ 若停滞，升级强模型
```

## 高难/关键题

```text
强模型主 Solver
+ M3 辅助 Scout/Summarizer
```

## Flag 验证

```text
确定性 Validator
→ 可选强模型 Discriminator
```

不允许 M3 独占 Flag 验证。

路由结果必须记录：

```ts
export interface ModelRoutingDecision {
  selectedModelId: string
  fallbackModelIds: string[]
  reason: string
  rejectedModels: Array<{
    modelId: string
    reason: string
  }>
}
```

---

# 十一、ContextCompiler：确定性选择优先

建议创建：

```text
src/core/contextCompiler/
├── contextCompiler.ts
├── contextProjection.ts
├── compilerValidator.ts
├── challengePromptCompiler.ts
├── solverBriefCompiler.ts
├── progressCompiler.ts
├── retryHandoffCompiler.ts
├── specialistContextCompiler.ts
└── templates/
```

重要原则：

> TaskState 是真相，Compiled Context 只是视图。

不得让 Context Compiler 产生新的事实。

## 两阶段编译

```text
确定性 ContextProjection
→ 可选模型渲染
```

### 第一阶段：确定性选择

从 TaskState 选择：

* Challenge Objective
* ContestScope
* 已确认 Evidence
* 关键 Observation
* Active Hypothesis
* Rejected Hypothesis
* Failed Attempt
* Important Artifact
* Pending Action
* 当前 Blocker
* Budget
* Allowed Tools

### 第二阶段：渲染

强模型或 M3 可以把选定结构渲染成简洁文本。

渲染模型：

* 不得改变 ID。
* 不得新增事实。
* 不得删除 Scope。
* 不得把 Hypothesis 写成 confirmed。
* 不得把 failed Attempt 写成成功。
* 输出必须经过 CompilerValidator。

---

# 十二、CompiledContext 结构

定义：

```ts
export interface CompiledContext {
  id: string

  taskId: string
  compilerType:
    | 'challenge_prompt'
    | 'solver_brief'
    | 'progress_handoff'
    | 'retry_handoff'
    | 'specialist_context'

  compilerVersion: string

  stateRevision: number
  stateSnapshotHash: string

  targetModelId: string
  targetRole: ModelRole

  objective: string
  scopeSummary: string

  confirmedEvidence: CompiledEvidenceRef[]
  activeHypotheses: CompiledHypothesisRef[]
  rejectedHypotheses: CompiledHypothesisRef[]

  failedAttempts: CompiledAttemptRef[]
  importantArtifacts: CompiledArtifactRef[]

  currentBlocker?: string

  recommendedActions: CompiledActionRef[]
  forbiddenRepeats: string[]

  allowedToolIds: string[]

  completionContract: string[]

  sourceIds: string[]

  estimatedTokens: number
  createdAt: number
}
```

Compiled Context 必须保留来源 ID。

例如：

```text
[E:evidence-id]
[H:hypothesis-id]
[A:attempt-id]
[F:artifact-id]
```

Solver 的结论可以追溯原始状态。

---

# 十三、四种 Compiler

## 1. ChallengePromptCompiler

首次解题：

```text
题面
+ 附件
+ 自动初筛
+ Scope
+ 基础策略
```

简单题不要调用额外 LLM Compiler。

采用阈值：

```text
原始输入较短
+ 状态较少
→ 确定性模板直接输出
```

复杂题才启用模型渲染。

## 2. ProgressCompiler

上下文压缩或 Solver 即将重启时：

```text
做到哪里
确认了什么
当前卡点
哪些路失败
当前环境变化
下一步 1–3 个动作
```

不让当前 Solver 自己总结自己。

优先：

* 确定性 State Projection；
* 可选独立 Summarizer。

## 3. RetryHandoffCompiler

题目暂停后重新启动：

必须包含：

* 可复现命令；
* 重要文件路径；
* Artifact SHA；
* 失败 Attempt Fingerprint；
* 已排除路线；
* 恢复入口；
* 环境依赖；
* 新 Solver 第一动作。

## 4. SpecialistContextCompiler

只提供与 Handoff 相关的：

* Artifact
* Evidence
* Hypothesis
* Failed Attempt
* Objective
* Scope

禁止将完整 TaskState 塞给 Specialist。

---

# 十四、M3 专用 SolverBrief

M3 输入必须更机械。

建议结构：

```text
<task>
  <objective>...</objective>
  <scope>...</scope>

  <confirmed_facts>
    ...
  </confirmed_facts>

  <active_hypotheses>
    ...
  </active_hypotheses>

  <do_not_repeat>
    ...
  </do_not_repeat>

  <allowed_tools>
    ...
  </allowed_tools>

  <next_action>
    只执行一个明确动作
  </next_action>

  <output_contract>
    必须返回指定 JSON
  </output_contract>
</task>
```

M3 每轮最多选择一个动作。

禁止 M3 返回：

* 长期计划后直接声称执行完成；
* 多个无依赖命令的巨大列表；
* 未调用工具却生成 Evidence；
* 未验证却输出 accepted Flag；
* 修改 Scope；
* 请求隐藏工具。

---

# 十五、CompilerValidator

验证：

* Objective 非空。
* Scope 存在。
* 所有 Source ID 存在。
* Confirmed Evidence 真实存在。
* Hypothesis 状态匹配。
* Failed Attempt 状态匹配。
* Artifact 属于当前 Task。
* Token Budget 未超限。
* Allowed Tools 符合 Visibility。
* Completion Contract 存在。
* 不包含 Secret/API Key。
* 不把 Candidate 当 accepted Flag。
* State Revision 没有过期。

若模型渲染失败：

```text
回退确定性模板
```

不能返回空 Context。

---

# 十六、ToolVisibilityPolicy

当前 allowedTools 只表达“能否执行”。

新增“谁能看到工具存在”。

定义：

```ts
export type ToolVisibility =
  | 'orchestrator'
  | 'solver'
  | `solver:${string}`
  | `model:${string}`
  | `specialist:${string}`
  | 'workflow-only'
  | 'oneshot-only'
  | 'operator-only'

export interface ToolVisibilityRule {
  toolId: string
  visibleTo: ToolVisibility[]
}
```

ToolBroker 生成 Tool Definitions 前必须经过：

```text
Authorization
+ Visibility
```

## Orchestrator 默认只看高层工具

例如：

* inspect_task_state
* run_workflow
* run_one_shot
* request_handoff
* inspect_solver
* send_solver_guidance
* validate_candidate
* pause_challenge

不应该看到几十个底层：

* exiftool
* binwalk
* zsteg
* 每个浏览器动作
* 每个 MCP 细粒度工具

## M3 Scout

默认最大可见工具数：

```text
8–15
```

根据题型选择。

工具过多时不允许简单截断前 N 个。

必须按：

* Role
* Challenge category
* Hypothesis
* Evidence
* Cost
* Availability

排序选择。

---

# 十七、MCP 工具隔离

为 MCP Server 增加：

```ts
export interface MCPServerConfig {
  command: string
  args?: string[]

  visibility?: ToolVisibility[]

  exposeToolsToParent?: boolean
}
```

例如 Browser MCP：

```text
只对 specialist:web/browser 可见
```

主 Orchestrator 只看到：

```text
request_browser_specialist
```

而不是所有浏览器底层工具。

测试必须验证：

* 隐藏 Tool 不进入 Model Tool Definition。
* 隐藏 Tool 即使模型伪造调用也被 Broker 拒绝。
* 子 Specialist 可以看到允许 Tool。
* 切换 Profile 后 Visibility 更新。

---

# 十八、建立 Solver Portfolio

建议创建：

```text
src/core/solverPortfolio/
├── solverTypes.ts
├── solverAdapter.ts
├── solverRegistry.ts
├── solverRunStore.ts
├── nativeSolverAdapter.ts
├── genericProcessSolverAdapter.ts
├── solverResultNormalizer.ts
├── solverPortfolio.ts
├── challengeSwarm.ts
├── crossSolverEvidenceBus.ts
├── stagnationDetector.ts
└── operatorMessage.ts
```

不要复制 Veria、CAI 或 HackSynth 的运行时。

使用 Adapter 接入。

---

# 十九、ExternalSolverAdapter

定义：

```ts
export interface SolverHealth {
  status:
    | 'ready'
    | 'degraded'
    | 'unavailable'

  capabilities: string[]
  reason?: string
}

export interface SolverChallengeInput {
  taskId: string
  challengeId: string

  compiledContext: CompiledContext

  workspaceDir: string
  artifactIds: string[]

  scope: ContestScope

  signal: AbortSignal
}

export interface SolverRunHandle {
  runId: string
  solverId: string

  wait(): Promise<ExternalSolverResult>

  sendGuidance(message: OperatorMessage): Promise<void>

  cancel(reason: string): Promise<void>

  inspect(): Promise<SolverRunSnapshot>
}

export interface ExternalSolverAdapter {
  id: string

  probe(): Promise<SolverHealth>

  start(
    input: SolverChallengeInput,
  ): Promise<SolverRunHandle>
}
```

外部 Solver Result：

```ts
export interface ExternalSolverResult {
  runId: string
  solverId: string

  status:
    | 'completed'
    | 'flag_candidate'
    | 'gave_up'
    | 'cancelled'
    | 'failed'
    | 'quota_error'

  observations: ExternalObservationDraft[]
  artifacts: ExternalArtifactDraft[]
  flagCandidates: ExternalFlagCandidateDraft[]

  summary?: string

  metrics: {
    durationMs: number
    inputTokens?: number
    outputTokens?: number
    estimatedCost?: number
  }
}
```

外部结果默认不可信。

必须经过：

```text
SolverResultNormalizer
→ ResultMaterializer
→ Evidence Validation
→ TaskState
```

外部 Solver 不能直接写 TaskState。

---

# 二十、NativeSolverAdapter

将当前 Agent_CTF 的单题 Runtime包装为 Solver Adapter。

不要创建第二个 TaskState。

Native Adapter 应：

* 使用当前 CTFTaskRuntime；
* 创建 SolverRunRecord；
* 使用 ContextCompiler；
* 调用 Main Agent 或 Workflow；
* 监听结构化输出；
* 返回 ExternalSolverResult 兼容格式；
* 支持取消；
* 支持 Guidance；
* 不重复 Materialize。

---

# 二十一、GenericProcessSolverAdapter

为 Codex CLI、Claude Code 或其他命令行 Solver 提供通用协议。

不要在核心代码硬编码某个专有 CLI。

建议 JSONL 协议。

## 输入

通过 stdin：

```json
{
  "type": "start",
  "runId": "...",
  "taskId": "...",
  "contextPath": "...",
  "workspaceDir": "...",
  "artifactPaths": ["..."]
}
```

Guidance：

```json
{
  "type": "guidance",
  "runId": "...",
  "message": "...",
  "priority": "normal"
}
```

Cancel：

```json
{
  "type": "cancel",
  "runId": "...",
  "reason": "..."
}
```

## 输出

```json
{
  "type": "observation",
  "summary": "...",
  "confidence": 0.8,
  "sourcePath": "..."
}
```

```json
{
  "type": "flag_candidate",
  "value": "...",
  "sourcePath": "..."
}
```

```json
{
  "type": "status",
  "status": "working",
  "summary": "..."
}
```

```json
{
  "type": "done",
  "status": "completed"
}
```

要求：

* `spawn(..., {shell:false})`
* 环境变量白名单。
* 独立 Workspace。
* 超时。
* 输出上限。
* JSON Schema。
* 非 JSON 行保存为日志 Artifact，不直接成为 Evidence。
* 子进程树取消。
* 不传 API Key，除非 Adapter 明确声明需要并由 Operator 配置。
* 测试使用 Fake Process，不依赖真实 Codex/Claude CLI。

---

# 二十二、SolverRunRecord

增加：

```ts
export interface SolverRunRecord {
  id: string
  taskId: string

  solverId: string
  modelId?: string
  role: ModelRole

  status:
    | 'queued'
    | 'running'
    | 'stagnating'
    | 'paused'
    | 'completed'
    | 'candidate_found'
    | 'gave_up'
    | 'cancelled'
    | 'failed'

  contextCompilerId: string
  compiledContextId: string

  observationIds: string[]
  evidenceIds: string[]
  artifactIds: string[]
  flagCandidateIds: string[]

  guidanceMessageIds: string[]

  startedAt?: number
  completedAt?: number

  failureReason?: string
}
```

加入 TaskState。

不允许 SolverPortfolio 用独立内存数组作为唯一真相源。

---

# 二十三、单题 ChallengeSwarm

本轮只实现单题 Swarm。

不实现完整比赛全局控制面。

定义：

```ts
export interface ChallengeSwarmPolicy {
  maxConcurrentSolvers: number
  maxTotalSolvers: number

  initialSolverIds: string[]
  escalationSolverIds: string[]

  cancelLosersOnValidatedCandidate: boolean

  requireFlagValidation: boolean

  stagnationEscalation: boolean
}
```

默认不要五模型无脑竞速。

建议两阶段：

```text
阶段一：
M3 Scout / Native cheap triage

阶段二：
出现以下条件之一：
- 题目高价值
- M3 停滞
- 有复杂 Evidence
- Candidate 不确定
→ 启动强模型
```

关键题可以配置并行竞速。

---

# 二十四、CrossSolverEvidenceBus

不要复制新的 MessageBus 真相源。

它必须是 TaskState Evidence 的投影视图。

定义：

```ts
export interface SolverEvidenceCursor {
  solverRunId: string
  lastSeenStateRevision: number
}

export interface SolverEvidenceMessage {
  id: string

  taskId: string
  sourceSolverRunId: string

  evidenceIds: string[]
  observationIds: string[]
  artifactIds: string[]

  summary: string

  priority:
    | 'low'
    | 'normal'
    | 'high'
    | 'critical'

  expiresAt?: number
}
```

只共享：

* 已验证 Evidence；
* 高价值 Observation；
* 新 Artifact；
* 已验证 Candidate；
* Operator Hint。

不要共享：

* 完整聊天记录；
* 全量 stdout；
* 未验证的模型幻想；
* API Key；
* 无关低置信度日志；
* 其他 Solver 的隐藏系统提示词。

每个 Solver 使用 Cursor 获取未读信息。

增加：

* 最大消息数；
* 去重；
* TTL；
* Priority；
* Source；
* 每轮注入上限。

---

# 二十五、Guidance 编译

CrossSolver Evidence 不能直接原样塞给 Solver。

使用：

```text
EvidenceMessage
→ SolverGuidanceCompiler
→ 模型适配提示
```

M3 Guidance 应非常短：

```text
新确认事实：
- ...

不要重复：
- ...

下一步只做：
- ...
```

强模型可以获得更多来源关系。

Guidance 仍必须保留 Evidence ID。

---

# 二十六、StagnationDetector

定义：

```ts
export interface StagnationSignals {
  cyclesWithoutNewEvidence: number
  millisecondsWithoutNewEvidence: number

  repeatedAttemptFingerprints: number
  repeatedActionFamilies: number

  consecutiveToolFailures: number
  contextCompactions: number

  hypothesisProgressDelta: number
}

export type StagnationDecision =
  | {
      action: 'continue'
    }
  | {
      action: 'nudge'
      reason: string
    }
  | {
      action: 'switch_model'
      targetModelId: string
      reason: string
    }
  | {
      action: 'spawn_branch'
      reason: string
    }
  | {
      action: 'pause'
      reason: string
    }
```

建议默认：

```text
重复相同行动 3 次：warning/nudge
重复 5 次：阻止并切换路线
连续若干 Cycle 无新 Evidence：升级模型
累计预算超阈值：pause
```

不要只看工具命令字符串。

使用：

* Attempt Fingerprint；
* SuggestedAction Family；
* Evidence Revision；
* Hypothesis 变化；
* Artifact 变化。

---

# 二十七、Stop-loss 与 Retry Handoff

Solver 暂停时必须生成：

```text
RetryHandoffCompiler
```

保存：

* 当前进展；
* 确认 Evidence；
* 当前 Hypothesis；
* 已失败路线；
* 可复现命令；
* Artifact；
* 当前 Blocker；
* 推荐的新 Solver/模型；
* 第一动作。

状态：

```text
running
→ stagnating
→ paused
```

恢复：

```text
paused
→ queued
→ running
```

暂停不等于失败。

不要采用“永不放弃”作为固定策略。

比赛中需要资源止损。

---

# 二十八、Branch Solver

允许同一题启动不同路线，但每个 Branch 必须有：

```ts
export interface SolverBranch {
  id: string
  parentSolverRunId?: string

  objective: string
  hypothesisIds: string[]

  forbiddenAttemptFingerprints: string[]

  artifactIds: string[]
  evidenceIds: string[]

  solverId: string
}
```

Branch 必须有不同：

* Hypothesis；
* 技术路线；
* Artifact；
* Model。

禁止启动三个 Prompt 几乎相同的 Solver 浪费成本。

---

# 二十九、OperatorMessage

定义：

```ts
export type OperatorMessage =
  | {
      type: 'hint'
      text: string
    }
  | {
      type: 'force_branch'
      objective: string
    }
  | {
      type: 'approve_expensive'
      actionId: string
    }
  | {
      type: 'change_priority'
      priority: number
    }
  | {
      type: 'pause'
      reason: string
    }
  | {
      type: 'resume'
    }
  | {
      type: 'stop'
      reason: string
    }
```

所有消息：

* 记录 EventLog；
* 绑定 Task/Solver；
* 经过权限检查；
* 不直接修改 TaskState；
* 通过正式 Event 应用。

---

# 三十、Flag Discriminator 与 Submission 边界

复用现有 FlagCandidateValidator。

增加明确职责：

```text
Solver：
发现 Candidate

FlagDiscriminator：
验证格式、来源、转换链和题目上下文

SubmissionController：
唯一有平台提交权限的组件
```

本轮只创建 SubmissionController 接口和 Fake 实现。

不连接真实比赛平台。

M3 永远不得：

* 调用 submit；
* 将 Candidate 标记 accepted；
* 取消其他 Solver；
* 宣布正式得分。

只有：

```text
本地确定性验证
+ 可选强模型 Discriminator
+ 平台响应
```

才能进入 accepted。

---

# 三十一、第一候选不等于获胜

ChallengeSwarm 不应在第一个模型输出类似 Flag 字符串时立刻取消其他 Solver。

正确流程：

```text
Candidate found
→ CandidateValidator
→ FlagDiscriminator
→ validated
→ 根据 Policy 决定是否暂停其他 Solver
```

真实比赛中：

```text
SubmissionController
→ accepted
→ cancel losers
```

若 Candidate rejected：

* 原 Solver继续或暂停；
* 其他 Solver 不取消。

---

# 三十二、TrajectoryRecorder

建议创建：

```text
src/core/trajectory/
├── trajectoryTypes.ts
├── trajectoryRecorder.ts
├── trajectoryReader.ts
├── trajectoryReplay.ts
└── trajectoryMetrics.ts
```

记录结构化事件：

* Model Routing Decision
* Compiled Context ID
* Model Response Schema Result
* Tool Call
* Attempt
* Observation
* Evidence
* Hypothesis Update
* SuggestedAction
* StrategyDecision
* Solver Guidance
* Stagnation
* Candidate
* Validation
* Stop/Pause

格式建议：

```text
JSONL
```

每条包含：

```ts
{
  timestamp
  taskId
  solverRunId
  eventType
  payload
  stateRevision
}
```

不要只保存聊天记录。

不要在 Trajectory 中保存：

* API Key
* Secret
* 未脱敏凭据
* 完整环境变量
* 平台 Token

---

# 三十三、Challenge Benchmark Adapter

本轮建立接口和本地 Fixture。

```ts
export interface BenchmarkChallenge {
  id: string
  category: string

  description: string

  artifactPaths: string[]

  expectedFlagPattern?: string
  expectedFlagHash?: string

  timeoutMs: number
  dockerComposePath?: string
}
```

支持类似：

```text
challenge.json
docker-compose.yml
```

但不要强制所有现有 Challenge 立即迁移。

创建 Adapter：

```ts
export interface ChallengeBenchmarkAdapter {
  load(path: string): Promise<BenchmarkChallenge>
  prepare(challenge: BenchmarkChallenge): Promise<void>
  verifyCandidate(
    challenge: BenchmarkChallenge,
    candidate: string,
  ): Promise<boolean>
  cleanup(): Promise<void>
}
```

---

# 三十四、模型可靠性 Benchmark

重点评估 M3，而不是只看“最终是否解题”。

指标：

```ts
export interface ModelReliabilityMetrics {
  schemaValidRate: number
  toolArgumentValidRate: number

  duplicateAttemptRate: number
  repeatedActionLoopRate: number

  unsupportedClaimRate: number

  evidenceGainPerAction: number
  successfulActionsPerRun: number

  contextCompilerValidationRate: number
  compactRecoveryRate: number
  retryHandoffResumeRate: number

  flagFalsePositiveRate: number

  averageDurationMs: number
  averageCost?: number
}
```

至少建立 A/B：

## A/B 1

```text
M3 + 全部工具
vs
M3 + ToolVisibility
```

## A/B 2

```text
M3 + 原始 TaskState 拼接
vs
M3 + SolverBriefCompiler
```

## A/B 3

```text
M3 单 Solver
vs
M3 Scout → 强模型升级
```

## A/B 4

```text
Solver 自己总结
vs
独立 ProgressCompiler
```

## A/B 5

```text
从头重试
vs
RetryHandoff
```

不要提前写“性能提升”。

只报告真实测量。

---

# 三十五、M3 输出协议测试

构造 Fake M3：

1. 返回非法 JSON。
2. 返回缺字段 JSON。
3. 返回不存在 Tool。
4. 返回越权 Tool。
5. 重复相同 Action。
6. 自称发现 Flag，但无来源。
7. 请求扩大 Scope。
8. 输出超长总结。
9. 返回空字符串。
10. 超时。
11. Provider 529/5xx。
12. 连续 Schema Failure。

验证：

* 一次 Repair。
* Fallback。
* Circuit Open。
* 不执行非法 Tool。
* 不创建虚假 Evidence。
* 不将 Candidate 标记 validated。
* Runtime 不崩溃。
* Solver 可以暂停或切换。

---

# 三十六、Tool Visibility 测试

验证：

* Orchestrator 只能看到高层工具。
* M3 Scout 工具数不超过配置上限。
* Browser Specialist 可以看到 Browser MCP。
* Orchestrator 看不到 Browser MCP 细粒度工具。
* 隐藏 Tool 的伪造调用被拒绝。
* Workflow-only Tool 不暴露给模型。
* OneShot-only Tool 不暴露给模型。
* Profile 切换会重新计算 Visibility。
* Cached Tool Definitions 被正确失效。

---

# 三十七、Context Compiler 测试

验证：

* 编译结果具有 State Revision。
* State 改变后旧 Brief 失效。
* Source ID 全部存在。
* Confirmed 与 Hypothesis 不混淆。
* Failed Attempt 正确列入 do_not_repeat。
* Scope 永远存在。
* Token 上限有效。
* M3 渲染新增事实被 Validator 拒绝。
* 模型渲染失败回退确定性模板。
* ProgressCompiler 不是由当前 Solver 自己执行。
* RetryHandoff 可以恢复第一动作。

---

# 三十八、Solver Adapter 测试

## Native Solver

* 使用现有 Runtime。
* 不创建第二 TaskState。
* 支持 Guidance。
* 支持 Cancel。
* 结果只 Materialize 一次。

## Generic Process Solver

* JSONL 输入输出。
* 非 JSON 行进入日志。
* Schema 错误不写 Evidence。
* 超时终止进程树。
* Cancel 精确生效。
* Workspace 隔离。
* 环境变量白名单。
* `shell:false`。
* 不依赖真实 Codex CLI。

---

# 三十九、Swarm 测试

## M3 停滞升级

```text
M3 Scout
→ 连续无新 Evidence
→ StagnationDetector
→ 启动强模型
```

## Evidence 共享

```text
Solver A 发现有效 Evidence
→ EvidenceBus
→ Solver B Cursor
→ 编译 Guidance
```

## 假 Candidate

```text
M3 Candidate
→ Validator rejected
→ 不取消强模型
```

## 真 Candidate

```text
Candidate validated
→ 根据 Policy 暂停其他 Solver
```

本轮没有真实平台 accepted，所以不要模拟平台得分。

## Branch

* Branch 目标不同。
* Failed Attempt 被继承。
* 不重复相同 Fingerprint。
* 超过最大 Solver 数量被拒绝。

---

# 四十、许可证和 Clean-room 检查

生成：

```text
docs/research/external-license-audit.md
```

记录每个参考仓库：

* License
* 查看了哪些文件
* 借鉴了什么行为
* 是否复制代码
* 本项目对应自主实现文件

禁止：

* 复制 AGPL 项目具体代码。
* 复制未经许可的 Prompt 全文。
* 复制大量注释或命名结构。
* 将参考仓库直接 vendoring 到 src。
* 删除版权声明后使用代码。

可以：

* 借鉴公开的架构思想。
* 自主设计接口。
* 编写行为兼容 Adapter。
* 使用公开协议。
* 记录来源。

---

# 四十一、静态禁止检查

完成后执行：

```bash
rg -n "client\\.chat|responses\\.create|completions\\.create" src/core src/ctf
```

CTF 业务模型调用应逐步经过 StructuredModelGateway。

允许底层 Gateway 自己命中。

检查：

```bash
rg -n "M3|m3" src
```

不应在业务模块散落模型名。

检查：

```bash
rg -n "getToolDefinitions.*all|allTools|registry\\.list\\(\\)" src/core
```

模型 Tool Definitions 必须经过 Visibility。

检查：

```bash
rg -n "shell:\\s*true" src/core/solverPortfolio
```

必须无匹配。

检查：

```bash
rg -n "submit.*flag|flag.*submit" src/core/solverPortfolio src/core/modelReliability
```

M3 和普通 Solver 不得直接提交。

检查：

```bash
rg -n "JSON\\.stringify\\(.*TaskState|JSON\\.stringify\\(state" src/core/contextCompiler
```

Compiler 不应直接全量序列化 State。

检查：

```bash
rg -n "new Map" src/core/solverPortfolio src/core/modelReliability
```

所有长期 Map 必须：

* 由 Runtime 实例持有；
* 有 dispose；
* 有大小上限；
* 或不是状态真相源。

检查：

```bash
rg -n "SolverPortfolioV2|ModelGatewayV2|ContextCompilerV2|OrchestratorV2" src
```

必须无匹配。

---

# 四十二、验证命令

执行：

```bash
pnpm typecheck
pnpm build
pnpm lint
pnpm test
```

运行无网络 Smoke Test。

## Smoke 1：M3 可靠性

```text
Fake M3 非法 JSON
→ Repair 失败
→ Fallback
→ 强模型 Fake 成功
→ Action 执行
```

## Smoke 2：Tool Visibility

```text
M3 Scout
→ 只收到有限 Tool
→ 伪造隐藏 Tool
→ Broker 拒绝
```

## Smoke 3：Progress Compiler

```text
Task 运行
→ Context 接近阈值
→ 独立 Compiler
→ 新 Solver 使用接班简报继续
```

## Smoke 4：Solver Escalation

```text
M3 Scout 无 Evidence
→ Stagnation
→ 强模型启动
→ 继承 RetryHandoff
```

## Smoke 5：Cross-solver Evidence

```text
Solver A Evidence
→ Bus
→ Solver B Guidance
→ Source ID 保留
```

## Smoke 6：Candidate

```text
M3 提交虚假 Candidate
→ Discriminator 拒绝
→ 其他 Solver继续
```

不得连接公网目标。

不得依赖真实比赛平台。

不得依赖真实 API Key。

---

# 四十三、完成标准

只有以下全部满足才能结束。

## 模型可靠性

* 所有 Model 通过 Registry。
* 业务调用经过 StructuredModelGateway。
* Schema 失败受控。
* Repair 最多一次。
* Fallback 生效。
* CircuitBreaker 生效。
* M3 没有决策权威权限。
* 模型失败不被记录为空成功。

## Context

* ChallengePromptCompiler 工作。
* SolverBriefCompiler 工作。
* ProgressCompiler 工作。
* RetryHandoffCompiler 工作。
* SpecialistContextCompiler 工作。
* Context 有 Source ID。
* Context 有版本和 Snapshot Hash。
* 编译结果不成为新真相源。
* 失败时有确定性回退。

## Tool Visibility

* Orchestrator 只看到高层工具。
* M3 看到有限工具。
* Specialist 看到领域工具。
* 隐藏工具伪造调用被拒绝。
* MCP 工具可按角色隐藏。

## Solver Portfolio

* Native Solver Adapter 工作。
* Generic Process Adapter 工作。
* SolverRunRecord 进入 TaskState。
* Solver 可以 inspect、guidance、cancel。
* 外部结果经过 Normalizer。
* 外部结果不能直接写 Evidence。

## Swarm

* 支持受控多 Solver。
* 默认不是无脑多模型并发。
* M3 停滞可以升级。
* Evidence 可以跨 Solver 共享。
* 每 Solver 有 Cursor。
* Candidate 必须验证后才影响其他 Solver。
* 分支不重复相同路线。
* Stop-loss 和 Pause 工作。

## Flag 边界

* Solver 只发现 Candidate。
* Discriminator 负责验证。
* SubmissionController 是唯一平台提交接口。
* M3 无提交权限。
* 本轮无真实平台自动提交。

## 评测

* TrajectoryRecorder 工作。
* 可靠性指标可计算。
* 至少完成规定 A/B Fixture。
* 不在没有数据时声称提升。
* Benchmark 可重复。
* 不依赖公网。

## 工程质量

* 不创建 V2。
* 不重复 TaskState。
* 不重复 MessageBus 真相源。
* 不增加大量 `any`。
* 不使用 eval。
* 不使用 `shell:true`。
* Typecheck 通过。
* Build 通过。
* Lint 通过。
* Tests 通过。
* Smoke Test 通过。
* 文档与实现一致。
* License Audit 完成。

---

# 四十四、执行顺序

严格按照：

```text
1. 本地代码审计
2. 外部参考机制矩阵
3. License Audit
4. ModelCapabilityRegistry
5. ModelHealth
6. StructuredModelGateway
7. CircuitBreaker
8. ModelRolePolicy
9. ModelRouter
10. ContextProjection
11. ContextCompiler
12. CompilerValidator
13. M3 SolverBrief
14. ToolVisibilityPolicy
15. MCP Visibility
16. SolverAdapter Protocol
17. NativeSolverAdapter
18. GenericProcessSolverAdapter
19. SolverRunRecord
20. CrossSolverEvidenceBus
21. Guidance Compiler
22. StagnationDetector
23. RetryHandoff
24. ChallengeSwarm
25. OperatorMessage
26. Flag Discriminator Boundary
27. TrajectoryRecorder
28. Benchmark Adapter
29. 可靠性 A/B 测试
30. 静态禁止检查
31. Smoke Test
32. 文档与最终报告
```

不要一开始实现 CTFd。

不要继续增加底层 CTF 工具。

不要把外部项目完整复制进仓库。

不要让 M3 决定架构。

不要让 M3 的自然语言总结直接成为 Evidence。

不要将“测试数量增加”当作实际效果证明。

本轮最终目标是：

> M3 即使输出不稳定、重复动作、参数错误或错误 Candidate，也只能造成一个受控 Solver Run 失败，不能污染 TaskState、扩大权限、浪费无限预算或错误终止比赛；同时系统能够在 M3 停滞时自动编译当前进展并将任务平滑升级给更可靠的 Solver。
