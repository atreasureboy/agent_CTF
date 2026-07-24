# Agent_CTF Phase 3.1：Phase 3 去桩化与真实生产接线

你正在当前最新的 `agent_CTF` 仓库中工作。

当前仓库已经新增：

* ModelCapabilityRegistry
* ModelHealthStore
* ModelCircuitBreaker
* ModelRouter
* StructuredModelGateway
* ContextCompiler
* CompilerValidator
* ToolVisibilityPolicy
* MCPVisibilityRegistry
* SolverPortfolio
* NativeSolverAdapter
* GenericProcessSolverAdapter
* ChallengeSwarm
* CrossSolverEvidenceBus
* StagnationDetector
* FlagDiscriminator
* SubmissionController
* TrajectoryRecorder

这些模块的目录和基础类型已经存在。

但当前部分实现仍然属于：

* 创建了对象但没有进入真实主路径；
* 使用 Mock 或模拟成功结果；
* 只在测试中工作；
* 与 TaskState、Orchestrator、ExecutionEngine 分离；
* 声称具有某种隔离或调度能力，但实际执行语义并不成立。

本轮唯一目标是：

> 删除 Phase 3 中的模拟实现和静默回退，让模型调用、工具可见性、上下文编译、外部 Solver、Solver Swarm、跨 Solver 证据共享和轨迹记录真正接入现有 CTFTaskRuntime，并且只使用一套 TaskState、权限体系和生命周期。

本轮必须直接修改代码。

不要只写审计文档。

不要继续增加新的 Phase 3 模块。

不要创建 V2。

不要因为现有测试通过就宣布完成。

---

# 一、本轮必须完成

1. 调整 Runtime 装配顺序。
2. Model Reliability 在 Harness 创建前完成装配。
3. 主 Agent 的真实模型请求经过 Model Gateway。
4. 删除 Gateway 中的模拟成功 Executor。
5. 建立真实 OpenAI-compatible Provider Adapter。
6. 修复 ModelRouter 的角色、能力、预算和 Fallback 校验。
7. 修复 ModelHealth 和 CircuitBreaker 的计数语义。
8. ToolVisibilityPolicy 真正作用于工具定义和工具执行。
9. Tool Visibility 改为完整运行身份，而不是只使用 Profile ID。
10. 将 ContextCompiler 直接绑定权威 TaskState。
11. NativeSolverAdapter 真正包装现有 CTFTaskRuntime。
12. 删除默认 Mock Generic Process Solver。
13. 修复 GenericProcessSolverAdapter 的进程、JSONL、取消和 Guidance。
14. SolverRun 正式进入 CTFTaskState。
15. SolverPortfolio 结果经过统一 Normalizer、Materializer 和 Projector。
16. ChallengeSwarm 实现真正受控并行。
17. StagnationDetector 使用真实运行指标。
18. CrossSolverEvidenceBus 改为 TaskState Evidence 的任务级投影视图。
19. 修复 Candidate 验证和取消其他 Solver 的条件。
20. TrajectoryRecorder 接入 Runtime 并支持 flush/dispose。
21. 删除所有生产 Mock、Synthetic Success 和演示 Adapter。
22. 增加真实端到端测试。

---

# 二、本轮禁止事项

不要：

* 不实现 CTFd。
* 不实现 BUUCTF 平台。
* 不实现真实 Flag 提交。
* 不迁移新的题型 Workflow。
* 不新增 OneShot Manifest。
* 不增加新的 Solver 类型。
* 不接入真实 Codex CLI 或 Claude CLI。
* 不引入数据库。
* 不引入消息队列。
* 不创建第二套 TaskState。
* 不创建第二套 ToolBroker。
* 不创建第二套模型循环。
* 不创建 ModelGatewayV2。
* 不创建 SolverPortfolioV2。
* 不创建 ChallengeSwarmV2。
* 不保留 Mock Adapter 作为默认生产 Adapter。
* 不允许测试 Fixture 被自动注册进生产 Runtime。
* 不用提交标题或测试数量证明功能完成。

---

# 三、先建立真实基线

执行：

```bash
git status --short
git branch --show-current
git log -15 --oneline
git diff --stat
git diff
```

然后：

```bash
pnpm typecheck
pnpm build
pnpm lint
pnpm test
```

以 `package.json` 的实际脚本为准。

执行搜索：

```bash
rg -n "mockSuccess|mock solver|Simulate native|Generic mock" src tests

rg -n "new StructuredModelGateway|new SolverPortfolio|new ToolVisibilityPolicy" src

rg -n "chat\\.completions\\.create|responses\\.create" src/core src/ctf

rg -n "toolVisibilityPolicy" src/core

rg -n "filterVisibleTools|isToolVisible" src/core

rg -n "NativeSolverAdapter|GenericProcessSolverAdapter|ChallengeSwarm" src

rg -n "solverRuns|SOLVER_RUN_" src/core/ctfRuntime

rg -n "CrossSolverEvidenceBus|getUnreadMessages|lastSeenStateRevision" src

rg -n "ContextProjection\\.project|compileM3Brief|compileProgress|compileRetryHandoff" src

rg -n "appendFileSync|writeFileSync" src/core/trajectory

rg -n "high-tier-model|m3-low-cost-tier|gpt-4o|m3-mini" src/core/modelReliability

rg -n "FakePlatform|isFakeMode|accepted: true" src/core/solverPortfolio
```

将真实审计写入：

```text
docs/architecture/phase-3.1-production-wiring-audit.md
```

文档必须区分：

* 已创建且真实使用；
* 已创建但只返回给调用方；
* 只在测试使用；
* 生产 Mock；
* 第二状态源；
* 名称声称的能力与实际语义不一致。

完成审计后继续修改代码。

---

# 四、修复 Runtime 装配顺序

当前禁止：

```text
创建 Harness
→ 创建 Orchestrator
→ 最后才创建 ModelGateway / VisibilityPolicy / Portfolio
→ 仅挂到 Runtime 返回对象
```

正确顺序必须是：

```text
Task AbortController
→ TaskExecutionContext
→ ProfileStore
→ TrajectoryRecorder
→ ModelCapabilityRegistry
→ ModelHealthStore
→ ModelCircuitBreaker
→ ModelRouter
→ Model Provider Adapter
→ ModelGateway
→ ToolVisibilityPolicy
→ ContextCompilerService
→ createHarness
→ CTFTaskStateStore
→ Orchestrator
→ SolverPortfolio
→ Runtime
```

修改 `createCTFTaskRuntime()`。

## 必须在 createHarness 前创建

* ModelGateway
* ToolVisibilityPolicy
* TrajectoryRecorder
* ModelRoleContextProvider

然后显式传入：

```ts
createHarness({
  ...,
  modelGateway,
  toolVisibilityPolicy,
  modelRoleContextProvider,
  trajectoryRecorder,
})
```

## 禁止

不要创建完成后只返回：

```ts
return {
  modelReliability,
  solverPortfolio,
  toolVisibilityPolicy,
}
```

而 Harness、Engine、Broker 和 Orchestrator完全不知道它们存在。

返回对象可以继续暴露只读引用，但生产使用必须来自正式依赖注入。

---

# 五、建立统一 ModelInvocationGateway

当前主 Agent 使用流式 Tool Calling，而 StructuredModelGateway 只适合结构化 JSON。

不要建立两套互不相关的模型健康和路由系统。

将现有 Gateway 扩展或重构为统一接口：

```ts
export interface ModelInvocationGateway {
  streamAgentTurn(input: AgentTurnModelRequest): Promise<AgentTurnStream>

  executeStructured<T>(
    input: StructuredModelRequest<T>,
  ): Promise<StructuredModelResponse<T>>
}
```

## AgentTurnModelRequest

```ts
export interface AgentTurnModelRequest {
  taskId: string
  agentRunId: string

  role: ModelRole
  preferredModelId?: string

  messages: OpenAIMessage[]
  tools: ToolDefinition[]

  temperature?: number
  maxOutputTokens?: number

  requiredCapabilities: string[]

  signal: AbortSignal
}
```

## 共同执行链

两种调用都必须经过：

```text
ModelRouter
→ ModelRolePolicy
→ ModelHealth
→ CircuitBreaker
→ Provider Adapter
→ Usage / Error Classification
→ Trajectory
```

不要让 Streaming 主 Agent 绕过 Gateway。

---

# 六、建立真实 Provider Adapter

建议创建：

```text
src/core/modelReliability/providers/
├── modelProvider.ts
└── openAICompatibleProvider.ts
```

接口：

```ts
export interface ModelProvider {
  id: string

  streamAgentTurn(
    model: ModelCapabilityProfile,
    input: ProviderAgentTurnInput,
  ): Promise<AgentTurnStream>

  executeStructured(
    model: ModelCapabilityProfile,
    input: ProviderStructuredInput,
  ): Promise<ProviderStructuredResult>
}
```

`OpenAICompatibleProvider` 包装当前已有 OpenAI Client。

必须支持：

* Streaming。
* Tool definitions。
* Tool choice。
* AbortSignal。
* Usage。
* Provider Error。
* Empty Response。
* Timeout。
* 429 / 5xx。
* Schema repair。

## 禁止默认 Mock

删除生产代码中的：

```ts
return {
  rawText: JSON.stringify({
    mockSuccess: true,
  }),
}
```

当没有 Provider 时：

```ts
throw new MissingModelProviderError(...)
```

测试必须显式注入：

```ts
FakeModelProvider
```

生产和测试不能共享隐式 Mock。

---

# 七、ExecutionEngine 必须使用 Gateway

修改 `ExecutionEngine.callLLM()`。

禁止继续直接：

```ts
this.client.chat.completions.create(...)
```

改成：

```ts
const stream = await this.config.modelGateway.streamAgentTurn({
  taskId,
  agentRunId,
  role,
  preferredModelId,
  messages,
  tools,
  signal,
})
```

底层 OpenAI SDK 调用只能存在于：

```text
openAICompatibleProvider.ts
```

允许其他非 CTF legacy Engine 暂时通过一个明确 Legacy Provider Adapter，但不能绕过统一错误和取消语义。

## 静态目标

最终：

```bash
rg -n "chat\\.completions\\.create|responses\\.create" src
```

只能命中 Provider Adapter 和明确的兼容测试。

---

# 八、模型运行身份

不能用：

```ts
profile.id
```

同时表示：

* ModelRole
* Solver ID
* Specialist ID
* Capability Profile
* Orchestrator 身份

建立：

```ts
export interface ModelExecutionIdentity {
  taskId: string

  modelRole: ModelRole

  capabilityProfileId: string

  modelId?: string
  solverId?: string
  specialistId?: string

  agentRunId?: string
  workflowRunId?: string
  oneShotRunId?: string
  handoffId?: string

  isOrchestrator: boolean
  isWorkflow: boolean
  isOneShot: boolean
}
```

该 Identity 由 Runtime 创建。

模型不能自行提交这些字段。

用于：

* ModelRouter
* ModelRolePolicy
* ToolVisibilityPolicy
* Trajectory
* ContextCompiler
* ToolBroker

---

# 九、修复 ModelRouter

## Preferred Model

当前 preferred model 也必须检查：

* Registry 是否存在。
* Role 是否允许。
* Required Capabilities。
* Health。
* Circuit。
* Budget。
* Provider 是否可用。

不得只检查 Health 后直接选择。

## Unknown Model

未知模型可以创建保守 Profile，但：

* 不得自动允许未声明 Role。
* 不得自动作为强模型 Fallback。
* 必须绑定一个实际 Provider。
* 必须记录 Conservative Routing。

## 无候选模型

禁止返回一个可能不存在的：

```text
high-tier-model
```

正确行为：

```ts
throw new NoEligibleModelError({
  role,
  requiredCapabilities,
  rejectedModels,
})
```

或者使用经过验证的、已注册的 Operator Fallback。

## Fallback

每个 Fallback 必须重新检查：

* Role。
* Capability。
* Health。
* Circuit。
* Provider。
* Budget。

不能只使用 Profile 中的字符串数组。

---

# 十、修复 ModelHealth

当前必须区分：

```text
累计失败数量
连续失败数量
时间窗口失败数量
```

定义：

```ts
export interface ModelHealthRecord {
  modelId: string
  taskId?: string

  status: ModelHealthStatus

  consecutiveSchemaFailures: number
  consecutiveToolArgumentFailures: number
  consecutiveProviderFailures: number

  totalSchemaFailures: number
  totalToolArgumentFailures: number
  totalProviderFailures: number

  timeoutTimestamps: number[]
  loopTimestamps: number[]

  successfulRuns: number

  lastSuccessAt?: number
  lastFailureAt?: number

  circuitOpenedAt?: number
  circuitReason?: string

  halfOpenProbeInFlight: boolean
}
```

## Success

成功时：

* 连续失败计数归零。
* 累计计数保留。
* degraded 可以恢复 healthy。
* half-open probe 成功后关闭 Circuit。

## Failure

只增加对应连续和累计计数。

## Window

Timeout 和 Loop 使用真实时间窗口。

定期裁剪旧 Timestamp。

不要把历史累计 Timeout 当作当前窗口。

---

# 十一、修复 CircuitBreaker

状态：

```text
closed
→ open
→ half_open
→ closed
```

要求：

* Cooldown 后只允许一个 Probe。
* Probe 成功后清理连续失败。
* Probe 失败重新打开 Circuit。
* 不直接修改从 Store 获取的对象。
* 所有修改通过 ModelHealthStore 方法。
* 并发请求不能同时穿过 Half-open。
* Circuit Open 原因可观测。
* Runtime dispose 清理 Health Store。

测试：

* 两次连续 Schema Failure 打开。
* 中间成功会重置连续计数。
* 两次非连续失败不会误打开。
* Cooldown 后单 Probe。
* Probe 成功关闭。
* Probe 失败重新打开。

---

# 十二、Structured Output Repair

Repair Prompt 不得无限包含原始输出。

限制：

```ts
maxRepairRawChars: 4_000
```

Repair 输入包含：

* Schema 名称。
* 精确 validation path。
* 截断后的原始内容。
* 只输出 JSON 的要求。

必须响应 AbortSignal。

Profile 中：

```ts
limits.maxRepairAttempts
```

当前阶段最大值仍建议不超过 1。

空响应必须作为：

```text
empty_response
```

而不是 JSON Parse Failure。

---

# 十三、ToolVisibilityPolicy 必须 Fail-closed

当前无 Rule 默认返回 true，无法真正限制不可靠模型。

建立明确默认策略：

```ts
export type VisibilityDefault =
  | 'deny'
  | 'profile_allowed'
  | 'legacy_allow'
```

CTFTaskRuntime 默认：

```text
profile_allowed
```

表示：

1. CapabilityProfile 允许。
2. Tool Metadata 声明其 Visibility Class。
3. ToolVisibilityPolicy 允许当前身份。
4. 才向模型展示和执行。

Legacy 非 CTF Harness 可以显式使用：

```text
legacy_allow
```

不得隐式使用。

---

# 十四、统一 Tool Visibility 过滤入口

当前 `filterVisibleTools()` 的：

* Orchestrator 高层工具集；
* maxVisibleTools；

没有被 Engine 使用。

建立唯一入口：

```ts
resolveVisibleTools(input: {
  tools: ToolDescriptor[]
  identity: ModelExecutionIdentity
  profile: CapabilityProfile
  modelProfile: ModelCapabilityProfile
  taskState: Readonly<CTFTaskState>
}): ToolDescriptor[]
```

排序依据：

1. 当前 Role。
2. Profile。
3. 当前 Challenge Category。
4. Active Hypothesis。
5. Pending Action。
6. Tool availability。
7. Cost。
8. 稳定 Tool ID。

禁止简单：

```ts
visible.slice(0, maxVisibleTools)
```

## Engine Tool Definitions

使用 `resolveVisibleTools()`。

## Broker 执行

伪造的隐藏 Tool 调用也必须通过同一个 Policy 再检查一次。

Definition 和 Execution 的判断必须一致。

---

# 十五、Orchestrator 工具可见性

Orchestrator 只能看到高层工具。

但当前不能采用：

```ts
if (filtered.length > 0) return filtered
return allVisibleTools
```

因为当高层工具未注册时会意外暴露全部工具。

正确行为：

```text
没有可见高层工具
→ 返回空 Tool Definition
→ 记录配置错误
```

不要 Fail-open。

Orchestrator 高层 Tool 列表应来自 Tool Metadata 或配置，不要在 Policy 类中硬编码第二份字符串表。

---

# 十六、MCP Visibility 真正接入

审计当前 MCP Client 的配置加载和 Tool 注册。

`MCPVisibilityRegistry` 必须在：

```text
MCP server initialize
→ tools/list
→ ToolRegistry registration
```

期间给每个 MCP Tool 写入 Visibility Metadata。

必须验证：

* Server 配置存在。
* `exposeToolsToParent=false` 时 Parent 看不到。
* Specialist 能看到允许的工具。
* Broker 拒绝伪造调用。
* MCP Server 断开时 Tool availability 更新。
* Visibility Rule 不依赖调用方后置手工注册。

---

# 十七、ContextProjection 必须直接读取权威 State

当前生产路径不得让任意调用方手工传入：

```ts
evidences
hypotheses
attempts
artifacts
```

建立：

```ts
export interface TaskStateProjectionBuilder {
  build(input: {
    state: Readonly<CTFTaskState>
    findingStore: FindingStore
    artifactStore: ArtifactStore
    identity: ModelExecutionIdentity
    targetModel: ModelCapabilityProfile
    compilerType: CompilerType
  }): TaskStateProjectionInput
}
```

Builder 负责：

* 精确映射当前 Hypothesis Status。
* 只选真实 Evidence。
* 获取 Artifact Metadata。
* 验证 Artifact 属于当前 Task。
* 获取 Pending Action。
* 获取失败 Attempt。
* 获取 Scope。
* 计算 State Revision。
* 计算确定性 Snapshot Hash。
* 根据 Visibility 生成 Allowed Tools。

生产 Compiler 只能接收 Builder 输出。

测试可以构造 Fixture。

---

# 十八、修复 Context 状态映射

不要维护一套与 TaskState 不同的状态名称：

```text
active
confirmed
pending
```

直接使用真实：

```text
proposed
testing
supported
rejected
inconclusive
```

Compiled Context 可以分组展示，但底层 Reference 必须保留原始 Status。

例如：

```ts
interface CompiledHypothesisRef {
  id: string
  statement: string
  status: CTFHypothesis['status']
  confidence?: number
}
```

禁止在投影时将：

```text
supported → confirmed
testing → active
```

后丢失原始语义。

---

# 十九、CompilerValidator 真正验证来源

Validator 接收：

```ts
validate(
  context: CompiledContext,
  dependencies: {
    state: Readonly<CTFTaskState>
    artifactStore: ArtifactStore
    expectedIdentity: ModelExecutionIdentity
    expectedSnapshotHash: string
  }
)
```

检查：

* taskId 一致。
* State Revision 一致。
* Snapshot Hash 一致。
* Evidence ID 存在。
* Hypothesis ID 存在且状态匹配。
* Attempt ID 存在且失败状态匹配。
* Artifact ID 存在且属于当前 Task。
* Artifact realpath 在授权目录。
* Allowed Tools 与 Visibility 一致。
* Scope 没有缩减或扩大错误。
* Candidate 未被写成 accepted。
* 不包含 Secret。
* Token Budget。
* Completion Contract。
* Context 未过期。

失败时回退确定性模板。

不能使用未经验证的模型渲染结果。

---

# 二十、Context Compiler 接入真实模型调用

## Main Agent

首次启动前使用：

```text
ChallengePromptCompiler
```

## M3 Scout

每个新 Solver Run 使用：

```text
SolverBriefCompiler
```

## Context Compact

长轨迹压缩后使用：

```text
ProgressCompiler
```

而不是只使用普通对话总结。

## Solver 恢复

使用：

```text
RetryHandoffCompiler
```

## Specialist

使用：

```text
SpecialistContextCompiler
```

不要将这些 Compiler 仅暴露为 Utility 后无人调用。

Trajectory 必须记录：

* compilerType；
* contextId；
* snapshotHash；
* sourceIds；
* targetModelId；
* validation result。

---

# 二十一、SolverRun 正式进入 TaskState

增加：

```ts
solverRuns: SolverRunRecord[]
activeSolverRunIds: string[]
```

增加事件：

```ts
SOLVER_RUN_QUEUED
SOLVER_RUN_STARTED
SOLVER_RUN_GUIDANCE_SENT
SOLVER_RUN_STAGNATING
SOLVER_RUN_PAUSED
SOLVER_RUN_COMPLETED
SOLVER_RUN_CANDIDATE_FOUND
SOLVER_RUN_GAVE_UP
SOLVER_RUN_CANCELLED
SOLVER_RUN_FAILED
SOLVER_RUN_OUTPUT_RECORDED
```

Reducer 必须实现 FSM。

允许转换：

```text
queued → running
running → stagnating
stagnating → running
stagnating → paused
running → paused
paused → queued
running → completed
running → candidate_found
running → gave_up
running → cancelled
running → failed
```

Terminal 状态不能回到 running。

SolverPortfolio 不得将独立 Map 作为 Solver 状态真相源。

---

# 二十二、NativeSolverAdapter 必须运行真实 Runtime

删除：

```text
Simulate native runtime cycle
```

NativeSolverAdapter 必须通过依赖注入接收：

```ts
interface NativeSolverRuntimeDelegate {
  runMainAgent(...)
  runWorkflow(...)
  cancel(...)
  inspectState(...)
  sendGuidance(...)
}
```

`start()` 必须：

1. 创建 SolverRunRecord。
2. 编译并验证 Context。
3. 根据 Policy 选择 Main Agent 或 Workflow。
4. 调用当前 Task 的 Orchestrator。
5. 收集真实 Observation、Evidence、Artifact 和 Candidate。
6. 返回结构化结果。
7. 支持 Abort。
8. 支持 Guidance。
9. 不创建第二个 TaskState。
10. 不重复 Materialize。

测试必须确认真实 Delegate 被调用。

---

# 二十三、删除生产 Mock Process Solver

禁止 SolverPortfolio 构造函数自动注册：

```ts
new GenericProcessSolverAdapter(
  'generic-process-solver',
  {
    executablePath: 'node',
    args: ['-e', '...mock...'],
  },
)
```

默认只注册已经具备真实依赖的 Native Adapter。

外部 Process Adapter 必须由 Operator 配置显式注册。

配置示例：

```ts
solverAdapters: [
  {
    id: 'codex-cli',
    type: 'process',
    executablePath: 'codex',
    args: [...],
  },
]
```

配置必须经过 Schema 校验和 probe。

测试 Mock 放在测试文件中。

---

# 二十四、修复 GenericProcessSolverAdapter

## Probe

实际检查：

* executablePath 是否存在；
* 是否可执行；
* Workspace 是否可写；
* 协议版本是否兼容。

不能永远返回 ready。

## JSONL

实现跨 Chunk 的 Line Buffer：

```ts
let pending = ''

onData(chunk) {
  pending += chunk
  while (pending contains newline) {
    extract complete line
    parse
  }
}
```

进程结束时处理最后一行。

限制：

* 最大单行长度。
* 最大总输出。
* Schema 验证。
* 非 JSON 输出进入日志 Artifact。
* 非法 JSON 不成为 Observation。

## Guidance

保存 Child stdin。

```ts
sendGuidance(message)
```

真正写入：

```json
{"type":"guidance", ...}
```

处理 stdin closed。

## Cancel

保存 Child Process Handle。

取消时：

* 设置状态。
* 终止进程树。
* 等待退出。
* 超时后强杀。
* 返回真实取消结果。

当前只修改 boolean 而不杀进程是不允许的。

## Signal

父 `SolverChallengeInput.signal` 必须关联子进程。

## Start Packet

包含：

* contextPath 或完整受限 Context；
* Artifact Paths；
* Scope；
* Protocol Version；
* Output Schema；
* Completion Contract。

不得只发送 Objective 和 Workspace。

---

# 二十五、SolverResultNormalizer 接入统一 Materializer

External Solver 的输出不应只做字符串 trim。

执行链必须是：

```text
ExternalSolverResult
→ Protocol Schema Validation
→ SolverResultNormalizer
→ ResultMaterializer
→ Observation / Evidence / Artifact / Candidate
→ TaskStateProjector
```

Normalizer 必须：

* 验证 sourcePath。
* 校验 Artifact 路径权限。
* 限制 Observation 数量。
* 限制 Summary。
* 不信任 Confidence。
* Candidate 只进入 detected。
* 外部 Solver 状态映射。
* 保留 SolverRun ID。
* 保存原始输出 Artifact。

External Solver 不能直接创建高置信度 Evidence。

---

# 二十六、ChallengeSwarm 必须真正并行

当前禁止：

```ts
for (...) {
  const handle = await adapter.start(...)
  const result = await handle.wait()
}
```

这不是 Swarm。

建立有界调度：

```text
启动符合 maxConcurrentSolvers 的 Initial Solvers
→ Promise race / event-driven result
→ 处理新 Evidence
→ 评估 Candidate
→ 评估 Stagnation
→ 必要时启动 Escalation
→ 完成或停止
```

要求：

* 初始 Solver 可以并行。
* 不超过并发上限。
* 不超过总 Solver 上限。
* 完成 Handle 从 active 中移除。
* 取消只针对仍活跃 Handle。
* Escalation Handle 也进入 active。
* Task Abort 取消全部。
* 每个 Solver 独立 Context 和 Workspace。
* 每个 Solver 有正式 State Record。
* 无未处理 Promise rejection。

---

# 二十七、使用真实 Stagnation Signal

禁止在生产代码硬编码：

```ts
{
  cyclesWithoutNewEvidence: 4,
  millisecondsWithoutNewEvidence: 10000,
  ...
}
```

建立：

```ts
StagnationSignalCollector
```

从以下真实数据计算：

* SolverRun 开始时间。
* 最后新 Evidence 时间。
* Attempt Fingerprints。
* Action Families。
* Tool failures。
* Context compactions。
* Hypothesis Revision。
* Artifact 数量变化。
* Budget。

每次信号必须绑定 SolverRun。

StagnationDetector 只做纯决策。

Collector 负责计算真实指标。

---

# 二十八、修复 CrossSolverEvidenceBus

它不能成为第二个 Evidence Store。

改为 TaskState 的投影视图：

```ts
class CrossSolverEvidenceView {
  getUnread(input: {
    taskId: string
    solverRunId: string
    afterStateRevision: number
    limit: number
  }): SolverEvidenceMessage[]
}
```

## 必须按 Task 隔离

查询必须：

```ts
message.taskId === input.taskId
```

## Cursor

Cursor 至少保存：

```ts
lastSeenStateRevision
seenMessageIds
```

下一次不能返回同一消息。

## 消息来源

只从 TaskState 中读取：

* 新 Evidence；
* 关键 Observation；
* 新 Artifact；
* validated Candidate；
* Operator Hint。

不要保存独立的事实副本。

运行时 Cursor 可以在内存中，但：

* 由 Runtime 实例持有；
* 有大小上限；
* dispose 清理；
* 不是真相源。

## Dedup

不要只根据 Summary 全局去重。

使用：

```text
taskId
+ sourceSolverRunId
+ stateRevision
+ evidence IDs
```

---

# 二十九、Candidate 验证不能只靠格式

FlagDiscriminator 返回：

```text
格式像 Flag
```

只能提升 Candidate 置信度，不能成为“已验证”。

区分：

```ts
syntaxValid
provenanceValid
locallyValidated
platformAccepted
```

ChallengeSwarm 取消其他 Solver 的条件：

## 本地 Fixture

```text
locallyValidated
+ CompletionPolicy 允许
```

## 真实比赛

```text
platformAccepted
```

普通正则匹配不能取消其他 Solver。

## 非严格格式

当前不能因为“不为空且不是纯小写单词”就：

```ts
valid: true
```

返回：

```text
inconclusive
```

建议结果：

```ts
status:
  | 'rejected'
  | 'syntax_match'
  | 'inconclusive'
  | 'locally_validated'
  | 'platform_accepted'
```

---

# 三十、Fake Submission 不得产生真实 Accepted

SubmissionController 的 Fake 模式返回：

```ts
accepted: true
```

容易污染 TaskState。

改成：

```ts
export interface SubmissionResponse {
  status:
    | 'simulated_accepted'
    | 'accepted'
    | 'rejected'
    | 'error'
}
```

Fake 模式只能返回：

```text
simulated_accepted
```

Reducer 不得将其映射为：

```text
FlagCandidate.status = accepted
Task solved
```

真实 `accepted` 只能来自正式 Platform Adapter。

---

# 三十一、TrajectoryRecorder 真正接入

在 Runtime 创建早期创建：

```ts
TrajectoryRecorder
```

传入：

* ModelGateway。
* ContextCompiler。
* SolverPortfolio。
* ChallengeSwarm。
* Orchestrator。
* ToolBroker。

## 禁止热路径同步写文件

当前 `appendFileSync()` 会阻塞模型和工具循环。

改为：

* 内存有界 Buffer；
* 异步追加；
* 单 Writer Queue；
* backpressure；
* flush；
* dispose。

## Redaction

当前只清理第一层 Key。

改为递归清理：

* 嵌套对象。
* 数组。
* Headers。
* URL Query。
* Tool Input。
* Environment。
* Authorization。
* Cookie。
* API Key。
* Token。
* Password。

限制 Payload 大小。

超大内容保存为安全 Artifact 引用。

## State Revision

不要固定传入 `1`。

从 TaskStateStore 获取真实 Revision。

---

# 三十二、生命周期和 Dispose

CTFTaskRuntime.dispose() 必须清理：

* ModelHealthStore。
* CircuitBreaker Probe。
* Trajectory Writer。
* SolverPortfolio 活跃 Handle。
* ChallengeSwarm。
* CrossSolver Cursors。
* Generic Process Children。
* Model Provider Streams。
* Context Compiler Cache。
* Tool Visibility subscriptions。

所有长期 Map 必须：

* 有 Owner；
* 有最大容量；
* 有 dispose；
* 不是状态真相源。

---

# 三十三、真实端到端测试

## 1. 主 Agent 经过 Gateway

```text
Fake Provider
→ ExecutionEngine
→ ModelGateway
→ ModelRouter
→ Streaming Tool Call
→ ToolBroker
```

断言：

* Provider 被调用。
* Engine 没有直接调用 OpenAI Client。
* Routing Decision 被记录。
* Health 成功更新。
* Trajectory 有模型路由事件。

## 2. M3 Schema Failure

```text
M3 返回非法 JSON
→ 一次 Repair
→ Repair 失败
→ Circuit 计数
→ 强模型 Fallback
→ 成功
```

断言不产生 Mock Success。

## 3. Tool Visibility

```text
M3 Scout
→ 当前状态下只看到有限工具
→ 伪造隐藏工具调用
→ Broker 拒绝
```

断言 Definition 与 Execution 使用相同 Policy。

## 4. Context Compiler

```text
真实 TaskState
→ ProjectionBuilder
→ M3 Solver Brief
→ Validator
→ Gateway
```

断言：

* Source ID 存在。
* Status 正确。
* Allowed Tools 一致。
* Snapshot Hash 正确。
* State 改变后旧 Context 失效。

## 5. Native Solver

```text
NativeSolverAdapter
→ Runtime Delegate
→ Orchestrator
→ Workflow/Main Agent
→ Structured Output
→ SolverRunRecord
```

禁止模拟 Observation。

## 6. Generic Process

使用测试进程：

* 分块输出 JSONL。
* 接收 Guidance。
* 输出 Candidate。
* 响应 Cancel。
* 非 JSON 行进入日志。
* 进程树最终退出。

## 7. Swarm 并行

两个 Fake Solver：

* 同时启动。
* 不串行。
* 一个产生假 Candidate。
* 一个继续。
* 真正本地验证后才取消剩余。

## 8. 跨 Task 隔离

Task A 和 Task B 分别产生 Evidence。

Solver A 只能读取 Task A 消息。

同一 Cursor 第二次读取不能收到相同消息。

---

# 三十四、静态禁止检查

完成后运行：

```bash
rg -n "mockSuccess|Generic mock solver|Simulate native runtime" src
```

生产代码必须无匹配。

```bash
rg -n "chat\\.completions\\.create|responses\\.create" src
```

只能命中正式 Provider Adapter。

```bash
rg -n "new StructuredModelGateway|new ToolVisibilityPolicy" src/core/ctfRuntime/createCTFTaskRuntime.ts
```

它们必须出现在 createHarness 之前。

```bash
rg -n "visible\\.slice\\(0" src/core/toolVisibility
```

必须删除简单截断。

```bash
rg -n "if \\(filtered\\.length > 0\\).*return filtered" src/core/toolVisibility
```

Orchestrator 不得 Fail-open。

```bash
rg -n "cyclesWithoutNewEvidence:\\s*4|millisecondsWithoutNewEvidence:\\s*10000" src/core/solverPortfolio
```

生产代码必须无硬编码模拟信号。

```bash
rg -n "await handle\\.wait\\(\\)" src/core/solverPortfolio/challengeSwarm.ts
```

不得存在于导致 Initial Solver 串行的循环中。

```bash
rg -n "appendFileSync|writeFileSync" src/core/trajectory
```

热路径必须无同步写。

```bash
rg -n "accepted:\\s*true" src/core/solverPortfolio
```

Fake Submission 不得返回真实 Accepted。

```bash
rg -n "SolverPortfolioV2|ChallengeSwarmV2|ModelGatewayV2" src
```

必须无匹配。

---

# 三十五、验证命令

执行：

```bash
pnpm typecheck
pnpm build
pnpm lint
pnpm test
```

运行无网络 Smoke Test。

## Smoke 1

```text
M3 Fake Provider
→ Schema 失败
→ Repair
→ Fallback
→ Tool Call
→ Evidence
```

## Smoke 2

```text
M3 Scout
→ Context Compiler
→ 受限 Tool Definitions
→ 伪造隐藏 Tool
→ 拒绝
```

## Smoke 3

```text
Native Solver
→ 真实 Orchestrator
→ unknown_file_triage
→ Solver Result
```

## Smoke 4

```text
两个 Fake Process Solver 并发
→ Evidence 共享
→ Task 隔离
→ 假 Candidate 不取消
→ 本地验证 Candidate 后取消
```

## Smoke 5

```text
Runtime dispose
→ 模型流取消
→ Process Solver 退出
→ Swarm 清理
→ Trajectory flush
→ Map 清空
```

不得连接公共目标。

不得依赖真实 API Key。

---

# 三十六、完成标准

只有以下全部满足才可以结束。

## 模型主路径

* Main Agent 经过 ModelGateway。
* Streaming 和 Structured 调用使用同一 Router、Health 和 Circuit。
* 没有默认 Mock Executor。
* Provider 缺失明确失败。
* Fallback 只选择合法模型。
* Circuit 具有真实 Half-open。

## Tool Visibility

* Policy 在 Harness 创建前注入。
* Tool Definitions 使用完整 Identity。
* Tool Execution 使用同一 Policy。
* Orchestrator Fail-closed。
* M3 工具数由能力 Profile 控制。
* 隐藏 MCP Tool 无法看到和调用。

## Context

* 从权威 TaskState 投影。
* 不依赖调用方手工编造状态。
* Source ID 验证。
* Artifact 验证。
* Snapshot Hash 验证。
* Context 真正用于模型和 Solver。

## Solver

* Native Adapter 不再模拟。
* 默认无 Mock Process Adapter。
* Process Adapter 可 Probe、Guidance、Cancel。
* SolverRun 进入 TaskState。
* External Result 经过统一 Materializer。
* 外部 Solver 不能直接写 Evidence。

## Swarm

* Initial Solver 真正并行。
* 并发和总量受限。
* Stagnation 使用真实信号。
* Evidence 跨 Solver 共享但不跨 Task。
* Cursor 不重复消息。
* Candidate 仅格式匹配不会取消其他 Solver。
* Completed Handle 正确清理。

## Trajectory

* Runtime 正式接入。
* 异步写入。
* 递归脱敏。
* State Revision 正确。
* dispose flush。

## 工程质量

* 不存在生产 Mock。
* 不存在 V2。
* 不新增大量 any。
* 不使用 eval。
* Typecheck 通过。
* Build 通过。
* Lint 通过。
* Tests 通过。
* Smoke Tests 通过。
* 文档与真实实现一致。

---

# 三十七、最终报告格式

## 1. 修改前真实断层

必须列出实际代码位置：

* Runtime 后置创建 Phase 3 组件
* Engine 直接调用 OpenAI
* Gateway Mock Success
* Visibility 默认放行
* Native Solver 模拟
* Generic Process Mock
* Swarm 串行
* Stagnation 硬编码
* Evidence Bus 跨 Task
* Context 手工投影
* SolverRun 不在 TaskState
* Fake Submission Accepted
* Trajectory 同步写

## 2. 最终 Runtime 装配顺序

说明：

```text
Context
→ Reliability
→ Visibility
→ Trajectory
→ Harness
→ Orchestrator
→ Portfolio
```

## 3. 模型调用链

说明 Streaming 和 Structured 两条路径。

## 4. Solver 调用链

说明 Native、Process 和 Swarm。

## 5. 状态所有权

说明：

* Model Health
* Compiled Context
* SolverRun
* Evidence
* Cursor
* Trajectory
* Candidate

## 6. 删除的 Mock 和旁路

逐项列出。

## 7. 测试结果

列出真实命令和数量。

## 8. 静态禁止检查

逐条列出结果。

## 9. 未解决问题

只列真实存在但不影响 Phase 3 生产接线的问题。

不要列：

* CTFd
* BUUCTF
* 多题控制面
* 更多 Solver
* 更多模型

这些属于下一阶段。

---

# 三十八、执行顺序

严格按照：

```text
1. 基线和真实使用审计
2. Runtime 装配顺序
3. Provider Adapter
4. ModelInvocationGateway
5. Engine 接入 Gateway
6. Router 修复
7. Health 与 Circuit 修复
8. Tool Identity
9. Visibility Fail-closed
10. MCP Visibility
11. TaskState Projection Builder
12. Compiler Validator
13. Context 自动接入
14. SolverRun State/Event
15. Native Solver 去模拟
16. 删除默认 Process Mock
17. Generic Process 生命周期
18. Solver Result Materialization
19. Swarm 并行调度
20. 真实 Stagnation Signal
21. Cross-Solver Task 隔离
22. Candidate 验证语义
23. Fake Submission 状态
24. Trajectory 异步接入
25. Dispose
26. 行为测试
27. 静态检查
28. Smoke Test
29. 文档与报告
```

不要先实现 CTFd。

不要继续新增外部项目适配器。

不要把“对象已经实例化”视为“功能已经接入”。

不要让 M3 修改核心架构后自行审计并宣布完成。

本轮最终目标是：

> Phase 3 中不存在任何“看上去能运行但实际返回模拟成功”的组件；主 Agent 的真实模型请求受到 Router、Health、Circuit 和 Tool Visibility 约束；Native Solver、Process Solver 与 Swarm 都执行真实任务，并将运行状态和结果收敛到唯一 CTFTaskState。
