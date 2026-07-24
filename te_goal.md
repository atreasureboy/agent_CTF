# Agent_CTF Phase 2.3：真实动作执行与推理闭环持久化

你正在当前最新的 `agent_CTF` 仓库中工作。

当前项目已经实现：

* CTFTaskRuntime
* CTFTaskOrchestrator
* ReasoningCoordinator
* StrategyPlanner
* Observation
* Evidence
* HypothesisUpdater
* Attempt
* PendingAction
* Reasoning Budget
* ParserRegistry
* ResultMerger
* ParserConflictResolver
* Workflow DAG、Retry、Condition
* OneShot / Shotgun
* Handoff / Specialist
* TaskState 不可变机制

但是当前推理闭环仍存在一个核心断层：

> Planner 已经能够选择下一 Action，但生产 Runtime 没有可靠的真实 StrategyActionExecutor；部分 Action 可能被记录为成功，却没有真正调用 Workflow、Tool、OneShot、Handoff 或 Flag Validator。

本轮唯一目标是：

> 让每个 Strategy Action 都通过真实 Runtime 执行，并将执行结果重新进入 Observation → Evidence → Hypothesis → StrategyDecision 闭环；同时统一 PendingAction、Evidence 来源、Parser 冲突、累计预算和自动触发语义。

必须直接审计并修改当前仓库。

不要只写文档。

不要只新增接口。

不要等待用户确认。

不要创建 ExecutorV2、CoordinatorV2 或 OrchestratorV2。

---

# 一、本轮必须完成

1. 建立生产级 `RuntimeStrategyActionExecutor`。
2. 删除生产路径中的隐式 Noop Executor。
3. 将真实 Executor 注入 CTFTaskRuntime、Orchestrator 和 ReasoningCoordinator。
4. 实现六类 Action 的真实执行：

   * run_workflow
   * run_oneshot
   * call_tool
   * request_handoff
   * verify_flag
   * stop
5. Main Agent、Workflow、OneShot 和 Specialist 完成后自动触发任务级推理。
6. 防止自动触发造成递归和双重推理。
7. 统一 PendingAction 的状态所有权。
8. 删除模块级长期 `_internals` 真相源。
9. 修复 Evidence 原子合并。
10. 保留所有 Parser Producer 来源。
11. 修复 ParserConflictResolver 的语义冲突模型。
12. 修复 HypothesisUpdater 的阴性证据逻辑。
13. 强制 Hypothesis 状态转换经过状态机。
14. 修复累计预算的预测检查。
15. 每轮读取最新 TaskState，而不是旧快照。
16. 修复 Executor 返回 stop 时的 Attempt 生命周期。
17. 修复 Workflow failed/partial 状态映射。
18. 建立完整的真实动作链集成测试。

---

# 二、本轮禁止事项

不要：

* 不增加新工具。
* 不增加新 OneShot Manifest。
* 不增加新 Specialist。
* 不迁移 Reverse、Pwn、Web、PCAP Workflow。
* 不重写 ExecutionEngine。
* 不重写 OneShot Runner。
* 不引入数据库。
* 不引入消息队列。
* 不引入新的全局状态管理框架。
* 不使用 LLM 作为 Action Executor。
* 不使用 LLM 作为默认 Parser。
* 不创建平行 Runtime。
* 不保留生产 Noop Executor 作为静默回退。
* 不让同一结果被 ReasoningCoordinator 处理两次。
* 不通过扩大 Strategy Cycle 数量掩盖闭环错误。
* 不通过弱化测试让实现通过。

---

# 三、建立修改前基线

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

以 `package.json` 实际脚本为准。

重点阅读：

```text
src/core/ctfReasoning/reasoningCoordinator.ts
src/core/ctfReasoning/strategyActionExecutor.ts
src/core/ctfReasoning/strategyPlanner.ts
src/core/ctfReasoning/pendingActionStore.ts
src/core/ctfReasoning/resultMerger.ts
src/core/ctfReasoning/parserConflictResolver.ts
src/core/ctfReasoning/evidence.ts
src/core/ctfReasoning/hypothesisUpdater.ts
src/core/ctfReasoning/reasoningBudget.ts

src/core/ctfRuntime/createCTFTaskRuntime.ts
src/core/ctfRuntime/taskOrchestrator.ts
src/core/ctfRuntime/taskState.ts
src/core/ctfRuntime/taskEvents.ts
src/core/ctfRuntime/taskStateStore.ts

src/core/workflowEngine.ts
src/core/toolBroker.ts

src/ctf/oneshot/dispatcher.ts
src/core/ctfRuntime/handoffCoordinator.ts
```

执行搜索：

```bash
rg -n "createNoopStrategyActionExecutor|noop.*executor|executor\\?" src/core

rg -n "processReasoningInput|processNewReasoningInputs" src

rg -n "_internals|new Map.*taskId|PendingActionStore" src/core/ctfReasoning

rg -n "markExecuted|markRejected|expire|markPendingSelected" src/core

rg -n "EVIDENCE_MERGED|mergedFrom|mergeEvidence" src/core

rg -n "producer|sources" src/core/ctfReasoning/resultMerger.ts src/core/ctfReasoning/evidence.ts

rg -n "conflict|claim\\.toLowerCase|conflictKey" src/core/ctfReasoning/parserConflictResolver.ts

rg -n "negative_result|zsteg|stego" src/core/ctfReasoning/hypothesisUpdater.ts

rg -n "estimatedCostUnitsUsed|maxEstimatedCostUnits" src/core/ctfReasoning

rg -n "options\\.state|taskState:\\s*options\\.state" src/core/ctfReasoning/reasoningCoordinator.ts

rg -n "WORKFLOW_COMPLETED|WORKFLOW_FAILED|partial" src/core/ctfRuntime/taskOrchestrator.ts
```

将真实发现写入：

```text
docs/architecture/phase-2.3-real-action-loop.md
```

文档记录：

* Planner 当前如何选择 Action
* Action 当前是否真实执行
* Executor 当前注入位置
* Reasoning 自动触发位置
* PendingAction 当前所有者
* Evidence 当前合并流程
* Parser 冲突当前判定方式
* Budget 当前消费顺序
* 本轮最终调用链

完成审计后继续修改代码。

---

# 四、建立生产 RuntimeStrategyActionExecutor

建议创建：

```text
src/core/ctfReasoning/runtimeStrategyActionExecutor.ts
```

接口沿用现有 `StrategyActionExecutor`，但生产实现必须拥有完整 Runtime 依赖：

```ts
export interface RuntimeStrategyActionExecutorDependencies {
  runWorkflow(input: {
    workflowId: string
    inputs: Record<string, unknown>
    signal: AbortSignal
    reasoningContext: ReasoningExecutionContext
  }): Promise<WorkflowRunResult>

  runOneShot(input: {
    manifestId: string
    inputArtifactIds: string[]
    options?: Record<string, unknown>
    signal: AbortSignal
    reasoningContext: ReasoningExecutionContext
  }): Promise<OneShotResult>

  callTool(input: {
    toolId: string
    input: Record<string, unknown>
    signal: AbortSignal
    reasoningContext: ReasoningExecutionContext
  }): Promise<ToolResult>

  requestHandoff(input: {
    capability: string
    objective: string
    artifactIds: string[]
    evidenceIds: string[]
    hypothesisIds: string[]
    signal: AbortSignal
    reasoningContext: ReasoningExecutionContext
  }): Promise<SpecialistResult>

  verifyFlag(input: {
    candidateId: string
    signal: AbortSignal
    reasoningContext: ReasoningExecutionContext
  }): Promise<FlagValidationResult>
}
```

定义：

```ts
export interface ReasoningExecutionContext {
  taskId: string
  strategyDecisionId: string
  attemptId: string
  cascadeId: string
  reasoningDepth: number

  sourceAgentRunId?: string
  sourceWorkflowRunId?: string
  sourceOneShotRunId?: string
  sourceHandoffId?: string
}
```

生产 Executor 根据 Action 类型调用真实依赖。

禁止直接模拟空结果。

---

# 五、删除生产 Noop 回退

当前不得再使用：

```ts
const executor =
  options.executor ??
  createNoopStrategyActionExecutor()
```

改为：

```ts
if (!options.executor) {
  throw new MissingStrategyActionExecutorError()
}
```

允许测试和 Dry Run 显式传入：

```ts
mode: 'dry-run'
executor: createNoopStrategyActionExecutor()
```

但必须满足：

1. Dry Run 必须显式声明。
2. 生产 Runtime 不得进入 Dry Run。
3. Dry Run 的 Attempt 状态应为 `skipped_policy` 或 `simulated`。
4. 不得将 Noop 结果记录为真实 succeeded。
5. CLI 默认不是 Dry Run。
6. Runtime Factory 在创建 LLM/Workflow Runtime 时必须注入生产 Executor。

静态检查：

```bash
rg -n "executor\\s*\\?\\?" src/core/ctfReasoning
rg -n "createNoopStrategyActionExecutor" src
```

生产调用点不得隐式使用 Noop。

---

# 六、Action 真实执行语义

## 1. run_workflow

调用真实：

```ts
orchestrator.runWorkflow(...)
```

返回后必须获得：

* workflowRunId
* status
* observationIds
* evidenceIds
* artifactIds
* suggestedActions
* flagCandidateIds
* warnings

不得再次对同一 Workflow Result重复执行 Materializer。

ActionExecutionResult：

```ts
{
  status: 'executed',
  executionRefs: {
    workflowRunId,
  },
  materializedResult,
}
```

## 2. run_oneshot

调用真实 OneShot Dispatcher。

必须：

* 使用当前 Task ID。
* 创建真实 OneShot Run。
* 等待 ResultStore 中的最终结果。
* 取得 Observation/Evidence/Candidate。
* 返回 oneShotRunId。
* 响应 AbortSignal。
* 不绕过 Budget 和 Scope。

## 3. call_tool

通过真实 ToolBroker。

必须经过：

* Profile。
* Scope。
* Permission。
* Tool availability。
* Tool execution policy。
* AbortSignal。
* ResultMaterializer。

不能直接调用 Tool class。

## 4. request_handoff

调用：

```text
Orchestrator
→ requestHandoff
→ approveHandoff
→ Specialist
→ ResultMaterializer
```

必须返回：

* handoffId
* agentRunId
* Specialist Observation
* Specialist Evidence
* Artifact
* Candidate
* SuggestedAction

不得仅创建 Handoff 后立即声称 Action 成功。

## 5. verify_flag

调用真实 FlagCandidateValidator。

更新 Candidate：

```text
detected
→ validated
```

或：

```text
detected
→ rejected
```

返回 Validation Observation 和 Evidence。

## 6. stop

`stop` 仍由 Coordinator 在创建 Attempt 前处理。

生产 Executor 不应接收到 `action.type === 'stop'`。

若收到，抛出：

```text
UnexpectedStopActionExecutionError
```

避免已经创建 Attempt 后返回 stop，留下非终态 Attempt。

---

# 七、Executor 输出不得重复 Materialize

明确每种 Adapter 的边界。

推荐统一：

```ts
export interface ActionExecutionResult {
  status: 'executed'

  executionRefs: {
    workflowRunId?: string
    oneShotRunId?: string
    agentRunId?: string
    handoffId?: string
  }

  materializedResult: MaterializedResult

  resultAlreadyProjected: boolean
}
```

## resultAlreadyProjected

若 Workflow 或 OneShot 已经将 Observation/Evidence 写入 TaskState：

```ts
resultAlreadyProjected: true
```

Coordinator 只读取 IDs，不再次添加。

若普通 Tool 尚未投影：

```ts
resultAlreadyProjected: false
```

Coordinator 负责应用 Draft。

必须保证：

* 每个 Observation 只创建一次。
* 每条 Evidence 只 Upsert 一次。
* 每个 Candidate 只检测一次。
* Attempt 仍能绑定所有产生的 IDs。
* 不因重复 Materialize 产生重复 SuggestedAction。

---

# 八、自动触发 Reasoning

Reasoning 不应只通过外部手工调用。

建立统一入口：

```ts
async handleStructuredRunOutput(input: {
  source: ReasoningInputSource

  observationIds: string[]
  evidenceIds: string[]
  suggestedActions: SuggestedAction[]
  flagCandidateIds: string[]

  runRefs: {
    agentRunId?: string
    workflowRunId?: string
    oneShotRunId?: string
    handoffId?: string
  }

  cascade: ReasoningCascadeContext
}): Promise<ReasoningResult>
```

## 自动触发位置

### Main Agent

在 Main Agent 的结构化产物完成投影后触发一次。

### Workflow

在 Workflow 最终结果完成后触发一次。

Workflow 内部 Step 不直接启动任务级 Reasoning。

### OneShot

OneShot 完成并保存 Result 后触发一次。

### Specialist

Specialist 结果投影到父任务后触发一次。

## 不自动触发的情况

* Task 已 terminal。
* Run cancelled。
* 没有新 Observation、Evidence、Candidate 或 SuggestedAction。
* 本次结果已经由当前 Cascade 处理。
* 调用方明确设置 `suppressTaskReasoning=true`。

---

# 九、防止递归与双重处理

真实 Executor 调用 `runWorkflow()` 后，Workflow 完成钩子可能再次自动触发 Reasoning。

必须防止：

```text
Reasoning
→ runWorkflow Action
→ Workflow 自动 Reasoning
→ 再次进入 Reasoning
```

建立：

```ts
export interface ReasoningCascadeContext {
  cascadeId: string
  depth: number

  parentStrategyDecisionId?: string
  parentAttemptId?: string

  suppressAutomaticTrigger: boolean
}
```

规则：

1. Reasoning Executor 启动子 Action 时设置：

   ```ts
   suppressAutomaticTrigger: true
   ```
2. 子 Action 返回 Materialized Result。
3. 原 Coordinator 继续处理结果。
4. 外部用户直接运行 Workflow 时：

   ```ts
   suppressAutomaticTrigger: false
   ```
5. `depth` 硬上限，例如 8。
6. 每个 Run Output 记录：

   ```ts
   processedByCascadeIds: string[]
   ```

   或使用独立 ProcessedOutput Registry。
7. 相同 Run Output 不得被同一 Cascade 处理两次。

不要依赖全局 boolean。

---

# 十、Orchestrator 自动接入

`runMainAgent()`、`runWorkflow()`、OneShot 完成处理和 Specialist 完成处理最终应调用统一输出处理器。

不要在四个地方复制：

```text
收集 Observation
→ 收集 Evidence
→ Coordinator
```

建议创建：

```text
src/core/ctfReasoning/structuredOutputHandler.ts
```

接口：

```ts
export interface StructuredOutputHandler {
  handle(
    output: StructuredRunOutput,
    options: {
      autoReason: boolean
      cascade?: ReasoningCascadeContext
    },
  ): Promise<ReasoningResult | null>
}
```

Orchestrator 只调用 Handler。

Handler 负责：

* 验证新 ID 属于当前 Task。
* 去重。
* 更新 Hypothesis。
* 添加 Pending Action。
* 调用 ReasoningCoordinator。
* 记录结果。

---

# 十一、移除模块级 `_internals`

当前不得使用模块级：

```ts
const _internals = new Map<string, ...>()
```

保存：

* PendingActionStore
* selectedActionIds
* strategyDecisionIds
* finalObservationIds
* finalEvidenceIds

## 正确所有权

### 持久状态

存入 TaskState：

* pendingActions
* strategyDecisions
* reasoningBudget
* Attempt
* Observation
* Evidence
* Candidate

### 运行中状态

由 Task Runtime Instance 持有：

* 当前 Reasoning Lock
* 当前 Cascade
* 当前 in-flight Promise

### 单次调用结果

ReasoningCoordinator 方法内部局部变量：

```ts
const selectedActionIds: string[] = []
const strategyDecisionIds: string[] = []
```

每次调用返回本次新增 ID。

不得返回之前调用的累计 ID。

## Dispose

Runtime dispose 时：

* 取消 in-flight Reasoning。
* 释放 Task Lock。
* 不留下模块级 Map。
* Pending Action 已在 TaskState，无需内存恢复。

---

# 十二、PendingAction 唯一状态源

`TaskState.pendingActions` 成为唯一真相源。

删除独立内存 PendingActionStore，或将其改成对 StateStore 的薄 Repository。

必须实现状态：

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

或者：

```text
pending
→ expired
```

## 选择时

发送：

```ts
{
  type: 'PENDING_ACTION_SELECTED',
  actionId,
  strategyDecisionId,
}
```

## 执行成功

发送：

```ts
{
  type: 'PENDING_ACTION_EXECUTED',
  actionId,
  attemptId,
}
```

## 被 Policy 拒绝

发送：

```ts
{
  type: 'PENDING_ACTION_REJECTED',
  actionId,
  reason,
}
```

## Hypothesis 失效

发送：

```ts
{
  type: 'PENDING_ACTION_EXPIRED',
  actionId,
  reason,
}
```

要求：

* selected Action 不得永远停留 selected。
* Coordinator 失败时要恢复 pending 或转 rejected。
* Task 恢复后可以继续读取 pending Action。
* 相同 Fingerprint 不重复创建 Pending Action。
* Stop Action 不进入普通 PendingAction 长期存储。

---

# 十三、Evidence 原子 Upsert

当前不要先创建一个未加入 State 的 Evidence ID，再发送：

```ts
EVIDENCE_MERGED {
  mergedFrom: newEvidenceId
}
```

## 替换为 EVIDENCE_UPSERTED

建议事件：

```ts
{
  type: 'EVIDENCE_UPSERTED',
  evidence: EvidenceDraftWithSources,
}
```

Reducer：

1. 计算 Fingerprint。
2. 不存在则创建 Evidence。
3. 已存在则合并 Source。
4. 合并 Observation IDs。
5. 合并 Artifact IDs。
6. 合并 Attempt IDs。
7. 重算有界 Confidence。
8. 返回最终 Evidence ID。

由于普通 Reducer 不能直接向调用方返回 ID，可采用：

### 方案 A：Store upsert 方法

```ts
store.upsertEvidence(draft): {
  state: Readonly<CTFTaskState>
  evidenceId: string
  created: boolean
}
```

内部仍生成并记录 Event。

### 方案 B：预先计算稳定 ID

Evidence ID 根据稳定 Fingerprint确定。

同一 Evidence Draft 得出相同 Evidence ID。

然后 Event 可以直接 Upsert。

优先选择与现有架构兼容的最小方案。

禁止 Merge 引用不存在的 Evidence。

---

# 十四、EvidenceDraft 支持多来源

当前 `ResultMerger` 不得只保留第一个：

```ts
producer
```

将 Draft 改为：

```ts
export interface EvidenceDraft {
  kind: EvidenceKind
  subject?: EvidenceSubject

  claim: string
  normalizedClaim: string

  polarity: EvidencePolarity

  sources: EvidenceSourceDraft[]

  confidence: number
}
```

Parser 创建单 Source Draft。

ResultMerger 合并等价 Evidence 时：

* 合并 `sources`。
* 合并 observationIds。
* 合并 artifactIds。
* 合并 attemptIds。
* 不丢失第二个 Parser。
* 不把两个来源错误当成完全独立来源无限抬高置信度。

最终 Evidence 必须显示：

```text
FileParser
HexHeaderParser
```

两个来源。

---

# 十五、修复 ParserConflictResolver

当前冲突不能使用：

```text
kind + 相同 claim
```

作为唯一冲突键。

建立语义 Subject 和 Claim Family。

例如：

```ts
export type EvidenceClaimFamily =
  | 'file_type'
  | 'archive_type'
  | 'encoding_type'
  | 'binary_arch'
  | 'flag_value'
  | 'network_service'
  | 'generic'
```

冲突组 Key：

```text
taskId
+ subject artifact/entity
+ claimFamily
```

在同一组中比较不同 Claim：

```text
PNG
ZIP
generic data
```

## File Type 优先级

```text
Magic Header Parser
> 专用格式 Parser
> file 命令
> Extension
> Generic Parser
```

输出：

* 保留所有 Observation。
* 选定主要 Evidence。
* 低优先级冲突 Evidence 标记为：

  ```ts
  polarity: 'contradicts'
  ```

  或添加 conflict metadata。
* 产生 ParserConflict Warning。
* 不直接删除原始来源。

## 无法解决

若两个高可信来源冲突：

* Hypothesis 标记 inconclusive。
* SuggestedAction 建议额外验证。
* 不擅自选择一个高置信度结果。

---

# 十六、HypothesisUpdater 阴性证据

当前 `negative_result` 不得创建相反方向的正向 Hypothesis。

例如：

```text
zsteg 未发现有效结果
```

不能创建：

```text
图片存在隐写载荷
```

## 正确行为

若对应 Hypothesis 已存在：

* 添加 contradicting Evidence。
* 降低 Confidence。
* 视证据强度改为 inconclusive。
* 不直接 rejected，除非证据足够强。

若对应 Hypothesis 不存在：

可以创建：

```text
常规 zsteg 扫描未发现明显隐写
```

作为负向或限制性 Hypothesis。

或者只保留 Negative Evidence，不创建 Hypothesis。

## Rule 模型

将 Hypothesis Rule 明确区分：

```ts
{
  evidenceKind,
  evidencePolarity,
  propose?: HypothesisTemplate,
  supportCategory?: string,
  contradictCategory?: string,
}
```

不能只按 EvidenceKind匹配。

---

# 十七、Hypothesis 状态机

HypothesisUpdater 不得直接通过普通 patch 任意修改 status。

所有状态变化必须经过：

```ts
HYPOTHESIS_STATUS_CHANGED {
  hypothesisId,
  from,
  to,
  reason,
  evidenceIds,
}
```

Reducer 校验合法转换。

对于 terminal Hypothesis：

```text
supported
rejected
```

出现新冲突 Evidence 时：

1. 不直接把旧 Hypothesis 改回 testing。
2. 创建 Revision：

   ```ts
   revisionOf: oldHypothesisId
   ```
3. 新 Revision 进入 proposed/testing。
4. 旧结论保留。

更新 Evidence 关联、Priority 等非状态字段可以使用普通 Update Event。

---

# 十八、每轮使用最新 State

ReasoningCoordinator 不得长期使用：

```ts
options.state
```

作为循环期间的执行状态。

每轮开始：

```ts
const liveState = options.store.getState()
```

以下全部使用 liveState：

* Task terminal 判断。
* Hypothesis。
* Attempt Dedup。
* Pending Action。
* Budget。
* Candidate。
* Strategy Planner。
* Action Executor 的 taskState。

执行 Action 前再次读取最新 State。

执行完成后再次读取。

避免 Planner 使用上一 Cycle 的旧快照。

---

# 十九、预算预测检查

当前检查不能只判断：

```ts
used >= max
```

必须判断：

```ts
used + actionCost > max
```

例如：

```ts
const projectedCost =
  state.estimatedCostUnitsUsed +
  costUnits(action.costTier)

if (projectedCost > limits.maxEstimatedCostUnits) {
  reject
}
```

同样检查：

* actionsExecuted + 1
* workflowRunsUsed + 1
* oneShotRunsUsed + 1
* handoffsUsed + 1
* expensiveActionsUsed + 1

## 消费时机

建议：

```text
Action 通过所有 Policy
→ Pending Action selected
→ 预算预留
→ Attempt started
→ 执行
```

若执行因内部程序错误完全没有启动：

* 释放预留。

若真实外部执行已经启动：

* 累计成本不返还。

Stop Action：

* 可以消费 Strategy Cycle；
* 不消费 Tool Action 成本。

没有候选 Action：

* 不消费普通 Action 数量。
* Strategy Cycle 是否消费需明确并保持一致。

---

# 二十、修复 Executor stop 生命周期

生产 Executor 不允许对非 stop Action 返回：

```ts
status: 'stop'
```

将类型收紧：

```ts
type ExecutableSuggestedAction =
  Exclude<SuggestedAction, { type: 'stop' }>
```

Executor 只接受 Executable Action。

Coordinator 在创建 Attempt 前处理 Stop。

这样可以删除：

```text
Attempt 已创建
→ Executor 返回 stop
→ Attempt 永远非 terminal
```

这一非法路径。

---

# 二十一、Workflow 状态映射

审计 Orchestrator 当前 Workflow 映射。

必须区分：

```text
completed
partial
failed
cancelled
```

不得：

```text
WorkflowResult.status = failed
→ WORKFLOW_COMPLETED
```

事件建议：

```ts
WORKFLOW_COMPLETED
WORKFLOW_PARTIAL
WORKFLOW_FAILED
WORKFLOW_CANCELLED
```

`partial` 可以产生 Observation/Evidence，并进入 Reasoning。

`failed` 若有部分结果，也应 Materialize failure Evidence，但 Run 状态仍是 failed。

---

# 二十二、Structured Run Output

统一四种执行来源的输出：

```ts
export interface StructuredRunOutput {
  taskId: string

  source:
    | {
        type: 'main-agent'
        agentRunId: string
      }
    | {
        type: 'workflow'
        workflowRunId: string
      }
    | {
        type: 'oneshot'
        oneShotRunId: string
      }
    | {
        type: 'specialist'
        agentRunId: string
        handoffId: string
      }

  observationIds: string[]
  evidenceIds: string[]
  artifactIds: string[]
  flagCandidateIds: string[]

  suggestedActions: SuggestedAction[]

  status:
    | 'completed'
    | 'partial'
    | 'failed'
    | 'cancelled'

  warnings: string[]
}
```

所有自动 Reasoning 输入必须来自该结构。

不要从日志文本重新猜测产物。

---

# 二十三、主路径集成测试

必须建立真实行为测试，而不是只测试纯函数。

## 测试 1：Workflow Action 真执行

```text
初始 Evidence
→ SuggestedAction run_workflow
→ Planner 选择
→ RuntimeStrategyActionExecutor
→ Fake WorkflowRunner 实际被调用
→ 生成新 Observation/Evidence
→ Attempt completed
→ Pending Action executed
```

断言：

* Workflow 调用次数为 1。
* workflowRunId 非空。
* Attempt 产物非空。
* Action 状态为 executed。
* 不使用 Noop Executor。

## 测试 2：OneShot Action 真执行

```text
SuggestedAction run_oneshot
→ Dispatcher
→ Background Job
→ Fake Runner
→ ResultStore
→ Observation/Evidence
→ 下一 Cycle
```

## 测试 3：Tool Action 真执行

验证：

* ToolBroker 被调用。
* Scope 和 Profile 检查生效。
* Tool Result 进入 Materializer。
* Attempt 绑定产物。

## 测试 4：Handoff Action 真执行

验证：

* Handoff 创建。
* Specialist 被调用。
* Specialist Evidence 回到父 Task。
* Handoff ID 和 AgentRun ID 进入 ExecutionRefs。

## 测试 5：Flag → Stop

```text
Candidate
→ verify_flag Action
→ validated
→ stop Action
→ 循环结束
```

断言后续 Pending Action 未执行。

---

# 二十四、防重入集成测试

模拟：

```text
Reasoning
→ run_workflow
→ Workflow 完成
```

验证：

* Workflow 自动完成回调没有创建第二个并行 Coordinator。
* 当前 Cascade 只处理结果一次。
* StrategyDecision 不重复。
* Observation/Evidence 不重复。
* Attempt 不重复。
* Reasoning Lock 最终释放。

外部用户直接调用同一 Workflow 时：

* 自动 Reasoning 正常触发一次。

---

# 二十五、PendingAction 恢复测试

1. 创建 Task。
2. 添加两个 Pending Action。
3. 选择第一个但在执行前模拟进程恢复。
4. 从 TaskState 恢复 Runtime。
5. 根据恢复策略：

   * selected 但无活跃 Attempt 的 Action 恢复 pending；
   * 或标记 interrupted 后重新决策。
6. 已 executed Action 不再执行。
7. rejected/expired Action 不再选择。
8. 无模块级 Map 残留。

---

# 二十六、Evidence 原子合并测试

输入：

```text
FileParser：PNG
HexHeaderParser：PNG
```

验证：

* 不抛出 missing mergedFrom。
* 只有一个 Evidence ID。
* 有两个 Sources。
* 两个 Parser ID 都保留。
* Attempt IDs 都保留。

并发 Upsert：

* 两个 Parser 同时 Upsert 等价 Evidence。
* 最终仍只有一条 Evidence。
* 不丢 Source。

---

# 二十七、Parser 冲突测试

## PNG vs ZIP

同一 Artifact：

```text
file 命令：Zip archive
Magic Parser：PNG
```

验证：

* 两个 Observation 保留。
* 被识别为同一 file_type Claim Family 冲突。
* Magic Parser 优先。
* 生成 Conflict Warning。
* Hypothesis 使用主要 Evidence。
* 必要时建议进一步验证。

## 高可信冲突

两个高可信 Magic 来源不一致：

* 不自动选择。
* Hypothesis inconclusive。
* Planner 选择额外验证 Action。

---

# 二十八、Hypothesis 阴性测试

输入：

```text
zsteg no meaningful result
```

验证：

* 不创建“存在隐写载荷”的正向 Hypothesis。
* 若正向 Hypothesis 已存在：

  * Evidence 进入 contradictingEvidenceIds；
  * Confidence 下降；
  * 进入 inconclusive 或保持 testing。
* 不直接证明不存在隐写。

Terminal Revision 测试：

* supported Hypothesis 收到强冲突 Evidence。
* 旧 Hypothesis 保持 supported。
* 创建 revisionOf 新 Hypothesis。
* 新 Hypothesis 进入 proposed/testing。

---

# 二十九、静态禁止检查

完成后执行：

```bash
rg -n "createNoopStrategyActionExecutor" src/core/ctfRuntime src/core/ctfReasoning

rg -n "executor\\s*\\?\\?" src/core/ctfReasoning

rg -n "_internals" src/core/ctfReasoning

rg -n "new Map.*PendingAction" src/core/ctfReasoning

rg -n "mergedFrom" src/core/ctfReasoning src/core/ctfRuntime

rg -n "taskState:\\s*options\\.state" src/core/ctfReasoning

rg -n "claim\\.toLowerCase\\(\\).*conflict" src/core/ctfReasoning

rg -n "negative_result.*image-stego|negative_result.*steganography" src/core/ctfReasoning

rg -n "used\\s*>=\\s*limit|maxEstimatedCostUnits" src/core/ctfReasoning/reasoningBudget.ts

rg -n "WORKFLOW_COMPLETED" src/core/ctfRuntime/taskOrchestrator.ts

rg -n "ReasoningCoordinatorV2|RuntimeStrategyActionExecutorV2|OrchestratorV2" src
```

测试代码可以显式使用 Noop Executor。

生产 Runtime 不得隐式回退。

---

# 三十、验证命令

执行：

```bash
pnpm typecheck
pnpm build
pnpm lint
pnpm test
```

运行无网络 Smoke Test：

```text
本地 ZIP-like Artifact
→ unknown_file_triage
→ StrategyPlanner
→ run_workflow Action
→ Workflow 真执行
→ 新 Evidence
→ 下一 Action
→ stop
```

另一个：

```text
本地 Base64
→ encoding_sweep
→ Candidate
→ verify_flag
→ stop
```

检查：

* Executor 调用计数。
* Attempt 产物。
* Pending Action 状态。
* Cascade ID。
* Budget。
* Hypothesis。
* Evidence Sources。
* Stop Reason。
* Runtime dispose 后无残留 Lock/Map。

不得连接公共网络。

不得依赖真实 API Key。

---

# 三十一、完成标准

只有以下全部满足才可以结束。

## 真实动作

* run_workflow 真正执行。
* run_oneshot 真正执行。
* call_tool 真正执行。
* request_handoff 真正执行。
* verify_flag 真正执行。
* stop 在 Attempt 前处理。
* 生产 Runtime 不使用 Noop Executor。

## 自动主路径

* Main Agent 完成后自动进入 Reasoning。
* Workflow 完成后自动进入 Reasoning。
* OneShot 完成后自动进入 Reasoning。
* Specialist 完成后自动进入 Reasoning。
* 当前 Cascade 内不会重复触发。

## Pending Action

* TaskState 是唯一来源。
* selected 最终进入 executed/rejected/expired。
* Runtime 恢复后可以继续。
* 不存在模块级长期 Map。

## Evidence

* Evidence Upsert 原子完成。
* 不引用不存在的 mergedFrom。
* 多 Parser Producer 不丢失。
* 并发 Upsert 不重复。
* 冲突 Evidence 可识别。

## Hypothesis

* Negative Evidence 不创建反向正 Hypothesis。
* 所有状态变化经过状态机。
* Terminal Hypothesis 使用 Revision。
* Planner 使用最新 Hypothesis。

## Budget

* 检查执行后的预测消费。
* 并发预算和累计预算分开。
* Action 真正启动后才计入不可返还消费。
* Stop 不消费 Tool Action 成本。

## 状态

* 每轮读取最新 TaskState。
* 单次 ReasoningResult 只返回本次新增 ID。
* Workflow 状态映射准确。
* Runtime dispose 后无 Reasoning 内存残留。

## 工程质量

* 不存在 V2。
* 不新增大量 any。
* 不使用 eval。
* Typecheck 通过。
* Build 通过。
* Lint 通过。
* Tests 通过。
* Smoke Test 通过。
* 文档与实现一致。

---

# 三十二、最终报告格式

## 1. 修改前执行断层

列出：

* Noop Executor 回退
* Orchestrator 未注入 Executor
* 自动 Reasoning 缺失
* Pending Action 双真相源
* Evidence Merge 引用不存在对象
* Producer 丢失
* Conflict Resolver 无法识别不同 Claim
* Negative Evidence 反向提出 Hypothesis
* Budget 可超限
* 旧 State 快照

## 2. 最终调用链

说明：

```text
Run Output
→ StructuredOutputHandler
→ ReasoningCoordinator
→ StrategyPlanner
→ RuntimeStrategyActionExecutor
→ Real Runtime Action
→ Materialized Result
→ Observation / Evidence / Hypothesis
→ 下一 Cycle或 Stop
```

## 3. 六类 Action

分别说明真实执行路径和返回数据。

## 4. 防重入

说明 Cascade、Depth、Suppress Trigger 和 Lock。

## 5. 状态所有权

说明：

* PendingAction
* Reasoning Budget
* Cascade
* Evidence
* Hypothesis
* Attempt
* StrategyDecision

## 6. 文件变更

列出新增、修改、删除和兼容接口。

## 7. 测试结果

列出真实命令与通过数量。

## 8. 静态禁止检查

逐条列出搜索结果。

## 9. 未解决问题

只列真实存在但不影响真实动作闭环的问题。

不要列：

* 更多工具
* 更多 Manifest
* 更多 Workflow
* 更复杂 LLM Planner

这些属于后续阶段。

---

# 三十三、执行顺序

严格按照：

```text
1. 基线和审计
2. RuntimeStrategyActionExecutor
3. 删除生产 Noop 回退
4. 六类 Action Adapter
5. StructuredRunOutput
6. StructuredOutputHandler
7. 自动 Reasoning 触发
8. Cascade 防重入
9. PendingAction 单一状态源
10. 删除模块级 internals
11. Evidence 原子 Upsert
12. EvidenceDraft 多来源
13. ParserConflictResolver
14. Hypothesis 阴性语义
15. Hypothesis 状态机和 Revision
16. 每轮 Live State
17. 预算预测检查
18. Workflow 状态映射
19. 真实动作测试
20. 防重入测试
21. 恢复测试
22. 静态检查
23. Smoke Test
24. 文档和最终报告
```

不要迁移新的题型 Workflow。

不要因为 581 项旧测试通过就跳过真实 Executor 集成测试。

不要在接口创建后提前结束。

本轮最终目标是：

> StrategyPlanner 选择的每个 Action 都能在真实 Runtime 中发生；每个结果都能回到同一个推理闭环；系统能解释动作为什么被选择、实际执行了什么、产生了哪些证据，以及为什么继续或停止。
