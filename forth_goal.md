# Agent_CTF Phase 1.6：唯一主路径强制切换

你正在当前 `agent_CTF` 仓库中工作。

上一轮已经创建：

* `TaskExecutionContext`
* `CTFTaskState`
* `CTFTaskEvent`
* `CTFTaskStateStore`
* `CTFTaskOrchestrator`

但当前代码仍然存在新旧双轨运行、CLI 绕过 Orchestrator、Handoff 独立执行、JobManager monkey patch、状态事件无效和产物未投影等问题。

本轮不是继续设计新架构。

本轮唯一目标：

> 删除所有绕过 `CTFTaskOrchestrator` 的实际执行路径，让 CLI、Main Agent、Workflow、Handoff、Specialist、Job、取消和产物同步全部经过唯一的 CTF Task Runtime。

你必须直接修改代码。

不要只写分析。

不要只新增文档。

不要等待确认。

---

# 一、严格限制本轮范围

本轮必须完成：

1. CTF CLI 全面切换到 Orchestrator。
2. 删除旧 Handoff 独立执行路径。
3. 创建完整 Specialist Harness Factory。
4. AbortSignal 真正贯穿整个执行链。
5. 移除 JobManager monkey patch 和轮询。
6. 修复 Hypothesis、Attempt、Job 状态事件。
7. 同步 Main Agent、Workflow、Specialist 产物。
8. 对过大的 Orchestrator 做有限职责拆分。
9. 增加真实主路径集成测试。
10. 更新 README 和架构文档。

本轮禁止：

* 不增加新 CTF 工具。
* 不增加新 Specialist。
* 不增加新 Workflow。
* 不优化 Workflow 具体解题策略。
* 不实现 Evidence Graph。
* 不实现自动 Flag 提交。
* 不建设 benchmark。
* 不重写通用 ExecutionEngine。
* 不重做 Memory。
* 不引入数据库。
* 不引入消息队列。
* 不创建 `OrchestratorV2`。
* 不保留长期双轨实现。

---

# 二、先建立当前代码基线

执行并记录：

```bash
git status --short
git log -5 --oneline
cat package.json
pnpm typecheck
pnpm build
pnpm test
```

以 `package.json` 实际命令为准。

然后执行以下搜索：

```bash
rg -n "createHarness|harness\.runWorkflow|broker.*opts|autoExecute|dispatchNext" bin src tests

rg -n "harness\.context\.abortSignal|new AbortController|abortSignal" src/core

rg -n "jm\.spawn|setTimeout\(tick|setInterval|ACTIVE_JOBS_REPLACED" src/core

rg -n "producedFindingIds:\s*\[\]|producedArtifactIds:\s*\[\]" src/core

rg -n "HYPOTHESIS_ADDED|ATTEMPT_RECORDED|JOB_RECORDED" src/core

rg -n "process\.cwd\(\)|sessionDir:\s*undefined" src/core src/workflows bin
```

将真实结果写入：

```text
docs/architecture/phase-1.6-audit.md
```

文档只记录：

* 搜索命中位置
* 当前执行路径
* 需要删除的旧路径
* 最终文件职责

完成审计后立即继续修改。

---

# 三、必须删除的已知错误模式

开始前先复核当前代码是否仍存在以下模式。

如果存在，必须在本轮删除。

## 1. CLI 直接创建 Harness

禁止 CTF CLI 继续出现：

```ts
const { createHarness } = await import(...)
const harness = createHarness(...)
```

## 2. CLI 直接运行 Workflow

禁止：

```ts
await harness.runWorkflow(...)
```

## 3. CLI 修改 Broker 私有配置

禁止：

```ts
(harness.broker as unknown as {
  opts: ...
}).opts.contestScope = ...
```

以及任何：

```ts
broker["opts"]
broker.opts
as unknown as { opts: ... }
```

## 4. Legacy Handoff 自行创建 Specialist

禁止 `orchestratorDispatch.ts` 中继续：

```ts
createHarness(...)
child.runTurn(...)
```

禁止继续提供：

```ts
autoExecute?: boolean
```

## 5. JobManager monkey patch

禁止：

```ts
const origSpawn = jm.spawn.bind(jm)
jm.spawn = ...
```

## 6. Job 状态轮询

禁止：

```ts
setTimeout(tick, 25)
setInterval(...)
```

用于同步 Job 状态。

## 7. 无效 AbortSignal

禁止只写：

```ts
harness.context.abortSignal
```

而没有真正建立 Signal 传递关系。

## 8. 固定空产物

禁止 Main Agent 或 Workflow 返回：

```ts
producedFindingIds: []
producedArtifactIds: []
```

除非本次执行计算后确实没有新产物。

## 9. 无效 reducer

禁止：

```ts
case "HYPOTHESIS_ADDED":
  return state
```

以及 Attempt、Job 同类空处理。

---

# 四、建立唯一的 Runtime 创建入口

创建：

```text
src/core/ctfRuntime/createCTFTaskRuntime.ts
```

或者符合项目命名规范的等价文件。

公开接口应接近：

```ts
export interface CreateCTFTaskRuntimeInput {
  cwd: string
  taskId?: string
  contestId?: string
  profileId: string

  contestConfig: ContestConfig
  contestScope: ContestScope

  challenge?: {
    description?: string
    category?: string
    flagPattern?: string
    inputArtifactIds?: string[]
  }

  client?: OpenAI
  renderer?: Renderer
  modelConfig?: ModelConfig

  sessionsRoot?: string
  environment?: Record<string, string>
}

export interface CTFTaskRuntime {
  orchestrator: CTFTaskOrchestrator
  getState(): Readonly<CTFTaskState>
  cancel(reason: string): Promise<void>
  dispose(): Promise<void>
}

export async function createCTFTaskRuntime(
  input: CreateCTFTaskRuntimeInput
): Promise<CTFTaskRuntime>
```

要求：

1. 这是创建 CTF Task 的唯一公开入口。
2. 它负责创建完整 `TaskExecutionContext`。
3. 它负责创建 Task 级 AbortController。
4. 它负责创建 Main Harness。
5. 它负责创建 StateStore。
6. 它负责创建 Orchestrator。
7. 它负责连接 Job 生命周期事件。
8. 它负责注册 Workflow。
9. 它不运行具体任务。
10. 不允许 CLI 重复实现这些步骤。

可以让现有：

```ts
CTFTaskOrchestrator.create(...)
```

内部委托该 Factory，或者让 Factory 委托现有静态方法。

但最终只能有一个真实装配路径。

---

# 五、全面迁移 CTF CLI

修改：

```text
bin/ovogogogo-ctf.ts
```

## 1. CLI 初始化

CLI 应当：

```text
解析参数
→ resolve ContestConfig
→ 创建 OpenAI client（需要 LLM 时）
→ 创建 Renderer（需要 LLM 时）
→ createCTFTaskRuntime
→ 调用 Orchestrator
```

禁止 CLI 直接创建 Harness。

## 2. Workflow 模式

必须改成：

```ts
const result = await runtime.orchestrator.runWorkflow(
  args.runWorkflow,
  inputs
)
```

禁止：

```ts
harness.runWorkflow(...)
```

## 3. 普通任务模式

当前普通任务不能继续只输出：

```text
LLM-backed turn is reserved...
```

需要复用主 CLI `bin/ovogogogo.ts` 中已有的：

* API Key 读取
* Base URL
* Model
* OpenAI client 创建
* Renderer 创建
* 错误处理

然后：

```ts
const result = await runtime.orchestrator.runMainAgent(args.task)
```

没有 API Key 时，输出明确错误并返回非零退出码。

不能静默跳过任务。

## 4. 中断信号

安装一次性处理器：

```ts
process.once("SIGINT", ...)
process.once("SIGTERM", ...)
```

处理器必须调用：

```ts
await runtime.cancel("SIGINT")
await runtime.dispose()
```

防止重复执行。

## 5. finally 清理

主函数必须：

```ts
let runtime: CTFTaskRuntime | undefined

try {
  ...
} finally {
  await runtime?.dispose()
}
```

不要依赖 `process.exit()` 跳过清理。

允许通过设置：

```ts
process.exitCode = 1
```

结束。

## 6. 可测试性

将 CLI 逻辑拆为：

```ts
export async function runCtfCli(
  argv: string[],
  deps?: CtfCliDependencies
): Promise<number>
```

依赖至少允许注入：

* stdout
* stderr
* client factory
* renderer factory
* runtime factory
* signal registrar

文件最后只保留：

```ts
runCtfCli(process.argv)
  .then(code => {
    process.exitCode = code
  })
  .catch(...)
```

---

# 六、彻底删除 Legacy Handoff 执行

修改：

```text
src/core/orchestratorDispatch.ts
```

## 最终允许的定位

它只能是旧 API 兼容代理。

允许：

```ts
export async function dispatchNext(
  parent: HarnessBundle,
  options: {
    orchestrator?: CTFTaskOrchestrator
    decision?: "approve" | "reject"
  }
): Promise<DispatchResult | null>
```

## 必须删除

删除参数：

```ts
autoExecute
cwd
apiKey
baseURL
model
openaiClient
renderer
userMessage
history
```

删除 import：

```ts
createHarness
getBuiltinProfile
PROFILES
```

删除：

```ts
const child = createHarness(...)
await child.runTurn(...)
```

## 无 Orchestrator 时

必须明确失败：

```ts
if (!options.orchestrator) {
  throw new Error(
    "dispatchNext requires an attached CTFTaskOrchestrator"
  )
}
```

不要保留 fallback。

不要“只批准不执行”。

不要创建一次性子 Harness。

## approve/reject

批准：

```ts
return options.orchestrator.approveHandoff(next.id)
```

拒绝：

```ts
options.orchestrator.rejectHandoff(next.id, reason)
```

所有 Specialist 启动只能来自：

```text
CTFTaskOrchestrator
→ HandoffCoordinator
→ SpecialistHarnessFactory
```

---

# 七、建立 AgentRuntimeDependencies

创建：

```text
src/core/ctfRuntime/agentRuntimeDependencies.ts
```

结构根据现有类型调整：

```ts
export interface AgentRuntimeDependencies {
  client?: OpenAI
  renderer?: Renderer
  modelConfig?: ModelConfig
  eventLog?: EventLog
  logger?: Logger
}
```

要求：

1. Main Harness 与 Specialist Harness 使用同一组基础运行时依赖。
2. 不允许 Specialist 自己从环境变量重新构造 Client。
3. 不允许 Specialist 缺少 Renderer 后直接运行。
4. Workflow-only 模式允许没有 Client/Renderer。
5. LLM 模式必须校验 Client 和 Renderer。
6. RuntimeDependencies 不保存 TaskState。
7. RuntimeDependencies 不保存 Profile。

---

# 八、建立 SpecialistHarnessFactory

创建：

```text
src/core/ctfRuntime/specialistHarnessFactory.ts
```

接口接近：

```ts
export interface CreateSpecialistHarnessInput {
  parentContext: TaskExecutionContext
  subtaskContext: TaskExecutionContext
  profile: CapabilityProfile
  dependencies: AgentRuntimeDependencies
  handoff: HandoffRecord
}

export interface SpecialistHarnessHandle {
  harness: HarnessBundle
  dispose(): Promise<void>
}

export class SpecialistHarnessFactory {
  async create(
    input: CreateSpecialistHarnessInput
  ): Promise<SpecialistHarnessHandle>
}
```

必须传入：

* Parent Task ID
* Handoff ID
* 派生后的 TaskExecutionContext
* 子目录
* 缩小后的 ContestScope
* Parent AbortSignal
* OpenAI client
* Renderer
* Model 配置
* Specialist Profile

禁止在 `taskOrchestrator.ts` 内继续直接：

```ts
createHarness({
  cwd: ...,
  profile: ...,
})
```

## 生命周期

Specialist 执行必须：

```ts
const handle = await specialistFactory.create(...)

try {
  return await handle.harness.runTurn(...)
} finally {
  await handle.dispose()
}
```

---

# 九、真正连接 AbortSignal

## 1. 创建 Task 时

必须：

```ts
const taskController = new AbortController()

const context: TaskExecutionContext = {
  ...,
  abortSignal: taskController.signal
}
```

Context 创建完成后不能再通过副作用补字段。

## 2. 父子 Signal

创建：

```text
src/core/ctfRuntime/linkedAbortController.ts
```

实现：

```ts
export function createLinkedAbortController(
  parent?: AbortSignal
): {
  controller: AbortController
  dispose(): void
}
```

要求：

* Parent abort 时 Child abort。
* Child abort 不自动 abort Parent。
* dispose 移除监听器。
* 已经 aborted 的 Parent 创建 Child 时，Child 立即 aborted。

## 3. 必须贯穿

确认 Signal 传入：

* Main Harness
* ExecutionEngine
* 模型请求
* WorkflowEngine
* WorkflowRunner
* ToolBroker
* Tool execute context
* BinaryTool/spawn
* Specialist Harness
* Background Job

## 4. Orchestrator.cancel()

改为异步：

```ts
async cancel(reason: string): Promise<void>
```

必须：

1. 幂等。
2. Abort Task Controller。
3. 取消运行中的 Workflow。
4. 取消运行中的 Specialist。
5. 取消可取消 Job。
6. 等待必要清理。
7. 所有 Run 状态收敛。
8. Task 进入 cancelled。
9. 不留下 running 状态。

---

# 十、移除 JobManager monkey patch 与轮询

修改 BackgroundJobManager。

## 1. 增加正式事件

定义：

```ts
export type BackgroundJobEvent =
  | { type: "JOB_STARTED"; job: BackgroundJob }
  | { type: "JOB_UPDATED"; job: BackgroundJob }
  | { type: "JOB_COMPLETED"; job: BackgroundJob }
  | { type: "JOB_FAILED"; job: BackgroundJob }
  | { type: "JOB_CANCELLED"; job: BackgroundJob }
```

提供：

```ts
subscribe(
  listener: (event: BackgroundJobEvent) => void
): () => void
```

## 2. JobManager 内部发事件

在真实状态发生变化的位置发事件：

* spawn 完成创建
* running
* success
* failed
* cancelled

不要让 Orchestrator 主动轮询。

## 3. Runtime 订阅

在 `createCTFTaskRuntime()` 中：

```ts
const unsubscribe = jobManager.subscribe(event => {
  taskStateProjector.projectJobEvent(event)
})
```

在 dispose 中取消订阅。

## 4. 删除

必须删除：

```ts
origSpawn
jm.spawn = ...
setTimeout(tick, 25)
ACTIVE_JOBS_REPLACED
```

如果 `ACTIVE_JOBS_REPLACED` 仅用于 monkey patch，同步删除该事件和 reducer 分支。

---

# 十一、修复 TaskState Event

检查并重构：

```text
src/core/ctfRuntime/taskEvents.ts
src/core/ctfRuntime/taskStateStore.ts
src/core/ctfRuntime/taskState.ts
```

## 1. Hypothesis

事件：

```ts
{
  type: "HYPOTHESIS_ADDED"
  hypothesis: CTFHypothesis
}
```

Reducer：

```ts
return {
  ...state,
  hypotheses: [...state.hypotheses, event.hypothesis]
}
```

## 2. Attempt

事件：

```ts
{
  type: "ATTEMPT_RECORDED"
  attempt: CTFAttempt
}
```

Reducer 真正加入数组。

## 3. Job

事件：

```ts
{
  type: "JOB_RECORDED"
  job: JobRecord
}
```

以及：

```ts
{
  type: "JOB_UPDATED"
  jobId: string
  patch: Partial<JobRecord>
}
```

Reducer 真正更新。

## 4. 更新事件

补充：

```ts
HYPOTHESIS_UPDATED
ATTEMPT_UPDATED
JOB_UPDATED
```

## 5. 不变量

必须检查：

* ID 不重复。
* 不更新不存在的对象。
* completed Attempt 不返回 running。
* terminal Job 不返回 running。
* Task 结束后不能创建新 Attempt。
* 迟到 Job Event 不能覆盖 Task completion。
* 已完成 Task 可保留只读审计产物，但不能恢复执行。

---

# 十二、调整 active 字段语义

当前字段若保存全部历史记录，不要继续命名为：

```ts
activeAgentRuns
activeWorkflowRuns
activeJobs
```

建议改为：

```ts
agentRuns
workflowRuns
jobs
```

活跃对象通过状态筛选：

```ts
state.agentRuns.filter(run => run.status === "running")
```

或者同时维护：

```ts
agentRuns
activeAgentRunIds
```

二选一。

不要保留误导性命名。

更新：

* TaskState
* Events
* Reducer
* Orchestrator
* Tests
* 文档

---

# 十三、建立 TaskStateProjector

创建：

```text
src/core/ctfRuntime/taskStateProjector.ts
```

职责：

* Main Agent 产物投影
* Workflow 产物投影
* Specialist 产物投影
* Job 生命周期投影
* Finding/Artifact 去重

## 快照结构

```ts
export interface TaskOutputSnapshot {
  findingIds: ReadonlySet<string>
  artifactIds: ReadonlySet<string>
}
```

方法：

```ts
capture(
  findingStore: FindingStore,
  artifactStore: ArtifactStore
): TaskOutputSnapshot

projectDiff(
  before: TaskOutputSnapshot,
  after: TaskOutputSnapshot,
  metadata: {
    taskId: string
    producerAgentId: string
    agentRunId?: string
    workflowRunId?: string
    handoffId?: string
  }
): {
  findingIds: string[]
  artifactIds: string[]
}
```

## Main Agent 流程

```text
snapshot before
→ runTurn
→ snapshot after
→ projectDiff
→ 更新 AgentRun.producedFindingIds
→ 更新 AgentRun.producedArtifactIds
```

不允许固定空数组。

## Workflow 流程

```text
snapshot before
→ runWorkflow
→ snapshot after
→ projectDiff
→ 更新 WorkflowRun 产物
```

## Specialist 流程

统一使用相同 Projector。

不要在 Specialist 路径中保留一套手写复制逻辑、Main Agent 再使用另一套逻辑。

## Artifact 文件复制

如果 Specialist 有独立 ArtifactStore：

1. 将真实文件安全复制到 Parent artifactDir。
2. 生成 Parent Artifact ID。
3. 保留：

   * originalArtifactId
   * producerAgentId
   * handoffId
   * sourcePath
4. 不允许只把子 Artifact 的 ID 写进父 State，却没有复制实际文件。

---

# 十四、有限拆分 TaskOrchestrator

当前 Orchestrator 不应继续承担：

* Runtime 创建
* Job 订阅
* Specialist Harness 创建
* Handoff 全生命周期
* 产物复制
* Profile 切换
* State Projector
* Abort 工具函数

本轮最多拆成：

```text
src/core/ctfRuntime/
├── createCTFTaskRuntime.ts
├── taskOrchestrator.ts
├── taskExecutionContext.ts
├── taskState.ts
├── taskEvents.ts
├── taskStateStore.ts
├── taskStateProjector.ts
├── handoffCoordinator.ts
├── specialistHarnessFactory.ts
├── agentRuntimeDependencies.ts
└── linkedAbortController.ts
```

## TaskOrchestrator 保留

* 公开任务级 API
* runMainAgent
* runWorkflow
* request/approve/reject Handoff 的高层入口
* switchProfile
* completeTask
* cancel
* dispose

## HandoffCoordinator

负责：

* 选择 Specialist
* Handoff 状态机
* 防重复 approve
* SpecialistFactory 调用
* Specialist 结果收回

## 禁止过度拆分

不要创建：

* Service Locator
* DI Container
* RuntimeManagerFactoryBuilder
* 每个函数一个 class
* 20 个新接口

---

# 十五、Profile 正确性

检查 ToolBroker 当前实现。

如果动态 Profile 仍保存在 readonly `opts.profile` 中，需要将动态字段移出不可变 Options。

建议：

```ts
class ToolBroker {
  private currentProfile: CapabilityProfile
  private readonly opts: StaticToolBrokerOptions

  getProfile(): CapabilityProfile {
    return this.currentProfile
  }

  setProfile(profile: CapabilityProfile): void {
    this.currentProfile = profile
  }
}
```

禁止使用类型断言修改 readonly 配置。

## switchProfile 顺序

```text
resolve profile
→ 校验工具依赖
→ 准备新 Tool Exposure
→ Broker setProfile
→ TaskState PROFILE_CHANGED
→ 清理缓存
```

失败时不允许出现一半新一半旧。

Main Agent 的 Prompt 必须在下一轮读取新 Profile，而不是闭包捕获初始化 Profile。

---

# 十六、真实运行路径

完成后必须是：

## Workflow-only

```text
CTF CLI
→ createCTFTaskRuntime
→ CTFTaskOrchestrator.runWorkflow
→ WorkflowRunner
→ ToolBroker
→ TaskStateProjector
→ TaskState
```

## Main Agent

```text
CTF CLI
→ createCTFTaskRuntime
→ CTFTaskOrchestrator.runMainAgent
→ Main Harness
→ ToolBroker
→ TaskStateProjector
→ TaskState
```

## Specialist

```text
Agent 请求 Handoff
→ Orchestrator.requestHandoff
→ approveHandoff
→ HandoffCoordinator
→ SpecialistHarnessFactory
→ Specialist Harness
→ TaskStateProjector
→ Parent TaskState
```

## Cancel

```text
SIGINT
→ Runtime.cancel
→ Orchestrator.cancel
→ Task AbortController
→ Main/Workflow/Specialist/Tool/Job
→ TaskState cancelled
```

不存在其他真实执行路径。

---

# 十七、必须增加的测试

## 1. CLI 测试

验证：

* Workflow 模式调用 `orchestrator.runWorkflow`。
* 普通任务调用 `orchestrator.runMainAgent`。
* CLI 不直接创建 Harness。
* CLI 不访问 Broker 私有字段。
* SIGINT 调用 Runtime cancel。
* finally 调用 dispose。

## 2. Legacy Handoff 测试

验证：

* `dispatchNext` 无 Orchestrator 时抛错。
* `dispatchNext` 不接受 `autoExecute`。
* `orchestratorDispatch.ts` 不 import `createHarness`。
* Specialist 只启动一次。

## 3. Specialist Factory 测试

验证 Specialist 获得：

* Client
* Renderer
* Model config
* Profile
* Subtask Context
* Parent-linked AbortSignal
* Narrowed Scope
* 独立 sessionDir
* 独立 artifactDir

## 4. Abort 测试

验证：

* Parent abort 后 Child Signal 立即 aborted。
* Child abort 不影响 Parent。
* dispose 移除监听。
* Workflow 取消后状态不是 running。
* Specialist 取消后 Handoff 不是 running。

## 5. Job Event 测试

验证：

* JobManager 不需要轮询。
* Job started/completed/failed/cancelled 进入 TaskState。
* dispose 后不再接收事件。
* 没有 Timer 泄漏。

## 6. Reducer 测试

验证：

* Hypothesis 真正加入。
* Attempt 真正加入。
* Job 真正加入。
* 更新不存在 ID 报错。
* 重复 ID 报错。
* 非法状态回退报错。

## 7. Projector 测试

验证：

* Main Agent Finding 被投影。
* Main Agent Artifact 被投影。
* Workflow Finding 被投影。
* Specialist Artifact 文件被复制到 Parent artifactDir。
* 重复 ID 不重复添加。
* produced IDs 不再固定为空。

## 8. 集成测试

至少建立一条：

```text
Fake CLI
→ Runtime
→ Orchestrator
→ Main Agent Fake Client
→ request Handoff
→ Specialist Fake Client
→ Finding 产生
→ Parent TaskState 收到 Finding
→ dispose
```

不连接真实网络。

---

# 十八、静态禁止检查

完成修改后，以下命令必须无匹配，或只有文档/明确测试断言匹配：

```bash
rg -n "autoExecute" src/core/orchestratorDispatch.ts

rg -n "createHarness" src/core/orchestratorDispatch.ts

rg -n "child\.runTurn" src/core/orchestratorDispatch.ts

rg -n "jm\.spawn.*=" src/core/ctfRuntime

rg -n "setTimeout\(tick,\s*25" src/core

rg -n "harness\.context\.abortSignal\s*$" src/core

rg -n "broker.*opts|\.opts\.contestScope" bin/ovogogogo-ctf.ts

rg -n "harness\.runWorkflow" bin/ovogogogo-ctf.ts

rg -n "producedFindingIds:\s*\[\]" src/core/ctfRuntime

rg -n "producedArtifactIds:\s*\[\]" src/core/ctfRuntime
```

注意：

空数组可以出现在初始化记录中，但不能作为运行完成后的固定返回结果。

如果搜索命中初始化代码，要在报告中解释。

---

# 十九、验证命令

执行：

```bash
pnpm typecheck
pnpm build
pnpm lint
pnpm test
```

随后运行：

```bash
node dist/bin/ovogogogo-ctf.js --help
```

再运行一个不需要模型的 Workflow smoke test。

使用仓库已有样本或创建临时无害文本文件：

```bash
printf 'RkxBR3t0ZXN0fQ==' > /tmp/ctf-input.txt

node dist/bin/ovogogogo-ctf.js \
  --profile crypto \
  --run-workflow encoding_sweep \
  --text 'RkxBR3t0ZXN0fQ=='
```

检查：

* CLI 成功创建 Runtime。
* Workflow 通过 Orchestrator。
* TaskState 存在 Workflow Run。
* Runtime dispose 成功。
* 没有挂起 Timer。
* 进程正常退出。

不要使用真实公共目标。

---

# 二十、完成标准

只有全部满足才能结束。

## CLI

* CTF CLI 不直接创建 Harness。
* Workflow 经过 Orchestrator。
* Main Agent 经过 Orchestrator。
* SIGINT 经过 Runtime cancel。
* CLI 不访问私有字段。
* CLI 执行 finally dispose。

## Handoff

* Legacy dispatch 不再创建 Specialist。
* `autoExecute` 被删除。
* 无 Orchestrator 明确失败。
* Specialist 只有一个创建入口。
* 重复 approve 不重复执行。

## Job

* 没有 monkey patch。
* 没有 25ms 轮询。
* 使用正式 Job Event。
* dispose 取消订阅。

## Abort

* Task 创建时就有 Signal。
* Main Agent 收到 Signal。
* Workflow 收到 Signal。
* Tool 收到 Signal。
* Specialist 收到 linked Signal。
* Job 收到取消。
* 状态最终收敛。

## State

* Hypothesis 真正存入 State。
* Attempt 真正存入 State。
* Job 真正存入 State。
* Main Agent 产物进入 State。
* Workflow 产物进入 State。
* Specialist 产物进入 State。
* Artifact 文件真实存在。
* active 字段语义正确。

## 架构

* Runtime 只有一个创建入口。
* Orchestrator 不再自行装配所有依赖。
* SpecialistFactory 是唯一 Specialist Harness Factory。
* Projector 统一产物同步。
* 没有 V2 或平行 Runtime。
* 没有 private-field hack。
* 没有新增大量 `any`。

## 质量

* Typecheck 通过。
* Build 通过。
* Lint 通过。
* Tests 通过。
* Smoke test 通过。
* README 与实际架构一致。

---

# 二十一、最终报告

按照以下格式汇报。

## 1. 审计命中

列出每个旧模式原本存在的位置。

## 2. 删除的旧路径

明确列出：

* CLI direct Harness
* CLI direct Workflow
* Broker private hack
* Legacy Handoff autoExecute
* Job spawn monkey patch
* Job polling
* 无效 Abort
* 空 reducer

## 3. 最终运行路径

分别说明：

* Workflow
* Main Agent
* Handoff
* Specialist
* Cancel
* Dispose

## 4. 文件变更

列出：

* 新增
* 修改
* 删除
* 废弃兼容接口

## 5. 状态所有权

说明：

* TaskState
* Profile
* Handoff
* Agent Run
* Workflow Run
* Job
* Finding
* Artifact
* AbortController

分别由谁拥有。

## 6. 验证结果

列出真实命令和结果。

## 7. 静态禁止检查

逐条列出 `rg` 命令结果。

## 8. 未解决问题

只列真实存在但不影响唯一主路径的问题。

不要列：

* Evidence Graph
* Workflow 智能化
* 更多工具

这些属于下一阶段，不是本轮未完成。

---

# 二十二、立即执行

现在开始。

执行顺序严格为：

```text
基线
→ 搜索旧路径
→ Runtime Factory
→ CLI 切换
→ Legacy Handoff 删除
→ Specialist Factory
→ Abort 贯通
→ Job Event
→ Reducer 修复
→ Projector
→ Orchestrator 有限拆分
→ 测试
→ 静态禁止检查
→ Smoke Test
→ 文档
```

不要在完成 Runtime Factory 后停止。

不要只让测试调用新架构。

真实 CTF CLI 必须使用新架构。

不要保留 fallback 以“兼容”。

本轮任务完成的判断标准只有一个：

> 从 `ovogogogo-ctf` CLI 入口开始，所有实际执行都经过同一个 CTFTaskRuntime 和 CTFTaskOrchestrator，旧路径无法再启动任何 Agent、Workflow 或 Specialist。
