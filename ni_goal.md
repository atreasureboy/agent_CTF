# Agent_CTF Phase 2.2：推理闭环接管主路径与状态语义收口

你正在当前最新的 `agent_CTF` 仓库中工作。

当前项目已经实现：

* `CTFTaskRuntime`
* `CTFTaskOrchestrator`
* `CTFTaskStateStore`
* `ReasoningCoordinator`
* `StrategyPlanner`
* `Observation`
* `Evidence`
* `Hypothesis`
* `Attempt`
* `SuggestedAction`
* `ParserRegistry`
* `ResultMaterializer`
* 类型化 Workflow Condition
* Workflow DAG
* Workflow Retry
* OneShot / Shotgun
* 三个已迁移 Workflow：

  * `unknown_file_triage`
  * `image_quick_scan`
  * `encoding_sweep`

但是当前结构化推理系统仍存在明显语义断裂：

1. `stop` Action 没有真正停止策略循环。
2. Attempt 在结构化产物写入前就被标记成功。
3. Attempt 没有绑定实际 Observation、Evidence、Artifact 和 FlagCandidate。
4. `ReasoningCoordinator` 尚未真正成为 Orchestrator 主路径的一部分。
5. Hypothesis 基本没有参与真实策略决策。
6. CostPolicy 主要限制并发，没有限制任务累计成本。
7. WorkflowCondition 默认读取整个 TaskState，可能被旧 Run 的产物误触发。
8. `artifact_exists` 没有真正检查 Artifact 类型和来源。
9. `encoding_sweep` 的停止条件过宽。
10. Evidence 无法正确合并不同来源对同一结论的支持。
11. ParserRegistry 没有统一去重、合并和冲突处理。
12. TaskState 仍可通过嵌套数组直接修改，绕过 Event 和 Reducer。
13. State listener 异常被静默吞掉。

本轮唯一目标是：

> 让结构化推理闭环真正接管 CTF Task 主路径，使每个执行结果都能更新假设、绑定 Attempt、形成可解释决策并正确继续或停止，同时保证 Condition、Evidence、Parser 和 TaskState 的语义可靠。

必须直接审计和修改当前仓库。

不要只写设计方案。

不要只新增类型。

不要等待用户确认。

不要创建 ReasoningCoordinatorV2、StrategyPlannerV2 或 OrchestratorV2。

---

# 一、本轮必须完成

必须完成以下内容：

1. 修复 `stop` Action 的真实停止语义。
2. 调整 Attempt 生命周期顺序。
3. 将 Attempt 与 Observation、Evidence、Artifact、FlagCandidate 双向关联。
4. 将 ReasoningCoordinator 正式接入 Orchestrator。
5. 建立 HypothesisUpdater。
6. 让 StrategyPlanner 真正读取 Hypothesis。
7. 建立累计任务预算，而不仅是并发计数。
8. 为 WorkflowCondition 增加运行范围和来源范围。
9. 修复 `artifact_exists`。
10. 修复 `encoding_sweep` 的停止条件。
11. 将 Evidence 改为可合并的多来源模型。
12. 建立 Parser 输出统一合并器。
13. 处理 Parser 之间的冲突结果。
14. 使 TaskState 对外真正不可变。
15. 让 State listener 错误可观测。
16. 增加一条真实的自动推理主路径集成测试。
17. 更新架构文档和 README。

---

# 二、本轮禁止事项

不要：

* 不增加新的 OneShot Manifest。
* 不增加新的第三方工具。
* 不增加新的 Specialist。
* 不迁移新的 Reverse、Pwn、Web、PCAP Workflow。
* 不重写 ExecutionEngine。
* 不重写全部 WorkflowEngine。
* 不引入数据库。
* 不引入图数据库。
* 不引入向量数据库。
* 不引入消息队列。
* 不使用 LLM 作为默认 Planner。
* 不使用 LLM 作为默认 Parser。
* 不实现真实比赛平台自动提交。
* 不自动访问未授权公共目标。
* 不创建 V2 平行系统。
* 不长期保留新旧两套 Reasoning 主路径。
* 不使用 `eval()`、`new Function()`。
* 不通过大量 `any` 绕过类型问题。
* 不通过删除或弱化测试让重构通过。

---

# 三、开始前建立基线

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

以 `package.json` 中的真实脚本为准。

重点读取：

```text
src/core/ctfReasoning/reasoningCoordinator.ts
src/core/ctfReasoning/strategyPlanner.ts
src/core/ctfReasoning/observation.ts
src/core/ctfReasoning/evidence.ts
src/core/ctfReasoning/hypothesis.ts
src/core/ctfReasoning/attempt.ts
src/core/ctfReasoning/attemptDeduplicator.ts
src/core/ctfReasoning/costPolicy.ts
src/core/ctfReasoning/toolSelectionPolicy.ts
src/core/ctfReasoning/parserRegistry.ts
src/core/ctfReasoning/resultMaterializer.ts
src/core/ctfReasoning/workflowCondition.ts

src/core/ctfRuntime/taskOrchestrator.ts
src/core/ctfRuntime/taskState.ts
src/core/ctfRuntime/taskEvents.ts
src/core/ctfRuntime/taskStateStore.ts
src/core/ctfRuntime/taskStateProjector.ts

src/core/workflowEngine.ts
src/core/workflowRunner.ts
src/workflows/typed/unknownFileTriage.ts
src/workflows/typed/imageQuickScan.ts
src/workflows/typed/encodingSweep.ts
```

执行搜索：

```bash
rg -n "case ['\"]stop['\"]|type:\s*['\"]stop['\"]" src/core

rg -n "ATTEMPT_COMPLETED|ATTEMPT_FAILED|ATTEMPT_STARTED" src/core

rg -n "observationIds:\s*\[\]|evidenceIds:\s*\[\]|artifactIds:\s*\[\]|flagCandidateIds:\s*\[\]" src/core/ctfReasoning

rg -n "ReasoningCoordinator|runStrategy|strategyDecision" src/core/ctfRuntime

rg -n "basedOnHypothesisIds:\s*\[\]|hypothesisIds:\s*\[\]" src/core/ctfReasoning

rg -n "inFlight.*fast|inFlight.*medium|inFlight.*heavy" src/core/ctfReasoning

rg -n "artifact_exists|evidence_exists|observation_exists" src/core/ctfReasoning src/workflows/typed

rg -n "negative_result|generic|maxDepth|noNewOutput" src/workflows/typed/encodingSweep.ts

rg -n "producer.*fingerprint|createEvidenceFingerprint|mergeEvidence" src/core/ctfReasoning

rg -n "aggregate\.observations\.push|aggregate\.evidence\.push|aggregate\.suggestedActions\.push" src/core/ctfReasoning/parserRegistry.ts

rg -n "Object\.freeze|getState\\(\\)|listener.*catch|catch\\s*\\{\\s*\\}" src/core/ctfRuntime/taskStateStore.ts
```

将真实发现写入：

```text
docs/architecture/phase-2.2-reasoning-main-path.md
```

文档记录：

* 当前 ReasoningCoordinator 调用入口
* 当前 stop Action 流程
* 当前 Attempt 完成顺序
* Hypothesis 的真实使用位置
* Condition 的查询范围
* Evidence 指纹结构
* Parser 输出合并方式
* TaskState 可变入口
* 本轮最终调用链

完成审计后继续修改代码。

---

# 四、修复 stop Action

当前 `stop` Action 必须成为策略循环的正式终止结果。

不得将其转换为：

```ts
{
  skipped: true,
  skipReason: "policy"
}
```

然后继续下一轮。

## 建立明确 ActionExecutionResult

建议：

```ts
export type ActionExecutionResult =
  | {
      status: 'executed'
      materializedResult: MaterializedResult
    }
  | {
      status: 'skipped'
      reason:
        | 'duplicate'
        | 'scope'
        | 'profile'
        | 'budget'
        | 'unavailable'
        | 'approval'
        | 'policy'
    }
  | {
      status: 'stop'
      reason: string
    }
```

ReasoningCoordinator 必须：

```ts
const execution = await executeSelectedAction(...)

if (execution.status === 'stop') {
  stopped = true
  stopReason = execution.reason
  break
}

if (execution.status === 'skipped') {
  // 根据原因决定是否继续下一候选或结束当前 Cycle
}
```

## Stop Action 要求

`stop` Action：

* 不创建普通 Tool Attempt。
* 可以创建一个 `strategy-stop` 审计记录，但不能伪装为失败或跳过 Tool Attempt。
* 必须记录 `StrategyDecision`。
* 必须返回真实 `stopReason`。
* 必须立即停止当前 Reasoning Loop。
* 不再继续到下一个 Cycle。
* 不将 Task 自动标记 solved。
* 不将 Stop 当成错误。
* 不能重复产生相同 Stop Decision。

扩展 ReasoningResult：

```ts
export interface ReasoningResult {
  cycles: number

  stopped: boolean
  stopReason?: string

  selectedActionIds: string[]
  strategyDecisionIds: string[]

  finalObservationIds: string[]
  finalEvidenceIds: string[]
}
```

增加测试：

1. Planner 选择 stop。
2. Coordinator 只执行一个 Cycle。
3. 不创建 Tool Attempt。
4. 返回 stopped=true。
5. stopReason 正确。
6. 后续 SuggestedAction 不执行。

---

# 五、修复 Attempt 生命周期顺序

当前禁止：

```text
执行 Action
→ ATTEMPT_COMPLETED
→ Materialize
→ 写 Observation/Evidence
```

正确顺序必须是：

```text
创建 Attempt
→ ATTEMPT_STARTED
→ 执行 Action
→ ResultMaterializer
→ 写 Observation
→ 写 Evidence
→ 写 Artifact
→ 写 FlagCandidate
→ 更新 Hypothesis
→ ATTEMPT_COMPLETED
```

失败顺序：

```text
创建 Attempt
→ ATTEMPT_STARTED
→ 执行失败
→ 必要的 failure Observation/Evidence
→ ATTEMPT_FAILED
```

取消顺序：

```text
ATTEMPT_STARTED
→ Abort
→ ATTEMPT_CANCELLED
```

## Attempt 完成事件

修改为携带完整产物：

```ts
{
  type: 'ATTEMPT_COMPLETED'

  attemptId: string

  observationIds: string[]
  evidenceIds: string[]
  artifactIds: string[]
  flagCandidateIds: string[]

  completedAt: number
}
```

失败事件：

```ts
{
  type: 'ATTEMPT_FAILED'

  attemptId: string

  observationIds: string[]
  evidenceIds: string[]

  error: {
    code?: string
    message: string
    retryable?: boolean
  }

  completedAt: number
}
```

取消事件：

```ts
{
  type: 'ATTEMPT_CANCELLED'
  attemptId: string
  reason: string
  completedAt: number
}
```

Reducer 必须：

* 更新状态；
* 写入所有产物 ID；
* 不允许 completed Attempt 再更新为 running；
* 不允许 failed Attempt 再直接改为 succeeded；
* Retry 执行仍属于同一 Attempt；
* Attempt 完成后产物 ID 不可修改，除非使用明确的补偿事件。

---

# 六、建立 Attempt 与产物的双向关联

Observation 增加可选字段：

```ts
attemptId?: string
```

Evidence 增加：

```ts
attemptIds: string[]
```

Artifact Metadata 增加：

```ts
attemptId?: string
```

FlagCandidate 增加：

```ts
sourceAttemptIds: string[]
```

要求：

* Attempt 知道自己产生了什么。
* Observation 知道由哪个 Attempt 产生。
* Evidence 可以由多个 Attempt 支持。
* Artifact 能追踪生成 Attempt。
* Candidate 能追踪转换链中的 Attempt。

不要复制完整 Attempt 对象。

只保存 ID。

## Materializer 上下文

ResultMaterializer 输入必须包含：

```ts
interface MaterializationContext {
  taskId: string
  attemptId: string

  agentRunId?: string
  workflowRunId?: string
  stepId?: string
  oneShotRunId?: string
  handoffId?: string

  producerId: string
}
```

Materialized Draft 中自动带上 Attempt ID。

---

# 七、ReasoningCoordinator 正式接入 Orchestrator

当前 ReasoningCoordinator 不应只是独立工具或测试对象。

## 目标调用链

```text
Orchestrator
→ Main Agent / Workflow / OneShot / Specialist
→ ResultMaterializer
→ TaskState Events
→ ReasoningCoordinator
→ StrategyPlanner
→ 下一 Action
```

## 建议接口

在 Orchestrator 中注入：

```ts
interface ReasoningRuntimeDependencies {
  reasoningCoordinator: ReasoningCoordinator
}
```

建立：

```ts
async processNewReasoningInputs(input: {
  source:
    | 'main-agent'
    | 'workflow'
    | 'oneshot'
    | 'specialist'

  newObservationIds: string[]
  newEvidenceIds: string[]
  suggestedActions: SuggestedAction[]

  runContext: {
    agentRunId?: string
    workflowRunId?: string
    oneShotRunId?: string
    handoffId?: string
  }
}): Promise<ReasoningResult>
```

## Main Agent

Main Agent 完成并投影产物后：

```text
project output
→ collect new Observation/Evidence/SuggestedAction
→ ReasoningCoordinator
```

## Workflow

Workflow 每个 Step 由 WorkflowEngine 处理自己的条件和 DAG。

Workflow 完成后，Orchestrator 对 Workflow 最终 SuggestedActions 运行一次 ReasoningCoordinator。

不要让 Orchestrator 和 WorkflowEngine 同时执行相同 SuggestedAction。

明确边界：

```text
WorkflowEngine：
负责当前 Workflow 内部 Step 和分支

ReasoningCoordinator：
负责跨 Workflow、OneShot、Specialist 的任务级下一步
```

## OneShot

OneShot 完成：

```text
OneShot Result
→ Unified Parser
→ Observation/Evidence
→ ReasoningCoordinator
```

## Specialist

Specialist 返回：

```text
Specialist Result
→ ResultMaterializer
→ Observation/Evidence
→ ReasoningCoordinator
```

## 防重入

ReasoningCoordinator 不得并发处理同一个 Task 的多个 Task-level Strategy Loop。

建立每 Task 锁：

```ts
withTaskReasoningLock(taskId, operation)
```

相同 Task 串行。

不同 Task 可并行。

锁完成后必须释放。

---

# 八、ReasoningCoordinator 终止边界

每次任务级推理：

```ts
maxStrategyCycles: 8
maxActionsPerCycle: 1
```

同时增加累计限制：

```ts
maxTotalStrategyActionsPerTask: 32
```

每轮开始前检查：

* Task terminal；
* AbortSignal；
* 累计 Budget；
* 当前是否存在相同 running Attempt；
* 是否已经存在高置信度 validated Candidate；
* 是否需要人工批准；
* Reasoning Lock；
* Action 是否来自当前新增 Evidence。

禁止：

* 一个旧 SuggestedAction 在每次新执行后反复被选中。
* Planner 不断选择 stop 而 Coordinator 继续。
* Strategy Loop 递归调用自身。
* Task-level Planner直接执行 Workflow 内部 Step。

---

# 九、建立 HypothesisUpdater

建议创建：

```text
src/core/ctfReasoning/hypothesisUpdater.ts
```

接口：

```ts
export interface HypothesisUpdateInput {
  state: Readonly<CTFTaskState>

  newObservationIds: string[]
  newEvidenceIds: string[]
}

export interface HypothesisUpdateResult {
  proposed: CTFHypothesis[]
  updates: Array<{
    hypothesisId: string

    status?: CTFHypothesis['status']

    supportingEvidenceIds?: string[]
    contradictingEvidenceIds?: string[]

    confidence?: number
  }>
}

export interface HypothesisUpdater {
  update(input: HypothesisUpdateInput): HypothesisUpdateResult
}
```

本轮使用确定性规则。

不要调用额外 LLM。

## 基础规则

### File 类型

Evidence：

```text
file_signature: PNG
```

支持：

```text
文件真实类型是 PNG
```

若扩展名不是 PNG：

```text
文件扩展名与真实类型不一致
```

### Embedded data

Evidence：

```text
embedded_archive
```

支持：

```text
文件包含嵌入归档
```

### Metadata

Evidence：

```text
suspicious_metadata
```

支持：

```text
图片元数据含异常文本
```

### Encoding

Evidence：

```text
encoding_layer
```

支持：

```text
输入是某种编码
```

若输出仍像另一编码：

```text
解码结果仍包含下一层编码
```

### Negative evidence

例如：

```text
zsteg no meaningful result
```

应：

* 降低“常规 zsteg 可直接发现隐写”的 Hypothesis；
* 不应完全证明不存在隐写；
* 状态可变为 inconclusive 或 confidence 下降。

## 更新原则

* Supporting Evidence 增加置信度。
* Contradicting Evidence 降低置信度。
* Evidence 不足时保持 proposed。
* 正在执行验证 Attempt 时改为 testing。
* 强支持时改为 supported。
* 明确推翻时改为 rejected。
* 阴性结果但不足以推翻时改为 inconclusive。

---

# 十、StrategyPlanner 真正使用 Hypothesis

Planner 当前不能只按 Action priority 排序。

## Planner 输入必须使用

```ts
state.hypotheses
state.evidence
state.attempts
state.flagCandidates
```

## Action 评分建议

建立可解释评分：

```ts
score =
  action.priority
  + hypothesisPriorityWeight
  + expectedInformationGain
  + evidenceFreshness
  - costPenalty
  - duplicatePenalty
  - failureHistoryPenalty
```

不要求复杂数学模型，但每项需要明确代码。

## Hypothesis 关联

SuggestedAction 中的：

```ts
hypothesisIds?: string[]
```

必须真正使用。

优先执行：

1. 验证高优先级、未解决 Hypothesis。
2. 能支持或推翻多个 Hypothesis 的 Action。
3. 能产生明确新 Artifact 的 Action。
4. 能验证 Candidate 的 Action。

降低优先级：

* 只重复已支持 Hypothesis。
* 指向 rejected Hypothesis。
* 没有任何 Hypothesis/Evidence 关系的高成本 Action。
* 最近失败多次的路线。

## StrategyDecision

必须正确填写：

```ts
basedOnHypothesisIds
basedOnEvidenceIds
basedOnObservationIds
```

不允许固定空数组。

`reason` 至少说明：

* 为什么选择；
* 验证哪个 Hypothesis；
* 为什么拒绝更高表面 priority 的其他 Action。

---

# 十一、累计任务预算

当前必须区分：

```text
Concurrency Limit
Cumulative Task Budget
```

## 并发预算

表示当前正在运行：

```ts
{
  cheap: number
  normal: number
  expensive: number
}
```

## 累计预算

增加：

```ts
export interface ReasoningBudgetState {
  strategyCyclesUsed: number
  actionsExecuted: number

  cheapActionsUsed: number
  normalActionsUsed: number
  expensiveActionsUsed: number

  workflowRunsUsed: number
  oneShotRunsUsed: number
  handoffsUsed: number

  estimatedCostUnitsUsed: number
}
```

配置：

```ts
export interface ReasoningBudgetLimits {
  maxStrategyCycles: number
  maxActions: number

  maxCheapActions: number
  maxNormalActions: number
  maxExpensiveActions: number

  maxWorkflowRuns: number
  maxOneShotRuns: number
  maxHandoffs: number

  maxEstimatedCostUnits: number
}
```

示例 Cost Unit：

```text
cheap = 1
normal = 3
expensive = 8
```

本轮不需要精确 CPU/Token 计费。

## State

Budget 应进入 TaskState 或正式 Task-level Runtime State。

不能只存在 Coordinator 局部变量中。

任务恢复后应能继续使用已消费预算。

---

# 十二、WorkflowCondition 增加 Scope

当前 Condition 默认不能查询整个 TaskState 后直接返回 true。

扩展：

```ts
export interface ConditionScope {
  taskId?: string

  workflowRunId?: string
  stepId?: string

  agentRunId?: string
  oneShotRunId?: string
  handoffId?: string

  producerId?: string
  artifactIds?: string[]

  sinceTimestamp?: number
}
```

将条件扩展为：

```ts
{
  type: 'evidence_exists'
  kind: EvidenceKind
  scope?: ConditionScope
  where?: Record<string, unknown>
  minConfidence?: number
}
```

同样应用于：

* observation_exists
* artifact_exists
* flag_candidate_exists
* attempt_exists
* hypothesis_status

## 默认 Scope

Workflow 内部 Condition 默认自动限制为：

```text
当前 workflowRunId
```

不允许默认扫描整个 Task 历史。

需要查询全局时必须显式：

```ts
scope: {
  taskId: currentTaskId
}
```

并标记：

```ts
scopeMode: 'task'
```

或等价结构。

## Step 条件

Step 内部建议默认：

```text
workflowRunId + 当前输入 Artifact
```

避免其他 Step 或旧 Workflow 污染判断。

---

# 十三、修复 artifact_exists

当前 `artifact_exists` 必须真正检查：

```ts
{
  type: 'artifact_exists'

  artifactKind?: string
  mimeType?: string
  extension?: string

  producedByStepId?: string
  producedByWorkflowRunId?: string
  producedByOneShotRunId?: string

  parentArtifactId?: string

  minCreatedAt?: number
}
```

ConditionEvaluator 从 ArtifactStore 或 TaskState Artifact Metadata 中查询。

不能只检查：

```ts
state.artifactIds.length > 0
```

如果 Artifact Metadata 当前不在 TaskState，ConditionEvaluator 应接收只读 Artifact Resolver：

```ts
interface WorkflowConditionDependencies {
  resolveArtifact(id: string): ArtifactMetadata | undefined
}
```

## image_quick_scan

修复当前 Stop Condition。

应检查：

```text
存在由 binwalk/extract Step 新产生的 Artifact
```

例如：

```ts
{
  type: 'artifact_exists'

  producedByWorkflowRunId: '$current'
  producedByStepId: 'binwalk-extract'

  minCreatedAt: '$workflowStartedAt'
}
```

不能因输入图片本身存在就停止。

---

# 十四、修复 encoding_sweep Stop Condition

不要使用宽泛：

```ts
{
  type: 'evidence_exists',
  kind: 'negative_result'
}
```

表示“没有新输出”。

增加明确 Evidence 属性。

例如：

```ts
{
  kind: 'negative_result'

  claim: 'Decode tree produced no new unique outputs'

  attributes: {
    reason: 'no_new_unique_output'
    decodeTreeId: string
  }
}
```

最大深度：

```ts
{
  kind: 'negative_result'

  attributes: {
    reason: 'max_depth_reached'
    depth: number
    maxDepth: number
  }
}
```

停止条件必须限定：

```ts
scope: {
  workflowRunId: '$current'
  stepId: 'decode-tree'
}
```

并匹配：

```ts
where: {
  reason: 'no_new_unique_output'
}
```

或：

```ts
where: {
  reason: 'max_depth_reached'
}
```

任务中其他旧 Evidence 不得触发当前 Workflow 停止。

---

# 十五、Evidence 改为多来源模型

当前 Evidence 的 Identity 不应包含 Producer。

将 Evidence 改为：

```ts
export interface EvidenceSource {
  producer: EvidenceProducer

  observationIds: string[]
  artifactIds: string[]
  attemptIds: string[]

  confidence: number

  createdAt: number
}

export interface Evidence {
  id: string
  taskId: string

  kind: EvidenceKind
  subject?: {
    artifactId?: string
    valueHash?: string
    entityId?: string
  }

  claim: string
  normalizedClaim: string

  polarity: 'supports' | 'contradicts' | 'neutral'

  confidence: number

  sources: EvidenceSource[]

  createdAt: number
  updatedAt: number
}
```

## Evidence Fingerprint

身份建议：

```text
taskId
+ kind
+ subject
+ normalizedClaim
+ polarity
```

不要包含：

```text
producer.type
producer.id
```

## Merge

两个 Parser 得出：

```text
文件是 PNG
```

应该合并为一个 Evidence，并拥有两个 Sources。

合并置信度必须使用有界方法。

可以采用：

```ts
combined = 1 - product(1 - sourceConfidence)
```

但需要限制最大值，例如不高于 `0.99`。

若来源不独立，不应过度提升。

可以对相同 ToolFamily 来源降权。

## 冲突

若 Evidence 对同一 subject/claim 存在：

```text
supports
contradicts
```

不得直接覆盖。

保留两条不同 polarity Evidence，并让 HypothesisUpdater 处理冲突。

---

# 十六、Observation 和 SuggestedAction 合并

建立：

```text
src/core/ctfReasoning/resultMerger.ts
```

接口：

```ts
export interface ResultMerger {
  merge(
    results: MaterializedResult[],
  ): MaterializedResult
}
```

## Observation 合并

Fingerprint：

```text
taskId
+ kind
+ source Run
+ normalized summary
+ subject artifact
```

相同 Observation 合并来源或保留最高置信度。

## Evidence 合并

使用新的多来源模型。

## SuggestedAction 去重

Fingerprint：

```text
type
+ targetId
+ normalized input
+ artifact IDs
+ hypothesis IDs
```

合并时：

* priority 取最高；
* reason 合并为有限列表；
* costTier 取较高成本，防止低估；
* hypothesisIds 合并。

## FlagCandidate 合并

按照：

```text
normalizedValue
```

合并来源和 Transform Chain。

---

# 十七、ParserRegistry 统一合并和冲突处理

当前 Registry 不得只是：

```ts
aggregate.observations.push(...)
aggregate.evidence.push(...)
```

改成：

```text
运行匹配 Parser
→ 收集 ParserResult
→ ResultMerger
→ ParserConflictResolver
→ 返回 MaterializedResult
```

## ParserConflictResolver

建议创建：

```text
src/core/ctfReasoning/parserConflictResolver.ts
```

至少处理：

### File type 冲突

例如：

```text
file parser → data
hex parser → PNG
```

优先级：

```text
Magic signature
> 专用 Parser
> file 命令
> Generic Parser
```

但保留低优先级 Observation 作为审计。

Evidence Claim 使用高置信度结论。

### Encoding 冲突

多个 Codec 都成功但输出不同：

* 不直接选一个；
* 创建不同 Decode Branch；
* 由 readability、UTF-8、Candidate 和下一层检测评分。

### Tool failure 与有效输出并存

如果 Tool exit 非零但产生部分有效 Artifact：

* 状态为 partial；
* 保留 Evidence；
* 记录 Warning；
* 不把全部结果视为失败。

## Parser 错误

Parser 抛错：

* 原始结果保留；
* 添加 parser_failure Warning；
* Generic Parser 兜底；
* 不吞掉错误；
* 不让一个 Parser 错误阻止其他 Parser。

---

# 十八、TaskState 真正不可变

当前禁止外部直接修改：

```ts
store.getState().observations.push(...)
store.getState().artifactIds.push(...)
```

## getState

选择以下一种可靠方案：

### 方案 A：开发期深冻结

```ts
getState(): DeepReadonly<CTFTaskState>
```

每次 apply 后：

```ts
deepFreeze(nextState)
```

生产环境也可以保留浅性能优化，但测试和开发必须能发现非法修改。

### 方案 B：返回隔离快照

```ts
structuredClone(state)
```

但注意性能。

推荐：

* StateStore 内部保存 immutable 数据；
* 对外返回 DeepReadonly；
* 开发和测试环境 deepFreeze；
* 生产环境至少冻结数组和关键嵌套对象。

## Reducer

Reducer 必须始终：

* 返回新对象；
* 返回新数组；
* 不修改旧 State；
* 不修改 Event payload。

## 测试

必须验证：

```ts
const state = store.getState()

expect(() => {
  state.observations.push(...)
}).toThrow()
```

以及：

```ts
const before = store.getState()
store.apply(event)
const after = store.getState()

expect(before).not.toBe(after)
expect(before.observations).not.toBe(after.observations)
```

删除所有依赖直接修改 State 的测试。

测试需要构造 State 时，使用：

```ts
createTestTaskState(...)
```

或者发送 Event。

---

# 十九、State Listener 错误处理

当前不允许：

```ts
try {
  listener(state, event)
} catch {
  // ignore
}
```

## 建立 ListenerErrorHandler

```ts
export interface StateListenerError {
  listenerId: string
  eventType: CTFTaskEvent['type']
  error: unknown
  timestamp: number
}

export interface StateStoreOptions {
  onListenerError?: (
    error: StateListenerError
  ) => void
}
```

默认行为：

* 记录到 Logger；
* 记录 EventLog；
* 不阻止其他 Listener；
* 不回滚已提交 State；
* 不静默吞掉。

关键订阅者可以注册为：

```ts
critical: true
```

对于 Critical Listener：

* apply 仍完成；
* Runtime 标记 degraded；
* 产生可观测错误；
* 由 Orchestrator 决定是否停止。

不要让 UI Renderer 失败导致 Runtime 崩溃。

不要让 Projector/Persistence 失败完全不可见。

---

# 二十、Reasoning Action 执行接口

建立统一接口：

```ts
export interface StrategyActionExecutor {
  execute(input: {
    taskState: Readonly<CTFTaskState>
    action: SuggestedAction
    attempt: CTFAttempt
    signal: AbortSignal
  }): Promise<ActionExecutionResult>
}
```

不同 Action：

```text
run_workflow
run_oneshot
call_tool
request_handoff
verify_flag
stop
```

分别由 Adapter 实现。

ReasoningCoordinator 不直接知道具体：

* ToolBroker 参数；
* WorkflowRunner 参数；
* OneShot Dispatcher 参数；
* Specialist Factory 参数。

避免 ReasoningCoordinator 变成 God Object。

---

# 二十一、动作执行结果反馈

每个 Action 执行完成后，必须返回：

```ts
{
  status: 'executed'

  materializedResult: MaterializedResult

  executionRefs: {
    workflowRunId?: string
    oneShotRunId?: string
    agentRunId?: string
    handoffId?: string
  }
}
```

Coordinator 随后：

1. 应用 Observation。
2. 合并 Evidence。
3. 添加 Candidate。
4. 更新 Hypothesis。
5. 回填 Attempt。
6. 记录 StrategyDecision。
7. 评估 Stop。
8. 进入下一 Cycle。

不要让各 Action Adapter 分别自行维护不同闭环。

---

# 二十二、Planner 候选 Action 来源控制

每轮 Planner 只考虑：

* 本轮新增 SuggestedAction；
* 尚未执行且仍有效的 Pending Action；
* Candidate Validator 建议；
* HypothesisUpdater 建议。

不要每轮重新读取历史上所有 SuggestedAction 并全部重排。

建立 PendingActionStore 或 TaskState 字段：

```ts
pendingActions: PendingSuggestedAction[]
```

状态：

```ts
type PendingActionStatus =
  | 'pending'
  | 'selected'
  | 'executed'
  | 'rejected'
  | 'expired'
```

每个 Action 只能：

```text
pending
→ selected
→ executed
```

或者：

```text
pending
→ rejected
```

证据失效或 Hypothesis rejected 后：

```text
pending
→ expired
```

防止同一个 Action 反复选中。

---

# 二十三、Flag Candidate 与 Stop

Planner 发现 Candidate 时：

1. 先选择 `verify_flag` Action。
2. Validator 完成后：

   * validated；
   * rejected。
3. validated Candidate 可以产生：

   ```ts
   {
     type: 'stop',
     reason: 'validated flag candidate found'
   }
   ```
4. Stop 只停止自动推理循环。
5. Task 是否 solved：

   * 本地 Fixture 可由配置自动 solved；
   * 实际比赛默认等待人工或平台确认。

增加策略配置：

```ts
interface CompletionPolicy {
  autoCompleteLocalFixtures: boolean
  requirePlatformVerification: boolean
}
```

---

# 二十四、主路径集成测试

必须建立完整测试：

```text
Fake CTFTaskRuntime
→ Orchestrator.runWorkflow(unknown_file_triage)
→ file Tool 返回 PNG
→ ParserRegistry
→ Observation(file_type)
→ Evidence(file_signature)
→ HypothesisUpdater
→ Hypothesis: file is image
→ SuggestedAction(image_quick_scan)
→ StrategyPlanner
→ Attempt started
→ image_quick_scan
→ Exif Parser 返回 FlagCandidate
→ Attempt 绑定 Observation/Evidence/Candidate
→ verify_flag
→ Candidate validated
→ stop Action
→ Reasoning Loop 真正停止
```

验证：

* Stop 后不再执行其他 Action。
* Attempt 产物 ID 非空。
* StrategyDecision 中 Hypothesis IDs 非空。
* Workflow Condition 不被旧 Artifact 触发。
* Candidate 有 Attempt 来源。
* Task 不自动 solved，除非 local Fixture policy 开启。

---

# 二十五、并发 Run Condition 测试

建立两个 WorkflowRun：

```text
Run A：旧 image scan，已有任意 Artifact
Run B：新 image scan，没有提取 Artifact
```

验证 Run B 的：

```text
artifact_exists producedByStep=binwalk-extract
```

返回 false。

再让 Run B 产生一个真实提取 Artifact，返回 true。

建立两个 encoding Workflow：

```text
Run A：有 negative_result
Run B：没有 no_new_unique_output
```

验证 Run B 不因 Run A Evidence 停止。

---

# 二十六、Evidence 合并测试

输入：

```text
FileParser:
文件是 PNG，confidence 0.85

HexHeaderParser:
文件是 PNG，confidence 0.98
```

预期：

* 只有一个 `file_signature` Evidence。
* Evidence 有两个 Sources。
* 综合 Confidence 有界。
* Sources 保留 Parser ID。
* Hypothesis 只关联一个 Evidence ID。

冲突测试：

```text
Parser A：文件是 ZIP
Parser B：Magic 显示 PNG
```

预期：

* 保留两个 Observation。
* 高优先级 PNG Evidence。
* ZIP Observation 被标记低置信度或 conflict。
* StrategyDecision Reason 说明选择依据。

---

# 二十七、预算测试

验证：

* cheap Action 消费 1 Unit。
* normal 消费 3 Unit。
* expensive 消费 8 Unit。
* 执行结束后累计预算不会减回去。
* 并发槽位会释放。
* 达到 Task 累计上限后 Action 被拒绝。
* Budget 拒绝记录 StrategyDecision。
* Task 恢复后预算仍存在。
* 两个 Task 的预算互不影响。

---

# 二十八、静态禁止检查

完成后执行：

```bash
rg -n "skipReason:\s*['\"]policy['\"].*stop|case ['\"]stop['\"].*skipped" src/core/ctfReasoning

rg -n "ATTEMPT_COMPLETED" src/core/ctfReasoning/reasoningCoordinator.ts

rg -n "observationIds:\s*\[\]|evidenceIds:\s*\[\]|artifactIds:\s*\[\]" src/core/ctfReasoning/reasoningCoordinator.ts

rg -n "basedOnHypothesisIds:\s*\[\]" src/core/ctfReasoning

rg -n "artifactIds\.length\s*>\s*0" src/core/ctfReasoning/workflowCondition.ts

rg -n "kind:\s*['\"]negative_result['\"].*stop|kind:\s*['\"]generic['\"].*maxDepth" src/workflows/typed/encodingSweep.ts

rg -n "producer.*createEvidenceFingerprint|producer.*fingerprint" src/core/ctfReasoning/evidence.ts

rg -n "aggregate\.(observations|evidence|suggestedActions)\.push" src/core/ctfReasoning/parserRegistry.ts

rg -n "catch\s*\{\s*\}" src/core/ctfRuntime/taskStateStore.ts

rg -n "getState\\(\\).*push|getState\\(\\).*splice" src tests

rg -n "ReasoningCoordinatorV2|StrategyPlannerV2|OrchestratorV2" src
```

允许测试 Fixture 初始化存在空数组。

生产运行完成逻辑不得固定返回空产物。

---

# 二十九、验证命令

执行：

```bash
pnpm typecheck
pnpm build
pnpm lint
pnpm test
```

运行无网络 Smoke Test：

## Stop

```text
Planner 返回 stop
→ Coordinator 一轮结束
→ stopped=true
```

## Attempt Binding

```text
Fake Tool
→ Observation
→ Evidence
→ Attempt completed
→ Attempt 中产物 ID 非空
```

## Image Chain

```text
PNG
→ unknown_file_triage
→ image_quick_scan
→ metadata Candidate
→ verify
→ stop
```

## Encoding Scope

```text
旧 Workflow 存在 negative_result
→ 新 encoding_sweep 不受影响
```

## Evidence Merge

```text
file + hex parser
→ 同一 Evidence 多 Source
```

不得连接公共网络。

不得依赖真实 API Key。

---

# 三十、完成标准

只有以下全部满足才能结束。

## Reasoning 主路径

* Orchestrator 正式调用 ReasoningCoordinator。
* Main Agent 结果进入推理闭环。
* Workflow 最终结果进入推理闭环。
* OneShot 结果进入推理闭环。
* Specialist 结果进入推理闭环。
* 相同 Task 的 Reasoning Loop 不并发重入。

## Stop

* Stop Action 真正终止循环。
* Stop 不作为 skipped Attempt。
* Stop Reason 可追踪。
* Stop 不自动等于 solved。

## Attempt

* Attempt 在 Materialize 后完成。
* Attempt 绑定 Observation。
* Attempt 绑定 Evidence。
* Attempt 绑定 Artifact。
* Attempt 绑定 Candidate。
* 失败和取消状态正确。
* Retry 属于同一个 Attempt。

## Hypothesis

* 新 Evidence 自动创建或更新 Hypothesis。
* Planner 使用 Hypothesis。
* StrategyDecision 的 Hypothesis IDs 非空。
* Rejected Hypothesis 不继续驱动相同 Action。
* Revision 保留历史。

## Budget

* 并发预算和累计预算分离。
* 累计预算进入任务状态。
* 执行完成不返还累计消耗。
* 超预算 Action 被拒绝并记录原因。

## Condition

* Workflow Condition 默认限制当前 Run。
* Artifact 条件检查真实类型和 Producer。
* 旧 Artifact 不误触发新 Workflow。
* Encoding Stop Condition 有明确 Reason 和 Run Scope。

## Evidence

* Evidence 身份不包含 Producer。
* 同一结论支持多 Source。
* 冲突证据不会被覆盖。
* Confidence 合并有界。
* Hypothesis 不重复绑定等价 Evidence。

## Parser

* Parser 输出统一通过 ResultMerger。
* Observation 去重。
* Evidence 合并。
* SuggestedAction 去重。
* Candidate 合并。
* Parser 冲突有明确策略。
* Parser 失败可观测。

## State

* getState 返回不可变状态。
* 外部不能 push/splice。
* Reducer 不修改旧 State。
* Listener 错误不静默。
* Critical Listener 失败可观测。

## 工程

* 不存在 V2。
* 不新增大量 any。
* 不使用 eval。
* Typecheck 通过。
* Build 通过。
* Lint 通过。
* Tests 通过。
* Smoke Tests 通过。
* 文档与实现一致。

---

# 三十一、执行顺序

严格按照：

```text
1. 基线和审计
2. Stop Action
3. Attempt 生命周期顺序
4. Attempt 与产物绑定
5. Result Materialization Context
6. Evidence 多来源模型
7. ResultMerger
8. ParserConflictResolver
9. HypothesisUpdater
10. StrategyPlanner 使用 Hypothesis
11. 累计 Budget
12. Condition Scope
13. artifact_exists
14. encoding_sweep Stop
15. TaskState 不可变
16. Listener Error
17. ActionExecutor
18. ReasoningCoordinator 接入 Orchestrator
19. PendingAction 生命周期
20. Flag Stop 语义
21. 行为测试
22. 主路径集成测试
23. 静态检查
24. Smoke Test
25. 文档和最终报告
```

不要先迁移更多 Workflow。

不要先增加更多 Parser。

不要因为当前 561 个测试通过就跳过主路径集成测试。

不要在修复 Stop Action 后提前结束。

本轮最终目标是：

> ReasoningCoordinator 不再只是独立的规则组件，而是 CTFTaskOrchestrator 的真实任务级决策核心；每个 Attempt 都能解释自己为什么执行、产生了什么、支持或推翻了哪个 Hypothesis，以及系统为什么继续或停止。
