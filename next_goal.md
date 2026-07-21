# Agent_CTF 第一阶段架构重构任务

你正在当前仓库 `agent_CTF` 中工作。

这是一个用于合法 CTF 竞赛和靶场解题的多 Agent 系统，基于通用 Agent Harness 扩展了 CTF Profile、专用工具、Workflow、Finding、Artifact、Handoff、后台任务和 Specialist Agent。

本次任务不是继续增加 CTF 工具，也不是扩充题型。

本次唯一目标是：

> 统一 CTF 解题任务的状态和调度控制，使主 Agent、Workflow、Specialist Agent、Handoff 和后台任务由同一个 CTF Orchestrator 管理。

你必须直接阅读并修改仓库代码。

不要只输出分析、计划或建议。

不要等待用户确认。

---

# 一、任务范围

本轮只完成以下四个核心目标：

1. 创建统一的 `CTFTaskState`。
2. 创建唯一的 `CTFTaskOrchestrator`。
3. 合并 Handoff 的审批路径和实际执行路径。
4. 修复 Workspace、ContestScope、Profile 三类状态不一致问题。

本轮暂时不要完成：

* 不重写底层通用 `ExecutionEngine`
* 不增加新的 CTF 工具
* 不增加新的 Specialist Agent
* 不增加新的 Workflow
* 不建设 benchmark 或 eval 系统
* 不重写所有 Workflow Step
* 不全面实现 Evidence Graph
* 不全面实现 Flag 自动提交
* 不重做 CLI 或 UI
* 不大规模修改 Prompt
* 不重做 Memory 系统
* 不删除当前已经存在的 CTF 功能

允许为了兼容新架构，对现有文件进行必要调整。

---

# 二、必须先完成仓库审计

开始修改代码前，先阅读仓库。

重点阅读以下内容；文件名不存在时，搜索功能相同的文件：

```text
README.md
AGENTS.md
package.json

src/core/harness.ts
src/core/engine.ts
src/core/toolBroker.ts
src/core/workflowRunner.ts
src/core/contestConfig.ts
src/core/findings.ts
src/core/artifacts.ts

src/workflows/
src/tools/
src/agents/
src/profiles/

所有包含以下关键词的文件：
handoff
dispatch
approveHandoff
dispatchNext
workflow
specialist
background
job
contestScope
profile
workspace
sessionDir
```

审计时必须确认：

1. 当前一次 CTF 任务从哪里创建。
2. 当前任务 ID 在哪里保存。
3. 当前 Profile 在哪里保存。
4. 当前 ContestScope 在哪里保存。
5. 当前 workspace 和 sessionDir 在哪里保存。
6. WorkflowRunner 使用的工作目录来自哪里。
7. Handoff 请求在哪里创建。
8. Handoff 请求在哪里批准。
9. Specialist Agent 实际在哪里启动。
10. Specialist 的结果如何返回主 Agent。
11. 当前是否存在两条或多条 Handoff 执行路径。
12. Harness、ToolBroker、WorkflowRunner 是否分别保存了独立 Profile。
13. 默认 ContestConfig 是否在多个位置重复创建。

把审计结论写入：

```text
docs/architecture/ctf-runtime-refactor.md
```

文档只需要简洁记录：

* 当前调用路径
* 当前重复状态
* 当前 Handoff 分叉
* 本轮目标架构
* 迁移顺序

完成文档后继续修改代码，不要停止。

---

# 三、建立统一的 TaskExecutionContext

创建一个统一的任务执行上下文。

建议位置：

```text
src/core/ctfRuntime/taskExecutionContext.ts
```

具体文件名可以根据仓库风格调整。

上下文至少应表达：

```ts
export interface TaskExecutionContext {
  taskId: string

  workspaceDir: string
  sessionDir: string
  artifactDir: string

  profileId: string

  contestScope: ContestScope
  contestConfig: ContestConfig

  environment?: Record<string, string>

  abortSignal?: AbortSignal
}
```

根据项目已有类型修改，不要重复创建同义类型。

要求：

1. 一次 CTF 任务只能有一个权威 `TaskExecutionContext`。
2. Harness 创建任务时构造该 Context。
3. WorkflowRunner 必须显式接收该 Context。
4. ToolBroker 执行工具时必须接收该 Context。
5. Specialist Agent 创建时必须继承或派生该 Context。
6. 不允许 WorkflowRunner 再使用无条件的 `process.cwd()`。
7. 不允许随意在各模块中重新构造 ContestConfig。
8. 不允许 ToolBroker 私自保存另一套 workspace 或 scope。

如果某个子任务需要独立目录，应通过明确函数派生：

```ts
deriveSubtaskContext(parentContext, subtaskId)
```

派生后的上下文必须保留：

* 父任务 ContestScope
* ContestConfig
* Profile 约束
* workspace 根目录约束
* Artifact 可追踪关系

不要通过复制散乱字段实现。

---

# 四、建立统一 CTFTaskState

建议创建：

```text
src/core/ctfRuntime/taskState.ts
```

建立唯一的 CTF 解题任务状态。

建议结构如下：

```ts
export type CTFTaskPhase =
  | "created"
  | "intake"
  | "triage"
  | "exploration"
  | "specialist_execution"
  | "verification"
  | "solved"
  | "blocked"
  | "failed"
  | "cancelled"

export interface CTFTaskState {
  taskId: string
  phase: CTFTaskPhase

  context: TaskExecutionContext

  challenge: {
    description?: string
    category?: string
    flagPattern?: string
    inputArtifactIds: string[]
  }

  activeProfileId: string

  findings: Finding[]
  artifactIds: string[]

  hypotheses: CTFHypothesis[]
  attempts: CTFAttempt[]

  handoffs: HandoffRecord[]

  activeAgentRuns: AgentRunRecord[]
  activeWorkflowRuns: WorkflowRunRecord[]
  activeJobs: JobRecord[]

  flagCandidates: FlagCandidate[]

  completion?: {
    status: "solved" | "blocked" | "failed" | "cancelled"
    reason: string
    flagCandidateId?: string
  }

  createdAt: number
  updatedAt: number
}
```

可以根据项目现有 Finding、Artifact、Job、Handoff 类型调整。

不要重复定义已经存在的实体。

## Hypothesis

至少应区分假设和事实：

```ts
export interface CTFHypothesis {
  id: string
  statement: string
  status:
    | "proposed"
    | "testing"
    | "supported"
    | "rejected"
    | "inconclusive"

  evidenceIds: string[]
  createdBy: string
  createdAt: number
  updatedAt: number
}
```

## Attempt

至少记录已经尝试过的操作：

```ts
export interface CTFAttempt {
  id: string
  kind: "tool" | "workflow" | "agent" | "manual"
  summary: string

  fingerprint?: string

  status:
    | "pending"
    | "running"
    | "succeeded"
    | "failed"
    | "cancelled"

  resultSummary?: string
  createdAt: number
  completedAt?: number
}
```

本轮不要求实现高级的重复尝试检测算法。

但必须给未来的去重保留明确的数据结构。

## 状态所有权要求

`CTFTaskState` 必须成为以下信息的唯一真相源：

* 当前任务阶段
* 当前 Profile
* 当前 Handoff
* 当前 Specialist 运行
* 当前 Workflow 运行
* 当前后台 Job
* 当前完成状态
* 当前 Flag 候选

Harness、WorkflowRunner、ToolBroker 和 Specialist Scheduler 可以保留运行时对象引用，但不能分别维护另一套相同语义的权威状态。

---

# 五、建立 CTFTaskEvent

建议创建：

```text
src/core/ctfRuntime/taskEvents.ts
```

事件至少覆盖：

```ts
export type CTFTaskEvent =
  | {
      type: "TASK_CREATED"
      taskId: string
    }
  | {
      type: "PHASE_CHANGED"
      phase: CTFTaskPhase
      reason?: string
    }
  | {
      type: "PROFILE_CHANGED"
      previousProfileId: string
      profileId: string
    }
  | {
      type: "WORKFLOW_STARTED"
      workflowRun: WorkflowRunRecord
    }
  | {
      type: "WORKFLOW_COMPLETED"
      workflowRunId: string
      summary?: string
    }
  | {
      type: "HANDOFF_REQUESTED"
      handoff: HandoffRecord
    }
  | {
      type: "HANDOFF_APPROVED"
      handoffId: string
    }
  | {
      type: "HANDOFF_REJECTED"
      handoffId: string
      reason: string
    }
  | {
      type: "SPECIALIST_STARTED"
      handoffId: string
      agentRun: AgentRunRecord
    }
  | {
      type: "SPECIALIST_COMPLETED"
      handoffId: string
      agentRunId: string
      summary?: string
    }
  | {
      type: "SPECIALIST_FAILED"
      handoffId: string
      agentRunId: string
      error: string
    }
  | {
      type: "FINDING_ADDED"
      finding: Finding
    }
  | {
      type: "ARTIFACT_ADDED"
      artifactId: string
    }
  | {
      type: "FLAG_CANDIDATE_ADDED"
      candidate: FlagCandidate
    }
  | {
      type: "TASK_COMPLETED"
      status: "solved" | "blocked" | "failed" | "cancelled"
      reason: string
    }
```

事件的作用不是仅仅打印日志。

状态变更必须经过统一方法，例如：

```ts
reduceCTFTaskState(state, event)
```

或者：

```ts
taskStateStore.apply(event)
```

不要让任意模块直接修改多个 State 字段。

事件系统保持简单：

* 进程内
* 类型安全
* 不引入重量级 Event Bus
* 不引入数据库
* 不引入分布式队列
* 不引入 Redux 等大型依赖

可以复用项目现有事件系统，但必须建立明确的 CTF Task Event 类型。

---

# 六、建立 CTFTaskStateStore

建议创建：

```text
src/core/ctfRuntime/taskStateStore.ts
```

职责：

```ts
interface CTFTaskStateStore {
  getState(): Readonly<CTFTaskState>
  apply(event: CTFTaskEvent): Readonly<CTFTaskState>
  subscribe(listener: TaskStateListener): Unsubscribe
}
```

要求：

1. 所有 TaskState 更新必须集中。
2. 每次更新刷新 `updatedAt`。
3. 非法状态转换应抛出清晰错误。
4. 已经结束的任务不能继续启动新的 Workflow 或 Specialist。
5. 被拒绝的 Handoff 不能进入 Specialist 运行状态。
6. 同一个 Handoff 不能重复启动两次。
7. `TASK_COMPLETED` 后，不能再次改变为其他完成状态。
8. 不使用 `any` 绕过类型检查。

本轮不要求持久化到数据库。

可以保留现有 FindingStore、ArtifactStore 等专用存储。

CTFTaskState 中可以保存引用或 ID，不必复制所有文件内容。

---

# 七、建立唯一的 CTFTaskOrchestrator

建议创建：

```text
src/core/ctfRuntime/taskOrchestrator.ts
```

它是本轮最重要的组件。

## Orchestrator 的职责

它负责：

* 创建 CTF Task
* 持有唯一的 TaskStateStore
* 启动主 Reasoning Agent
* 启动 Workflow
* 接收 Handoff 请求
* 批准或拒绝 Handoff
* 启动 Specialist Agent
* 收回 Specialist Agent 结果
* 将 Finding 和 Artifact 合并回 TaskState
* 管理后台 Job 的任务级状态
* 更新任务阶段
* 结束任务
* 取消任务

## Orchestrator 不负责

它不应直接：

* 实现模型 API
* 解析模型 Streaming
* 实现具体 CTF Tool
* 拼装所有 Shell 命令
* 解析所有 Workflow 输出
* 实现图像隐写算法
* 实现密码学算法
* 自己执行 nmap、binwalk、file 等工具

它应调用已有系统：

```text
ExecutionEngine
WorkflowRunner
ToolBroker
Specialist Agent Harness
Finding Store
Artifact Store
Background Job Manager
```

## 推荐接口

根据现有项目调整，但整体应类似：

```ts
export interface CreateCTFTaskInput {
  description?: string
  category?: string
  flagPattern?: string

  profileId: string

  workspaceDir: string
  sessionDir: string
  artifactDir: string

  contestConfig: ContestConfig
  contestScope: ContestScope

  inputArtifactIds?: string[]
}

export interface RequestHandoffInput {
  fromAgentRunId: string
  targetCapability: string
  targetAgentId?: string
  reason: string
  artifactIds?: string[]
  findingIds?: string[]
}

export class CTFTaskOrchestrator {
  createTask(input: CreateCTFTaskInput): Promise<CTFTaskState>

  runMainAgent(input?: string): Promise<AgentRunResult>

  runWorkflow(
    workflowId: string,
    variables?: Record<string, string>
  ): Promise<WorkflowRunResult>

  requestHandoff(input: RequestHandoffInput): Promise<HandoffRecord>

  approveHandoff(handoffId: string): Promise<AgentRunResult>

  rejectHandoff(
    handoffId: string,
    reason: string
  ): Promise<void>

  cancel(reason: string): Promise<void>

  getState(): Readonly<CTFTaskState>

  dispose(): Promise<void>
}
```

不要机械照抄。

优先兼容仓库现有公开 API。

---

# 八、合并 Handoff 的两条执行路径

当前需要重点检查：

```text
approveHandoff()
dispatchNext()
HandoffQueue
Agent Scheduler
Harness 中的 Handoff 方法
```

目标是只保留一条权威流程：

```text
Agent 请求 Handoff
→ Orchestrator 创建 HandoffRecord
→ Handoff 状态为 requested
→ 审批
→ Handoff 状态为 approved
→ Orchestrator 启动 Specialist Agent
→ Specialist 执行
→ Finding 和 Artifact 回收
→ Handoff 状态为 completed 或 failed
→ 主任务状态更新
```

## HandoffRecord 建议结构

```ts
export interface HandoffRecord {
  id: string
  taskId: string

  fromAgentRunId: string

  requestedCapability: string
  requestedAgentId?: string

  selectedAgentId?: string

  reason: string

  artifactIds: string[]
  findingIds: string[]

  status:
    | "requested"
    | "approved"
    | "rejected"
    | "running"
    | "completed"
    | "failed"
    | "cancelled"

  createdAt: number
  approvedAt?: number
  startedAt?: number
  completedAt?: number

  rejectionReason?: string
  error?: string
}
```

## 必须满足

1. `approveHandoff()` 不再只是修改一个布尔值。
2. 批准成功后，由 Orchestrator 调用唯一的 Specialist 启动函数。
3. `dispatchNext()` 如果仍然存在，必须变成内部实现，不能再形成另一条公开主路径。
4. 所有 Specialist 启动都必须关联一个 Handoff ID。
5. 同一个 Handoff 只能启动一次 Specialist。
6. Specialist 结束后必须更新 Handoff 状态。
7. Specialist 产生的 Finding 必须回收。
8. Specialist 产生的 Artifact 必须回收。
9. Specialist 失败不能让整个 Orchestrator 状态卡在 running。
10. Specialist 完成不等于整个 CTF Task 完成。
11. 不允许 Agent 绕过 Orchestrator 直接私自启动另一个 Agent。

## Agent 选择

Handoff 可以指定具体 Agent，也可以只指定 Capability。

如果只指定 Capability，则由现有 Agent Registry 或 Profile 系统选择 Specialist。

本轮不要设计复杂评分算法。

可以使用明确、可预测的选择顺序：

1. Agent 已启用。
2. Agent 支持请求的 Capability。
3. 所需工具和二进制可用。
4. 优先选择 Profile 中声明的首选 Agent。
5. 多个候选相同时使用稳定排序。

没有可用 Agent 时：

* Handoff 标记为 failed。
* 返回明确错误。
* 不允许静默回退到错误 Agent。

---

# 九、修复 ContestConfig 默认值分叉

搜索所有创建默认 ContestConfig 的代码。

目标：

只保留一个权威函数：

```ts
export function createDefaultContestConfig(): ContestConfig
```

例如统一放在：

```text
src/core/contestConfig.ts
```

所有入口，包括：

* CLI
* Harness
* Orchestrator
* 测试辅助函数
* Workflow
* Specialist Agent

都必须使用相同的默认配置函数。

禁止继续出现：

```ts
allowPublicNetwork: true
```

和另一个默认入口：

```ts
allowPublicNetwork: false
```

这种不同入口行为不一致的情况。

## 默认策略

保持仓库原本更安全、更保守的默认策略。

除非用户或 ContestConfig 明确允许，否则：

* 不允许公共网络
* 不扩大目标范围
* 不扩大文件系统范围
* 不让 Specialist 获得比父任务更宽的 ContestScope

Specialist Context 的 Scope 必须满足：

```text
childScope ⊆ parentScope
```

不要让子 Agent 扩大 Scope。

---

# 十、修复 Workflow 工作目录

检查 WorkflowRunner 当前是否使用：

```ts
cwd: process.cwd()
sessionDir: undefined
```

如果存在，必须修复。

WorkflowRunner 的运行接口应显式接收：

```ts
TaskExecutionContext
```

所有 Workflow Step 默认在：

```ts
context.workspaceDir
```

中运行。

临时文件使用：

```ts
context.sessionDir
```

产物文件使用：

```ts
context.artifactDir
```

要求：

1. Workflow 不得依赖 Codex 启动时的 shell 当前目录。
2. Workflow 不得在仓库根目录随意产生题目文件。
3. Specialist Workflow 使用派生后的子任务 Context。
4. Workflow 输出 Artifact 时必须记录实际文件路径。
5. Artifact 路径必须经过 workspace 或 artifactDir 范围校验。
6. 不允许通过 `../` 逃逸 Scope。
7. 如果工作目录不存在，应明确创建或抛出错误，不能静默回退到 `process.cwd()`。

---

# 十一、修复 Profile 状态不一致

搜索类似以下代码：

```ts
broker["opts"].profile = profile
```

或者直接访问 private/protected 字段的代码。

全部替换为正式接口。

## 目标

创建原子化的 Profile 更新方法，例如：

```ts
await orchestrator.switchProfile(profileId)
```

或者：

```ts
await harness.applyProfile(profile)
```

根据当前架构选择。

一次 Profile 更新必须同步处理：

* TaskState.activeProfileId
* Harness 当前 Profile
* ToolBroker Tool exposure
* Tool execution policy
* Workflow 默认 Agent 或默认能力
* Specialist 可选范围
* Profile 对应的预算
* Profile 对应的 Prompt 或 Context Patch
* 任何缓存过的 Tool Definitions

不能只修改 ToolBroker 的一个私有字段。

## 重要限制

优先采用：

```text
主 Agent 身份固定
→ 需要其他能力时启动 Specialist
```

而不是让同一个 Agent 在一次运行中频繁改变身份。

只有用户明确切换 Profile，或任务阶段要求整体切换时，才执行 `switchProfile()`。

Handoff 不应通过修改主 Agent Profile 来模拟 Specialist。

---

# 十二、Harness 的最终定位

当前 Harness 如果承担了过多 CTF 调度职责，需要收缩。

最终建议关系：

```text
CTFTaskOrchestrator
│
├── Main Agent Harness
├── Specialist Agent Harnesses
├── WorkflowRunner
├── ToolBroker
├── Finding Store
├── Artifact Store
└── Background Job Manager
```

Harness 负责一个 Agent Run 的执行环境。

Harness 不应再成为整个 CTF Task 的唯一最高控制者。

如果为了兼容旧 API，必须保留：

```ts
harness.approveHandoff(...)
harness.dispatchNext(...)
```

则这些方法只能委托给 Orchestrator：

```ts
return this.orchestrator.approveHandoff(...)
```

不能继续保留旧的独立实现。

---

# 十三、任务阶段转换

实现简单且明确的阶段转换规则。

允许的主要转换：

```text
created → intake
intake → triage
triage → exploration
exploration → specialist_execution
specialist_execution → exploration
exploration → verification
verification → solved
verification → exploration
任意未结束状态 → blocked
任意未结束状态 → failed
任意未结束状态 → cancelled
```

不要过度限制实际执行，但至少防止：

* solved 后重新启动 Workflow
* cancelled 后启动 Specialist
* rejected Handoff 进入 running
* completed Handoff 再次 approve
* failed Handoff 再次自动执行
* Task 已结束但后台 Job 仍不断更新主状态

如果需要恢复失败 Handoff，应创建新的 HandoffRecord，而不是重用旧记录。

---

# 十四、错误处理

所有异步运行必须使用 `try/finally` 保证状态收敛。

## Specialist 执行

```ts
HANDOFF_APPROVED
→ SPECIALIST_STARTED
→ try execute
→ SPECIALIST_COMPLETED
→ catch SPECIALIST_FAILED
→ finally 清理 activeAgentRuns
```

## Workflow 执行

```ts
WORKFLOW_STARTED
→ try execute
→ WORKFLOW_COMPLETED
→ catch WORKFLOW_FAILED
→ finally 清理 activeWorkflowRuns
```

如果项目当前事件类型中缺少 Workflow Failed，可以补充。

任何失败都不能留下：

* 永远 running 的 Handoff
* 永远 active 的 Agent Run
* 永远 active 的 Workflow Run
* 无法取消的后台 Job
* 没有错误原因的 failed 状态

错误必须保留原始 `cause`，并转换为用户可理解的摘要。

不要用空 `catch`。

不要只打印日志然后吞掉错误。

---

# 十五、并发与重复执行保护

本轮不需要实现复杂调度器，但必须处理明显竞态。

至少需要保护：

1. 同一个 Task 不能同时执行两个 `approveHandoff(handoffId)`。
2. 同一个 Handoff 不能启动两个 Specialist。
3. Task 结束过程中不能继续启动新任务。
4. `cancel()` 可以中止当前 Main Agent、Workflow 和 Specialist。
5. `dispose()` 必须清理订阅和后台运行对象。
6. 多个只读 Specialist 是否并行，保持当前行为即可。
7. 状态更新必须保持原子顺序。

可以使用：

* Promise 锁
* 状态检查
* Map 中保存 in-flight Promise

不要引入重量级并发库。

---

# 十六、向后兼容

尽量保持以下行为和接口：

* CLI 启动方式
* 现有 Contest 配置文件格式
* 现有 Profile 定义
* Tool API
* Workflow 定义格式
* Finding API
* Artifact API
* Agent 定义
* Handoff 用户交互
* 后台任务
* 当前 Renderer 输出
* 当前 ExecutionEngine

确实必须修改公开接口时：

1. 提供兼容适配层。
2. 更新仓库内所有调用点。
3. 在架构文档中写明。
4. 不保留两套永久实现。

迁移期间可以存在短期适配器。

最终必须只有一条真实执行路径。

---

# 十七、禁止事项

不要做以下事情：

## 禁止只写设计

不允许只新增：

```text
docs/architecture/...
```

然后停止。

必须完成代码修改。

## 禁止建立平行系统

不要创建：

```text
newHarness
harnessV2
orchestratorV2
newHandoffManager
legacyRuntime
experimentalRuntime
```

然后让旧代码继续运行。

必须逐步迁移现有主路径。

## 禁止伪重构

以下不算完成：

* 只把原方法移动到新文件
* 新类内部继续调用 Harness 私有方法
* Orchestrator 只是空壳转发器
* TaskState 创建了但实际执行仍读取旧状态
* 新旧 Profile 状态同时双写
* Handoff 仍然存在两个启动入口
* Workflow 仍然使用 `process.cwd()`
* ContestConfig 仍然存在多个默认构造
* 通过 `as any` 或索引 private 字段解决问题

## 禁止扩大范围

不要顺手：

* 重写全部 Tool
* 重写全部 Workflow
* 增加几十个事件类型
* 重写 Prompt
* 重写 Memory
* 实现完整 Flag 平台提交
* 引入数据库
* 引入消息队列
* 引入大型状态管理库
* 修改项目定位

---

# 十八、推荐实施顺序

严格按以下顺序执行。

## 阶段 1：审计

完成：

* 当前调用路径
* 重复状态列表
* Handoff 两条路径列表
* Context 传递问题列表

写入架构文档。

然后继续。

## 阶段 2：基础类型

创建或整理：

```text
TaskExecutionContext
CTFTaskState
CTFTaskEvent
HandoffRecord
AgentRunRecord
WorkflowRunRecord
FlagCandidate
```

优先复用已有类型。

确保类型检查通过。

## 阶段 3：StateStore

实现：

```text
getState
applyEvent
subscribe
状态转换校验
```

增加少量针对纯状态转换的测试。

不要建设大型测试框架。

## 阶段 4：统一默认 ContestConfig

实现：

```ts
createDefaultContestConfig()
```

替换所有重复默认值。

检查公共网络默认行为。

## 阶段 5：统一 Context

让以下模块显式接收 Context：

```text
Harness
ToolBroker
WorkflowRunner
Specialist 创建逻辑
```

修复 `process.cwd()` 和 `sessionDir: undefined`。

## 阶段 6：Orchestrator

创建 `CTFTaskOrchestrator`。

先让它能够：

* 创建 Task
* 读取 TaskState
* 启动 Workflow
* 请求 Handoff
* 批准 Handoff
* 启动 Specialist
* 回收结果
* 取消任务

## 阶段 7：合并 Handoff

将旧审批和调度逻辑迁移到 Orchestrator。

移除重复执行路径。

保留必要兼容方法，但只做代理。

## 阶段 8：Profile 原子更新

删除 private 字段修改。

实现公开 Profile 更新接口。

保证状态、Tool exposure 和策略同步。

## 阶段 9：清理旧状态

搜索并处理：

```text
currentProfile
currentHandoff
pendingHandoff
activeSpecialist
currentWorkflow
currentContestScope
workspaceDir
sessionDir
```

确保没有多个权威来源。

删除已无调用的旧代码。

## 阶段 10：验证和文档

执行项目真实存在的：

```bash
pnpm typecheck
pnpm build
pnpm lint
pnpm test
```

如果项目使用 npm 或其他命令，以 `package.json` 为准。

更新架构文档和 README 中相关架构说明。

---

# 十九、必要测试

本轮不建设 eval 系统，但必须为关键状态逻辑补充少量测试。

至少覆盖：

1. 默认 ContestConfig 从不同入口创建时结果一致。
2. Workflow 使用 TaskExecutionContext.workspaceDir。
3. Specialist Scope 不能比父 Scope 更宽。
4. Handoff 从 requested 到 approved 到 running 到 completed。
5. 同一个 Handoff 不能重复启动。
6. rejected Handoff 不能启动 Specialist。
7. Specialist 失败后 Handoff 进入 failed。
8. Specialist Finding 能合并回 TaskState。
9. Specialist Artifact 能合并回 TaskState。
10. Task 完成后不能再启动 Workflow。
11. Profile 更新不会通过访问 private 字段实现。
12. Profile 更新后 Tool exposure 同步变化。

测试只验证架构关键逻辑。

不要为了测试而大量 Mock 整个系统。

优先测试：

* reducer
* state store
* scope narrowing
* handoff lifecycle

---

# 二十、完成标准

只有以下条件全部满足，任务才可以结束。

## 统一状态

* 存在统一 `CTFTaskState`。
* 存在唯一 `CTFTaskStateStore`。
* Task 阶段有明确所有者。
* Profile 有明确所有者。
* Handoff 有明确所有者。
* Workflow Run 有明确所有者。
* Specialist Run 有明确所有者。
* 完成状态有明确所有者。

## 统一调度

* 存在 `CTFTaskOrchestrator`。
* Main Agent、Workflow 和 Specialist 由 Orchestrator 协调。
* ExecutionEngine 只作为 Agent Worker 使用。
* WorkflowRunner 不再独立决定整个 Task 是否完成。
* Specialist 完成结果能够返回 TaskState。

## Handoff

* Handoff 审批和执行只有一条真实路径。
* `approveHandoff()` 会实际触发统一 Specialist 调度。
* `dispatchNext()` 不再形成平行公开路径。
* Specialist 执行与 Handoff ID 绑定。
* 重复 approve 不会重复执行。

## Context

* Workflow 不再依赖 `process.cwd()`。
* sessionDir 不再无条件为 undefined。
* Specialist 继承 TaskExecutionContext。
* Artifact 路径受 Scope 限制。

## ContestScope

* 默认 ContestConfig 只有一个来源。
* 不同入口默认权限一致。
* Specialist 不能扩大父 Scope。

## Profile

* 不再使用 `broker["opts"]` 等方式修改私有状态。
* Profile 更新是原子的。
* Tool exposure、Tool policy 和 TaskState 同步。

## 工程质量

* 没有 `orchestratorV2` 或永久双轨架构。
* 没有大量新增 `any`。
* 没有隐藏错误的空 catch。
* 没有删除已有核心功能。
* 类型检查通过。
* 构建通过。
* 主要测试通过。
* 架构文档与实际代码一致。

---

# 二十一、最终报告格式

代码完成后，最终只按照以下结构汇报。

## 1. 实际发现的问题

列出在仓库中真实发现的：

* 状态分叉
* Handoff 分叉
* Context 传递问题
* 默认配置不一致
* Profile 私有字段修改
* 竞态或生命周期问题

不要只复述任务描述。

## 2. 最终架构

列出：

* `CTFTaskOrchestrator`
* `CTFTaskStateStore`
* `TaskExecutionContext`
* Harness
* WorkflowRunner
* ToolBroker
* Specialist Harness
* Finding/Artifact Store

说明每个组件的职责和状态所有权。

## 3. 一次完整运行流程

按照真实实现说明：

```text
创建 Task
→ Main Agent
→ Workflow
→ Handoff 请求
→ Handoff 批准
→ Specialist 执行
→ 结果回收
→ 验证或继续
→ Task 完成
```

## 4. 文件变更

分别列出：

* 新增文件
* 修改文件
* 删除文件
* 兼容适配文件

## 5. 兼容性

说明：

* 保持了哪些公开接口
* 哪些接口增加了适配层
* 哪些旧路径被删除
* 哪些行为有必要调整

## 6. 验证结果

列出实际运行的命令和结果。

不要写“应该通过”。

必须写真实结果。

## 7. 未解决问题

只列本轮真实存在但不适合继续扩大范围解决的问题。

不要添加泛化 TODO。

---

# 二十二、执行要求

现在开始执行。

先审计仓库，然后直接修改代码。

不要只输出计划。

不要请求确认。

不要因为仓库较大而缩减任务。

不要因为部分旧测试失败就提前停止。

不要把任务扩展成整个 CTF 系统重写。

优先保证以下主线真正完成：

```text
统一 TaskExecutionContext
→ 统一 CTFTaskState
→ 建立 StateStore
→ 建立 Orchestrator
→ 合并 Handoff
→ 修复 Workspace
→ 统一 ContestConfig
→ 原子更新 Profile
→ 删除重复状态路径
→ 构建和测试
```

只有在代码、调用路径和状态所有权均完成迁移后，才能宣布完成。
