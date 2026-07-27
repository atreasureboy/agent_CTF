# Agent_CTF Phase 3.3：Production Truthfulness Closure

## 生产真实性收口、在线 Solver 协调与轨迹真实回放

你正在当前最新的 `agent_CTF` 仓库中工作。

当前项目已经实现大量基础组件：

* CTFTaskRuntime
* CTFTaskOrchestrator
* CTFTaskStateStore
* ModelCapabilityRegistry
* ModelRouter
* ModelHealthStore
* ModelCircuitBreaker
* StructuredModelGateway
* OpenAI-compatible Provider
* MonitoredAgentTurnStream
* ModelExecutionIdentity
* ToolVisibilityPolicy
* ContextCompiler
* TaskStateProjectionBuilder
* SolverPortfolio
* NativeSolverAdapter
* GenericProcessSolverAdapter
* ChallengeSwarm
* SolverRunRecord
* CrossSolverEvidenceBus
* StagnationDetector
* FlagDiscriminator
* TrajectoryRecorder
* TrajectoryValidator
* TrajectoryReplay

但是当前公开实现仍存在明显的“架构声明强于生产行为”问题。

典型情况包括：

```text
ModelGateway 存在
≠ 所有模型请求真的经过 Gateway

MonitoredAgentTurnStream 存在
≠ Gateway 真正使用它监控完整 Stream

SolverPortfolio 存在
≠ Solver 真正执行任务

SolverEvent 接口存在
≠ ChallengeSwarm 在线消费事件

Canonical Snapshot 存在
≠ Context 投影数据完整可信

TrajectoryReplay 存在
≠ 真正重建 TaskState 和回放推理

NativeSolverAdapter 返回 completed
≠ Native Runtime 真正运行

测试通过
≠ 生产路径不存在模拟成功
```

本轮唯一目标是：

> 删除所有模拟成功、默认占位、临时旁路和双重状态源，使每一次“成功”都必须对应真实 Provider、真实模型输出、真实 Tool 或 Solver 执行、真实 TaskState 产物和可重放轨迹。

必须直接修改当前代码。

不要只写审计报告。

不要新增 V2。

不要增加新的 Solver、工具、Workflow 或比赛平台。

---

# 一、参考项目原则

本轮继续参考以下项目已经验证过的工程机制：

```text
yhy0/CHYing-agent
verialabs/ctf-agent
aliasrobotics/CAI
aielte-research/HackSynth
amazon-science/Cyber-Zero
amazon-science/CTF-Dojo
amazon-science/Cyber-Zero/enigma-plus
```

重点吸收以下机制。

## CHYing-agent

参考：

* MCP Tool Visibility
* PromptCompiler
* ProgressCompiler
* RetryHandoffCompiler
* ABANDON
* PreToolUse 重复路线阻断
* 弱模型速度和准确率问题
* 比赛中的止损与资源切换

注意：

* 不直接复制源代码。
* 不直接复制 Prompt 全文。
* PromptCompiler、ProgressCompiler 和 RetryHandoff 必须通过本项目 A/B 测试验证。
* 不预设复杂 Context Compiler 一定优于简单模板。

## Veria CTF Agent

参考：

* 多 Solver 并行
* Solver 实时 Trace
* Coordinator 在线观察
* 中途 Guidance
* Cross-solver Insight
* Operator Message
* 找到候选后的验证与取消

重点不是“同时运行多个 Solver”，而是：

```text
运行中观察
→ 判断是否卡住
→ 分享其他 Solver 的可靠发现
→ 发送明确指导
→ 动态升级、暂停或取消
```

## CAI

参考：

```text
Solver
→ Flag Candidate
→ Flag Discriminator
→ Submission Controller
```

普通 Solver 不得自行宣布任务成功。

## HackSynth

参考：

* Planner 和 Summarizer 分离
* Summarizer 只压缩已有事实
* Planner 才决定下一动作
* 不让 Solver 自己总结自己并把总结当事实

## Cyber-Zero / EnIGMA+

参考：

* Trajectory Schema
* Command Format Validation
* Action Consistency
* Output Parsing
* Completeness
* Accuracy
* Realism
* 可重复 Benchmark
* Trajectory Replay

所有外部参考必须采用 Clean-room 行为级实现。

---

# 二、本轮禁止事项

本轮禁止：

* 不实现 CTFd。
* 不实现 BUUCTF。
* 不实现比赛账户登录。
* 不实现真实 Flag 自动提交。
* 不增加新的 OneShot Manifest。
* 不迁移新的 Reverse/Pwn/Web/PCAP Workflow。
* 不增加新的 Solver Adapter 类型。
* 不接入真实 Codex CLI。
* 不接入真实 Claude Code CLI。
* 不新增模型供应商。
* 不实现 RL 或微调。
* 不引入数据库。
* 不引入消息队列。
* 不创建 ModelGatewayV2。
* 不创建 SolverPortfolioV2。
* 不创建 ChallengeSwarmV2。
* 不创建 ContextCompilerV2。
* 不创建 TrajectoryV2。
* 不保留旧旁路作为静默回退。
* 不允许“Provider 不存在时返回模拟结果”。
* 不允许“Delegate 不存在时返回 completed”。
* 不允许“没有真实 Evidence ID 时广播为可靠事实”。
* 不允许测试 Fixture 自动进入生产注册表。
* 不通过增加测试数量证明功能有效。

---

# 三、M3 的职责限制

本任务的核心修改必须由 Codex 或当前主编码模型完成。

M3 仅允许处理：

* 文件定位
* 静态搜索结果整理
* Fixture 编写
* 小型纯函数
* 类型补全
* 明确 Schema 下的 Parser
* 单元测试
* 文档整理
* 重复代码检查
* 测试失败原因分类

M3 不得负责：

* Gateway 架构
* Provider 绑定
* Stream 生命周期
* Model Health 和 Circuit 状态机
* ModelExecutionIdentity
* Tool Visibility 权限
* Solver 状态所有权
* Swarm 并发
* Evidence 共享语义
* Flag 验证边界
* Trajectory Replay
* 核心 Reducer 修改
* 删除旧生产路径
* 宣布任务完成

M3 的任何修改必须经过：

```text
主模型审查 Diff
→ typecheck
→ 定向测试
→ 集成测试
```

---

# 四、开始前建立真实基线

执行：

```bash
git status --short
git branch --show-current
git log -20 --oneline
git diff --stat
git diff
git diff origin/main...HEAD --stat
```

不得 reset。

不得覆盖用户未提交修改。

然后执行：

```bash
pnpm typecheck
pnpm build
pnpm lint
pnpm test
```

以 `package.json` 实际脚本为准。

如果某一命令不存在，记录真实替代命令。

---

# 五、第一轮生产真实性审计

执行：

```bash
rg -n "new StructuredModelGateway" src
rg -n "constructor\\(" src/core/modelReliability/structuredModelGateway.ts
rg -n "new ModelCapabilityRegistry|registerDefault|high-tier-model|m3-low-cost-tier|gpt-4o" src

rg -n "providerId|providerModelName|provider:" src/core/modelReliability
rg -n "Array\\.from\\(this\\.providers\\.values\\(\\)\\)\\[0\\]" src
rg -n "providers\\.size.*true|hasProvider.*true" src

rg -n "MonitoredAgentTurnStream" src
rg -n "recordSuccess" src/core/modelReliability
rg -n "streamAgentTurn" src/core/modelReliability src/core/engine.ts

rg -n "new OpenAICompatibleProvider" src
rg -n "chat\\.completions\\.create|responses\\.create" src
rg -n "profile\\.id as any|as ModelRole" src

rg -n "resolveVisibleTools|resolveDefinitions|isToolVisible" src/core
rg -n "filterVisibleTools" src
rg -n "getToolDefinitions|getToolSchemas" src/core/engine.ts src/core/toolBroker.ts

rg -n "new SolverPortfolio" src
rg -n "registerDefaultAdapters|Generic mock solver|Simulate native" src
rg -n "new NativeSolverAdapter" src
rg -n "status:\\s*['\"]ready['\"]" src/core/solverPortfolio/nativeSolverAdapter.ts

rg -n "events\\(\\)|SolverEvent|handle\\.wait" src/core/solverPortfolio
rg -n "evidenceIds:\\s*\\[\\]|observationIds:\\s*\\[\\]|artifactIds:\\s*\\[\\]" src/core/solverPortfolio

rg -n "CrossSolverEvidenceBus|private messages|seenMessageIds|lastSeenStateRevision" src
rg -n "stateRevision.*1" src

rg -n "TaskStateProjectionBuilder|allowedToolIds|path:\\s*id|sha256|mime" src/core/contextCompiler
rg -n "snapshotContent\\.length|state\\.updatedAt|hash_" src/core/contextCompiler

rg -n "TrajectoryReplay|state-rebuild|mock-execution" src/core/trajectory
rg -n "events\\.push|RingBuffer|maxWriteQueueBytes|maxPayloadBytes" src/core/trajectory
```

将结果写入：

```text
docs/architecture/phase-3.3-production-truthfulness-audit.md
```

必须逐项分类：

```text
A. 真实生产使用
B. 仅实例化但未调用
C. 仅测试使用
D. 模拟成功
E. 双重真相源
F. 声明能力与实际行为不一致
G. 类型或构造签名异常
```

完成后继续修改。

---

# 六、修复 StructuredModelGateway 构造和依赖

检查 `StructuredModelGateway` 构造函数和所有调用点。

必须使用显式依赖对象，避免参数位置错误：

```ts
export interface StructuredModelGatewayDependencies {
  registry: ModelCapabilityRegistry
  router: ModelRouter
  healthStore: ModelHealthStore
  circuitBreaker: ModelCircuitBreaker

  providers: ReadonlyMap<string, ModelProvider>

  trajectoryRecorder: TrajectoryRecorder

  getStateRevision: (
    taskId: string,
  ) => number
}

export class StructuredModelGateway {
  constructor(
    private readonly deps:
      StructuredModelGatewayDependencies,
  ) {}
}
```

禁止继续使用：

```ts
new StructuredModelGateway(
  router,
  healthStore,
  circuitBreaker,
  registry,
  trajectoryRecorder,
)
```

所有依赖改为具名字段。

测试必须验证：

* Registry 没有传错位置。
* TrajectoryRecorder 没有丢失。
* 缺失依赖时立即失败。
* 不允许 undefined 被静默接受。

---

# 七、Model Profile 和 Provider 严格绑定

统一模型配置：

```ts
export interface ModelCapabilityProfile {
  id: string

  providerId: string
  providerModelName: string

  contextWindow: number

  capabilities: {
    toolCalling: boolean
    structuredOutput: boolean
    vision: boolean
    longContext: boolean
  }

  allowedRoles: ModelRole[]

  trustLevel:
    | 'auxiliary'
    | 'standard'
    | 'privileged'

  limits: {
    maxVisibleTools: number
    maxIterations: number
    maxRepairAttempts: number
    maxConsecutiveFailures: number
  }

  fallbackModelIds: string[]
}
```

Gateway 路由完成后必须：

```ts
const profile =
  registry.getRequired(routing.selectedModelId)

const provider =
  providers.get(profile.providerId)

if (!provider) {
  throw new MissingModelProviderError({
    modelId: profile.id,
    providerId: profile.providerId,
  })
}
```

Provider 接收：

```ts
profile.providerModelName
```

不能接收内部 Profile ID 代替真实模型名称。

---

# 八、删除所有自动占位模型

删除生产默认自动注册：

```text
high-tier-model
m3-low-cost-tier
gpt-4o
m3-mini
```

除非它们来自用户显式配置。

增加：

```ts
export interface RuntimeModelConfiguration {
  providers: ProviderConfiguration[]
  models: ModelCapabilityProfile[]
  routingPolicies?: ModelRoutingPolicy[]
}
```

规则：

## Workflow-only Runtime

没有模型配置时可以启动。

## LLM Runtime

没有任何合法模型和 Provider 时：

```text
Runtime creation failed:
No configured model/provider available
```

不得创建伪模型。

不得延迟到执行过程中随机失败。

提供：

```text
examples/model-config.example.json
```

仅作为示例，不自动加载。

---

# 九、Provider 配置启动校验

Runtime 创建阶段执行：

```ts
validateModelRuntimeConfiguration(...)
```

检查：

* Model ID 唯一。
* Provider ID 唯一。
* 每个 Model 的 Provider 存在。
* `providerModelName` 非空。
* 每个 Fallback Model 存在。
* Fallback Model 具有可用 Provider。
* Fallback Model 允许相同 Role。
* Fallback Model 具备所需能力。
* Provider 配置完整。
* LLM Runtime 至少有一个可用模型。

无效 Model：

* 标记 unavailable；
* 或拒绝 Runtime 启动。

不得假设 Provider 存在。

不得使用：

```ts
providers.size === 0
  ? true
  : providers.has(...)
```

---

# 十、MonitoredAgentTurnStream 必须接入 Gateway

`streamAgentTurn()` 返回值必须使用：

```ts
new MonitoredAgentTurnStream(...)
```

完整生命周期：

```text
Router 选择模型
→ Circuit 检查
→ Provider 建立 Stream
→ Monitored Stream
→ Engine 消费
→ 正常 EOF
→ Health Success
```

错误分类：

```text
连接失败
首 Token 超时
中途失败
空 Stream
无有效 Assistant 输出
Tool 参数错误
Consumer Cancel
Task Abort
```

只有以下条件全部满足才记录成功：

```text
至少一个有效 Chunk
+ Stream 正常 EOF
+ 未被 Abort
+ 未发生中途异常
```

禁止：

```ts
const stream =
  await provider.streamAgentTurn(...)

healthStore.recordSuccess(...)

return stream
```

---

# 十一、Streaming 失败和 Fallback 语义

允许自动 Fallback 的条件：

```text
尚未向 Engine 暴露任何有效 Chunk
```

例如：

* Provider 建连失败。
* 首 Token 超时。
* 空响应。
* 429。
* 5xx。

若已输出部分有效内容后失败：

```text
返回 PartialStreamFailure
```

不得悄悄切换另一个模型继续拼接。

Engine 可以选择：

* 终止本轮；
* 创建新 Turn；
* 使用完整消息重新请求 Fallback。

必须记录：

* 原模型。
* 原 Provider。
* 已输出 Chunk 数。
* Failure Kind。
* 是否允许重试。
* 是否使用 Fallback。

---

# 十二、统一模型错误分类

定义：

```ts
export type ModelInvocationFailureKind =
  | 'routing_rejected'
  | 'role_denied'
  | 'capability_missing'
  | 'provider_unavailable'
  | 'provider_429'
  | 'provider_5xx'
  | 'timeout'
  | 'first_token_timeout'
  | 'stream_interrupted'
  | 'empty_response'
  | 'schema_failure'
  | 'tool_argument_failure'
  | 'cancelled'
  | 'consumer_cancelled'
```

规则：

* Role 拒绝不计入 Schema Failure。
* Capability 缺失不计入模型质量失败。
* Routing Rejected 不计入 Provider Failure。
* Abort 不计入模型失败。
* Consumer Cancel 不计入模型失败。
* Schema Failure 只用于结构化输出校验。
* Tool Argument Failure 只用于 Tool Call 参数。
* Provider 429 和 5xx 分别记录。
* Empty Response 独立记录。

---

# 十三、删除 ExecutionEngine 模型旁路

最终 `ExecutionEngine` 不得：

* 临时创建 Provider；
* 临时创建 Model Profile；
* 直接调用 OpenAI SDK；
* 在没有 Gateway 时自动降级；
* 使用 `profile.id as ModelRole`；
* Compact 时绕过 Gateway。

生产配置必须要求：

```ts
modelGateway: ModelInvocationGateway
```

LLM 模式下缺失 Gateway：

```text
throw MissingModelInvocationGatewayError
```

Workflow-only 模式不得进入模型调用。

最终：

```bash
rg -n "new OpenAICompatibleProvider" src
rg -n "chat\\.completions\\.create|responses\\.create" src
```

只允许正式 Provider Adapter 命中。

---

# 十四、Compact、Critic 和 Summarizer 统一接入

检查：

* maybeCompact
* conversation summary
* progress summary
* critic
* reflection
* context model rendering
* retry handoff rendering
* flag discriminator model调用

全部通过 Gateway。

映射 Role：

```text
Compact / Progress → progress_summarizer
Task Planning → task_planner
Main Solver → deep_solver
Scout → solver_scout
Specialist → specialist
Flag Judge → flag_discriminator
```

禁止使用 Capability Profile ID 代替 ModelRole。

---

# 十五、ModelExecutionIdentity 必须真实使用

所有模型和工具调用构造：

```ts
export interface ModelExecutionIdentity {
  taskId: string

  modelRole: ModelRole
  modelProfileId: string
  providerId: string

  capabilityProfileId: string

  solverRunId?: string
  specialistId?: string

  agentRunId?: string
  workflowRunId?: string
  oneShotRunId?: string
  handoffId?: string

  isOrchestrator: boolean
}
```

Identity 由 Runtime 创建。

禁止模型输入以下字段：

* modelRole
* modelProfileId
* providerId
* capabilityProfileId
* isOrchestrator
* solverRunId

Identity 用于：

* ModelRouter
* ModelRolePolicy
* ToolExposureResolver
* ToolBroker
* ContextCompiler
* Trajectory
* Solver Portfolio

---

# 十六、ToolExposureResolver 成为唯一入口

建立或完善：

```ts
export interface ToolExposureResolver {
  resolveDefinitions(input: {
    identity: ModelExecutionIdentity

    modelProfile:
      ModelCapabilityProfile

    capabilityProfile:
      CapabilityProfile

    taskState:
      Readonly<CTFTaskState>

    tools:
      ToolDescriptor[]
  }): ToolDescriptor[]

  assertExecutable(input: {
    identity:
      ModelExecutionIdentity

    modelProfile:
      ModelCapabilityProfile

    capabilityProfile:
      CapabilityProfile

    taskState:
      Readonly<CTFTaskState>

    tool:
      ToolDescriptor
  }): void
}
```

## Tool Definition

Engine 调模型前只调用：

```ts
resolveDefinitions(...)
```

禁止继续逐个调用：

```ts
isToolVisible(profile.id, tool.id)
```

## Tool Execution

ToolBroker 执行前调用：

```ts
assertExecutable(...)
```

Definition 和 Execution 必须使用同一 Resolver。

伪造隐藏 Tool Call 必须被拒绝。

---

# 十七、Tool 排序和限制

Tool 排序依据：

```text
Role 匹配
→ Capability Profile
→ 当前题型
→ Active Hypothesis
→ Pending Action
→ Tool Availability
→ 预计信息增益
→ Cost
→ Tool ID
```

排序后应用：

```ts
modelProfile.limits.maxVisibleTools
```

禁止直接对 Registry 顺序：

```ts
tools.slice(0, maxVisibleTools)
```

M3 或 auxiliary 模型工具数必须受严格限制。

---

# 十八、Orchestrator Tool Visibility Fail-closed

Orchestrator 只允许高层 Tool，例如：

```text
run_workflow
run_one_shot
request_handoff
inspect_task_state
inspect_solver
send_solver_guidance
validate_candidate
pause_solver
resume_solver
```

高层 Tool 分类必须来自 Tool Metadata：

```ts
tool.metadata.visibilityClass =
  'orchestrator'
```

不要在 Policy 中维护第二份硬编码工具名。

当没有任何 Orchestrator Tool 注册时：

```text
返回空 Tool Definitions
+ 记录配置错误
```

禁止退化成暴露全部工具。

---

# 十九、SolverPortfolio 强制依赖注入

改为：

```ts
export interface SolverPortfolioDependencies {
  stateStore: CTFTaskStateStore

  contextCompiler:
    ContextCompilerService

  resultNormalizer:
    SolverResultNormalizer

  trajectoryRecorder:
    TrajectoryRecorder

  adapters:
    ExternalSolverAdapter[]
}

export class SolverPortfolio {
  constructor(
    private readonly deps:
      SolverPortfolioDependencies,
  ) {}
}
```

禁止：

```ts
new SolverPortfolio()
```

禁止构造函数内部：

```ts
registerDefaultAdapters()
```

测试必须显式传入 Fake Adapter。

生产 Runtime 必须显式注册真实可用 Adapter。

---

# 二十、NativeSolverAdapter 去除模拟成功

NativeSolverAdapter 必须强制依赖：

```ts
export interface NativeSolverRuntimeDelegate {
  run(input: {
    taskId: string
    solverRunId: string
    compiledContext: CompiledContext
    signal: AbortSignal
  }): Promise<NativeSolverRuntimeResult>

  sendGuidance(
    solverRunId: string,
    guidance: SolverGuidance,
  ): Promise<void>

  cancel(
    solverRunId: string,
    reason: string,
  ): Promise<void>
}
```

没有 Delegate：

```ts
probe() {
  return {
    status: 'unavailable',
    reason:
      'NativeSolverRuntimeDelegate not configured',
  }
}
```

`start()` 必须抛出：

```text
SolverUnavailableError
```

禁止生成模拟 Observation。

禁止返回 completed。

测试必须验证真实 Delegate 调用次数。

---

# 二十一、禁止所有 Synthetic Solver Success

生产代码搜索：

```bash
rg -n "Simulate|mock solver|synthetic|fake completed|dummy observation" src/core/solverPortfolio
```

所有模拟结果必须移入测试。

生产 Solver Result 的 `completed` 必须满足：

* Solver 真正启动。
* 存在开始时间。
* 存在最终状态。
* Result 来源真实。
* Runtime 或 Process 实际运行。
* Attempt 或事件可追踪。

---

# 二十二、SolverRunHandle 在线事件能力必须实现

统一接口：

```ts
export interface SolverRunHandle {
  readonly runId: string
  readonly solverId: string

  events(): AsyncIterable<SolverEvent>

  wait(): Promise<ExternalSolverResult>

  sendGuidance(
    message: SolverGuidance,
  ): Promise<void>

  cancel(
    reason: string,
  ): Promise<void>

  inspect(): Promise<SolverRunSnapshot>
}
```

所有生产 Adapter 必须支持：

```ts
events()
```

如果 Adapter 无法产生细粒度事件，至少输出：

```text
status
progress
candidate
warning
terminal
```

禁止返回永不产生事件的空 AsyncIterator。

---

# 二十三、Solver Event Buffer 和 Backpressure

建立有界事件通道：

```ts
interface SolverEventChannelLimits {
  maxBufferedEvents: number
  maxBufferedBytes: number
}
```

规则：

* 高优先级 Candidate/Event 不丢。
* 低优先级 Progress 可合并。
* Slow Consumer 不阻塞 Solver 主循环。
* 超限时记录 Warning。
* Cancel 后关闭 Stream。
* Terminal 后关闭 Stream。
* 不允许事件永久积压。

---

# 二十四、ChallengeSwarm 必须在线消费事件

Swarm 对每个 Solver 同时启动：

```text
Event Consumer
Final Result Waiter
Stagnation Monitor
Guidance Channel
Abort Controller
```

不能只：

```text
Promise.race(handles.map(wait))
```

而忽略 `events()`。

在线流程：

```text
Solver Event
→ 投影 TaskState
→ 更新 Stagnation Signal
→ 生成 Grounded Knowledge
→ Observer Decision
→ Guidance / Pause / Upgrade
```

Final Result 只负责终态收敛。

---

# 二十五、SolverObserver

建立：

```ts
export interface SolverObserver {
  observe(input: {
    solverRun:
      SolverRunRecord

    recentEvents:
      SolverEvent[]

    taskState:
      Readonly<CTFTaskState>

    stagnation:
      StagnationSignals
  }): ObserverDecision
}
```

第一阶段使用确定性规则。

输出：

```ts
export type ObserverDecision =
  | {
      type: 'none'
    }
  | {
      type: 'send_guidance'
      guidance: SolverGuidance
    }
  | {
      type: 'pause'
      reason: string
    }
  | {
      type: 'switch_solver'
      targetSolverId: string
      reason: string
    }
  | {
      type: 'spawn_branch'
      objective: string
      hypothesisIds: string[]
      reason: string
    }
```

暂不使用额外 Coordinator LLM。

---

# 二十六、在线 ABANDON / Repetition Guard

参考 CHYing 的 PreToolUse 阻断，但使用当前结构化 Attempt。

建立：

```ts
export interface SolverPreActionGuard {
  inspect(input: {
    taskId: string
    solverRunId: string

    action:
      SuggestedAction

    fingerprint: string

    taskState:
      Readonly<CTFTaskState>
  }): RepetitionDecision
}
```

检测：

## 完全重复

```text
同 Tool
+ 同目标
+ 同输入 Artifact
+ 等价参数
+ 同意图
```

## 技术路线重复

```text
同 Encoding Branch
同 Stego Channel
同漏洞编号
同 Exploit Primitive
同 Web Route
同 Archive Password
```

## 已知失败条件

例如：

* Tool unavailable
* Unsupported format
* Access denied
* Invalid padding
* Connection refused
* Missing dependency

优先使用结构化 Error Code。

自然语言关键词只作为兼容信号。

输出：

```ts
export type RepetitionDecision =
  | {
      allowed: true
    }
  | {
      allowed: false
      reason: string
      priorAttemptIds: string[]
      requiredDirectionChange: true
    }
```

阻断必须发生在 Tool/Workflow/OneShot 执行前。

---

# 二十七、真实 Stagnation Signal Collector

建立：

```ts
export interface StagnationSignalCollector {
  collect(input: {
    taskId: string
    solverRunId: string
    taskState:
      Readonly<CTFTaskState>
    recentEvents:
      SolverEvent[]
    now: number
  }): StagnationSignals
}
```

使用：

* 最后新 Evidence 时间。
* 最后新 Artifact 时间。
* 最后 Hypothesis 状态变化。
* 重复 Attempt Fingerprint。
* 重复 Action Family。
* 连续 Tool Failure。
* Solver 已用预算。
* Context Compact 次数。
* Guidance 次数。
* Candidate 变化。

禁止生产中硬编码模拟信号。

策略：

```text
轻度停滞
→ send guidance

中度停滞
→ 强制不同 Action Family

严重停滞
→ pause / switch / spawn branch
```

---

# 二十八、CrossSolverEvidenceBus 改为 TaskState View

删除独立：

```ts
private messages:
  SolverEvidenceMessage[]
```

改为：

```ts
export class CrossSolverKnowledgeView {
  constructor(
    private readonly stateStore:
      CTFTaskStateStore,
  ) {}

  getUnread(input: {
    taskId: string
    solverRunId: string
    afterRevision: number
    limit: number
  }): SolverKnowledgeMessage[]
}
```

知识来源只允许：

* TaskState Evidence。
* TaskState Observation。
* Task Artifact Metadata。
* Validated Candidate。
* Operator Hint Event。

KnowledgeView 不保存事实副本。

---

# 二十九、跨 Solver 信息必须 Grounded

消息：

```ts
export interface SolverKnowledgeMessage {
  id: string
  taskId: string

  sourceSolverRunId?: string

  stateRevision: number

  evidenceIds: string[]
  observationIds: string[]
  artifactIds: string[]
  candidateIds: string[]

  priority:
    | 'low'
    | 'normal'
    | 'high'
    | 'critical'

  createdAt: number
}
```

要求：

* 至少有一个正式 State ID。
* 所有 ID 属于同一 Task。
* ID 必须存在。
* Candidate 必须至少 validated 才能作为高优先级知识。
* 不跨 Task。
* 不重复发送。
* 使用 Revision 确定未读。

没有正式 ID 的自然语言：

```text
SolverNote
```

只能作为低信任备注，不能进入 Evidence View。

---

# 三十、Cursor 语义

Cursor：

```ts
export interface SolverKnowledgeCursor {
  taskId: string
  solverRunId: string

  lastSeenRevision: number

  seenMessageIds:
    string[]
}
```

每次读取：

1. 只读取 `stateRevision > lastSeenRevision`。
2. 排除 seen IDs。
3. 限制数量。
4. 成功编译 Guidance 后更新 Cursor。
5. Runtime dispose 清理。

Cursor 是运行时状态，不是事实真相源。

---

# 三十一、Context Projection 必须使用真实工具和 Artifact

`TaskStateProjectionBuilder` 必须依赖：

```ts
export interface TaskStateProjectionBuilderDependencies {
  artifactStore: ArtifactStore
  findingStore: FindingStore
  toolRegistry: ToolRegistry
  toolExposureResolver:
    ToolExposureResolver
}
```

不得：

```ts
resolveVisibleTools([])
```

必须传入真实 Tool Registry。

Artifact 投影：

```ts
interface CompiledArtifactRef {
  id: string
  authorizedPath: string

  sha256?: string
  size?: number
  mimeType?: string

  lineage?: string[]

  createdByAttemptId?: string
}
```

不能使用：

```ts
path: artifactId
```

---

# 三十二、Context Evidence 可信度规则

Evidence 进入 `confirmedEvidence` 必须满足：

```text
polarity = supports
+ confidence 达到阈值
+ 至少一个有效 Source
+ Observation/Artifact 来源存在
```

以下不能进入 confirmed：

* neutral。
* contradicts。
* 无来源。
* Parser Failure。
* Solver Note。
* 仅模型自然语言声明。
* Inconclusive Candidate。

Negative Evidence 单独分组：

```text
negativeEvidence
```

冲突 Evidence 单独分组：

```text
conflictingEvidence
```

不要将所有高 Confidence Evidence 都称为 confirmed。

---

# 三十三、Context Snapshot 真正代表状态

规范化输入至少包含：

```ts
{
  taskId,
  stateRevision,

  evidence: [
    {
      id,
      kind,
      polarity,
      confidence,
      sourceIds,
      claimHash,
    },
  ],

  hypotheses: [
    {
      id,
      status,
      confidence,
      supportingEvidenceIds,
      contradictingEvidenceIds,
    },
  ],

  attempts: [
    {
      id,
      status,
      fingerprint,
      targetId,
    },
  ],

  artifacts: [
    {
      id,
      sha256,
      size,
      mimeType,
    },
  ],

  pendingActions: [
    {
      id,
      status,
      fingerprint,
    },
  ],

  allowedToolIds,

  compilerVersion,
}
```

执行：

```text
稳定排序
→ Canonical JSON
→ SHA-256
```

测试：

* 相同数量、不同内容 Hash 不同。
* Evidence Confidence 变化 Hash 变化。
* Hypothesis Status 变化 Hash 变化。
* Artifact SHA 变化 Hash 变化。
* Tool Exposure 变化 Hash 变化。
* 数组顺序变化 Hash 不变。

---

# 三十四、GenericProcessSolverAdapter 强化

## Probe

真实检查：

* 绝对路径是否存在。
* 简单命令是否可在 PATH 找到。
* 文件是否可执行。
* 协议版本是否兼容。
* Workspace 是否可写。

不能永远 ready。

## Process Tree

POSIX：

```text
独立 Process Group
→ kill(-pid)
```

Windows：

* 使用 Job Object；
* 或明确受测的 taskkill `/T` 降级；
* 不只 kill 当前 PID。

## JSONL Schema

所有消息经过 Zod：

```text
status
progress
observation
artifact
candidate
warning
tool_call_started
tool_call_completed
done
```

外部 Solver 不允许提供最终 Evidence ID。

它只能提供 Draft。

Draft 必须经过：

```text
Normalizer
→ Materializer
→ TaskState
```

## 路径

所有 Artifact/Source Path：

* realpath。
* Workspace containment。
* Symlink escape 拒绝。
* 文件大小限制。
* 不允许任意系统文件。

## Confidence

外部 Solver 提供 Confidence 只作为 Hint。

Normalizer 设置最大可信上限。

---

# 三十五、Flag Discriminator 完整输入

Flag 验证必须接收：

```ts
export interface FlagDiscriminationInput {
  taskId: string
  candidateId: string

  value: string
  normalizedValue: string

  challengePattern?: string

  sourceObservationIds: string[]
  sourceEvidenceIds: string[]
  sourceArtifactIds: string[]
  sourceAttemptIds: string[]

  transformChain:
    TransformStep[]

  localFixtureExpectedHash?: string
}
```

状态：

```text
detected
syntax_match
provenance_valid
locally_validated
platform_accepted
rejected
inconclusive
```

普通格式匹配：

```text
syntax_match
```

不能：

* 停止所有 Solver。
* 标记 accepted。
* 标记 Task solved。

本地 Fixture：

```text
locally_validated
+ CompletionPolicy 允许
```

才可以取消其他 Solver。

真实比赛：

```text
platform_accepted
```

才可以取消。

---

# 三十六、Trajectory Event 强类型化

定义：

```ts
export interface TrajectoryEventEnvelope<T> {
  schemaVersion: '1.0'

  eventId: string
  timestamp: number

  taskId: string
  stateRevision: number

  solverRunId?: string
  agentRunId?: string
  attemptId?: string

  eventType: TrajectoryEventType
  payload: T

  payloadHash: string
}
```

每类 Event 有独立 Zod Schema。

禁止最终写入：

```ts
payload:
  Record<string, any>
```

边界可以接收 unknown，但写入前验证。

---

# 三十七、TrajectoryRecorder 有界化

落实：

```ts
interface TrajectoryRecorderLimits {
  maxBufferedEvents: number
  maxWriteQueueBytes: number
  maxPayloadBytes: number
}
```

必须实际生效。

## Payload 超限

* 截断安全字段；
* 或写入 Artifact；
* Trajectory 中保存引用。

## Write Queue 超限

* Backpressure；
* 或降级到 bounded buffer；
* 记录 warning。

禁止无限内存增长。

## Revision

所有事件使用：

```ts
stateStore.getRevision()
```

禁止固定 `1`。

---

# 三十八、TrajectoryValidator 真正验证

至少实现以下确定性检查。

## Command Format

* Tool ID 存在。
* 参数符合 Schema。
* 没有未授权 Tool。
* 没有隐藏 Tool。
* 没有 shell 注入式参数。
* Attempt Fingerprint 匹配。

## Action Consistency

```text
StrategyDecision.selectedAction
=
实际执行 Action
=
Attempt.target
```

## Output Parsing

```text
Tool Result
→ Observation
→ Evidence
```

链路存在。

Parser Warning 未被吞掉。

## Completeness

每个 Attempt：

```text
started
→ completed / failed / cancelled
```

每个 SolverRun 有 Terminal Event。

每个 Model Stream 有结束状态。

## Accuracy

* Evidence 有来源。
* Candidate 有来源。
* accepted 只来自 Platform。
* locally_validated 有 Fixture Hash。
* Solver Note 没有被当 Evidence。

## Realism

检测：

* 未执行 Tool 却出现 Tool Result。
* Attempt 完成早于开始。
* Artifact 创建早于 Attempt。
* 同一 Run 多次 Terminal。
* Model Success 出现在 Stream EOF 前。
* Solver completed 但没有启动事件。
* Native Solver 无 Delegate 却 completed。

---

# 三十九、Trajectory Replay 真正重建

## validate-only

加载 JSONL：

* Schema Validation。
* Hash Validation。
* Consistency Validation。

## state-rebuild

使用正式 Reducer 从初始 State 重放 Task Event。

最终比较：

```text
replayedStateHash
vs
recordedFinalStateHash
```

不能只返回最后一个 Payload Hash。

## mock-execution

不执行真实模型或工具。

但重新执行：

```text
记录的 Tool Result
→ ParserRegistry
→ ResultMaterializer
→ Evidence Upsert
→ HypothesisUpdater
→ StrategyPlanner
```

比较旧版本和新版本输出：

* Observation IDs/Fingerprint。
* Evidence Fingerprint。
* Hypothesis Status。
* Strategy Action Family。
* Candidate 状态。

用于回归测试推理逻辑。

---

# 四十、Production Truthfulness Guard

建立测试辅助和运行时断言：

```ts
export interface ProductionTruthfulnessGuard {
  assertRealModelInvocation(...)
  assertRealSolverExecution(...)
  assertGroundedKnowledge(...)
  assertValidCompletion(...)
}
```

生产模式下拒绝：

* Mock Provider。
* Fake Provider。
* Synthetic Solver Result。
* 无 Delegate Native Solver。
* `simulated_accepted` 被当 accepted。
* 空 Materialized Result 被当成功。
* 无 Start Event 的 Terminal Run。
* 无正式 ID 的 Evidence Broadcast。
* Provider 不存在但路由成功。

测试模式必须显式：

```ts
runtimeMode: 'test'
```

不能通过 `NODE_ENV` 隐式猜测。

---

# 四十一、必须新增的端到端测试

## 1. Gateway 构造依赖

验证：

* Registry 正确。
* Recorder 正确。
* Providers 正确。
* 参数不会错位。
* 缺失依赖立即失败。

## 2. Provider 绑定

两个 Model Profile：

```text
model-a → provider-a
model-b → provider-b
```

调用 Model B：

```text
只调用 provider-b
```

## 3. Stream 成功

```text
Provider 输出有效 Chunks
→ 正常 EOF
→ recordSuccess
```

EOF 前不得成功。

## 4. Stream 中断

```text
两个 Chunk
→ 抛错
→ stream_interrupted
→ 不记录 success
```

## 5. Engine 无旁路

缺失 Gateway：

```text
LLM Runtime 创建失败
```

不得临时创建 Provider。

## 6. Tool Exposure

M3 Scout：

* 只收到有限相关 Tool。
* 隐藏 Tool 不在 Definitions。
* 伪造调用被 Broker 拒绝。

## 7. Native Solver

无 Delegate：

```text
probe unavailable
start throws
```

有 Delegate：

```text
真实 Delegate 调用
→ Solver Event
→ Result
```

## 8. Live Swarm

两个 Solver 并发运行。

Solver A 重复动作：

```text
PreActionGuard 阻断
→ Guidance
```

Solver B 产生正式 Evidence：

```text
TaskState Evidence ID
→ Knowledge View
→ Solver A Guidance
```

## 9. 跨 Task 隔离

Task A 的 Solver 不得收到 Task B 的 Evidence。

## 10. Candidate

格式类似 Flag：

```text
syntax_match
→ 其他 Solver继续
```

本地 Fixture Hash 正确：

```text
locally_validated
→ Policy 允许取消
```

## 11. Trajectory State Rebuild

```text
记录完整 Task
→ Replay Reducer
→ Final State Hash 一致
```

## 12. Mock Execution Replay

同一历史 Tool Result：

```text
旧 Parser/Reasoning 输出
vs
当前 Parser/Reasoning 输出
```

输出差异报告。

---

# 四十二、静态禁止检查

执行：

```bash
rg -n "new StructuredModelGateway\\(" src
```

确认使用具名依赖对象。

```bash
rg -n "high-tier-model|m3-low-cost-tier|m3-mini" src
```

生产代码不得自动注册占位模型。

```bash
rg -n "Array\\.from\\(this\\.providers\\.values\\(\\)\\)\\[0\\]" src
```

必须无匹配。

```bash
rg -n "recordSuccess" src/core/modelReliability/structuredModelGateway.ts
```

不得在返回原始 Stream 前调用。

```bash
rg -n "new OpenAICompatibleProvider" src
rg -n "chat\\.completions\\.create|responses\\.create" src
```

只能命中正式 Provider Adapter。

```bash
rg -n "profile\\.id as any|as ModelRole" src
```

必须无匹配。

```bash
rg -n "isToolVisible" src/core/engine.ts src/core/toolBroker.ts
```

Engine/Broker 应使用统一 Exposure Resolver。

```bash
rg -n "new SolverPortfolio\\(\\)" src
rg -n "registerDefaultAdapters" src
```

必须无匹配。

```bash
rg -n "Simulate native|mock solver|synthetic.*completed" src/core/solverPortfolio
```

生产代码必须无匹配。

```bash
rg -n "private messages:.*Solver" src/core/solverPortfolio
```

不得有第二 Evidence 消息真相源。

```bash
rg -n "evidenceIds:\\s*\\[\\].*summary|observationIds:\\s*\\[\\].*summary" src/core/solverPortfolio
```

不得广播无来源可靠信息。

```bash
rg -n "stateRevision.*1" src/core/modelReliability src/core/trajectory src/core/contextCompiler
```

不得固定 Revision。

```bash
rg -n "path:\\s*id" src/core/contextCompiler
```

Artifact 不得用 ID 冒充路径。

```bash
rg -n "ModelGatewayV2|SolverPortfolioV2|ChallengeSwarmV2|TrajectoryV2" src
```

必须无匹配。

---

# 四十三、验证命令

执行：

```bash
pnpm typecheck
pnpm build
pnpm lint
pnpm test
```

必须执行无网络 Smoke Test。

## Smoke 1：Provider 精确绑定

```text
两个 Fake Provider
→ 指定 Model Profile
→ 只调用对应 Provider
```

## Smoke 2：Stream 生命周期

```text
Provider 输出 2 Chunks
→ 正常 EOF
→ 成功
```

以及：

```text
Provider 输出 2 Chunks
→ 中途失败
→ 不成功
```

## Smoke 3：M3 Tool Exposure

```text
M3 Scout
→ 只看到相关有限 Tool
→ 伪造隐藏 Tool
→ Broker 拒绝
```

## Smoke 4：Native Solver

```text
真实 Runtime Delegate
→ Workflow
→ Evidence
→ Solver Result
```

## Smoke 5：在线 Swarm

```text
Solver A 重复路线
→ PreActionGuard
→ Guidance
```

```text
Solver B 新 Evidence
→ Grounded Knowledge
→ Solver A 收到
```

## Smoke 6：Flag

```text
syntax_match
→ 不取消
```

```text
locally_validated
→ 根据 Policy 取消
```

## Smoke 7：Replay

```text
完整 Task Trajectory
→ validate-only
→ state-rebuild
→ mock-execution
```

不得连接公网。

不得依赖真实 API Key。

不得使用真实比赛平台。

---

# 四十四、真实性验收标准

只有以下全部满足才能结束。

## Model

* Gateway 构造依赖不再错位。
* Model Profile 来自 Registry。
* Provider 按 Profile 精确选择。
* 无占位模型自动启用。
* Provider 缺失不能路由成功。
* Engine 无模型调用旁路。
* Compact/Critic/Summarizer 全部经过 Gateway。
* Stream 正常 EOF 后才成功。
* Mid-stream Failure 不记成功。
* Role Denied 不记 Schema Failure。

## Tool

* 完整 ModelExecutionIdentity 生效。
* Tool Definitions 使用 Exposure Resolver。
* Tool Execution 使用相同 Resolver。
* Orchestrator Fail-closed。
* M3 工具数量受限。
* 隐藏 MCP Tool 不可见且不可伪造调用。

## Context

* Projection 使用真实 ArtifactStore。
* Projection 使用真实 Tool Registry。
* Evidence 分类考虑 Polarity 和 Provenance。
* Artifact 路径、SHA、MIME 真实。
* Snapshot 使用 Canonical SHA-256。
* 相同数量不同内容能产生不同 Hash。
* Compiler 真正进入 Main、Compact、Retry、Specialist。

## Solver

* SolverPortfolio 强制依赖注入。
* 无默认 Adapter。
* Native 无 Delegate unavailable。
* 无 Synthetic Success。
* SolverEvent 可在线消费。
* ChallengeSwarm 在线观察而不是只等待终态。
* Pre-action Guard 真正阻断重复路线。
* Stagnation 使用实时数据。

## Knowledge

* TaskState 是唯一事实源。
* Knowledge View 不保存 Evidence 副本。
* 跨 Solver 消息具有正式 ID。
* 不跨 Task。
* Cursor 使用真实 Revision。
* 无来源自然语言不成为 Evidence。

## Flag

* Solver 只产生 Candidate。
* Discriminator 使用完整来源。
* syntax_match 不取消 Solver。
* locally_validated 根据 Policy 处理。
* accepted 只来自真实 Platform Adapter。

## Trajectory

* Event Schema 版本化。
* Payload 写入前验证。
* Buffer 和 Queue 有界。
* State Revision 真实。
* Validator 检查一致性和真实性。
* Replay 真正重建 TaskState。
* Mock Replay 重新运行 Parser 和 Reasoning。
* 模拟成功能被 Validator 检出。

## 工程

* 不存在生产 Mock。
* 不存在第二 Evidence 真相源。
* 不存在 V2。
* 不新增大量 any。
* 不使用 eval。
* Typecheck 通过。
* Build 通过。
* Lint 通过。
* Tests 通过。
* Smoke Tests 通过。
* 文档与真实代码一致。

---

# 四十五、最终报告格式

## 1. 修改前生产不真实性

逐项列出真实代码位置：

* Gateway 构造错位
* Provider ID 不一致
* 占位模型
* Stream 提前成功
* Engine 临时 Provider
* Compact 旁路
* Tool Exposure 未接入
* SolverPortfolio 空构造
* Native 模拟成功
* 无来源 Knowledge
* Context 空工具/伪 Artifact
* Trajectory 伪 Replay

## 2. 删除的模拟和旁路

列出删除文件、函数和兼容分支。

## 3. 最终 Model 调用链

```text
ModelExecutionIdentity
→ ModelRouter
→ Registry Profile
→ Provider Binding
→ Circuit
→ Monitored Stream
→ Engine
→ Health / Trajectory
```

## 4. 最终 Tool 调用链

```text
Tool Registry
→ Exposure Resolver
→ Model Definitions
→ Tool Call
→ Exposure Recheck
→ ToolBroker
```

## 5. 最终 Solver 调用链

```text
Portfolio
→ Adapter
→ Solver Event Stream
→ Swarm Observer
→ Guidance / Guard
→ Result
→ TaskState
```

## 6. 最终 Knowledge 共享

```text
TaskState Revision
→ Knowledge View
→ Grounded Message
→ Guidance Compiler
→ Solver
```

## 7. 最终 Trajectory

说明：

* Schema
* Revision
* Validation
* Replay
* State Hash
* Mock Execution

## 8. 测试结果

列出真实命令和测试数量。

## 9. 静态禁止检查

逐条列出命令结果。

## 10. 尚未解决问题

只列不影响 Phase 3.3 真实性收口的问题。

不要列：

* CTFd
* BUUCTF
* 多题控制面
* 更多 Solver
* 更多模型
* 更多 Workflow

这些属于后续阶段。

---

# 四十六、严格执行顺序

```text
1. 基线和真实性审计
2. Gateway 构造修复
3. Registry / Provider 精确绑定
4. 删除占位模型
5. 配置启动校验
6. Monitored Stream 接入
7. 错误分类
8. 删除 Engine 模型旁路
9. Compact/Critic/Summarizer 接入
10. ModelExecutionIdentity
11. ToolExposureResolver
12. Orchestrator Fail-closed
13. SolverPortfolio 依赖注入
14. Native Solver 去模拟
15. 删除 Synthetic Solver Result
16. SolverEvent Channel
17. Swarm 在线事件消费
18. Pre-action Guard
19. 实时 Stagnation
20. CrossSolver Knowledge View
21. Cursor Revision
22. Context Artifact/Tool 投影
23. Canonical Snapshot
24. Generic Process 强化
25. Flag Discriminator Context
26. Trajectory 强类型 Schema
27. 有界 Recorder
28. Trajectory Validator
29. State Replay
30. Mock Execution Replay
31. Production Truthfulness Guard
32. 端到端测试
33. 静态禁止检查
34. Smoke Test
35. 文档和最终报告
```

不要先实现 CompetitionControlPlane。

不要先接入真实外部 CLI。

不要继续增加新架构。

不要把“测试通过”当作“真实执行”。

本轮最终目标是：

> 仓库中不再存在任何能够在未调用真实模型、未执行真实 Solver、未产生真实 Evidence 的情况下返回成功的生产路径；每个成功状态都必须能从可验证轨迹中追溯到真实输入、真实执行、真实输出和正式 TaskState 产物。
