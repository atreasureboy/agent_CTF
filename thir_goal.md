# Agent_CTF Phase 3.2：真实模型身份、在线 Solver 协调与可验证轨迹

你正在当前最新的 `agent_CTF` 仓库中工作。

当前项目已经实现：

* CTFTaskRuntime
* CTFTaskOrchestrator
* ModelCapabilityRegistry
* ModelRouter
* ModelHealthStore
* ModelCircuitBreaker
* StructuredModelGateway
* OpenAI-compatible Provider
* ToolVisibilityPolicy
* ContextCompiler
* SolverPortfolio
* NativeSolverAdapter
* GenericProcessSolverAdapter
* ChallengeSwarm
* CrossSolverEvidenceBus
* StagnationDetector
* FlagDiscriminator
* TrajectoryRecorder

但是 Phase 3.1 仍存在明显的生产语义问题：

1. ModelGateway 没有使用 Registry 中的真实 Model Profile。
2. ModelGateway 使用第一个 Provider，而不是模型声明的 Provider。
3. 流式请求在 Stream 尚未消费完成前就可能被记为成功。
4. Role Policy 拒绝被错误记成 Schema Failure。
5. Trajectory 中部分 State Revision 固定为 1。
6. 业务代码仍可能临时创建 Provider 和合成 Model Profile。
7. Tool Visibility 没有统一使用完整 ModelExecutionIdentity。
8. SolverPortfolio 仍自动注册 Mock Solver。
9. Native Solver 没有 Delegate 时仍报告 ready。
10. Swarm 只有 Solver 完成后才看到结果，无法在线干预。
11. Cross Solver 消息缺少真实 Evidence ID。
12. EvidenceBus 仍是一套独立消息真相源。
13. Stagnation 不能观察运行中的 Solver。
14. Context Snapshot Hash 不代表真实状态内容。
15. Trajectory 只是日志，不具备质量验证和 Replay 能力。

本轮唯一目标是：

> 删除剩余演示语义，建立真实、可验证的 Model Identity 与 Provider 路由；让 ChallengeSwarm 能在 Solver 运行过程中接收结构化事件、共享有来源的 Evidence、检测停滞并发送指导；同时将轨迹升级为可以验证、回放和进行 A/B 评测的工程数据。

必须直接修改代码。

不要只写设计方案。

不要只补测试。

不要创建 V2。

---

# 一、参考项目要求

本轮必须再次读取并参考以下项目：

```text
yhy0/CHYing-agent
verialabs/ctf-agent
aliasrobotics/CAI
aielte-research/HackSynth
amazon-science/Cyber-Zero
amazon-science/CTF-Dojo
amazon-science/Cyber-Zero/enigma-plus
```

重点参考：

## CHYing-agent

* MCP Visibility
* PromptCompiler
* ProgressCompiler
* RetryHandoffCompiler
* ABANDON
* PreToolUse 阻断
* 弱模型与强模型速度差异

注意：

* MCP Visibility 有实战日志支持。
* PromptCompiler 有整体 Benchmark 数据，但不是严格独立变量实验。
* ProgressCompiler 和 RetryHandoffCompiler 没有单独 A/B 证明。
* 因此这些机制必须在本项目中通过 A/B 验证，不能直接宣称有效。

## Veria CTF Agent

* 多模型并行竞速
* Solver Trace 实时读取
* Coordinator Guidance
* Cross-solver Insight
* Operator Messaging
* Solver Sandbox
* Flag 出现后的取消策略

不要只模仿“多 Solver”。

真正需要借鉴的是：

```text
运行中观察
→ 在线指导
→ Evidence 共享
→ 动态升级
→ 验证后取消
```

## CAI

* Handoff as Tool
* Solver 与 Flag Discriminator 职责隔离
* Trace
* 不同模型承担不同角色

## HackSynth

* Planner 与 Summarizer 分离
* Summarizer 不负责决策
* 反馈压缩后再进入下一轮

## Cyber-Zero / EnIGMA+

* 轨迹 Schema
* Command Format Validation
* Action Consistency
* Output Parsing
* Trajectory Completeness
* Solution Accuracy
* Realism
* 可重复 Benchmark

只做 Clean-room 行为级借鉴。

禁止复制外部项目具体代码、Prompt 全文和受许可证约束的实现。

---

# 二、M3 的执行权限

本任务由 Codex 或当前主编码模型负责核心实现。

M3 只允许处理：

* 文件搜索
* 静态命中整理
* Fixture
* 小型纯函数
* 明确接口下的 Parser
* 单元测试
* 文档
* 重复代码整理

M3 不得负责：

* Model Identity
* Provider 路由
* Stream 生命周期
* Tool 权限
* Solver 状态所有权
* Swarm 并发
* Flag 验证边界
* Evidence 真相源
* Trajectory Schema
* 状态机修改
* 删除兼容路径
* 宣布任务完成

每个 M3 修改必须经过：

```text
类型检查
→ 定向测试
→ 主模型审查 Diff
→ 集成测试
```

---

# 三、本轮严格范围

本轮必须完成：

1. ModelRegistry、ModelProfile 和 Provider 的真实绑定。
2. 删除 Gateway 内临时 Model Profile。
3. 删除“第一个 Provider”选择逻辑。
4. 建立正确的 Streaming 生命周期和 Health 记录。
5. 区分 Policy、Routing、Schema、Tool Argument 和 Provider Failure。
6. 删除所有临时 Provider 创建和模型调用旁路。
7. 建立显式 ModelRole 映射。
8. 删除根据模型名称字符串判断 M3/mini/small 的逻辑。
9. Tool Definitions 与 Tool Execution 使用同一 Exposure Resolver。
10. Context Snapshot 使用真实 State Revision 和规范化哈希。
11. Context Compiler 真正接入 Main、Compact、Retry 和 Specialist。
12. SolverPortfolio 改为显式依赖注入。
13. 删除默认 Mock Solver。
14. Native Solver 无 Delegate 时报告 unavailable。
15. SolverRunHandle 支持在线事件流。
16. ChallengeSwarm 在线观察 Solver，而不是只等待最终结果。
17. 建立真实 Observer/Coordinator Guidance。
18. Cross Solver 共享必须引用 TaskState 中的 ID。
19. 删除独立 Evidence 消息真相源。
20. 建立运行时 ABANDON / Stagnation Pre-action Guard。
21. Flag Discriminator 使用完整来源和 Challenge Context。
22. Trajectory 升级为有界、版本化、可验证、可回放。
23. 建立 Phase 3 实际 A/B Benchmark。
24. 增加真实端到端测试。

本轮禁止：

* 不实现 CTFd。
* 不实现 BUUCTF。
* 不连接真实比赛平台。
* 不实现真实 Flag Submit。
* 不增加 Solver 类型。
* 不增加 OneShot Manifest。
* 不迁移新的题型 Workflow。
* 不训练模型。
* 不实现 RL。
* 不引入数据库。
* 不引入消息队列。
* 不创建 ModelGatewayV2。
* 不创建 SolverPortfolioV2。
* 不创建 EvidenceBusV2。
* 不保留 Mock Solver 作为生产默认项。

---

# 四、开始前真实审计

执行：

```bash
git status --short
git branch --show-current
git log -15 --oneline
git diff --stat
git diff

pnpm typecheck
pnpm build
pnpm lint
pnpm test
```

以真实 `package.json` 为准。

搜索：

```bash
rg -n "Array\\.from\\(this\\.providers\\.values\\(\\)\\)\\[0\\]" src
rg -n "contextWindow:\\s*128000|reliability:.*0\\.8|model:\\s*activeModelId" src/core/modelReliability
rg -n "providers\\.size\\s*>\\s*0.*hasProvider.*true" src
rg -n "recordFailure.*schema.*roleCheck" src
rg -n "trajectoryRecorder.*record|stateRevision.*1" src/core/modelReliability

rg -n "new OpenAICompatibleProvider" src
rg -n "chat\\.completions\\.create|responses\\.create" src
rg -n "profile\\.id as any|as ModelRole|role:.*profile\\.id" src
rg -n "includes\\(['\"]m3|includes\\(['\"]mini|includes\\(['\"]small" src/core/modelReliability

rg -n "registerDefaultAdapters|Generic mock solver output" src
rg -n "new NativeSolverAdapter\\(\\)" src
rg -n "status:\\s*['\"]ready['\"]" src/core/solverPortfolio/nativeSolverAdapter.ts

rg -n "CrossSolverEvidenceBus|messages:\\s*SolverEvidenceMessage" src
rg -n "evidenceIds:\\s*\\[\\]|observationIds:\\s*\\[\\]|artifactIds:\\s*\\[\\]" src/core/solverPortfolio/challengeSwarm.ts

rg -n "state\\.updatedAt\\s*\\|\\|\\s*1|hash_.*snapshotContent\\.length" src/core/contextCompiler
rg -n "this\\.events\\.push|stateRevision.*1" src/core/trajectory
```

生成：

```text
docs/architecture/phase-3.2-runtime-truthfulness-audit.md
```

必须记录：

* 实际模型路由调用链；
* Model Profile 来源；
* Provider 选择方式；
* Stream 成功记录时机；
* 所有模型调用旁路；
* Tool Exposure 调用位置；
* Context Compiler 实际调用位置；
* Solver Adapter 注册来源；
* Swarm 在线事件能力；
* Evidence 共享来源；
* Trajectory 内存和磁盘语义；
* 外部参考机制与当前差距。

完成审计后继续实现。

---

# 五、Model Profile 必须来自 Registry

`StructuredModelGateway` 必须显式依赖：

```ts
export interface ModelProfileResolver {
  getRequired(modelId: string): ModelCapabilityProfile
}
```

路由后：

```ts
const modelProfile =
  this.modelRegistry.getRequired(activeModelId)
```

禁止 Gateway 自行构造：

```ts
{
  id: activeModelId,
  provider: provider.id,
  model: activeModelId,
  contextWindow: 128000,
  capabilities: {...},
  reliability: {...}
}
```

必须使用 Registry 中真实：

* provider
* providerModelName
* contextWindow
* capabilities
* allowedRoles
* reliability
* economics
* limits
* fallback IDs
* temperature defaults
* max token defaults

## Model ID 与 Provider Model Name

区分：

```ts
interface ModelCapabilityProfile {
  id: string
  providerId: string
  providerModelName: string
}
```

例如：

```text
内部 ID：m3-scout
Provider ID：minimax-openai-compatible
Provider Model Name：MiniMax-M3
```

禁止假设三者相同。

---

# 六、Provider 必须按 Profile 选择

改成：

```ts
const provider =
  this.providers.get(modelProfile.providerId)
```

找不到时：

```ts
throw new MissingModelProviderError(
  modelProfile.id,
  modelProfile.providerId
)
```

删除：

```ts
Array.from(this.providers.values())[0]
```

删除：

```ts
providers.size > 0
  ? providers.has(id)
  : true
```

Provider 为空时 Router 必须知道：

```text
hasProvider = false
```

## Provider 注册校验

Runtime 创建时检查：

* 每个启用 Model Profile 的 Provider 存在；
* Provider ID 唯一；
* Provider Model Name 非空；
* Fallback Model 具有可用 Provider；
* 不允许 Registry 默认 Profile 指向不存在的 Provider。

无法满足时：

* Runtime 创建失败；
* 或该 Model 标记 unavailable；
* 不允许延迟到第一次调用才随机失败。

---

# 七、删除占位内置模型

审计：

```text
high-tier-model
m3-low-cost-tier
gpt-4o
m3-mini
```

生产 Runtime 不得自动把这些占位 Profile 当成真实可用模型。

采用配置驱动：

```ts
interface RuntimeModelConfiguration {
  providers: ProviderConfiguration[]
  models: ModelCapabilityProfile[]
  routingPolicies: ModelRoutingPolicy[]
}
```

可以提供：

```text
examples/model-config.example.json
```

但生产必须由 Operator、CLI 或测试显式配置。

无模型配置时：

* workflow-only Runtime 可以启动；
* LLM Runtime 明确失败；
* 不创建伪模型。

---

# 八、显式 ModelRole 映射

禁止：

```ts
role: profile.id as any
```

建立：

```ts
export interface ModelRoleResolverInput {
  capabilityProfileId: string
  agentKind:
    | 'orchestrator'
    | 'main-agent'
    | 'specialist'
    | 'solver'
    | 'summarizer'
    | 'flag-discriminator'

  workflowId?: string
  specialistId?: string
}

export interface ModelRoleResolver {
  resolve(input: ModelRoleResolverInput): ModelRole
}
```

推荐映射：

```text
orchestrator → task_planner
main-agent → deep_solver
cheap/scout solver → solver_scout
progress compiler → progress_summarizer
specialist → specialist
flag validator → flag_discriminator
```

Model Role 由 Runtime 决定。

模型不能自行声明 Role。

---

# 九、删除模型名字符串启发式

禁止：

```ts
modelId.includes('m3')
modelId.includes('mini')
modelId.includes('small')
```

ModelRolePolicy 应读取：

```ts
modelProfile.reliabilityClass
modelProfile.allowedRoles
modelProfile.trustLevel
modelProfile.limits
```

增加：

```ts
export type ModelTrustLevel =
  | 'auxiliary'
  | 'standard'
  | 'privileged'
```

例如：

```text
M3 配置为 auxiliary
Codex 配置为 privileged
```

业务代码只读取 TrustLevel，不读取品牌名称。

---

# 十、Streaming 生命周期必须覆盖完整消费

当前不能在：

```ts
const stream = await provider.streamAgentTurn(...)
health.recordSuccess(...)
return stream
```

中提前记录成功。

建立包装器：

```ts
class MonitoredAgentTurnStream
  implements AsyncIterable<ChatCompletionChunk>
```

语义：

```text
Provider 建立连接
→ stream_started
→ 首 Chunk
→ 多个 Chunk
→ 正常 EOF
→ success
```

错误：

```text
连接失败 → provider_failure
首 Chunk 超时 → first_token_timeout
中途异常 → stream_interrupted
零 Chunk 正常结束 → empty_response
无有效 Assistant Content → empty_response
非法 Tool Argument → tool_argument_failure
Abort → cancelled
```

只有完整消费并正常结束后：

```ts
healthStore.recordSuccess(...)
circuitBreaker.recordProbeSuccess(...)
```

## Consumer 提前停止

若 Engine 主动停止读取 Stream：

* 调用 `return()`；
* 释放 Provider 连接；
* 状态记录为 `consumer_cancelled`；
* 不记录模型成功；
* 不记录 Provider Failure。

## Fallback

只有在 Stream 尚未向 Engine暴露任何有效 Chunk时允许自动 Fallback。

若已输出部分内容后失败：

* 不允许无提示切换另一个模型继续同一 Stream；
* 返回明确 partial failure；
* 由 Engine 决定重试新 Turn。

---

# 十一、错误分类

建立统一：

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
```

Role Policy 拒绝：

```text
role_denied
```

不得记录成：

```text
schema_failure
```

Policy 和 Routing 拒绝默认不降低模型内容质量 Health。

Provider Failure、Schema Failure、Tool Argument Failure 分别计数。

---

# 十二、统一所有模型调用

执行：

```bash
rg -n "new OpenAICompatibleProvider|chat\\.completions\\.create|responses\\.create" src
```

检查：

* Main Agent
* Compact
* Critic
* Reflection
* Context Compiler
* Progress Compiler
* Retry Handoff
* Flag Discriminator
* Coordinator Guidance
* Summarizer

所有生产模型调用必须经过统一 Gateway。

禁止在 `maybeCompact()` 中临时创建 Provider 或 Model Profile。

## Compact

使用：

```text
role = progress_summarizer
```

## Critic / Reflection

使用明确 Role。

不得借用当前 Agent Profile ID。

## Dry Run / Test

Fake Provider 只能由测试显式注入。

---

# 十三、State Revision 必须来自 StateStore

给 TaskStateStore 增加或使用已有：

```ts
getRevision(): number
```

每次成功 apply Event 后递增。

Trajectory、Context Compiler、Evidence View 必须读取同一个 Revision。

删除固定：

```ts
stateRevision = 1
```

Gateway 的 Trajectory 记录应调用 Revision Provider：

```ts
trajectoryRecorder.record(
  taskId,
  eventType,
  payload,
  stateStore.getRevision(),
)
```

Gateway 不应自己猜 Revision。

可以由 Runtime 注入：

```ts
getTaskStateRevision(taskId): number
```

---

# 十四、ToolExposureResolver 作为唯一入口

建立或统一：

```ts
export interface ToolExposureResolver {
  resolveDefinitions(input: {
    identity: ModelExecutionIdentity
    modelProfile: ModelCapabilityProfile
    capabilityProfile: CapabilityProfile
    taskState: Readonly<CTFTaskState>
    allTools: ToolDescriptor[]
  }): ToolDescriptor[]

  assertExecutable(input: {
    identity: ModelExecutionIdentity
    tool: ToolDescriptor
    taskState: Readonly<CTFTaskState>
  }): void
}
```

## Tool Definitions

Engine 在调用模型前：

```ts
const visibleTools =
  exposureResolver.resolveDefinitions(...)
```

不得逐项调用弱化版 `isToolVisible(profile.id)`。

必须使用完整：

* ModelRole
* Model ID
* TrustLevel
* Solver ID
* Specialist ID
* Profile ID
* Active Hypothesis
* Pending Action
* Availability
* Cost
* maxVisibleTools

## Tool Execution

ToolBroker 在执行前调用同一个：

```ts
assertExecutable(...)
```

防止模型伪造隐藏 Tool。

## 排序与上限

先计算相关性：

```text
Role
→ Profile
→ 当前 Hypothesis
→ Pending Action
→ Category
→ Availability
→ Cost
→ Tool ID
```

然后应用 `maxVisibleTools`。

不能对 Registry 原始顺序直接 `slice()`。

---

# 十五、遵循 CHYing 的工具隔离原则

Orchestrator 默认只看高层工具：

```text
run_workflow
run_one_shot
request_handoff
inspect_task_state
inspect_solver
send_solver_guidance
validate_candidate
pause_solver
```

Browser Specialist 才能看到浏览器 MCP 细粒度工具。

Reverse Specialist 才能看到 Ghidra MCP。

主 Agent 不应同时看到几十个细粒度 MCP Tool。

必须测试：

* Orchestrator 看不到 Browser MCP。
* M3 Scout 看不到高风险底层 Tool。
* Specialist 可以看到所需 Tool。
* 伪造 Tool Call 被拒绝。
* 配置缺失时 Fail-closed，不是暴露全部工具。

---

# 十六、Context Snapshot 使用规范化哈希

删除：

```ts
state.updatedAt || 1
hash_${revision}_${stringLength}
```

建立：

```ts
interface ContextSnapshotSource {
  taskId: string
  stateRevision: number

  evidence: Array<{
    id: string
    confidence: number
    polarity: string
    sourceIds: string[]
  }>

  hypotheses: Array<{
    id: string
    status: string
    confidence: number
  }>

  attempts: Array<{
    id: string
    status: string
    fingerprint: string
  }>

  artifacts: Array<{
    id: string
    sha256?: string
    size?: number
  }>

  pendingActions: Array<{
    id: string
    status: string
  }>

  toolExposureHash: string
  compilerVersion: string
}
```

流程：

```text
稳定排序
→ Canonical JSON
→ SHA-256
```

Snapshot Hash 必须随着：

* Evidence 内容；
* Hypothesis Status；
* Attempt；
* Artifact SHA；
* Pending Action；
* Tool Visibility；

变化。

不能只看数组数量。

---

# 十七、Context Compiler 真实接入

必须验证并接入：

## Main Agent 首轮

```text
ChallengePromptCompiler
```

## M3 Scout 每次启动

```text
SolverBriefCompiler
```

## Context Compact

```text
ProgressCompiler
```

## 暂停后恢复

```text
RetryHandoffCompiler
```

## Specialist

```text
SpecialistContextCompiler
```

不能只提供 Utility。

## Planner 与 Summarizer 分离

参考 HackSynth 和 CHYing：

* Solver 不总结自己。
* Summarizer 不选择下一 Action。
* Summarizer 只压缩已有事实。
* StrategyPlanner 根据结构化 State 决策。

## 简单题优化

由于 CHYing 的 PromptCompiler 会增加额外延迟，而 Progress/Retry 尚无单独 A/B 数据，因此增加：

```ts
type ContextCompilationMode =
  | 'deterministic'
  | 'model_rendered'
```

默认规则：

```text
简单题 / 状态短 → deterministic
复杂题 / 状态长 → model_rendered
```

最终是否有效由 Benchmark 决定。

---

# 十八、SolverPortfolio 显式依赖注入

删除：

```ts
constructor() {
  this.evidenceBus = new CrossSolverEvidenceBus()
  this.registerDefaultAdapters()
}
```

改为：

```ts
export interface SolverPortfolioDependencies {
  stateStore: CTFTaskStateStore
  contextCompiler: ContextCompilerService
  resultNormalizer: SolverResultNormalizer
  trajectoryRecorder: TrajectoryRecorder

  adapters: ExternalSolverAdapter[]
}

export class SolverPortfolio {
  constructor(
    private readonly deps:
      SolverPortfolioDependencies
  ) {}
}
```

禁止自动注册任何 Adapter。

生产 Runtime 显式提供 Adapter。

测试显式提供 Fake Adapter。

---

# 十九、删除 Mock Solver

生产代码必须删除：

```text
Generic mock solver output
node -e console.log(...)
```

Native Solver 无 Delegate 时：

```ts
probe(): {
  status: 'unavailable'
  reason: 'NativeSolverRuntimeDelegate not configured'
}
```

禁止永远返回 ready。

`start()` 无 Delegate：

```ts
throw new SolverUnavailableError(...)
```

不能返回空成功 Observation。

---

# 二十、SolverRunHandle 支持在线事件

参考 Veria 的实时 Coordinator Guidance。

升级：

```ts
export type SolverEvent =
  | {
      type: 'status'
      status: SolverRunStatus
      timestamp: number
    }
  | {
      type: 'tool_call_started'
      toolId: string
      attemptFingerprint: string
      timestamp: number
    }
  | {
      type: 'tool_call_completed'
      toolId: string
      attemptId: string
      observationIds: string[]
      evidenceIds: string[]
      artifactIds: string[]
      timestamp: number
    }
  | {
      type: 'hypothesis_updated'
      hypothesisIds: string[]
      timestamp: number
    }
  | {
      type: 'candidate_detected'
      candidateId: string
      timestamp: number
    }
  | {
      type: 'progress'
      summary: string
      sourceIds: string[]
      timestamp: number
    }
  | {
      type: 'warning'
      code: string
      message: string
      timestamp: number
    }
```

SolverRunHandle 增加：

```ts
events(): AsyncIterable<SolverEvent>
```

或者等价的受控 Subscription。

要求：

* 有 Backpressure。
* 有最大 Buffer。
* Slow Consumer 不拖死 Solver。
* 事件最终对应 TaskState ID。
* 自然语言 Summary 不能替代 Evidence ID。
* Dispose 后 Stream 正常关闭。

---

# 二十一、Generic Process Solver 在线协议

JSONL 输出增加：

```json
{"type":"tool_call_started", ...}
{"type":"tool_call_completed", ...}
{"type":"evidence", "evidenceIds":["..."]}
{"type":"progress", "sourceIds":["..."]}
{"type":"candidate", "candidateId":"..."}
```

外部 Solver 不能凭空指定 TaskState Evidence ID。

外部 Observation/Evidence Draft 必须先经过 Normalizer 和 Projector，得到正式 ID 后再广播。

非 JSON 输出只能进入 Log Artifact。

---

# 二十二、ChallengeSwarm 在线协调

当前不能只：

```text
handle.wait()
→ Solver 完成
→ 才检查结果
```

建立在线循环：

```text
启动 Solver
→ 消费 SolverEvent
→ 更新 TaskState
→ Observer 分析真实进展
→ 必要时 Guidance
→ Stagnation / ABANDON
→ Candidate Validation
→ Solver完成
```

每个 Solver 同时有：

* Final Result Promise；
* Event Stream；
* AbortController；
* Guidance Channel。

## Coordinator

建立轻量：

```ts
interface SolverObserver {
  observe(input: {
    solverRun: SolverRunRecord
    recentEvents: SolverEvent[]
    taskState: Readonly<CTFTaskState>
  }): ObserverDecision
}
```

Observer 第一阶段使用确定性规则。

不要先引入额外 Coordinator LLM。

允许输出：

```ts
type ObserverDecision =
  | { type: 'none' }
  | { type: 'send_guidance'; guidance: SolverGuidance }
  | { type: 'pause'; reason: string }
  | { type: 'switch_model'; targetSolverId: string; reason: string }
  | { type: 'spawn_branch'; objective: string; hypothesisIds: string[] }
```

---

# 二十三、在线 ABANDON

参考 CHYing，但不要直接照搬固定阈值。

建立 Pre-action Guard：

```ts
export interface RepetitionGuard {
  inspect(input: {
    solverRunId: string
    action: SuggestedAction
    attemptFingerprint: string
    taskState: Readonly<CTFTaskState>
  }): RepetitionDecision
}
```

检测三层：

## 1. 失败模式

例如：

* Access Denied
* Connection Refused
* File not found
* Unsupported format
* Tool unavailable
* Invalid padding

必须来自结构化 Error Code 或 Observation。

不要只依赖自然语言关键词。

## 2. Action Fingerprint

使用现有 Attempt Fingerprint。

区分：

```text
同目标 + 同工具 + 同目的 + 等价参数
```

不要只因为相同 Host 就视为重复。

需要提取：

```text
Action Family
Resource Path
Operation Intent
Input Artifact
```

## 3. Vulnerability / Technique Family

例如：

```text
同一 CVE
同一 Encoding Branch
同一 Stego Channel
同一 Web Route
同一 Exploit Primitive
```

## Decision

```ts
type RepetitionDecision =
  | { allowed: true }
  | {
      allowed: false
      reason: string
      priorAttemptIds: string[]
      requiredDirectionChange: true
    }
```

阻断发生在 Tool 执行前。

不能在第五次失败后只写日志。

---

# 二十四、Stagnation 使用实时数据

StagnationSignalCollector 每个 Solver 单独计算：

* 最近新 Evidence 时间；
* 最近新 Artifact 时间；
* Hypothesis 状态变化；
* 重复 Attempt；
* 重复 Action Family；
* 连续 Tool Failure；
* Budget 消耗；
* Context Compact 次数；
* Guidance 次数；
* Candidate 进展。

不要只在 Solver 完成后计算。

建议：

```text
轻微停滞 → Guidance
继续停滞 → 强制换方向
严重停滞 → Pause / Upgrade / Branch
```

Guidance 必须由 Context Compiler 生成：

```text
确认事实
不要重复
当前卡点
下一步只做一个动作
```

---

# 二十五、Cross Solver 共享必须有来源

删除 Swarm 中：

```ts
{
  evidenceIds: [],
  observationIds: [],
  artifactIds: [],
  summary: obs.summary
}
```

跨 Solver 消息必须至少包含一个正式 ID：

```ts
export interface SolverKnowledgeMessage {
  id: string
  taskId: string
  sourceSolverRunId: string
  stateRevision: number

  evidenceIds: string[]
  observationIds: string[]
  artifactIds: string[]
  candidateIds: string[]

  priority: KnowledgePriority
  createdAt: number
}
```

自然语言 Guidance 由这些 ID 编译生成。

没有正式来源 ID 的信息：

* 可以保留为低信任 Solver Note；
* 不能进入 Cross Solver Evidence；
* 不能驱动取消其他 Solver。

---

# 二十六、删除 EvidenceBus 第二真相源

`CrossSolverEvidenceBus` 当前保存自己的 Messages。

改为：

```ts
class CrossSolverKnowledgeView {
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

消息根据 TaskState Event 和 Revision动态生成。

运行时 Cursor 可以保存：

```ts
lastSeenRevision
seenMessageIds
```

但：

* Cursor 不是 Evidence 真相源；
* 由 Runtime 实例拥有；
* 有容量上限；
* dispose 清理；
* 按 Task+Solver 隔离。

## Revision

查询必须真正使用：

```ts
afterRevision
```

不能只写入 Cursor 后忽略。

---

# 二十七、Flag Discriminator 职责隔离

参考 CAI：

```text
Solver
→ Candidate
→ Deterministic Validator
→ Flag Discriminator
→ Submission Controller
```

Flag Discriminator 输入必须包含：

```ts
interface FlagDiscriminationInput {
  taskId: string
  candidateId: string

  value: string
  challengePattern?: string

  sourceObservationIds: string[]
  sourceEvidenceIds: string[]
  sourceArtifactIds: string[]
  sourceAttemptIds: string[]

  transformChain: TransformStep[]

  localFixtureExpectedHash?: string
}
```

输出：

```ts
type FlagDiscriminationStatus =
  | 'rejected'
  | 'syntax_match'
  | 'provenance_valid'
  | 'locally_validated'
  | 'platform_accepted'
  | 'inconclusive'
```

禁止只传：

```ts
candidateValue
```

## 取消其他 Solver

真实比赛：

```text
platform_accepted
```

才允许取消。

本地 Fixture：

```text
locally_validated
+ CompletionPolicy 允许
```

普通格式匹配不允许取消。

---

# 二十八、Trajectory Schema 版本化

定义：

```ts
export interface TrajectoryEventEnvelope {
  schemaVersion: '1.0'

  eventId: string
  timestamp: number

  taskId: string
  stateRevision: number

  solverRunId?: string
  agentRunId?: string
  attemptId?: string

  eventType: TrajectoryEventType
  payload: unknown

  payloadHash: string
}
```

每个 Event Type 有 Zod Schema。

禁止：

```ts
payload: Record<string, any>
```

作为未验证的最终存储形式。

可以在边界接收 unknown，但写入前验证。

---

# 二十九、Trajectory 内存有界

当前 `events.push()` 会永久保留全部事件。

改为：

* 有界 Ring Buffer；
* 默认保留最近 N 条；
* 完整历史写 JSONL；
* 支持按偏移读取；
* 支持按 Task/Solver/Event Type 索引；
* 不将所有历史常驻内存。

配置：

```ts
interface TrajectoryRecorderLimits {
  maxBufferedEvents: number
  maxWriteQueueBytes: number
  maxPayloadBytes: number
}
```

超过写队列上限：

* Backpressure；
* 或写入降级；
* 不允许无限增长。

---

# 三十、Trajectory Quality Validator

参考 Cyber-Zero，建立：

```text
src/core/trajectory/trajectoryValidator.ts
```

验证：

## Command Format

* Tool ID 存在；
* 参数符合 Schema；
* 没有 shell 注入；
* 与记录的 Attempt 一致。

## Action Consistency

* StrategyDecision 选择的 Action 等于实际执行 Action；
* Attempt Fingerprint 匹配；
* Scope 和 Profile 允许。

## Output Parsing

* Tool Result 对应 Observation；
* Observation 对应 Evidence；
* Parser Warning 可追踪。

## Completeness

每个 Attempt 必须具有：

```text
started
→ completed / failed / cancelled
```

每个 SolverRun 必须 terminal。

## Accuracy

* Candidate 状态有 Validator 依据；
* accepted 只能来自 Platform；
* Evidence Claim 有来源。

## Realism

只做确定性异常检测：

* 未执行工具却出现 Tool Result；
* 时间顺序倒退；
* 产物创建早于 Attempt；
* 同一 Run 同时多次 terminal。

不要使用单个 LLM Judge 作为唯一 Validator。

---

# 三十一、Trajectory Replay

建立：

```ts
interface TrajectoryReplay {
  replay(input: {
    trajectoryPath: string
    mode:
      | 'validate-only'
      | 'state-rebuild'
      | 'mock-execution'
  }): Promise<ReplayResult>
}
```

## validate-only

检查 Schema 和一致性。

## state-rebuild

从 Event 重建 TaskState，比较最终 Hash。

## mock-execution

不运行真实 Tool，只将记录的结果输入 Parser/Reasoning，验证新版本是否产生相同：

* Evidence；
* Hypothesis；
* StrategyDecision；
* Candidate。

这对于后续优化 M3 非常重要。

---

# 三十二、ProgressCompiler 必须接受 A/B 验证

不要直接宣称 ProgressCompiler 有效。

建立配置：

```ts
progressCompilation:
  | 'disabled'
  | 'deterministic'
  | 'model-rendered'
```

Benchmark 比较：

```text
原始 Compact
vs
确定性 Progress Compiler
vs
模型渲染 Progress Compiler
```

指标：

* 恢复后重复 Attempt 数；
* 首个新 Evidence 时间；
* Token 消耗；
* 重复路线；
* 最终成功率。

RetryHandoff 同理。

---

# 三十三、Phase 3 A/B Benchmark

建立重复运行 Benchmark。

每个 Fixture 至少运行：

```text
3–5 次
```

不要只跑一次。

## A/B 1：Tool Visibility

```text
M3 + 全部 Profile Tool
vs
M3 + Identity-based Tool Exposure
```

指标：

* Tool Selection Accuracy；
* Hidden Tool Attempt；
* Tool Argument Failure；
* Tokens；
* Evidence Gain。

## A/B 2：Context Compiler

```text
Raw State
vs
Deterministic Solver Brief
vs
Model-rendered Solver Brief
```

## A/B 3：Progress Compiler

```text
Self Summary
vs
Independent Deterministic Summary
vs
Independent Model Summary
```

## A/B 4：Stop-loss

```text
无 ABANDON
vs
Attempt Fingerprint Guard
vs
Fingerprint + Observer Guidance
```

## A/B 5：Solver Strategy

```text
M3 单 Solver
vs
M3 Scout → Strong Upgrade
vs
M3 + Strong 并行
```

## A/B 6：Cross Solver Knowledge

```text
不共享
vs
自然语言摘要
vs
Grounded ID Guidance
```

不允许在没有数据时写“性能提升”。

---

# 三十四、核心评测指标

```ts
interface Phase32BenchmarkMetrics {
  solveRate: number
  medianTimeToSolveMs: number
  medianTimeToFirstEvidenceMs: number

  evidenceGainPerAction: number
  supportedClaimRate: number

  duplicateAttemptRate: number
  repeatedActionFamilyRate: number

  toolSelectionAccuracy: number
  toolArgumentFailureRate: number

  contextRecoverySuccessRate: number
  postCompactDuplicateRate: number

  invalidCandidateRate: number
  falseSolverCancellationRate: number

  guidanceAcceptanceRate: number
  guidanceEvidenceGainRate: number

  trajectoryValidationPassRate: number

  estimatedCostPerSolvedTask?: number
}
```

---

# 三十五、必须新增的测试

## Model Gateway

* 正确 Profile。
* 正确 Provider。
* Provider 不存在明确失败。
* 不使用第一个 Provider。
* 流正常 EOF 后才成功。
* Mid-stream Failure 被记录。
* Empty Stream 被记录。
* Abort 不记模型失败。
* Role Denied 不记 Schema Failure。
* Fallback 不跨 Provider 乱选。

## Tool Exposure

* Full Identity 参与。
* maxVisibleTools 生效。
* 与 Hypothesis 相关 Tool 优先。
* Definitions 和 Execution 一致。
* Orchestrator Fail-closed。
* 隐藏 MCP Tool 不可伪造调用。

## Context

* 同数量不同内容得到不同 Hash。
* Artifact SHA 变化导致 Hash 变化。
* Tool Exposure 变化导致 Hash 变化。
* State Revision 正确。
* 旧 Context 被识别为 stale。
* Compiler 真正用于模型调用。

## SolverPortfolio

* 无默认 Adapter。
* Native 无 Delegate unavailable。
* Process Adapter 由配置注册。
* Mock 只存在测试。

## Live Solver

* 运行中发出 Tool Event。
* Coordinator 在完成前发送 Guidance。
* Guidance 被 Solver 接收。
* Slow Event Consumer 不阻塞。
* Cancel 关闭 Event Stream。

## Swarm

* Solver 真并发。
* 运行中停滞可升级。
* Grounded Evidence 共享。
* 不同 Task 严格隔离。
* 假 Candidate 不取消。
* Local Validated 按 Policy 取消。
* Completed Solver 正确清理。

## ABANDON

* 相同 Fingerprint 被阻止。
* 同 Host 不同路径不误判。
* 不同目的同 Tool 不误判。
* 同一 CVE 反复失败被识别。
* Near-success 合理重试不被过早拦截。
* 阻断记录 prior Attempt。

## Trajectory

* Schema Validation。
* Ring Buffer 上限。
* JSONL 完整。
* State Revision 正确。
* Recursive Redaction。
* Replay 重建一致。
* 缺失 Terminal Event 被检测。
* Strategy 和实际 Action 不一致被检测。

---

# 三十六、静态禁止检查

完成后执行：

```bash
rg -n "Array\\.from\\(this\\.providers\\.values\\(\\)\\)\\[0\\]" src
rg -n "contextWindow:\\s*128000.*activeModelId" src/core/modelReliability
rg -n "providers\\.size.*\\?.*: true" src/core/modelReliability
rg -n "recordFailure.*schema.*role" src/core/modelReliability

rg -n "new OpenAICompatibleProvider" src
rg -n "chat\\.completions\\.create|responses\\.create" src
```

只允许正式 Provider Adapter 命中 SDK 调用。

```bash
rg -n "profile\\.id as any|role:.*profile\\.id" src
rg -n "includes\\(['\"]m3|includes\\(['\"]mini|includes\\(['\"]small" src/core/modelReliability
```

必须无匹配。

```bash
rg -n "registerDefaultAdapters|Generic mock solver output" src
rg -n "new NativeSolverAdapter\\(\\)" src/core/solverPortfolio
```

生产代码不得默认创建无 Delegate Adapter。

```bash
rg -n "evidenceIds:\\s*\\[\\]|observationIds:\\s*\\[\\].*summary" src/core/solverPortfolio/challengeSwarm.ts
```

不得广播无来源 Insight。

```bash
rg -n "state\\.updatedAt\\s*\\|\\|\\s*1|snapshotContent\\.length|hash_" src/core/contextCompiler
```

不得使用伪 Snapshot Hash。

```bash
rg -n "private messages:.*SolverEvidenceMessage" src/core/solverPortfolio
```

不得保留第二 Evidence 真相源。

```bash
rg -n "stateRevision.*1" src/core/modelReliability src/core/trajectory
```

不得固定 Revision。

```bash
rg -n "ModelGatewayV2|SolverPortfolioV2|EvidenceBusV2|TrajectoryV2" src
```

必须无匹配。

---

# 三十七、Smoke Test

不得连接公网。

不得依赖真实 API Key。

## Smoke 1：Provider 路由

```text
两个 Fake Provider
→ 两个 Model Profile
→ 指定模型
→ 只调用对应 Provider
```

## Smoke 2：Stream Failure

```text
Provider 输出两个 Chunk
→ 中途失败
→ 不记录成功
→ 返回 partial failure
```

## Smoke 3：Visibility

```text
M3 Scout
→ 只看到题型相关有限工具
→ 伪造隐藏 MCP Tool
→ Broker 拒绝
```

## Smoke 4：Context

```text
TaskState
→ Solver Brief
→ 改变 Evidence
→ 旧 Context stale
→ 重新编译
```

## Smoke 5：Live Swarm

```text
Solver A 运行中重复路线
→ Observer 检测
→ Guidance
→ Solver A 换方向
```

同时：

```text
Solver B 发现 Evidence
→ 正式 State ID
→ Solver A 收到 Grounded Guidance
```

## Smoke 6：Candidate

```text
格式类似 Flag
→ syntax_match
→ 不取消其他 Solver
```

再：

```text
Fixture Hash 验证成功
→ locally_validated
→ Policy 允许取消
```

## Smoke 7：Replay

```text
记录一次完整解题轨迹
→ validate-only
→ state-rebuild
→ mock-execution
```

最终状态 Hash 一致。

---

# 三十八、完成标准

只有全部满足才能结束。

## 模型真实性

* Gateway 使用真实 Registry Profile。
* Model Profile 决定 Provider。
* 无第一个 Provider逻辑。
* 无临时 Profile。
* 无占位模型自动启用。
* Role 显式解析。
* 无模型名字符串启发式。
* Stream 完整消费后才记录成功。
* Mid-stream Failure 可观测。
* Policy Failure 不污染 Schema Health。

## Tool Exposure

* 使用完整 Model Identity。
* Definition 和 Execution 使用同一 Resolver。
* Orchestrator Fail-closed。
* MCP Visibility 真实生效。
* M3 只能看到有限相关工具。

## Context

* 使用真实 State Revision。
* Snapshot 为规范化 SHA-256。
* Main、Compact、Retry、Specialist 全部真实使用 Compiler。
* Compiler 不成为事实真相源。
* Progress/Retry 通过 A/B 验证，而不是预设有效。

## Solver

* Portfolio 无默认 Mock。
* Native 无 Delegate unavailable。
* SolverRunHandle 有实时 Event。
* Swarm 在 Solver 运行中观察和指导。
* Stagnation 使用真实信号。
* ABANDON 在 Action 执行前阻止死路。

## 跨 Solver

* 共享内容必须有正式 State ID。
* Evidence 真相只在 TaskState。
* Cursor 使用真实 Revision。
* 不跨 Task。
* 不重复发送。
* Guidance 保留 Source ID。

## Flag

* Solver 只发现 Candidate。
* Discriminator 使用完整 Context。
* 格式匹配不等于验证。
* 未验证 Candidate 不取消 Solver。
* 平台 Accepted 边界保留。

## Trajectory

* Schema 版本化。
* Payload 验证。
* 内存有界。
* Revision 正确。
* 能 Replay。
* 能验证 Action Consistency。
* 能验证 Output Parsing。
* 能检测不完整/虚假轨迹。

## 评测

* 规定 A/B 测试完成。
* 每个 Fixture 重复运行。
* 报告方差或分布。
* 不使用测试数量代替效果。
* 不在无数据时宣称提升。

## 工程质量

* 不存在 V2。
* 不存在生产 Mock。
* 不存在第二 Evidence 真相源。
* 不增加大量 any。
* 不使用 eval。
* Typecheck 通过。
* Build 通过。
* Lint 通过。
* Tests 通过。
* Smoke Tests 通过。
* 文档与真实实现一致。

---

# 三十九、执行顺序

严格按照：

```text
1. 基线和外部项目复核
2. Model Profile Resolver
3. Provider 精确绑定
4. 删除占位模型
5. ModelRole Resolver
6. Streaming 生命周期
7. 错误分类
8. 删除模型调用旁路
9. State Revision Provider
10. ToolExposureResolver
11. MCP Visibility
12. Context Canonical Snapshot
13. Context Compiler 真实接入
14. SolverPortfolio 显式依赖
15. 删除 Mock Adapter
16. SolverEvent Stream
17. Generic Process Event Protocol
18. ChallengeSwarm 在线协调
19. ABANDON Pre-action Guard
20. 真实 Stagnation
21. Grounded Knowledge View
22. Flag Discriminator Context
23. Trajectory Schema
24. 有界 Recorder
25. Trajectory Validator
26. Replay
27. A/B Benchmark
28. 行为测试
29. 静态禁止检查
30. Smoke Test
31. 文档和最终报告
```

不要先实现 CTFd。

不要先增加更多 Solver。

不要让 M3 根据测试数量宣布成功。

不要把“可以实例化”视为“生产功能正常”。

本轮最终目标是：

> 每次模型调用都能明确回答“由哪个模型 Profile、哪个 Provider、哪个 Role 执行，什么时候真正成功”；每个 Solver 在运行中都能被观察、指导、停止或升级；跨 Solver 分享的每条信息都有 TaskState 来源；每条轨迹都能被验证和回放，而不是只是一份看起来完整的日志。
