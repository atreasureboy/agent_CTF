# Agent_CTF Phase 2.0：OneShot 运行时收敛与一等公民化

你正在当前最新的 `agent_CTF` 仓库中工作。

当前项目已经完成：

* CTFTaskRuntime 单入口
* CTFTaskOrchestrator
* TaskExecutionContext
* ProfileStore
* HandoffCoordinator
* SpecialistHarnessFactory
* OneShot Manifest 系统
* Process / Container / Service Runner
* Shotgun Agent
* OneShot Tool
* BudgetManager
* ScopeGate
* Doctor
* Benchmark

本轮不是继续增加更多 OneShot 工具。

本轮唯一目标是：

> 将当前相对独立的 OneShot/Shotgun 子系统正式合并进 CTFTaskRuntime，使每次 OneShot 都拥有真实 Task、Run、Job、Attempt、Abort、Scope、Result、Evidence 和 TaskState 生命周期，并修复当前 Result 查询、按 Run 取消、预算、网络权限、路径权限和输出解析问题。

必须直接审计并修改当前仓库。

不要只写方案。

不要请求确认。

不要创建 OneShot V2。

---

# 一、本轮范围

本轮必须完成：

1. OneShot 通过真实 `BackgroundJobManager` 执行。
2. OneShot 成为 `CTFTaskState` 的正式运行实体。
3. 每个 OneShot 使用真实 `taskId`，禁止空字符串和固定 `parent`。
4. 实现按 `runId` 查询结果。
5. 实现按 `runId` 精确取消。
6. 建立持久化且有界的 OneShotResultStore。
7. 将 OneShot Tool 的目录、Scope 和身份改由 Runtime 注入。
8. 禁止模型自行声明可信 Scope。
9. 建立结构化 Manifest 输入，不再默认接受任意 argv。
10. 修复网络模式的可执行语义。
11. 修复 Process、Container、Service Runner 生命周期。
12. 修复 Evidence 文件复制和输出读取。
13. 将 OneShot Finding、Artifact、Candidate 投影进 TaskState。
14. 修复 Hypothesis、Attempt、Job 事件的空 Reducer。
15. 让 Selector 使用真实 TaskState、Artifact 和历史 Attempt。
16. 让 ShotgunCoordinator 成为 Orchestrator 管理的 Specialist 能力。
17. 将 Benchmark 从“选择器覆盖”升级为真实结果质量测试。

本轮禁止：

* 不增加新的 Manifest。
* 不增加新的第三方工具。
* 不增加新的 Specialist Profile。
* 不实现完整动态 Workflow。
* 不实现复杂 Evidence Graph。
* 不实现真实平台 Flag 自动提交。
* 不引入数据库。
* 不引入消息队列。
* 不重写通用 ExecutionEngine。
* 不创建第二套 Background Job 系统。
* 不创建 DispatcherV2。
* 不允许旧 Dispatcher 和新 Dispatcher 长期并存。

---

# 二、开始前审计

首先执行：

```bash
git status --short
git branch --show-current
git log -10 --oneline
git diff --stat

pnpm typecheck
pnpm build
pnpm lint
pnpm test
```

以 `package.json` 的真实 scripts 为准。

随后搜索：

```bash
rg -n "taskId:\s*['\"]['\"]|taskId:\s*''" src/ctf
rg -n "tryAcquire.*parent|cancelTask\\(['\"]parent" src/ctf
rg -n "getResult\\(|return null" src/ctf/oneshot
rg -n "jobManager" src/ctf/oneshot/dispatcher.ts
rg -n "runnerFor\\(|\\.run\\(manifest" src/ctf/oneshot/dispatcher.ts
rg -n "workspace|evidenceRoot|scope" src/ctf/tools/runOneShot.ts
rg -n "argv" src/ctf/oneshot src/ctf/tools src/ctf/agents
rg -n "readFileSync|writeFileSync|require\\(['\"]fs" src/ctf/oneshot
rg -n "HYPOTHESIS_ADDED|ATTEMPT_RECORDED|JOB_RECORDED" src/core/ctfRuntime
rg -n "ONESHOT_" src/core/ctfRuntime src/ctf
rg -n "network.*bridge|--network" src/ctf/oneshot
rg -n "latest" oneshot/manifests
```

将真实审计结果写入：

```text
docs/architecture/phase-2.0-oneshot-runtime.md
```

记录：

* OneShot 当前真实调用链
* JobManager 是否实际执行
* taskId 来源
* Run ID 来源
* Result 存储位置
* Abort 路径
* Scope 来源
* Workspace 来源
* Candidate 投影路径
* 当前空 Reducer
* Manifest 可重复性问题

完成审计后继续修改。

---

# 三、建立 OneShotRunRecord

在 `CTFTaskState` 中增加正式记录。

建议：

```ts
export type OneShotRunStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'partial'
  | 'timeout'
  | 'failed'
  | 'cancelled'
  | 'unavailable'

export interface OneShotRunRecord {
  id: string
  taskId: string

  manifestId: string
  profileId: string

  initiatedByAgentRunId?: string
  initiatedByWorkflowRunId?: string
  handoffId?: string

  backgroundJobId: string

  lane: 'fast' | 'medium' | 'heavy'
  status: OneShotRunStatus

  inputArtifactIds: string[]
  attemptId: string

  findingIds: string[]
  artifactIds: string[]
  flagCandidateIds: string[]

  evidenceRoot: string
  resultPath?: string

  queuedAt: number
  startedAt?: number
  completedAt?: number

  summary?: string
  error?: string
}
```

根据现有类型调整。

不要重复建立相同含义的实体。

`CTFTaskState` 增加：

```ts
oneShotRuns: OneShotRunRecord[]
```

不要命名为 `activeOneShotRuns`，因为数组需要保留历史。

活跃 Run 通过状态筛选。

---

# 四、增加正式 OneShot Task Event

增加：

```ts
type CTFTaskEvent =
  | {
      type: 'ONESHOT_RUN_QUEUED'
      run: OneShotRunRecord
    }
  | {
      type: 'ONESHOT_RUN_STARTED'
      runId: string
      backgroundJobId: string
      startedAt: number
    }
  | {
      type: 'ONESHOT_RUN_COMPLETED'
      runId: string
      summary: string
      findingIds: string[]
      artifactIds: string[]
      flagCandidateIds: string[]
      completedAt: number
    }
  | {
      type: 'ONESHOT_RUN_PARTIAL'
      runId: string
      summary: string
      completedAt: number
    }
  | {
      type: 'ONESHOT_RUN_FAILED'
      runId: string
      error: string
      completedAt: number
    }
  | {
      type: 'ONESHOT_RUN_TIMEOUT'
      runId: string
      error?: string
      completedAt: number
    }
  | {
      type: 'ONESHOT_RUN_CANCELLED'
      runId: string
      reason: string
      completedAt: number
    }
```

要求：

* 每个 Event 必须携带真实 `taskId` 可追踪关系。
* Reducer 真正更新 `oneShotRuns`。
* Run ID 不允许重复。
* Terminal Run 不允许回到 running。
* Task terminal 后不能新建 OneShot。
* 迟到的 completion 事件只能作为审计记录，不能恢复 Task。
* 一个 BackgroundJob 只能关联一个 OneShot Run。
* 一个 OneShot Run 只能关联一个 Attempt。

---

# 五、修复 Hypothesis、Attempt 和 Job Reducer

当前必须重点检查：

```text
HYPOTHESIS_ADDED
ATTEMPT_RECORDED
JOB_RECORDED
```

事件不能只携带 ID。

改成：

```ts
{
  type: 'HYPOTHESIS_ADDED'
  hypothesis: CTFHypothesis
}

{
  type: 'ATTEMPT_RECORDED'
  attempt: CTFAttempt
}

{
  type: 'JOB_RECORDED'
  job: JobRecord
}
```

并增加：

```ts
HYPOTHESIS_UPDATED
ATTEMPT_UPDATED
JOB_UPDATED
```

Reducer 必须真实更新：

```ts
state.hypotheses
state.attempts
state.activeJobs
```

至少保证：

* 重复 ID 报错。
* 不更新不存在记录。
* succeeded Attempt 不回到 running。
* failed Attempt 不自动重试为原记录。
* terminal Job 不返回 pending。
* terminal Task 不创建新 Attempt。

OneShot 启动时创建：

```ts
CTFAttempt {
  kind: 'tool'
  summary: `one-shot:${manifestId}`
  fingerprint: ...
  status: 'running'
}
```

结束时将 Attempt 更新为：

```text
succeeded / failed / cancelled
```

---

# 六、Dispatcher 必须真正使用 BackgroundJobManager

当前最终调用链必须变成：

```text
Dispatcher.runOne
→ 创建 OneShotRunRecord
→ 创建 Attempt
→ BackgroundJobManager.spawn
→ JobRunner
→ runnerFor(manifest).run
→ BackgroundJobManager.wait
→ ResultNormalizer
→ OneShotResultStore
→ TaskState 投影
```

禁止 Dispatcher 直接：

```ts
await runnerFor(manifest).run(...)
```

作为生产主路径。

## JobSpec

为 OneShot 使用明确 Tool ID：

```ts
{
  taskId,
  agentId,
  toolId: `oneshot:${manifestId}`,
  input: {
    oneShotRunId,
    manifestId,
    resolvedInput,
    evidenceRoot
  },
  timeoutMs
}
```

Background Job 的 Runner 负责识别 `oneshot:` 前缀并调用 OneShot Runner。

如果现有 BackgroundJobManager 的单一 Runner 不适合多种后端，可以建立轻量 Runner Registry：

```ts
interface BackgroundJobRunnerRegistry {
  register(prefix: string, runner: JobRunner): void
  resolve(toolId: string): JobRunner
}
```

不要创建第二套 Job Manager。

---

# 七、真实 taskId 和运行身份

修改所有 OneShot 接口。

`DispatcherInputs` 至少包含：

```ts
interface DispatcherInputs {
  taskId: string
  agentRunId?: string
  workflowRunId?: string
  handoffId?: string

  profileId: string

  inputArtifactIds: string[]
  options: Record<string, unknown>

  context: TaskExecutionContext
  signal: AbortSignal
}
```

禁止：

```ts
taskId: ''
taskId: 'parent'
tryAcquire('parent', ...)
cancelTask('parent')
```

Budget、Job、Result、Event、Evidence 路径全部使用真实 `taskId`。

---

# 八、每个 OneShot 独立 AbortController

Dispatcher 维护：

```ts
private readonly activeRuns = new Map<
  string,
  {
    controller: AbortController
    backgroundJobId: string
    promise: Promise<OneShotResult>
  }
>()
```

每个 Run：

```text
Task AbortSignal
→ OneShot linked AbortController
→ Background Job
→ Process / Container / Service Runner
```

实现：

```ts
cancelRun(runId: string, reason: string): Promise<boolean>
```

要求：

1. 只取消指定 Run。
2. 不取消整个 Task。
3. 不影响其他 OneShot。
4. 更新 Background Job。
5. 更新 OneShotRunRecord。
6. 更新 Attempt。
7. 清理 activeRuns。
8. Terminal Run 再取消返回 false 或明确错误。
9. 父 Task cancel 时取消所有 Run。

删除当前“忽略 runId，取消 parent”的实现。

---

# 九、建立 OneShotResultStore

创建：

```text
src/ctf/oneshot/resultStore.ts
```

接口建议：

```ts
interface OneShotResultStore {
  save(result: OneShotResult): Promise<void>
  get(runId: string): Promise<OneShotResult | null>
  listByTask(taskId: string): Promise<OneShotResult[]>
  delete(runId: string): Promise<boolean>
  gc(options?: {
    maxPerTask?: number
    maxAgeMs?: number
  }): Promise<number>
}
```

持久化位置：

```text
<task workspace>/oneshots/results/<runId>.json
<task workspace>/oneshots/results/index.jsonl
```

要求：

* 原子写入临时文件再 rename。
* Result 必须带真实 taskId。
* 完成后仍可 inspect。
* 进程重启后仍可读取。
* 内存中可以有有界 LRU Cache。
* 不无限保存完整 stdout。
* Result 保存的是结构化摘要和路径。
* GC 不删除仍在 TaskState 引用的 Result。
* `getResult()` 不再固定返回 null。

---

# 十、修复 inspect 和 cancel Tool

## inspect_one_shot_result

必须调用 ResultStore：

```ts
resultStore.get(runId)
```

返回：

* manifestId
* status
* summary
* findings 数量
* artifacts 数量
* candidates 数量
* evidence 路径
* started/finished/duration
* parser warnings

不要把完整 stdout 返回模型。

## cancel_one_shot

必须调用：

```ts
dispatcher.cancelRun(runId, reason)
```

不能调用固定 Task。

返回：

```text
cancelled
already_terminal
unknown_run
cancel_failed
```

---

# 十一、Tool 输入不允许控制 Runtime 权限

当前模型不应提供：

* workspace
* evidenceRoot
* trusted scope
* taskId
* profileId

修改 `run_one_shot` Tool Schema。

建议只允许：

```ts
{
  manifestId: string
  inputArtifactIds?: string[]
  options?: Record<string, unknown>
  reason?: string
}
```

这些值必须从 `ToolContext` 或 `TaskExecutionContext` 得到：

```text
workspace
sessionDir
artifactDir
evidenceRoot
contestScope
taskId
agentRunId
profileId
AbortSignal
```

模型提供的 `scope` 不能成为权限来源。

即使为了兼容暂时接受旧字段，也必须：

* 忽略它们；
* 记录 deprecated warning；
* 不用它们扩大权限。

---

# 十二、建立结构化 Manifest Input

当前 Manifest 不能只声明任意 argv。

增加：

```ts
input: {
  artifactKinds?: string[]
  minArtifacts?: number
  maxArtifacts?: number

  optionsSchema?: JsonSchemaLike

  argumentTemplate: string[]

  allowedExtraArgs?: string[]
}
```

例如：

```json
{
  "input": {
    "artifactKinds": ["image"],
    "minArtifacts": 1,
    "maxArtifacts": 1,
    "argumentTemplate": ["${artifact:0}"],
    "optionsSchema": {
      "type": "object",
      "properties": {
        "extract": { "type": "boolean" }
      },
      "additionalProperties": false
    }
  }
}
```

由 Framework 根据 Artifact ID 解析受控文件路径。

模型不能直接提交任意主命令或替换 Manifest command。

额外参数必须：

* 在 Manifest 白名单内；
* 通过参数 Schema；
* 不允许插入 shell；
* Runner 始终使用 `spawn(binary, argv, {shell:false})`。

---

# 十三、路径权限

所有路径必须经过：

```ts
resolveAuthorizedArtifactPath({
  taskContext,
  artifactId,
})
```

要求：

* Artifact 必须属于当前 Task 或明确继承。
* `realpath` 后位于 Workspace/ArtifactDir。
* 拒绝符号链接逃逸。
* 拒绝 `../`。
* 拒绝绝对路径绕过。
* EvidenceRoot 由 Runtime 创建。
* EvidenceRoot 必须位于 Task workspace。
* Manifest artifact glob 不能越过 run output 目录。
* 不允许模型指定任意 EvidenceRoot。

---

# 十四、Scope 和网络语义

## Scope 权威来源

Scope 只来自：

```text
TaskExecutionContext.contestScope
```

不得来自 Tool 参数。

## 目标提取

网络 Manifest 必须明确声明：

```ts
network: {
  mode: 'contest-target-only'
  targetInputs: ['host', 'url']
}
```

从结构化输入中提取全部目标。

禁止只检查 argv 最后一个参数。

必须验证：

* 每个 Host
* 每个 Domain
* 每个 IP
* 每个 Port
* 每个 URL 重定向目标（适用时）
* DNS 解析结果（若执行网络访问）

## Container 网络

不能把普通：

```text
--network bridge
```

描述成“contest-target-only”。

本轮采用以下策略：

1. `network.mode=none`：Docker `--network none`。
2. `contest-target-only`：

   * 只有配置了可执行的受限网络 Adapter 时才 READY；
   * 没有 Adapter 时状态为 `DISABLED_SCOPE_REQUIRED` 或 `UNAVAILABLE`；
   * 不允许退化为 unrestricted bridge。
3. `outbound-readonly`：

   * 需要显式 operator enable；
   * 默认禁用；
   * 记录网络策略和目标。

可以定义：

```ts
interface OneShotNetworkAdapter {
  prepare(input): Promise<NetworkExecutionPlan>
  dispose(): Promise<void>
}
```

本轮不需要实现复杂防火墙产品，但不能虚假声明已限制目标。

---

# 十五、Container 可重复性和隔离

对于 `stable` 和 `candidate` Container Manifest：

* 必须提供 `imageDigest`。
* 禁止 `:latest`。
* Digest 必须参与 Result 审计。
* Doctor 校验 Digest 格式。
* 未固定 Digest 时标记 DEGRADED 或 UNAVAILABLE。

Container 默认增加适用的：

```text
--read-only
--cap-drop=ALL
--security-opt=no-new-privileges
--pids-limit
--memory
--cpus
```

结果目录单独 RW。

Workspace 只读。

不得挂载：

* HOME
* SSH
* API Key
* `.git`
* Docker socket
* 整个 `/home`
* 系统敏感目录

---

# 十六、ProcessRunner 正确性

修复：

1. 不在 ESM 中使用运行时 `require('fs')`。
2. 使用正式 import。
3. 维护 `runId → child process` Map。
4. 支持精确 cancel(runId)。
5. POSIX 平台使用独立进程组，并终止整个进程组。
6. Windows 使用等价的子进程树终止策略或明确降级。
7. 等待 stdout/stderr Stream 完成后再 resolve。
8. 输出超过上限时只写剩余允许字节，不丢弃整个跨界 Chunk。
9. 区分 timeout、cancelled、failed。
10. `error` 事件必须收敛 Promise。
11. spawn 失败不能挂起。
12. 清理 Timer 和 Abort Listener。

---

# 十七、ContainerRunner 正确性

维护：

```ts
runId → containerName/dockerProcess
```

实现：

```ts
cancel(runId)
```

取消时：

1. 中止 docker client process。
2. 执行受控 `docker kill <containerName>`。
3. 执行必要 cleanup。
4. 更新状态。
5. 不留下孤儿容器。

检查 Docker 不存在时返回 `unavailable`。

不要把测试用的 synthetic unavailable 混入生产默认行为。

---

# 十八、ServiceRunner 正确性

修复：

* Abort Listener 在请求结束后移除。
* Poll 等待支持 Abort。
* 使用有界指数退避。
* 处理 4xx 和 5xx 的不同语义。
* 处理重定向时重新校验 Scope。
* 限制 Response 最大字节。
* 不把任意 Endpoint 视为可信。
* Endpoint 必须来自 Operator Manifest，不来自模型。
* `cancel(runId)` 需要终止本地 Poll；远端取消 API 若未声明则只记录 local cancelled。

---

# 十九、EvidenceCollector

禁止同步一次性读取大型 Artifact。

改为流式：

```ts
pipeline(
  createReadStream(source),
  createWriteStream(destination)
)
```

同时计算：

* SHA-256
* Size
* MIME
* Source path
* Destination path

执行前：

* realpath containment 检查；
* 文件大小上限；
* 符号链接检查；
* Artifact glob 范围检查。

复制失败必须返回明确错误。

禁止：

```ts
catch {
  return Buffer.alloc(0)
}
```

不能把读取失败伪装成空文件 Evidence。

---

# 二十、Output Parser

默认 `passthrough` 不应把每一行变成 Finding。

改为：

* 保留有限摘要；
* 最多前 N 条有意义行；
* 噪声过滤；
* 超限写入 Artifact；
* 低置信度原始输出不直接污染 FindingStore。

本轮至少实现以下确定性 Parser：

```text
file
strings
binwalk
zsteg
checksec
```

每个 Parser 输出：

```ts
{
  findings
  artifacts
  candidates
  warnings
  confidence
}
```

要求：

* Parser 按行流式读取或限制读取字节。
* Tool unavailable 不产生“有效 Finding”。
* Exit code 0 不等于存在结果。
* Flag Candidate 必须记录来源 Run 和 Evidence。
* Parser Warning 不能被吞掉。

---

# 二十一、投影到 TaskState

OneShot 完成后统一执行：

```text
OneShotResult
→ FindingStore
→ ArtifactStore
→ FlagCandidate
→ TaskStateProjector
→ OneShotRunRecord
→ Attempt
```

## Finding

转换为现有 `Finding` 类型，保留：

* oneShotRunId
* manifestId
* producerProfileId
* confidence
* evidence paths
* recommended actions

## Artifact

复制到正式 Task Artifact Store。

保留：

* original evidence path
* OneShot Run ID
* Manifest ID
* SHA-256
* Size
* MIME
* Lineage

## Candidate

转换为正式 `FlagCandidate`：

* source 增加 `oneshot`，或使用兼容来源并记录 Run ID；
* matchedPattern 由 Task challenge 校验；
* 未验证 Candidate 不得使 Task solved；
* 多个 Run 命中相同值时合并来源。

---

# 二十二、OneShotResultStore 与 Projector 原子性

运行结束时采用：

```text
保存 Result
→ 保存 Finding/Artifact
→ 应用 TaskState Events
→ 标记 OneShot Completed
→ 标记 Attempt Succeeded
```

如果中间失败：

* OneShot 标记 partial 或 failed；
* ResultStore 保留诊断；
* 不允许 OneShot completed 但 TaskState 没有产物；
* 不允许 Artifact ID 已写 State 但文件不存在。

必要时实现轻量补偿：

```ts
ProjectionTransaction
```

不需要数据库事务，但要有清晰提交顺序和失败收敛。

---

# 二十三、Selector 升级

Selector 输入应来自：

```ts
{
  taskState
  artifactMetadata
  profile
  availableManifests
  doctorStatus
  previousAttempts
}
```

选择规则：

1. Profile 允许。
2. Manifest READY。
3. 输入 Artifact 满足。
4. MIME/Extension/Magic 匹配。
5. Scope 满足。
6. 未运行过等价成功 Attempt。
7. 未重复最近失败 Attempt。
8. Budget 可用。
9. Stable 优先 Candidate。
10. Fast 优先于 Heavy，但 Fast 不能因为“便宜”而无条件匹配。

删除：

```text
fast-tier always eligible
```

这种与输入无关的原因。

`existingFindingTitles` 必须真正参与跳过逻辑，或者删除无效字段。

---

# 二十四、调度和预算

当前 `runSelected()` 不应简单串行遍历。

建立按 Lane 的调度：

```text
Fast：最多 N
Medium：最多 N
Heavy：最多 N
```

要求：

* 保持每 Task 上限。
* 使用真实 taskId。
* 并发预算原子获取。
* 无槽位时排队或明确 skipped_budget。
* 不直接伪造 generic failed result。
* 每个选择都产生 Attempt。
* 单个失败不终止其他独立 Run。
* 任务取消后不调度新 Run。
* Heavy 默认需要显式批准。
* 调度结果顺序可追踪。

---

# 二十五、ShotgunCoordinator 接入 Orchestrator

ShotgunCoordinator 必须由 CTFTaskRuntime 创建或由 Specialist Factory 注入。

它必须接收：

```ts
TaskExecutionContext
CTFTaskStateStore
TaskStateProjector
Dispatcher
ProfileStore
```

不能由 LLM 提供：

* workspace
* evidenceRoot
* scope
* taskId

LLM 可以请求：

* manifestId
* inputArtifactIds
* options
* reason

Coordinator 必须重新验证：

* Profile
* Manifest Health
* Input
* Scope
* Budget
* Duplicate Attempt
* Heavy approval

Shotgun 不得绕过 Orchestrator 直接宣布 Task solved。

---

# 二十六、ToolFirstPolicy 接入 OneShot 状态

将 ToolFirstPolicy 从静态提示升级为能够读取：

```ts
{
  taskState
  oneShotCatalog
  doctorStatus
  previousAttempts
}
```

至少支持：

* 推荐 OneShot 前检查 Manifest READY。
* 已成功运行则不重复推荐。
* 已失败且输入未变则要求说明重试理由。
* 有标准 OneShot 时阻止手写重复 Bash，具体严重度按配置。
* Heavy Tool 不自动运行。
* OneShot unavailable 时允许正常降级，不重复提醒。

不要让 ToolFirstPolicy 直接执行工具。

---

# 二十七、Doctor

Doctor 必须真实检查：

* Process binary 是否存在。
* Version 是否满足 Manifest。
* Container image 是否固定 Digest。
* Docker 是否存在。
* Service endpoint 是否允许探测。
* Parser 是否已注册。
* Network Adapter 是否存在。
* Artifact 输入能力是否满足。
* Runner 是否支持当前平台。

状态原因必须具体：

```text
READY
DEGRADED: image not pinned
UNAVAILABLE: binary missing
DISABLED_SCOPE_REQUIRED: no authorized target
DISABLED_HEAVY: operator approval required
```

不要仅因为 Manifest 字段存在就显示 READY。

---

# 二十八、Benchmark 升级

当前 Synthetic Fixture 不应只验证 Selector 覆盖。

每个 Fixture 增加：

```ts
{
  expectedSelectedManifestIds
  forbiddenManifestIds

  expectedFindingCategories
  expectedCandidateValues
  expectedArtifactKinds

  maxFalsePositiveFindings
  maxDurationMs
}
```

至少覆盖：

* Base64
* 多层编码
* RSA 参数
* ELF
* PCAP
* ZIP
* Office 文档

Benchmark 输出：

```text
Selection Precision
Selection Recall
Run Success Rate
Finding Precision
Candidate Recall
False Positive Count
Timeout Rate
Cancellation Success
Median Duration
```

Fixture 必须无网络、无恶意执行、可重复。

---

# 二十九、必须新增的测试

## Runtime 集成

```text
Fake CTFTaskRuntime
→ run_one_shot
→ BackgroundJobManager
→ Fake Runner
→ ResultStore
→ TaskState
```

验证真实 Task ID 全链路一致。

## Inspect

* 完成后可以查询。
* 进程重建 Store 后仍可查询。
* 未知 Run 返回明确错误。
* GC 后返回 evicted。

## Cancel

* 精确取消一个 Run。
* 其他 Run 不受影响。
* Task cancel 取消全部 Run。
* Terminal Run 不重复取消。

## Budget

* 不同 Task 独立计数。
* Fast/Medium/Heavy 限制。
* Heavy Task 上限。
* 释放后可以继续执行。
* 不出现固定 parent。

## Scope

* 模型提供的 scope 被忽略。
* 所有结构化 Target 都被检查。
* argv 中隐藏额外 Target 被拒绝。
* unrestricted bridge 不被当成 contest-target-only。
* 无 Network Adapter 时网络 Manifest 不执行。

## Path

* `../` 拒绝。
* Symlink escape 拒绝。
* 绝对路径逃逸拒绝。
* 非当前 Task Artifact 拒绝。
* EvidenceRoot 不能由 Tool 输入修改。

## Result

* Result 使用真实 taskId。
* OneShot Run 投影。
* Attempt 投影。
* Finding 投影。
* Artifact 文件存在。
* Candidate 来源完整。

## Runner

* Spawn error 收敛。
* Timeout 收敛。
* Abort 收敛。
* Stream 完成后才 resolve。
* 超限 Chunk 正确截断。
* 不留下子进程或容器。

## Selector

* Fast 不会无条件匹配。
* 已成功 Attempt 不重复。
* Unavailable Manifest 不选择。
* Heavy 未批准不选择。
* 输入不满足不选择。

---

# 三十、静态禁止检查

完成后执行：

```bash
rg -n "taskId:\s*['\"]['\"]|taskId:\s*''" src/ctf

rg -n "['\"]parent['\"]" src/ctf/oneshot src/ctf/tools

rg -n "cancelTask\\(" src/ctf/tools/cancelOneShot.ts

rg -n "return null" src/ctf/oneshot/dispatcher.ts

rg -n "workspace|evidenceRoot|scope" src/ctf/tools/runOneShot.ts

rg -n "readFileSync" src/ctf/oneshot/evidenceCollector.ts

rg -n "require\\(['\"]fs" src/ctf/oneshot

rg -n "fast-tier always eligible" src/ctf

rg -n '"image":\s*"[^"]*:latest"' oneshot/manifests

rg -n "network.*bridge|--network.*bridge" src/ctf/oneshot

rg -n "case 'HYPOTHESIS_ADDED'.*return state" src/core/ctfRuntime

rg -n "case 'ATTEMPT_RECORDED'.*return state" src/core/ctfRuntime

rg -n "case 'JOB_RECORDED'.*return state" src/core/ctfRuntime
```

生产路径中应不存在：

* 空 Task ID
* 固定 parent
* 整 Task 代替按 Run 取消
* 永远 null 的 Result
* Tool 控制 workspace/scope
* 同步全文件 Evidence 复制
* Unpinned latest Container
* 虚假的 contest-only bridge
* 空 State Reducer

---

# 三十一、验证命令

执行：

```bash
pnpm typecheck
pnpm build
pnpm lint
pnpm test
```

运行无网络 Smoke Test：

```text
1. 创建 workflow-only CTFTaskRuntime
2. 注册 Fake OneShot Manifest
3. 运行 Fake Process Runner
4. 等待 Background Job
5. Inspect Result
6. 检查 TaskState.oneShotRuns
7. 检查 Attempt
8. 检查 Finding
9. 精确取消另一个慢速 Run
10. dispose
```

再运行已安装的安全本地 Manifest：

```text
file
strings
```

不得连接公共目标。

不得依赖真实比赛服务器。

---

# 三十二、完成标准

只有全部满足才能结束。

## 一条真实执行路径

* OneShot 经过 BackgroundJobManager。
* Dispatcher 不直接形成第二个后台系统。
* Shotgun 经过 Orchestrator。
* Tool 经过 Task Context。
* 所有 Run 使用真实 Task ID。

## 生命周期

* OneShot 有正式 RunRecord。
* OneShot 有正式 Attempt。
* OneShot 有 Background Job。
* 每个 Run 有独立 AbortController。
* 可按 Run 查询。
* 可按 Run 取消。
* Task cancel 可取消全部。
* Result 可重启恢复。

## 权限

* Workspace 来自 Runtime。
* EvidenceRoot 来自 Runtime。
* Scope 来自 TaskExecutionContext。
* 模型不能扩大 Scope。
* 网络 Target 全量校验。
* 无真实网络隔离时不声称 contest-target-only。
* Artifact 路径不能逃逸。

## 输出

* ResultStore 工作。
* Inspect 工作。
* Finding 投影工作。
* Artifact 投影工作。
* Candidate 投影工作。
* Parser 不把每一行都当 Finding。
* Evidence 大文件使用流式处理。

## State

* OneShot Event 真正更新 State。
* Hypothesis Event 真正更新 State。
* Attempt Event 真正更新 State。
* Job Event 真正更新 State。
* 不存在空 Reducer。

## 调度

* Budget 使用真实 Task ID。
* Lane 并发有效。
* Heavy 默认受限。
* Selector 不重复成功 Attempt。
* Selector 不选择 unavailable Manifest。
* `runSelected` 支持受控并行。

## 可重复性

* Container Image 固定 Digest。
* 禁止 latest。
* Doctor 检查真实环境。
* Benchmark 测量真实质量指标。

## 工程质量

* 不创建 DispatcherV2。
* 不创建 OneShotRuntimeV2。
* 不保留永久双轨路径。
* 不新增大量 `any`。
* Typecheck 通过。
* Build 通过。
* Lint 通过。
* Tests 通过。
* Smoke Test 通过。
* 文档与实现一致。

---

# 三十三、最终报告格式

## 1. 修改前真实问题

逐项列出实际代码位置：

* Dispatcher 绕过 JobManager
* 空 taskId
* 固定 parent
* getResult 无实现
* cancel 忽略 runId
* Tool 可控制 Scope/Workspace
* Container 网络语义不真实
* 空 Reducer
* 同步 Evidence
* Parser 噪声
* Selector 无状态

## 2. 最终调用链

说明：

```text
Agent/Workflow
→ run_one_shot
→ Orchestrator
→ Dispatcher
→ BackgroundJobManager
→ Runner
→ ResultStore
→ Projector
→ TaskState
```

## 3. 状态所有权

分别说明：

* OneShot Run
* Background Job
* Attempt
* Result
* AbortController
* Finding
* Artifact
* Candidate
* Budget
* Scope

## 4. 权限边界

说明：

* 模型能够提供什么
* Runtime 提供什么
* Scope 如何验证
* Artifact 如何解析
* Network 如何限制
* Container 如何隔离

## 5. 文件变更

列出新增、修改、删除和兼容接口。

## 6. 测试结果

列出真实命令和结果。

## 7. 静态禁止检查

逐条列出 `rg` 结果。

## 8. Benchmark

列出：

* Selection Precision
* Selection Recall
* Run Success
* Candidate Recall
* False Positives
* Cancellation Success

## 9. 未解决问题

只列真实存在但不影响 OneShot 一等公民化的问题。

不要在本节列：

* 更多 Manifest
* 更多 Specialist
* 完整 Evidence Graph
* 动态 Workflow

这些属于后续阶段。

---

# 三十四、执行顺序

严格按照：

```text
1. 基线与审计
2. 修复 TaskState 空 Reducer
3. OneShotRunRecord 与 Events
4. OneShotResultStore
5. BackgroundJobManager 真正接入
6. 真实 Task Identity
7. Per-Run Abort 与 Cancel
8. Inspect Tool
9. Runtime 注入 Tool Context
10. Manifest Structured Input
11. Path Authorization
12. Scope 与 Network Adapter
13. Process Runner
14. Container Runner
15. Service Runner
16. EvidenceCollector
17. Output Parser
18. TaskState Projector
19. Selector 与 Attempt Dedup
20. Lane Scheduler
21. ShotgunCoordinator 接入
22. Doctor
23. Benchmark
24. 行为测试
25. 静态禁止检查
26. Smoke Test
27. 文档与报告
```

不要先继续增加工具。

不要因为 490 个测试通过就认为生产链完整。

不要只修改类型和测试。

真实 `run_one_shot` 调用必须最终进入 BackgroundJobManager、ResultStore 和 CTFTaskState。

本轮最终目标是：

> OneShot 不再是挂在 CTF Agent 旁边的一套独立工具集合，而是拥有真实任务身份、权限边界、运行状态、取消能力、结果持久化和证据谱系的 CTFTaskRuntime 一等执行单元。
