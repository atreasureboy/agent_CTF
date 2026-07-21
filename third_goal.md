# Agent_CTF Phase 1.5：主运行路径收敛与架构正确性修复

你正在当前 `agent_CTF` 仓库中工作。

上一轮已经新增了以下架构组件：

* `TaskExecutionContext`
* `CTFTaskState`
* `CTFTaskEvent`
* `CTFTaskStateStore`
* `CTFTaskOrchestrator`
* 新的 Handoff 生命周期
* ContestConfig、Workspace、Profile 相关调整

但是当前架构仍未真正完成迁移。

目前存在的核心问题是：

> 新的 Orchestrator 和 TaskState 已经建立，但真实 CLI、Harness、Workflow、Specialist 和旧 Handoff 路径仍有部分绕过新架构，导致新旧控制路径并存。

本轮任务不是继续设计新架构。

本轮唯一目标是：

> 让 `CTFTaskOrchestrator` 真正成为 CTF 任务的唯一控制入口，并修复 Specialist 依赖传递、取消机制、Profile 状态、TaskState 投影和旧 Handoff 路径。

你必须直接检查并修改当前仓库。

不要只输出方案。

不要等待确认。

---

# 一、本轮必须解决的问题

必须完成以下八项：

1. CLI 主路径接入 `CTFTaskOrchestrator`
2. Specialist Harness 正确继承模型和运行时依赖
3. AbortSignal 真正贯穿 Main Agent、Workflow、Tool 和 Specialist
4. 删除旧 Handoff 的独立执行路径
5. 修复 Profile 的单一状态源
6. 修复 Hypothesis、Attempt、Job 等事件不更新 State 的问题
7. Main Agent 和 Workflow 产物必须同步进入 TaskState
8. 清理 JobManager monkey patch 和轮询式状态同步

本轮完成后：

```text
CLI
  ↓
CTFTaskOrchestrator
  ↓
Main Agent / Workflow / Specialist
  ↓
统一 TaskState
```

必须成为实际执行路径，而不是只存在于测试中的旁路架构。

---

# 二、本轮禁止事项

本轮不要进行以下工作：

* 不增加新 CTF 工具
* 不增加新 Specialist
* 不增加新 Workflow
* 不实现完整 Evidence Graph
* 不实现自动 Flag 提交
* 不重写底层 ExecutionEngine
* 不重写全部 Workflow
* 不重写全部 ToolBroker
* 不设计复杂 Agent 评分系统
* 不增加数据库
* 不引入消息队列
* 不引入大型状态管理框架
* 不重做 UI
* 不扩展 Memory
* 不创建 Orchestrator V2
* 不保留新旧两套永久主路径

允许对上一轮新增的代码进行重构。

如果上一轮的某些设计存在明显错误，应直接修正，不要为了“兼容上一轮”保留错误结构。

---

# 三、开始前必须完成的审计

先阅读并分析当前最新代码。

重点检查以下文件或功能对应文件：

```text
bin/ovogogogo-ctf.ts

src/core/harness.ts
src/core/orchestratorDispatch.ts
src/core/toolBroker.ts
src/core/workflowRunner.ts
src/core/contestConfig.ts

src/core/ctfRuntime/taskOrchestrator.ts
src/core/ctfRuntime/taskState.ts
src/core/ctfRuntime/taskEvents.ts
src/core/ctfRuntime/taskStateStore.ts
src/core/ctfRuntime/taskExecutionContext.ts

src/core/findings.ts
src/core/artifacts.ts
src/core/backgroundJobs.ts

所有包含以下关键词的位置：

createHarness
runTurn
runWorkflow
approveHandoff
dispatchNext
runSpecialist
switchProfile
setProfile
AbortController
abortSignal
process.cwd
sessionDir
activeAgentRuns
activeWorkflowRuns
activeJobs
HYPOTHESIS_ADDED
ATTEMPT_RECORDED
JOB_RECORDED
```

必须确认：

1. CLI 当前是否创建 Orchestrator。
2. CLI 的普通任务是否仍直接调用 Harness。
3. CLI 的 Workflow 是否仍直接调用 Harness 或 WorkflowRunner。
4. Specialist Harness 创建时是否继承了 client、renderer、model、event sink。
5. Orchestrator 的 AbortController 是否真正传入了执行链。
6. Harness 是否闭包捕获了初始 Profile。
7. ToolBroker 是否仍通过类型断言修改 readonly/private 配置。
8. `approveHandoff()` 和 `dispatchNext()` 是否都能启动 Specialist。
9. Main Agent 产出的 Finding/Artifact 是否进入 TaskState。
10. Workflow 产出的 Finding/Artifact 是否进入 TaskState。
11. JobManager 是否仍通过替换函数或定时轮询同步状态。
12. `activeAgentRuns` 等字段究竟表示活跃对象还是历史记录。

把实际发现更新到：

```text
docs/architecture/ctf-runtime-refactor.md
```

不要完成审计后停止。

---

# 四、第一目标：CLI 必须全面使用 Orchestrator

当前真实 CLI 必须成为新架构入口。

## 目标结构

CLI 不应再直接拥有 CTF 调度逻辑。

应当类似：

```ts
const orchestrator = await createCTFTaskOrchestrator({
  client,
  renderer,
  modelConfig,
  profile,
  contestConfig,
  contestScope,
  workspaceDir,
  sessionDir,
  artifactDir,
})

await orchestrator.createTask(...)

await orchestrator.runMainAgent(...)
```

Workflow 模式应当是：

```ts
await orchestrator.runWorkflow(workflowId, variables)
```

Handoff 应当是：

```ts
await orchestrator.approveHandoff(handoffId)
```

取消应当是：

```ts
await orchestrator.cancel(reason)
```

## 必须迁移的 CLI 路径

检查并迁移：

* 普通 CTF Agent 对话模式
* 单次任务模式
* Workflow 模式
* 指定 Profile 模式
* 指定 ContestConfig 模式
* 恢复 Session 或指定 Workspace 模式
* 中断信号处理
* CLI 退出清理

## 禁止

CLI 中不允许继续：

```ts
harness.runWorkflow(...)
```

不允许直接修改：

```ts
harness.broker.opts
```

不允许 CLI 自己创建 Handoff Scheduler。

不允许 CLI 同时创建一个 Harness 和一个互不相关的 Orchestrator。

Harness 必须由 Orchestrator 创建或注入。

## 兼容性

CLI 参数和用户使用方式尽量保持不变。

确实需要调整内部初始化顺序时，可以修改，但不要无意义改变命令名称和参数。

---

# 五、建立明确的 RuntimeDependencies

当前 Specialist 不能只继承 TaskExecutionContext。

它还必须继承真实运行所需的基础依赖。

创建或整理统一类型：

```ts
export interface AgentRuntimeDependencies {
  client: OpenAIClient
  renderer: Renderer
  modelConfig: ModelConfig

  eventSink?: RuntimeEventSink
  logger?: Logger

  toolRegistry?: ToolRegistry
  moduleRegistry?: ModuleRegistry
}
```

根据仓库实际类型修改。

不要重复已有类型。

## 要求

主 Agent 和 Specialist 共享：

* OpenAI client
* Renderer 或可派生 Renderer
* 模型配置
* Logger
* Event sink
* 全局 Tool/Module Registry

主 Agent 和 Specialist 不共享：

* Agent Profile
* Agent Run ID
* 子任务 sessionDir
* 子任务 artifactDir
* 当前消息上下文
* 当前 Harness 实例
* 当前 AbortController

## SpecialistHarnessFactory

创建正式 Factory，例如：

```ts
export interface SpecialistHarnessFactory {
  create(input: {
    context: TaskExecutionContext
    profile: AgentProfile
    dependencies: AgentRuntimeDependencies
    parentTaskId: string
    handoffId: string
  }): Promise<HarnessBundle>
}
```

或者等价结构。

Factory 必须负责：

* 创建 Specialist Harness
* 注入 client
* 注入 renderer
* 注入 model config
* 注入派生 Context
* 注入 AbortSignal
* 注入正确 Profile
* 设置 Specialist Agent ID
* 建立 Finding/Artifact 关联
* 保证 teardown

## 禁止

不允许在 `approveHandoff()` 内临时拼装不完整 Harness。

不允许创建缺少 Renderer 的子 Harness 后直接调用 `runTurn()`。

不允许 Specialist 回退到全局 `process.cwd()`。

不允许 Specialist 使用比父任务更宽的 Scope。

---

# 六、让 AbortSignal 真正贯穿运行链

当前 Orchestrator 的取消不能只修改 TaskState。

需要建立真实中断链。

## TaskExecutionContext

创建 Task 时必须包含真实 Signal：

```ts
const taskAbortController = new AbortController()

const context: TaskExecutionContext = {
  ...,
  abortSignal: taskAbortController.signal,
}
```

不要创建后再尝试修改 readonly Context。

Context 应在构造时完整建立。

## 子任务 Signal

Specialist 和 Workflow 应使用子 AbortController，并与父 Signal 关联。

可实现：

```ts
function createLinkedAbortController(
  parentSignal?: AbortSignal
): AbortController
```

父任务取消时：

* Main Agent 中止
* Workflow 中止
* Specialist 中止
* Tool 调用收到 Signal
* Background Job 根据当前能力取消或标记取消
* TaskState 最终进入 cancelled

子 Specialist 自己失败或取消时，不应自动取消整个父任务，除非策略明确要求。

## 必须检查 Signal 是否传到

* 模型 API 请求
* Streaming consumer
* ToolBroker
* ToolExecutor
* WorkflowRunner
* Bash/spawn 子进程
* Specialist Harness
* Background Job

已有模块不支持 AbortSignal 时，添加最小必要接口。

不要重写整个模块。

## cancel()

`cancel()` 必须：

1. 防止重复取消。
2. 先将任务标记为正在取消或记录取消请求。
3. abort 父 Controller。
4. 中止活跃 Agent、Workflow、Specialist。
5. 处理可取消 Job。
6. 等待必要清理。
7. 将 TaskState 收敛到 `cancelled`。
8. 不留下 running 状态。

必须使用 `try/finally`。

---

# 七、Profile 必须成为真正单一状态源

当前不能同时存在：

```text
TaskState.activeProfileId
Harness 初始化时捕获的 profile
ToolBroker 内部 profile
WorkflowRunner 默认 profile
System Prompt 构建时的旧 profile
```

## 建立 ProfileStore 或 RuntimeProfileState

可以创建轻量组件：

```ts
export interface ProfileStore {
  getCurrent(): AgentProfile
  switchTo(profile: AgentProfile): void
  subscribe(listener: ProfileListener): Unsubscribe
}
```

也可以由 Orchestrator 持有当前 Profile，并通过 getter 注入。

但必须保证所有组件读取同一个权威来源。

## Harness 修改

检查 Harness 是否：

```ts
const profile = options.profile
```

然后在闭包中长期使用。

如果是，必须调整为：

```ts
getCurrentProfile()
```

在以下操作发生时读取当前 Profile：

* System Prompt 构建
* Tool exposure
* agentId
* 模型参数
* Workflow 默认 Agent
* 权限策略
* Budget
* Context Patch

## ToolBroker 修改

禁止：

```ts
(this.opts as any).profile = profile
```

禁止：

```ts
broker["opts"].profile = profile
```

改为正式公开方法或依赖 ProfileStore：

```ts
broker.setProfile(profile)
```

该方法不能继续通过 private 字段 hack 实现。

如果 `opts` 本身应该是不可变配置，则将动态 Profile 从 `opts` 中移出。

## switchProfile()

必须作为原子操作：

```text
校验 Profile
→ 更新 ProfileStore
→ 更新 TaskState
→ 重新计算 Tool Exposure
→ 更新权限策略
→ 更新 Prompt Context
→ 清理相关缓存
→ 发布 PROFILE_CHANGED
```

任何一步失败时，不能出现一半新、一半旧的状态。

可以先准备新配置，全部成功后再提交。

## Handoff

Handoff 启动 Specialist 时：

* 不修改主 Agent Profile
* 使用 Specialist 自己的 Profile
* 主 Agent Profile 保持不变

---

# 八、删除旧 Handoff 的独立执行路径

本轮结束后，只允许以下真实路径启动 Specialist：

```text
Orchestrator.approveHandoff()
→ HandoffCoordinator
→ SpecialistHarnessFactory
→ Specialist Harness
```

## 检查并修改

重点检查：

```text
harness.approveHandoff()
orchestratorDispatch.dispatchNext()
HandoffStore
旧 Agent Scheduler
```

## 兼容方法

如果旧 API 必须保留：

```ts
harness.approveHandoff(id)
```

它只能委托：

```ts
return orchestrator.approveHandoff(id)
```

如果没有绑定 Orchestrator，应明确报错：

```text
CTF handoff requires an attached CTFTaskOrchestrator
```

不能自行执行 Specialist。

## dispatchNext()

如果该函数仍有外部调用：

* 改为 Orchestrator 内部适配。
* 或标记 deprecated 并委托 Orchestrator。
* 删除没有 Orchestrator 时自动创建子 Harness 的 fallback。

禁止继续存在：

```text
有 Orchestrator → 走新路径
无 Orchestrator → 走旧 Specialist 执行路径
```

## Handoff 生命周期

唯一允许：

```text
requested
→ approved
→ running
→ completed
```

异常路径：

```text
requested → rejected
approved/running → failed
requested/approved/running → cancelled
```

必须防止：

* 重复 approve
* completed 后重新执行
* rejected 后执行
* failed 后自动重试同一 Record
* 两个并发 approve 启动两个 Agent

使用 `inFlightHandoffs: Map<string, Promise<...>>` 或轻量锁。

---

# 九、修复 TaskState 事件无效问题

检查以下事件：

```text
HYPOTHESIS_ADDED
HYPOTHESIS_UPDATED
ATTEMPT_RECORDED
ATTEMPT_UPDATED
JOB_RECORDED
JOB_UPDATED
```

如果事件只携带 ID，而 Reducer 无法更新完整 State，必须修复。

## 事件必须携带足够数据

例如：

```ts
{
  type: "HYPOTHESIS_ADDED"
  hypothesis: CTFHypothesis
}
```

```ts
{
  type: "ATTEMPT_RECORDED"
  attempt: CTFAttempt
}
```

```ts
{
  type: "JOB_RECORDED"
  job: JobRecord
}
```

更新事件可以携带完整新对象，或者：

```ts
{
  type: "ATTEMPT_UPDATED"
  attemptId: string
  patch: Partial<CTFAttempt>
}
```

必须避免非法字段修改。

## Reducer 要求

Reducer 必须真正更新：

```ts
state.hypotheses
state.attempts
state.jobs
```

不能收到事件后直接返回原 State。

必须防止：

* 重复 ID
* 更新不存在对象
* completed Attempt 再回到 running
* completed Job 重新进入 pending
* Task 完成后新增 Attempt

## 命名修正

如果字段保存历史记录，不要继续命名为：

```text
activeAgentRuns
activeWorkflowRuns
activeJobs
```

建议改成：

```text
agentRuns
workflowRuns
jobs
```

并通过状态筛选活跃对象。

或者拆成：

```ts
agentRuns: AgentRunRecord[]
activeAgentRunIds: string[]
```

不要让名称与实际语义矛盾。

修改后更新所有调用点。

---

# 十、Main Agent 和 Workflow 产物必须进入 TaskState

当前不能只有 Specialist 产物被同步。

## 需要同步的产物

每次 Main Agent、Workflow、Specialist 执行后，都要同步：

* 新 Finding
* 新 Artifact
* 新 FlagCandidate
* 必要的 Attempt
* 运行摘要
* 失败原因

## 推荐实现：State Projector

创建轻量组件：

```ts
export class TaskStateProjector {
  captureSnapshot(): TaskOutputSnapshot

  projectDiff(
    before: TaskOutputSnapshot,
    after: TaskOutputSnapshot,
    metadata: ProjectionMetadata
  ): CTFTaskEvent[]
}
```

Snapshot 可以包含：

```ts
interface TaskOutputSnapshot {
  findingIds: Set<string>
  artifactIds: Set<string>
  flagCandidateIds: Set<string>
}
```

运行流程：

```text
执行前 Snapshot
→ 执行 Agent/Workflow
→ 执行后 Snapshot
→ 计算差集
→ 发布 FINDING_ADDED / ARTIFACT_ADDED / FLAG_CANDIDATE_ADDED
```

如果现有 FindingStore、ArtifactStore 已支持事件订阅，可以直接订阅。

但不要同时使用订阅和快照产生重复事件。

选择一个明确方案。

## Main Agent

`runMainAgent()` 不允许继续返回固定空数组：

```ts
producedFindingIds: []
producedArtifactIds: []
```

必须返回实际差集。

## Workflow

`runWorkflow()` 必须同步 Workflow 期间新增的 Finding 和 Artifact。

Workflow 完成不代表 Task 完成。

Workflow 失败也不一定代表 Task 失败。

由 Orchestrator 根据错误类型和策略决定下一步。

## 去重

TaskState 中 Finding ID 和 Artifact ID 不允许重复。

---

# 十一、清理 JobManager monkey patch

检查当前是否通过以下方式监听 Job：

* 替换 `jobManager.spawn`
* 定时轮询状态
* 每 25ms 检查一次
* 修改其他对象方法以截获生命周期

这些方式必须移除。

## 正确方案

给 JobManager 增加正式生命周期订阅接口：

```ts
type JobEvent =
  | { type: "JOB_STARTED"; job: JobRecord }
  | { type: "JOB_UPDATED"; job: JobRecord }
  | { type: "JOB_COMPLETED"; job: JobRecord }
  | { type: "JOB_FAILED"; job: JobRecord }
  | { type: "JOB_CANCELLED"; job: JobRecord }

interface JobManager {
  subscribe(listener: (event: JobEvent) => void): Unsubscribe
}
```

如果已有 EventEmitter，应复用。

Orchestrator 创建时订阅。

`dispose()` 时取消订阅。

## 要求

* 不 monkey patch 方法。
* 不依赖高频轮询。
* 不泄漏 Timer。
* 不重复记录 Job。
* Job 更新能进入 TaskState。
* Task 取消时可取消 Job，或明确标记无法取消。
* 已完成 Task 收到迟到 Job Event 时，不得破坏 Completion 状态。

---

# 十二、拆分过大的 TaskOrchestrator

当前 `taskOrchestrator.ts` 如果已经承担过多职责，应进行有限拆分。

本轮建议最多拆为：

```text
src/core/ctfRuntime/
├── taskOrchestrator.ts
├── taskState.ts
├── taskEvents.ts
├── taskStateStore.ts
├── taskExecutionContext.ts
├── handoffCoordinator.ts
├── specialistHarnessFactory.ts
├── taskStateProjector.ts
└── linkedAbortController.ts
```

职责：

## TaskOrchestrator

负责公开任务级 API 和高层协调。

## HandoffCoordinator

负责：

* Handoff 生命周期
* Agent 选择
* 重复执行保护
* 调用 Specialist Factory
* 收回 Specialist 结果

## SpecialistHarnessFactory

负责创建完整 Specialist Harness。

## TaskStateProjector

负责把 Store/Run 产物投影到 TaskState。

## linkedAbortController

负责父子取消链。

不要继续拆出几十个类。

不要创建 Service Locator。

不要创建复杂 DI Container。

TaskOrchestrator 应保留清晰主流程，而不是变成所有子组件的空转发器。

---

# 十三、实际主流程必须变成以下形式

## CLI 初始化

```text
解析 CLI 参数
→ 构造 ContestConfig
→ 构造 ContestScope
→ 构造 RuntimeDependencies
→ 创建 CTFTaskOrchestrator
→ 创建 CTF Task
```

## Main Agent

```text
Orchestrator.runMainAgent
→ 创建 Main Agent Run Record
→ Snapshot
→ Harness.runTurn
→ Project 新 Finding/Artifact
→ 更新 Agent Run
→ 更新 TaskState
```

## Workflow

```text
Orchestrator.runWorkflow
→ 创建 Workflow Run Record
→ 使用 TaskExecutionContext
→ Snapshot
→ WorkflowRunner.execute
→ Project 新 Finding/Artifact
→ 更新 Workflow Run
```

## Handoff

```text
请求 Handoff
→ TaskState: requested
→ approveHandoff
→ TaskState: approved
→ SpecialistHarnessFactory
→ TaskState: running
→ Specialist runTurn
→ Project Finding/Artifact
→ TaskState: completed 或 failed
```

## Cancel

```text
CLI 信号
→ Orchestrator.cancel
→ 父 AbortController.abort
→ Main/Workflow/Specialist/Tool 收到 Signal
→ 清理运行对象
→ TaskState: cancelled
```

## Dispose

```text
取消订阅
→ 停止剩余任务
→ dispose Harness
→ dispose JobManager
→ 清理 Timer
→ 清理临时资源
```

---

# 十四、状态转换和错误收敛

所有异步入口必须保证状态最终收敛。

## Main Agent

```ts
record started
try {
  execute
  record completed
} catch (error) {
  if abort:
    record cancelled
  else:
    record failed
} finally {
  clear in-flight reference
}
```

## Workflow

同样处理。

## Specialist

同样处理，并更新 Handoff。

## 错误要求

不允许：

* 空 catch
* 只 console.error 后继续假装成功
* Agent Run 永久 running
* Workflow Run 永久 running
* Handoff 永久 approved
* Task cancel 后仍为 exploration
* Task solved 后被失败 Job 改成 failed

需要区分：

* 用户取消
* Scope 拒绝
* Profile 不可用
* Specialist 不存在
* 模型失败
* Tool 失败
* Workflow 失败
* 编程错误

保留原始 `cause`。

对外输出清晰摘要。

---

# 十五、测试要求

本轮不是建设 Benchmark，但必须增加主路径测试。

## 1. CLI 主路径测试

至少验证：

* CLI 初始化时创建 Orchestrator。
* Workflow 模式调用 Orchestrator，而不是直接调用 Harness。
* 普通任务调用 Orchestrator。
* SIGINT 或等价中断调用 Orchestrator.cancel。

可以将 CLI 初始化逻辑提取为可测试函数。

不要启动真实模型。

## 2. Specialist 完整依赖测试

创建 Fake Client 和 Fake Renderer。

验证 Specialist Factory 创建的 Harness 拥有：

* client
* renderer
* model config
* profile
* context
* abortSignal

验证 `runTurn()` 能走到 Fake Client，而不是因为缺依赖提前失败。

## 3. Handoff 唯一路径测试

验证：

* 旧 `dispatchNext()` 不再独立创建 Specialist。
* 旧 API 委托 Orchestrator。
* 没有 Orchestrator 时明确报错。
* 同一个 Handoff 并发 approve 只启动一次 Specialist。

## 4. Abort 测试

验证：

* 父任务取消后 Specialist Signal 为 aborted。
* Workflow 能收到 Signal。
* TaskState 最终为 cancelled。
* 不留下 running Run。

## 5. Profile 测试

验证：

* `switchProfile()` 后 TaskState 更新。
* Harness Prompt 使用新 Profile。
* Tool exposure 使用新 Profile。
* 主 Agent 切换不会修改已经运行中的 Specialist Profile。
* 不通过 private 字段访问实现。

## 6. State Event 测试

验证：

* Hypothesis 真正加入数组。
* Attempt 真正加入数组。
* Job 真正加入数组。
* 重复 ID 被拒绝。
* 非法状态转换被拒绝。

## 7. 产物投影测试

验证：

* Main Agent 新 Finding 进入 TaskState。
* Workflow 新 Artifact 进入 TaskState。
* Specialist 新 Finding/Artifact 进入 TaskState。
* 已存在 ID 不重复添加。

## 8. Job 事件测试

验证：

* 不需要轮询即可收到 Job 更新。
* dispose 后不再响应 Job Event。
* Task 完成后迟到事件不会修改 Completion。

---

# 十六、验证命令

以 `package.json` 的实际 scripts 为准执行：

```bash
pnpm typecheck
pnpm build
pnpm lint
pnpm test
```

如果使用 npm，则使用 npm。

必须记录真实结果。

不能写“理论上通过”。

如果存在重构前已有失败：

1. 先确认是否为原有失败。
2. 记录失败命令和错误。
3. 不删除测试。
4. 不跳过测试。
5. 不通过降低类型严格度解决。

---

# 十七、完成标准

只有全部满足才可以结束。

## 主路径

* CLI 创建并使用 `CTFTaskOrchestrator`。
* 普通任务通过 Orchestrator 执行。
* Workflow 通过 Orchestrator 执行。
* Handoff 通过 Orchestrator 执行。
* Cancel 通过 Orchestrator 执行。
* CLI 不再直接修改 Harness/ToolBroker 私有状态。

## Specialist

* Specialist Harness 拥有完整 RuntimeDependencies。
* Specialist 拥有正确 Renderer。
* Specialist 拥有正确 Client。
* Specialist 使用派生 Context。
* Specialist 使用自己的 Profile。
* Specialist Scope 不扩大。
* Specialist 可以被取消。
* Specialist 结果进入 TaskState。

## Abort

* 父 AbortSignal 贯穿执行链。
* Main Agent 可取消。
* Workflow 可取消。
* Tool 可取消。
* Specialist 可取消。
* TaskState 最终收敛。

## Profile

* Profile 存在唯一权威来源。
* Harness 不再永久捕获初始化 Profile。
* ToolBroker 不修改 private/readonly opts。
* `switchProfile()` 原子更新相关组件。
* Handoff 不通过切换主 Profile 实现。

## Handoff

* 只有一条真实 Specialist 执行路径。
* 旧 API 只做代理。
* 无 Orchestrator 时不再 fallback 执行。
* 并发 approve 不重复启动。
* Handoff 状态完整收敛。

## TaskState

* Hypothesis 事件真实更新 State。
* Attempt 事件真实更新 State。
* Job 事件真实更新 State。
* Main Agent 产物进入 State。
* Workflow 产物进入 State。
* Specialist 产物进入 State。
* 字段名称与实际语义一致。

## Job

* 没有 monkey patch。
* 没有高频轮询。
* 使用正式生命周期事件。
* dispose 清理订阅。
* 没有 Timer 泄漏。

## 工程

* 不存在 Orchestrator V2。
* 不存在永久双轨 Runtime。
* 不新增大量 `any`。
* 不存在 private 字段索引修改。
* 类型检查通过。
* 构建通过。
* 主要测试通过。
* 架构文档与实现一致。

---

# 十八、最终报告格式

完成修改后，按照以下格式输出。

## 1. 上一轮遗留问题

必须列出真实代码中确认的问题：

* CLI 绕过 Orchestrator
* Specialist 依赖缺失
* AbortSignal 未贯通
* Profile 状态分叉
* Handoff 双路径
* State Event 无效
* 产物未投影
* Job monkey patch

只列实际存在的问题。

## 2. 主路径迁移结果

说明以下路径最终如何执行：

```text
CLI → Orchestrator → Main Agent
CLI → Orchestrator → Workflow
Agent → Orchestrator → Handoff → Specialist
CLI Signal → Orchestrator → Cancel
```

## 3. 最终组件职责

列出：

* CTFTaskOrchestrator
* HandoffCoordinator
* SpecialistHarnessFactory
* TaskStateStore
* TaskStateProjector
* ProfileStore
* WorkflowRunner
* ToolBroker
* JobManager

说明状态所有权。

## 4. 文件变更

分别列出：

* 新增
* 修改
* 删除
* 废弃但保留的兼容接口

## 5. 删除的旧路径

明确列出：

* 哪条旧 Handoff 路径删除
* 哪个 CLI 直接调用删除
* 哪个 private hack 删除
* 哪个轮询或 monkey patch 删除

## 6. 测试结果

列出执行命令、通过数量和失败数量。

## 7. 未解决问题

只列本轮真实无法解决且不影响唯一主路径的问题。

不要生成泛化 TODO。

---

# 十九、执行顺序

严格按照以下顺序：

```text
1. 审计真实主路径
2. 建立 RuntimeDependencies
3. 建立 SpecialistHarnessFactory
4. 接通 AbortSignal
5. 修复 Profile 单一状态源
6. 修复 TaskEvent 和 Reducer
7. 建立 TaskStateProjector
8. 清理 JobManager monkey patch
9. 合并 Handoff 路径
10. 迁移 CLI 到 Orchestrator
11. 删除旧执行路径
12. 添加主路径测试
13. 类型检查、构建、测试
14. 更新架构文档
```

不要一开始就重写整个 Orchestrator。

每完成一阶段，先运行类型检查或相关测试，再进入下一阶段。

迁移时使用：

```text
建立新接口
→ 接入现有实现
→ 切换真实调用点
→ 验证
→ 删除旧路径
```

不要长期双写。

---

# 二十、立即开始

现在开始阅读当前仓库最新代码。

先确认上一轮实际实现与本任务描述是否一致。

以真实代码为准调整细节。

不要只输出计划。

不要请求用户确认。

不要提前停止在“架构已搭建”。

本轮最终目标不是新增文件数量，而是：

> 从真实 CLI 启动开始，Main Agent、Workflow、Handoff、Specialist、Profile、取消和产物状态全部通过同一个 CTFTaskOrchestrator 控制。

只有当新 Runtime 真正接管生产主路径、旧独立路径被删除后，任务才算完成。
