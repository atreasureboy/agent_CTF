# Agent_CTF Phase 1.7：运行时正确性收口与真实生命周期修复

你正在当前 `agent_CTF` 仓库中工作。

此前已经完成 Phase 1.6，当前项目已经具有：

* `createCTFTaskRuntime`
* `CTFTaskOrchestrator`
* `CTFTaskStateStore`
* `TaskStateProjector`
* `HandoffCoordinator`
* `SpecialistHarnessFactory`
* Job 生命周期事件
* CLI → Runtime → Orchestrator 主路径

这些架构已经基本接入真实运行路径。

本轮不要重新设计一套 Runtime，也不要增加新的 CTF 解题能力。

本轮唯一目标是：

> 修复当前 Runtime 中 Context、Abort、Profile、Specialist、Artifact 投影、并发锁、Dispose 和 CLI 生命周期的正确性问题，确保已经建立的唯一主路径在真实运行中可靠，而不只是单元测试表面通过。

你必须直接审计并修改当前仓库。

不要只输出方案。

不要等待确认。

不要创建 V2。

---

# 一、本轮严格范围

本轮必须完成：

1. 在 Harness 创建前构造完整 TaskExecutionContext。
2. 删除创建 Harness 后覆盖 `harness.context` 的实现。
3. 让 AbortSignal 真正贯穿 Main Agent、Workflow、Tool、Specialist 和 Job。
4. 让 ProfileStore 成为唯一动态 Profile 来源。
5. 删除 Orchestrator 的第二套 Runtime 装配入口。
6. 修复 Orchestrator 的 cancel、dispose 和 in-flight 生命周期。
7. 修复 Workflow 锁清理和状态映射。
8. 为每个 Specialist 创建独立的子 AbortController。
9. 修复 Specialist 的能力匹配和依赖检查。
10. 明确 Specialist Artifact Store 隔离和父子产物投影。
11. 修复 TaskStateProjector 的错误吞噬、并发归属和复制失败问题。
12. 修复 CLI 参数解析和 Signal Handler 清理。
13. 将现有表面测试升级为真实行为测试。

本轮禁止：

* 不实现 Observation/Evidence 系统。
* 不实现动态 Workflow。
* 不实现 Workflow DAG。
* 不实现 Flag 自动验证。
* 不增加新工具。
* 不增加 Specialist。
* 不增加 Workflow。
* 不重写通用 ExecutionEngine。
* 不创建 Runtime V2。
* 不引入数据库。
* 不引入消息队列。
* 不引入 DI Container。
* 不保留新旧两套长期装配路径。

---

# 二、建立修改前基线

首先执行：

```bash
git status --short
git branch --show-current
git log -10 --oneline
git diff --stat
cat package.json
```

运行当前项目实际存在的：

```bash
pnpm typecheck
pnpm build
pnpm lint
pnpm test
```

随后搜索：

```bash
rg -n "harness\.context\s*=|as unknown as.*context" src bin tests

rg -n "opts\.profile|this\.opts\.profile|setProfile|getProfile|ProfileStore" src/core

rg -n "CTFTaskOrchestrator\.create|createCTFTaskRuntime" src bin tests

rg -n "new AbortController|abortSignal|createLinkedAbortController" src/core

rg -n "dispose\(|cancel\(|disposed|cancelled" src/core/ctfRuntime

rg -n "catch\s*\{\s*\}" src/core/ctfRuntime

rg -n "snapshot|projectDiff|copyArtifact|producedFindingIds|producedArtifactIds" src/core/ctfRuntime

rg -n "process\.removeAllListeners|args\.indexOf|takesValue" bin

rg -n "locks\.get|locks\.set|withLock" src/core/ctfRuntime
```

将真实发现写入：

```text
docs/architecture/phase-1.7-runtime-correctness.md
```

文档记录：

* 当前装配顺序
* Context 创建时间
* Abort 传播路径
* Profile 读取位置
* Runtime 双入口
* Specialist 生命周期
* Projector 归属方式
* Dispose 顺序
* 需要删除的类型断言和旁路

完成审计后继续修改代码。

---

# 三、TaskExecutionContext 必须在 Harness 创建前完成

当前禁止以下流程：

```text
createHarness
→ Harness 内部创建旧 Context
→ Runtime Factory 创建新 Context
→ 强制覆盖 harness.context
```

这种做法无法更新已经捕获旧 Context 的：

* WorkflowRunner
* WorkflowEngine
* ToolBroker
* ExecutionEngine
* Tool execution context
* Module
* Background Job

## 目标流程

必须改成：

```text
创建 Task AbortController
→ 创建完整 TaskExecutionContext
→ 创建 ProfileStore
→ createHarness(context, profileStore, runtimeDependencies)
→ Harness 内所有组件使用同一个 Context 实例
```

## 修改 createHarness 输入

根据现有类型调整，使其明确接收：

```ts
export interface CreateHarnessInput {
  context: TaskExecutionContext
  profileStore: ProfileStore
  runtimeDependencies: AgentRuntimeDependencies

  profile: CapabilityProfile
  contestConfig: ContestConfig

  findingStore?: FindingStore
  artifactStore?: ArtifactStore
}
```

如果需要兼容普通非 CTF Harness，可以：

```ts
context?: TaskExecutionContext
```

但 CTF Runtime 创建时必须显式传入。

## 必须删除

删除所有：

```ts
(harness as unknown as { context: TaskExecutionContext }).context = context
```

删除所有类似的 Context 后置替换。

## 一致性要求

以下对象必须持有同一个 Context 或从统一 Context Provider 读取：

* Harness public context
* WorkflowRunner
* WorkflowEngine
* ToolBroker
* Tool execution context
* Main Agent
* Runtime modules

增加行为测试：

```ts
expect(harness.context).toBe(capturedWorkflowContext)
expect(harness.context).toBe(capturedToolContext)
```

不要只比较字段值。

---

# 四、统一 AbortSignal

## 1. Task Controller

在 Runtime Factory 最开始创建：

```ts
const taskAbortController = new AbortController()
```

然后构造：

```ts
const context: TaskExecutionContext = {
  ...,
  abortSignal: taskAbortController.signal,
}
```

Context 创建后不再补写 Signal。

## 2. Main Agent

确认 `runMainAgent()` 最终传递 Signal 到：

* ExecutionEngine
* 模型请求
* Streaming
* Tool 调用

如果 ExecutionEngine 尚不支持外部 Signal，增加最小接口：

```ts
interface RunTurnOptions {
  signal?: AbortSignal
}
```

不要创建一套新 Engine。

## 3. Workflow

`runWorkflow()` 必须将：

```ts
context.abortSignal
```

传入 WorkflowEngine 的真实执行选项。

不允许 WorkflowRunner 仅保存 Signal，却不传递到：

* Bash
* ToolBroker
* Spawn
* Workflow retry wait
* 并行 Step

## 4. Tool

Tool execution context 必须包含：

```ts
signal: AbortSignal
```

Binary Tool 使用：

```ts
spawn(command, args, {
  signal,
  shell: false,
})
```

或当前运行环境支持的等价中止机制。

## 5. Job

父任务取消后：

* 可取消 Job 应真正取消；
* 不可取消 Job 应记录 `cancellation_requested`；
* 不允许 Job 永久保持 running。

---

# 五、每个 Specialist 使用独立子 AbortController

当前禁止所有 Specialist 共用同一个可被 dispose/unlink 的控制对象。

## 正确结构

```text
Task AbortController
├── Main Agent linked controller
├── Workflow linked controller
├── Handoff A linked controller
└── Handoff B linked controller
```

## SpecialistHarnessFactory

Factory 内部创建：

```ts
const linked = createLinkedAbortController(
  parentContext.abortSignal
)
```

然后将：

```ts
linked.controller.signal
```

写入 Specialist Context。

返回：

```ts
interface SpecialistHarnessHandle {
  harness: HarnessBundle
  context: TaskExecutionContext
  abort(reason?: string): void
  dispose(): Promise<void>
}
```

`dispose()` 只能移除自己的父子监听。

不能 unlink Task 级 Controller。

## HandoffCoordinator

维护：

```ts
private readonly activeSpecialists = new Map<
  string,
  SpecialistHarnessHandle
>()
```

`cancelHandoff(handoffId)` 必须：

1. 找到对应 Handle。
2. 调用该 Specialist 的 abort。
3. 等待其执行收敛。
4. 更新 AgentRun。
5. 更新 Handoff 为 cancelled。
6. 不取消父任务。
7. 不影响其他 Specialist。

父任务 cancel 时：

* 取消所有 Specialist；
* 等待所有 Specialist 收敛；
* 清理 Map。

---

# 六、ProfileStore 成为唯一动态来源

当前必须消除以下状态分叉：

```text
ProfileStore 当前 Profile
TaskState.activeProfileId
TaskExecutionContext.profileId
ToolBroker.opts.profile
Harness 闭包中的 profile
Prompt Builder 初始化 profile
```

## 权威定义

采用：

```text
ProfileStore：运行时当前 Profile 的唯一权威来源
TaskState.activeProfileId：ProfileStore 变化的审计投影
TaskExecutionContext.profileId：当前 Harness 创建时的静态身份，不用于动态查询
```

如果 `TaskExecutionContext.profileId` 容易产生误解，可以改名为：

```ts
initialProfileId
```

或者：

```ts
agentProfileId
```

根据当前兼容性选择。

## createHarness

必须接收同一个 ProfileStore。

以下逻辑每次都必须调用：

```ts
profileStore.getCurrent()
```

或者统一：

```ts
getCurrentProfile()
```

包括：

* Tool visibility
* Tool execution authorization
* ToolFirstPolicy
* Prompt 构建
* Agent identity
* Model 参数
* Workflow 默认 Agent
* Tool execution metadata
* Budget

## ToolBroker

将静态和动态配置拆开：

```ts
interface ToolBrokerStaticOptions {
  contestScope: ContestScope
  contestConfig: ContestConfig
  registry: ToolRegistry
}

class ToolBroker {
  private readonly opts: ToolBrokerStaticOptions
  private readonly profileStore: ProfileStore

  getProfile(): CapabilityProfile {
    return this.profileStore.getCurrent()
  }
}
```

所有地方禁止继续：

```ts
this.opts.profile
```

禁止：

```ts
(this.opts as unknown as ...).profile = profile
```

## switchProfile

顺序必须是：

```text
解析 Profile
→ 验证 Profile
→ 预计算 Tool Exposure
→ ProfileStore.commit
→ TaskState PROFILE_CHANGED
→ 清理 Tool/Prompt 缓存
```

失败时不得出现半更新状态。

---

# 七、删除 Runtime 第二装配入口

当前最终只能保留：

```ts
createCTFTaskRuntime(...)
```

作为生产 Runtime 装配入口。

## CTFTaskOrchestrator.create()

如果当前仍自行：

* 创建 Harness
* 创建 Renderer
* 创建 Fake Client
* 创建 Context
* 创建 ProfileStore
* 创建 JobManager

必须删除该装配逻辑。

允许两种方案：

### 方案 A

彻底删除静态：

```ts
CTFTaskOrchestrator.create()
```

所有生产和测试调用改用：

```ts
createCTFTaskRuntime()
```

### 方案 B

保留兼容入口，但只能委托 Factory：

```ts
static create(input) {
  return createCTFTaskRuntime(input)
}
```

注意避免循环依赖。

更推荐方案 A。

## 禁止默认假客户端

删除生产代码中的：

```ts
'test-key'
({} as OpenAI)
new Renderer() // 在没有真实 LLM 依赖时伪装可运行
```

Runtime 必须有明确模式：

```ts
type CTFTaskRuntimeMode =
  | 'workflow-only'
  | 'llm'
```

### workflow-only

允许没有：

* OpenAI Client
* Renderer
* Model

但调用 `runMainAgent()` 时必须报清晰错误。

### llm

创建时必须验证：

* Client
* Renderer
* ModelConfig

缺失时立即失败。

---

# 八、修复 Orchestrator 生命周期

## 1. dispose 顺序

禁止：

```ts
this.disposed = true
await this.cancel()
```

因为 cancel 可能看到 disposed 后直接返回。

正确顺序：

```ts
async dispose(): Promise<void> {
  if (this.disposed || this.disposing) return

  this.disposing = true

  try {
    await this.cancel('runtime disposed')
    await this.awaitInFlightRuns()
    await this.cleanupResources()
  } finally {
    this.disposed = true
    this.disposing = false
  }
}
```

或者等价实现。

需要明确区分：

* active
* cancelling
* cancelled
* disposing
* disposed

不要只使用两个容易冲突的 boolean。

## 2. Main Agent in-flight

维护：

```ts
private readonly inFlightAgentRuns = new Map<
  string,
  Promise<AgentRunResult>
>()
```

Main Agent 必须和 Workflow、Specialist 一样：

* 可追踪；
* 可取消；
* dispose 时等待；
* 失败时收敛；
* 取消时记录 cancelled，而不是 failed。

## 3. cancel

`cancel()` 必须等待：

* Main Agent
* Workflow
* Specialist
* 可取消 Job

不允许只给 Promise 添加 `.catch()` 后立即把 Task 标为 cancelled。

可以设置合理的清理超时，但必须记录超时对象。

## 4. Workflow 状态映射

禁止将所有非 cancelled 结果都标记为 completed。

必须映射：

```text
WorkflowResult.status = completed
→ WORKFLOW_COMPLETED

WorkflowResult.status = failed
→ WORKFLOW_FAILED

WorkflowResult.status = partial
→ WORKFLOW_PARTIAL 或明确的 completed-with-errors

WorkflowResult.status = cancelled
→ WORKFLOW_CANCELLED
```

根据当前真实类型实现。

TaskState 中必须保留实际 Workflow 状态。

## 5. 删除无意义订阅

删除在每次 Workflow 运行中创建、但回调什么都不做的 StateStore subscription。

---

# 九、修复 Workflow Lock

当前锁实现必须审计：

```ts
this.locks.set(key, previous.then(() => next))
```

如果 finally 中比较：

```ts
this.locks.get(key) === next
```

则永远不会相等。

## 正确实现

可以创建：

```ts
private async withKeyLock<T>(
  key: string,
  operation: () => Promise<T>
): Promise<T>
```

要求：

1. 相同 key 串行。
2. 不同 key 可并行。
3. 操作完成后 Map Entry 被删除。
4. 操作失败后也删除。
5. 不产生未处理 Promise rejection。
6. 长期运行后 Map 大小回到 0。
7. 取消等待锁的操作可以退出。

增加测试：

* 连续执行 100 次后 Map 为空。
* 同 workflow 串行。
* 不同 workflow 并行。
* 第一个失败后第二个仍执行。
* Abort 后等待者退出。

---

# 十、修复 Handoff Agent 选择

## 1. 显式 Agent

当 Handoff 指定：

```ts
requestedAgentId
```

不能只检查 Agent 是否存在。

必须验证：

* Agent 已启用。
* Agent 支持 `requestedCapability`。
* Agent Profile 被当前 Task 允许。
* Agent 所需工具存在。
* Agent 所需 Binary 可用。
* Scope 可以缩小到该 Agent 任务。

不匹配时明确失败。

## 2. Capability 匹配

实现确定性选择：

```text
支持 requestedCapability
→ Profile 中明确首选
→ requiredTools 可用
→ requiredBinaries 可用
→ 稳定排序
```

不要选择“任意工具可用的第一个 Agent”。

## 3. requiredTools 与 allowedTools

区分：

```ts
allowedTools: string[]
requiredTools?: string[]
requiredBinaries?: string[]
```

`allowedTools` 表示最多可以使用什么。

`requiredTools` 表示 Agent 能工作的最低依赖。

不能通过过滤掉不存在的 allowedTool，假装 Agent 依赖已满足。

## 4. Scope

Specialist 必须获得最小 Scope。

实现：

```ts
deriveSpecialistScope({
  parentScope,
  artifactIds,
  objective,
  requestedCapability,
})
```

结果必须满足：

```text
childScope ⊆ parentScope
```

默认只允许：

* 本次 Handoff 关联 Artifact；
* 子任务目录；
* 必要工具；
* 父 Scope 中对应目标。

不要无条件把完整父 Scope 传给 Specialist。

---

# 十一、修复 Handoff 生命周期语义

## 1. 选择失败

没有匹配 Specialist 时，不应创建空 `agentRunId` 并发送假的 Specialist Failed。

增加明确事件：

```ts
{
  type: 'HANDOFF_FAILED'
  handoffId: string
  stage: 'selection' | 'creation' | 'execution' | 'projection'
  error: string
}
```

## 2. Terminal Handoff 重复 approve

禁止返回带空 ID 的伪结果。

二选一：

* 返回已存储的真实 HandoffResult；
* 抛出明确的 `HandoffAlreadyTerminalError`。

不要伪造一次新的成功。

## 3. AgentRun 记录

审计：

```text
AGENT_RUN_STARTED
SPECIALIST_STARTED
```

确保一个 Specialist 只创建一个 AgentRunRecord。

不能两个事件分别追加相同 Run。

`SPECIALIST_STARTED` 应只更新：

* Handoff status
* selectedAgentId
* agentRunId

或者只使用一个统一事件。

## 4. 取消

`cancelHandoff()` 必须真正调用该 Handoff 的 AbortController。

不能只更新 Store。

---

# 十二、明确 Specialist Store 隔离

当前必须在以下两个方案中选择一个，并统一实现。

## 采用方案：独立子 Store

每个 Specialist 创建：

* 独立 FindingStore
* 独立 ArtifactStore
* 独立 sessionDir
* 独立 artifactDir

完成后通过 TaskStateProjector 将有效产物投影到父任务。

## 禁止混合

不能：

```text
生产代码共享父 Store
测试代码使用独立 Store
Projector 又假设需要复制 Artifact
```

这会导致测试和真实运行语义不同。

## 投影要求

子 Finding 投影到父任务时保留：

* originalFindingId
* parentTaskId
* childTaskId
* handoffId
* agentRunId
* producerAgentId

子 Artifact 投影时：

1. 校验源文件在子 ArtifactDir。
2. 流式复制到父 ArtifactDir。
3. 创建新的父 Artifact ID。
4. 写入父 ArtifactStore。
5. 添加 lineage。
6. 更新父 TaskState。
7. 复制失败则 Handoff 进入 projection failed。
8. 不能把不可访问的子 Artifact ID 写进父 State。

---

# 十三、修复 TaskStateProjector

## 1. 禁止空 catch

删除：

```ts
catch {}
```

以及：

```ts
catch {
  // ignore
}
```

针对以下操作不得静默失败：

* Finding snapshot
* Artifact snapshot
* Finding projection
* Artifact projection
* 文件复制
* Lineage 写入
* Store 写入
* TaskState apply

## 2. ProjectionError

定义：

```ts
export class ProjectionError extends Error {
  constructor(
    message: string,
    readonly stage:
      | 'snapshot'
      | 'finding'
      | 'artifact-copy'
      | 'artifact-store'
      | 'state',
    readonly cause?: unknown,
  ) {
    super(message)
  }
}
```

Orchestrator 根据来源决定：

* Main Agent projection 失败；
* Workflow projection 失败；
* Specialist Handoff projection 失败。

不得继续假装成功。

## 3. Run 关联

单纯：

```text
执行前 Store ID
→ 执行后 Store ID
→ 差集
```

在并发情况下会将其他 Run 的产物误认为当前 Run 产物。

需要给 Finding 和 Artifact 增加：

```ts
taskId
agentRunId?
workflowRunId?
handoffId?
producerAgentId?
createdAt
```

在创建 Tool/Workflow/Agent execution context 时注入当前 Run ID。

Projector 优先使用：

```text
run ID + task ID + producer
```

筛选。

Snapshot 差集只能作为 Legacy fallback。

## 4. 并发测试

同时启动：

* Main Agent A
* Workflow B

分别各自产生一个 Finding 和 Artifact。

必须验证：

```text
AgentRun A 只拥有 A 的产物
WorkflowRun B 只拥有 B 的产物
```

---

# 十四、修复 CLI 参数解析

当前不要继续使用：

```ts
for (const arg of args)
args.indexOf(arg)
```

这种解析方式无法可靠消费参数值，并且重复参数会取第一次出现的位置。

## 正确实现

使用索引循环：

```ts
for (let i = 0; i < args.length; i++) {
  const arg = args[i]

  switch (arg) {
    case '--profile':
      result.profile = requireValue(args, ++i, arg)
      break
  }
}
```

支持：

* 参数值消费；
* 重复参数策略；
* `--flag=value`，如果当前 CLI 风格需要；
* `--` 后的纯 positional；
* 缺失值报错；
* 未知 flag 报错；
* positional task 正确拼接；
* 文件名以 `-` 开头时通过 `--` 处理。

## 测试

覆盖：

```text
--profile crypto --run-workflow encoding_sweep
--profile crypto --profile pwn
--input ./sample.bin
--task "analyze this"
-- --literal-starting-with-dash
未知参数
缺失参数值
重复相同参数
```

---

# 十五、修复 Signal Handler 清理

禁止：

```ts
process.removeAllListeners('SIGINT')
```

这会删除其他模块安装的监听器。

## 正确接口

```ts
function installSignalHandlers(
  onSignal: (signal: NodeJS.Signals) => Promise<void>
): () => void
```

内部保存具体 Handler：

```ts
process.on('SIGINT', handler)
process.on('SIGTERM', handler)

return () => {
  process.off('SIGINT', handler)
  process.off('SIGTERM', handler)
}
```

## shutdownPromise

保证多次 Signal 不重复 cancel/dispose：

```ts
let shutdownPromise: Promise<void> | undefined

function requestShutdown(signal: NodeJS.Signals) {
  shutdownPromise ??= shutdown(signal)
  return shutdownPromise
}
```

`finally` 中调用 unregister。

测试：

1. 预先安装一个无关 SIGINT Handler。
2. 运行 CLI。
3. CLI dispose。
4. 无关 Handler 仍存在。
5. CLI 自己的 Handler 已删除。
6. 两次 Signal 只执行一次 cancel/dispose。

---

# 十六、修复测试中的假覆盖

审计 Phase 1.6 测试。

删除或改写以下弱测试模式：

## 1. 只检查源码字符串

例如只检查：

```text
文件中不包含 createHarness
```

静态检查可以保留，但不能替代行为测试。

## 2. 手工模拟 Signal

不能只在测试中自行调用：

```ts
controller.abort()
```

然后声称 CLI Signal 已测试。

必须通过注入的 Signal Registrar 或真实 Handler 驱动 `runCtfCli()`。

## 3. Specialist Context 字段测试

不能只验证：

```ts
handle.context.abortSignal === signal
```

还要让 Specialist 内部 Tool 或 Workflow 真正捕获 Signal。

## 4. Projector 测试与生产语义不一致

如果生产 Specialist 使用独立 Store，测试也必须使用独立 Store。

如果生产共享 Store，则删除复制测试。

本轮规定采用独立 Store。

## 5. Main Agent 产物测试

不能运行 Workflow 后只断言：

```ts
after >= before
```

必须：

1. 使用 Fake Model Client。
2. Main Agent 调用 Fake Tool。
3. Fake Tool 创建 Finding/Artifact。
4. 验证 AgentRun 精确拥有对应 IDs。
5. 验证 IDs 非空。
6. 验证没有认领其他 Run 的产物。

---

# 十七、必须新增的行为测试

## Context

* Harness 内所有子组件使用同一个 Context。
* 不存在 Context 后置覆盖。
* WorkflowRunner 捕获的 Signal 与 Task Signal 相同。
* Tool execution 捕获的 workspace 与 Task Context 相同。

## Profile

* 切换 Profile 后 Tool visibility 改变。
* 切换 Profile 后 Tool execution policy 改变。
* 下一轮 Prompt 使用新 Profile。
* Workflow 默认 Agent 使用新 Profile。
* 不存在 `this.opts.profile` 动态读取。
* 不存在 readonly/private 强制修改。

## Abort

* 慢速 Main Agent 被 cancel。
* 慢速 Workflow 被 cancel。
* 慢速 Tool 子进程被 cancel。
* 单个 Specialist 被 cancel。
* 取消 Specialist 不取消父 Task。
* 父 Task cancel 取消所有 Specialist。
* dispose 会取消正在运行的任务。

## Orchestrator

* Workflow failed 映射为 failed。
* Workflow partial 不映射为普通 completed。
* Main Agent abort 映射为 cancelled。
* dispose 后所有 in-flight Map 为空。
* Lock Map 运行后为空。

## Handoff

* 显式不兼容 Agent 被拒绝。
* 缺 requiredTool 的 Agent 不被选择。
* 缺 requiredBinary 的 Agent 不被选择。
* Child Scope 不大于 Parent Scope。
* 重复 approve 不产生第二个 AgentRun。
* Selection failure 不创建空 AgentRun。
* cancelHandoff 真正 abort 对应 Specialist。

## Projector

* 并发 Run 不串产物。
* 子 Artifact 真实复制。
* 子 Artifact 复制失败不会写入父 ID。
* Projection 错误可以观测。
* Lineage 中父子 Task ID 正确。
* 大文件复制不一次性全部读入内存。

## CLI

* 参数值被正确消费。
* positional 不混入 flag value。
* 未知 flag 返回非零退出码。
* Signal Handler 精确注销。
* 多次 Signal 幂等。

---

# 十八、静态禁止检查

完成后执行：

```bash
rg -n "harness\.context\s*=" src bin

rg -n "as unknown as.*context" src bin

rg -n "this\.opts\.profile|opts\.profile\s*=" src/core/toolBroker.ts

rg -n "test-key|\{\}\s+as\s+OpenAI" src/core/ctfRuntime

rg -n "removeAllListeners" bin src

rg -n "args\.indexOf\(arg\)" bin

rg -n "catch\s*\{\s*\}" src/core/ctfRuntime

rg -n "readFileSync.*artifact|readFileSync.*sourcePath" src/core/ctfRuntime

rg -n "CTFTaskOrchestrator\.create" src bin tests
```

预期：

* 生产代码无 Context 后置覆盖。
* ToolBroker 无动态 `opts.profile`。
* Runtime 无假 Client。
* CLI 不删除全部 Signal listener。
* Projector 无空 catch。
* 生产代码只使用一个 Runtime 装配入口。

如果为了 Legacy Adapter 保留命中，必须在最终报告逐项解释。

---

# 十九、验证和 Smoke Test

执行：

```bash
pnpm typecheck
pnpm build
pnpm lint
pnpm test
```

运行 Workflow-only Smoke Test。

运行 Fake LLM Main Agent 集成测试。

运行 Fake Specialist Handoff 集成测试。

增加一个取消 Smoke Test：

```text
启动一个持续数秒的本地 Tool
→ 100ms 后调用 runtime.cancel()
→ Tool 被中止
→ Workflow/Agent 状态 cancelled
→ Task 状态 cancelled
→ runtime.dispose()
→ 进程正常退出
```

禁止连接公共目标。

禁止依赖真实 API Key。

---

# 二十、完成标准

只有以下全部满足才可以结束。

## Context

* Context 在 Harness 创建前完成。
* 不再覆盖 harness.context。
* 所有子组件共享同一 Context。
* Workflow、Tool 和 Engine 读取真实 Signal。

## Profile

* ProfileStore 是唯一动态来源。
* ToolBroker 不读取旧 opts.profile。
* Prompt 使用当前 Profile。
* Tool exposure 使用当前 Profile。
* TaskState 正确投影 Profile 变化。
* 不使用 private/readonly hack。

## Runtime

* 只有 createCTFTaskRuntime 负责生产装配。
* Orchestrator 不再创建假 Client。
* workflow-only 和 llm 模式明确。
* 测试使用真实 Factory 或明确的内部测试装配接口。

## Abort

* Main Agent 可中止。
* Workflow 可中止。
* Tool 可中止。
* Job 可中止或明确记录不可中止。
* 每个 Specialist 拥有独立子 Controller。
* cancelHandoff 真正中止 Agent。
* dispose 真正先取消再释放。

## Orchestrator

* Main Agent in-flight 可追踪。
* cancel 等待运行收敛。
* Workflow status 映射正确。
* Lock Map 无泄漏。
* 无无意义订阅。
* dispose 幂等。

## Handoff

* Agent Capability 匹配正确。
* requiredTools 和 requiredBinaries 正确检查。
* Scope 最小化。
* 不创建空 AgentRun。
* 不重复创建 AgentRun。
* Terminal approve 不返回伪结果。

## Projector

* 无空 catch。
* Projection 错误可见。
* 并发 Run 不串产物。
* Specialist 使用独立 Store。
* Artifact 文件真实复制。
* 复制失败不产生错误父引用。
* Lineage 正确。

## CLI

* 参数解析正确。
* flag value 不成为 positional。
* 未知参数报错。
* Signal Handler 精确删除。
* 多次 Signal 幂等。
* finally 正常 dispose。

## 工程质量

* Typecheck 通过。
* Build 通过。
* Lint 通过。
* Tests 通过。
* Smoke Test 通过。
* 无 Runtime V2。
* 无大规模新增 `any`。
* 架构文档与代码一致。

---

# 二十一、最终报告格式

完成后按照以下结构汇报。

## 1. 修改前真实问题

逐项列出实际命中位置：

* Context 后置覆盖
* Abort 未贯穿
* Profile 分叉
* Runtime 双入口
* Dispose 顺序
* Lock 泄漏
* Specialist 共享 Abort
* Agent 选择不完整
* Projector 空 catch
* 并发归属问题
* CLI 参数问题
* Signal 清理问题

不要只复述本任务描述。

## 2. 最终装配顺序

说明：

```text
Task Controller
→ TaskExecutionContext
→ ProfileStore
→ Harness
→ Orchestrator
→ Runtime
```

## 3. 生命周期

分别说明：

* Main Agent
* Workflow
* Specialist
* Job
* cancel
* cancelHandoff
* dispose

## 4. 状态所有权

说明：

* Context
* Profile
* AbortController
* AgentRun
* WorkflowRun
* Handoff
* Finding
* Artifact

## 5. 删除内容

列出：

* Context 覆盖
* 假 Client
* Orchestrator 第二装配入口
* private Profile hack
* empty catch
* removeAllListeners
* 错误参数解析
* 共享 Specialist Controller

## 6. 测试结果

列出真实命令和通过数量。

## 7. 静态禁止检查

逐条列出 `rg` 结果。

## 8. 未解决问题

只列本轮真实存在但不影响 Runtime 正确性的问题。

不要在此处列：

* Evidence Graph
* 动态 Workflow
* Flag 自动验证
* 更多 Specialist

这些属于下一阶段。

---

# 二十二、执行顺序

严格按照：

```text
1. 基线和代码审计
2. Context 前置构造
3. ProfileStore 真实接入
4. 删除 Runtime 双入口
5. Main/Workflow Abort 贯通
6. Specialist 独立 Abort
7. Orchestrator cancel/dispose
8. Workflow Lock
9. Handoff Agent 选择
10. Specialist Store 隔离
11. Projector 运行归属与错误处理
12. CLI 参数解析
13. Signal Handler 清理
14. 行为测试
15. 静态禁止检查
16. Smoke Test
17. 文档与最终报告
```

不要同时开始 Workflow Evidence 重构。

不要因为现有测试通过就跳过真实行为测试。

不要创建临时双轨后留在那里。

本轮最终目标是：

> TaskExecutionContext、ProfileStore 和 AbortController 从 Runtime 创建开始就被正确注入每个组件；每个 Run 和 Handoff 都有独立、可取消、可追踪的生命周期；任何产物都能精确归属于真实生产者；dispose 能可靠停止整个任务且不泄漏资源。
