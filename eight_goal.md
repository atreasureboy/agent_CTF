# Agent_CTF Phase 2.1：结构化推理闭环与自适应 Workflow

你正在当前最新的 `agent_CTF` 仓库中工作。

当前项目已经完成：

* CTFTaskRuntime 单一入口
* CTFTaskOrchestrator
* TaskExecutionContext
* ProfileStore
* Main Agent / Workflow / Specialist 生命周期
* HandoffCoordinator
* BackgroundJobManager
* OneShot / Shotgun 子系统
* OneShotResultStore
* Manifest Catalog
* Process / Container / Service Runner
* ScopeGate
* BudgetManager
* Finding / Artifact / FlagCandidate 投影
* Hypothesis 和 Attempt 基础类型

本轮不再继续修 OneShot 基础设施，也不增加更多工具。

本轮唯一目标是：

> 将当前“执行工具 → 返回字符串 → 生成静态 Finding”的系统，升级为“工具结果 → Observation → Evidence → Hypothesis → Attempt → StrategyDecision → 下一行动”的结构化 CTF 解题闭环。

本轮必须直接审计、修改和接入真实生产路径。

不要只新增类型。

不要只写文档。

不要只修改 Prompt。

不要等待用户确认。

不要创建 WorkflowEngineV2 或 ReasoningRuntimeV2。

---

# 一、本轮必须完成

必须完成以下内容：

1. 建立统一 Observation 模型。
2. 建立统一 Evidence 模型。
3. 扩展 Hypothesis 生命周期。
4. 扩展 Attempt 生命周期和稳定指纹。
5. 建立 ResultMaterializer。
6. 建立 ParserRegistry。
7. 将普通 Tool、Workflow 和 OneShot 输出统一转化为 Observation/Evidence。
8. 建立类型化 WorkflowCondition。
9. 实现真正可执行的 Stop Condition。
10. 实现真正的 Step Retry。
11. 实现具有依赖关系的 Workflow DAG。
12. 建立轻量、确定性的 StrategyPlanner。
13. 建立 AttemptDeduplicator。
14. 建立 CostPolicy 和 ToolSelectionPolicy。
15. 建立 FlagCandidateDetector 与本地 Validator。
16. 迁移三个代表性 Workflow：

    * `unknown_file_triage`
    * `image_quick_scan`
    * `encoding_sweep`
17. 将 OneShot 结果纳入同一推理闭环。
18. 将 Handoff 上下文升级为结构化证据子集。
19. 让 Orchestrator 驱动有限、可终止的策略循环。
20. 增加真实行为测试和无网络 Smoke Test。

---

# 二、本轮禁止事项

不要：

* 不增加新 OneShot Manifest。
* 不增加新的第三方工具。
* 不增加新的 Specialist Profile。
* 不一次迁移全部 Workflow。
* 不实现真实平台自动提交。
* 不自动连接未授权公共目标。
* 不引入图数据库。
* 不引入向量数据库。
* 不引入消息队列。
* 不引入大型规则引擎。
* 不使用 LLM 解析所有工具输出。
* 不重写底层 ExecutionEngine。
* 不重写 OneShot Runner。
* 不创建 WorkflowEngineV2。
* 不创建 ReasoningRuntimeV2。
* 不长期保留新旧两套 Workflow 语义。
* 不让 StrategyPlanner 绕过 Scope、Profile、Permission 或 Budget。
* 不让 Workflow 无限递归执行 SuggestedAction。
* 不因为发现类似 Flag 的字符串就直接将任务标记 solved。

---

# 三、开始前审计

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

以 `package.json` 的实际 scripts 为准。

重点读取：

```text
src/core/workflowDefinition.ts
src/core/workflowEngine.ts
src/core/workflowRunner.ts
src/workflows/builtins.ts

src/core/ctfRuntime/taskState.ts
src/core/ctfRuntime/taskEvents.ts
src/core/ctfRuntime/taskStateStore.ts
src/core/ctfRuntime/taskOrchestrator.ts
src/core/ctfRuntime/taskStateProjector.ts

src/ctf/oneshot/outputParser.ts
src/ctf/oneshot/selector.ts
src/ctf/oneshot/dispatcher.ts
src/ctf/oneshot/types.ts

src/core/toolBroker.ts
src/core/findings.ts
src/core/artifacts.ts
```

执行：

```bash
rg -n "stopConditions|onFailure.*retry|executionMode.*dag" src
rg -n "when:\s*['\"]|evaluateCondition" src
rg -n "emit_finding|summary:.*summary|suggestedAgent" src/workflows
rg -n "HYPOTHESIS|ATTEMPT|FlagCandidate" src/core/ctfRuntime
rg -n "readFileSync|builtInParsers|NormalizedFinding" src/ctf/oneshot
rg -n "capturedOutputs" src/core
rg -n "Promise\.allSettled" src/core/workflowEngine.ts
```

把真实发现写入：

```text
docs/architecture/phase-2.1-reasoning-loop.md
```

文档记录：

* 当前 Workflow 执行语义
* 当前 Retry 行为
* 当前 DAG 行为
* 当前 Condition 行为
* 当前 Stop Condition 行为
* 当前 Tool 结果结构
* 当前 OneShot Parser 输出结构
* 当前 Hypothesis/Attempt 使用位置
* 当前下一步决策由谁负责
* 本轮迁移边界

完成审计后继续修改代码。

---

# 四、建立统一 Observation

建议创建：

```text
src/core/ctfReasoning/observation.ts
```

定义：

```ts
export type ObservationKind =
  | 'file_type'
  | 'file_magic'
  | 'metadata'
  | 'embedded_data'
  | 'printable_text'
  | 'encoding_result'
  | 'archive_entry'
  | 'image_property'
  | 'binary_protection'
  | 'tool_availability'
  | 'command_status'
  | 'network_service'
  | 'flag_like_text'
  | 'negative_result'
  | 'generic'

export interface ObservationSource {
  type:
    | 'tool'
    | 'workflow'
    | 'oneshot'
    | 'agent'
    | 'specialist'
    | 'manual'

  toolId?: string
  workflowId?: string
  workflowRunId?: string
  stepId?: string
  oneShotRunId?: string
  agentRunId?: string
  handoffId?: string
  artifactId?: string
}

export interface Observation {
  id: string
  taskId: string

  kind: ObservationKind
  source: ObservationSource

  summary: string

  attributes: Record<string, unknown>

  rawExcerpt?: string

  confidence: number

  createdAt: number
}
```

要求：

1. `confidence` 范围统一为 `0–1`。
2. Observation 表示“某个执行结果中观察到了什么”。
3. Observation 不直接代表最终事实。
4. 每个 Observation 必须绑定 Source。
5. `rawExcerpt` 必须有统一长度上限。
6. 大型原始输出必须保存为 Artifact，而不是全部塞入 State。
7. 相同 Run 内的等价 Observation 应稳定去重。
8. 不允许无 taskId、无 source 的 Observation。
9. Negative Result 也应成为 Observation，例如：

   * zsteg 没有有效命中；
   * binwalk 没发现签名；
   * 某 binary 不可用；
   * 某解码方式失败。

---

# 五、建立统一 Evidence

建议创建：

```text
src/core/ctfReasoning/evidence.ts
```

定义：

```ts
export type EvidenceKind =
  | 'file_signature'
  | 'extension_mismatch'
  | 'embedded_archive'
  | 'suspicious_metadata'
  | 'encoding_decoded'
  | 'encoding_layer'
  | 'known_magic'
  | 'binary_protection'
  | 'flag_candidate_source'
  | 'tool_failure'
  | 'tool_unavailable'
  | 'negative_result'
  | 'generic'

export interface EvidenceProducer {
  type:
    | 'parser'
    | 'workflow'
    | 'oneshot'
    | 'agent'
    | 'specialist'
    | 'manual'

  id: string
}

export interface Evidence {
  id: string
  taskId: string

  kind: EvidenceKind

  claim: string

  observationIds: string[]
  artifactIds: string[]

  polarity: 'supports' | 'contradicts' | 'neutral'

  confidence: number

  producer: EvidenceProducer

  createdAt: number
}
```

关键区别：

```text
Observation:
binwalk 在偏移 0x1234 输出 “Zip archive data”

Evidence:
目标文件包含一个可提取的 ZIP 数据区
```

要求：

1. Evidence 必须引用至少一个 Observation 或 Artifact。
2. 不允许无来源 Evidence。
3. Evidence 使用稳定指纹去重。
4. Evidence 不直接等于 FlagCandidate。
5. Negative Evidence 必须保留。
6. 同一 Claim 可以有多个来源。
7. 多来源应合并 Source，而不是重复污染 State。
8. Evidence 的置信度不能高于来源能支持的范围。
9. Parser 不得凭空生成高置信度结论。

---

# 六、扩展 CTFTaskState

在现有 State 中增加：

```ts
observations: Observation[]
evidence: Evidence[]
strategyDecisions: StrategyDecision[]
```

保留现有：

```ts
hypotheses
attempts
flagCandidates
```

事件至少增加：

```ts
OBSERVATION_ADDED
OBSERVATIONS_ADDED

EVIDENCE_ADDED
EVIDENCE_MERGED

HYPOTHESIS_PROPOSED
HYPOTHESIS_STATUS_CHANGED

ATTEMPT_STARTED
ATTEMPT_COMPLETED
ATTEMPT_FAILED
ATTEMPT_CANCELLED
ATTEMPT_SKIPPED

STRATEGY_DECISION_RECORDED

FLAG_CANDIDATE_DETECTED
FLAG_CANDIDATE_VALIDATED
FLAG_CANDIDATE_REJECTED
```

要求：

* Event 携带 Reducer 所需完整数据。
* 不允许事件只带 ID 后让 Reducer无从更新。
* Terminal Task 不允许启动新 Attempt。
* Terminal Task 可以接收必要的 bookkeeping 更新，但不能恢复执行。
* Observation 和 Evidence ID 不重复。
* 不更新不存在的 Hypothesis、Attempt 或 Candidate。
* 不允许非法状态倒退。

---

# 七、扩展 Hypothesis 生命周期

将现有 `CTFHypothesis` 升级为：

```ts
export interface CTFHypothesis {
  id: string
  taskId: string

  statement: string
  category: string

  status:
    | 'proposed'
    | 'testing'
    | 'supported'
    | 'rejected'
    | 'inconclusive'

  supportingEvidenceIds: string[]
  contradictingEvidenceIds: string[]

  proposedBy: {
    type: 'planner' | 'workflow' | 'agent' | 'specialist' | 'manual'
    id: string
  }

  priority: number
  confidence: number

  revisionOf?: string

  createdAt: number
  updatedAt: number
}
```

允许转换：

```text
proposed → testing
proposed → rejected

testing → supported
testing → rejected
testing → inconclusive

inconclusive → testing
```

禁止直接：

```text
rejected → supported
supported → testing
```

若新证据推翻旧结论：

* 创建新的 Revision；
* 保留旧 Hypothesis；
* 使用 `revisionOf` 建立关系。

至少支持以下自动初筛假设：

```text
文件扩展名与真实类型不一致
文件包含附加数据
文件包含嵌入归档
图片元数据含异常文本
图片可能存在隐写
输入可能是 Base16
输入可能是 Base32
输入可能是 Base64
输入可能是 Base85
输入可能是 URL Encoding
解码结果仍是另一层编码
解码结果包含 FlagCandidate
```

---

# 八、扩展 Attempt 生命周期

升级现有 `CTFAttempt`：

```ts
export interface CTFAttempt {
  id: string
  taskId: string

  kind:
    | 'tool'
    | 'workflow'
    | 'oneshot'
    | 'handoff'
    | 'verification'
    | 'manual'

  targetId: string

  input: Record<string, unknown>

  fingerprint: string

  hypothesisIds: string[]

  status:
    | 'pending'
    | 'running'
    | 'succeeded'
    | 'failed'
    | 'cancelled'
    | 'skipped_duplicate'
    | 'skipped_policy'
    | 'skipped_budget'

  observationIds: string[]
  evidenceIds: string[]
  artifactIds: string[]
  flagCandidateIds: string[]

  retryExecutions?: AttemptExecution[]

  error?: {
    code?: string
    message: string
    retryable?: boolean
  }

  startedAt?: number
  completedAt?: number
}
```

定义：

```ts
export interface AttemptExecution {
  index: number
  startedAt: number
  completedAt?: number

  status: 'succeeded' | 'failed' | 'cancelled'

  errorCode?: string
  errorMessage?: string
}
```

---

# 九、建立稳定 Attempt Fingerprint

建议创建：

```text
src/core/ctfReasoning/attemptFingerprint.ts
```

接口：

```ts
export function createAttemptFingerprint(input: {
  kind: CTFAttempt['kind']
  targetId: string
  parameters: Record<string, unknown>
  inputArtifactIds?: string[]
}): string
```

要求：

1. 对对象 Key 稳定排序。
2. 规范化路径。
3. Artifact 使用 ID 或 SHA-256，不使用临时绝对路径。
4. 去除：

   * 时间戳；
   * Run ID；
   * Session 临时目录；
   * 无关日志参数。
5. 不将密码、Token、完整 Flag 等敏感数据写入 Fingerprint 文本。
6. 最终使用 SHA-256 或项目现有稳定 Hash。
7. 等价输入产生相同 Fingerprint。
8. 实质不同输入产生不同 Fingerprint。
9. Workflow Retry 属于同一个 Attempt，不创建新 Fingerprint。
10. 人工 Override 必须记录原因。

---

# 十、建立 AttemptDeduplicator

建议创建：

```text
src/core/ctfReasoning/attemptDeduplicator.ts
```

接口：

```ts
export interface AttemptCandidate {
  kind: CTFAttempt['kind']
  targetId: string
  input: Record<string, unknown>
  inputArtifactIds?: string[]
  hypothesisIds?: string[]
  overrideReason?: string
}

export interface AttemptDeduplicationDecision {
  allowed: boolean

  fingerprint: string

  reason?: string
  existingAttemptId?: string
}

export interface AttemptDeduplicator {
  check(
    candidate: AttemptCandidate,
    state: Readonly<CTFTaskState>,
  ): AttemptDeduplicationDecision
}
```

规则：

* 相同成功 Attempt 默认禁止重复。
* 相同 running Attempt 禁止并发重复。
* 相同失败 Attempt 且输入没有变化，默认禁止立即重试。
* 若输入 Artifact SHA、参数或工具版本变化，可以重新执行。
* 显式人工 Override 可以执行，但记录原因。
* Planner 不能自行伪造 Override。
* Tool 内部 Retry 不创建新 Attempt。
* OneShot 的 Attempt 使用 Manifest ID + Artifact + Options。
* Workflow Attempt 使用 Workflow ID + 输入。
* Handoff Attempt 使用 Capability + Artifact + Objective。

---

# 十一、建立 ResultMaterializer

建议创建：

```text
src/core/ctfReasoning/resultMaterializer.ts
```

它负责把不同执行系统输出统一成：

```ts
export interface MaterializedResult {
  observations: ObservationDraft[]
  evidence: EvidenceDraft[]

  suggestedActions: SuggestedAction[]

  flagCandidateDrafts: FlagCandidateDraft[]

  warnings: string[]

  rawArtifactIds: string[]

  metrics?: {
    durationMs?: number
    outputBytes?: number
    truncated?: boolean
  }
}
```

输入来源：

```ts
type MaterializableResult =
  | ToolExecutionMaterial
  | WorkflowStepMaterial
  | OneShotMaterial
  | SpecialistMaterial
```

要求：

1. 普通 Tool、Workflow Step、OneShot、Specialist 使用同一套输出语义。
2. ResultMaterializer 不直接执行下一步。
3. Materializer 不直接修改 TaskState。
4. Materializer 输出 Draft。
5. Orchestrator 或 Workflow Runtime 将 Draft 转为正式 Event。
6. 原始完整输出保存为 Artifact。
7. 不使用 LLM 作为默认 Materializer。
8. 无 Parser 时使用 Generic Parser。
9. Generic Parser 只生成：

   * command status；
   * bounded preview；
   * warning。
10. Generic Parser 不产生高置信度 Evidence。

---

# 十二、建立 ParserRegistry

建议创建：

```text
src/core/ctfReasoning/parserRegistry.ts
src/core/ctfReasoning/parsers/
```

定义：

```ts
export interface ParserSelectionInput {
  toolId?: string
  manifestId?: string
  workflowId?: string
  stepId?: string
  mimeType?: string
}

export interface ParserInput {
  taskId: string
  source: ObservationSource

  content?: string

  stdoutPath?: string
  stderrPath?: string

  artifactIds: string[]

  exitCode?: number
  isError: boolean

  parserOptions?: Record<string, unknown>
}

export interface ResultParser {
  id: string

  supports(input: ParserSelectionInput): boolean

  parse(input: ParserInput): Promise<MaterializedResult>
}
```

Registry：

```ts
export class ParserRegistry {
  register(parser: ResultParser): void

  resolve(input: ParserSelectionInput): ResultParser[]

  parse(
    selection: ParserSelectionInput,
    input: ParserInput,
  ): Promise<MaterializedResult>
}
```

要求：

* Parser ID 唯一。
* 稳定排序。
* 不匹配时使用 Generic Parser。
* Parser 失败不应使原始 Tool Result 丢失。
* Parser Failure 产生 Warning 和低置信度 Observation。
* Parser 必须限制输出数量。
* 大文件使用流式读取。
* 不重复维护 OneShot 私有 Parser Registry 和通用 Parser Registry。

---

# 十三、统一 OneShot Parser

当前 OneShot 已有：

```text
passthrough
flag-regex
file
strings
binwalk
zsteg
checksec
jsonl
```

迁移原则：

1. 保留 Manifest 的 `output.parser` 字段。
2. OneShot Parser 注册到统一 ParserRegistry。
3. OneShot 原来的 `NormalizedFinding` 输出通过兼容 Adapter 转为 Observation/Evidence。
4. 最终生产路径不再让 OneShot Parser 直接成为唯一 Finding 真相。
5. 兼容期允许同时生成 Finding，但 Finding 必须引用 Evidence ID。
6. `passthrough` 只生成 bounded preview Observation。
7. 不将 preview 直接视为有意义 Finding。
8. `file` 生成：

   * file_type Observation；
   * file_signature Evidence。
9. `strings` 生成：

   * printable_text Observation；
   * flag_like_text Observation；
   * 必要 Candidate。
10. `binwalk` 生成：

    * embedded_data Observation；
    * embedded_archive Evidence；
    * 提取 Artifact SuggestedAction。
11. `zsteg` 生成：

    * image property Observation；
    * meaningful result Evidence；
    * no-result Negative Evidence。
12. `checksec` 生成结构化 Protection Attributes。

不要长期维护两套 Parser 实现。

---

# 十四、本轮必须实现的 Parser

至少实现：

```text
GenericParser
FileParser
HexHeaderParser
StringsParser
ExifToolParser
BinwalkParser
ZstegParser
ChecksecParser
EncodingParser
```

## GenericParser

输出：

* command_status Observation；
* bounded preview；
* Tool unavailable / failed Evidence；
* warning。

## FileParser

识别：

```text
PNG
JPEG
GIF
ZIP
7z
GZIP
PDF
ELF
PE
PCAP
ASCII/UTF-8 text
generic data
```

输出：

* file_type Observation；
* file_signature Evidence；
* extension mismatch Evidence；
* SuggestedAction。

## HexHeaderParser

通过 Magic 识别：

```text
PNG
JPEG
GIF
ZIP
PDF
ELF
PE
GZIP
7z
RAR
PCAP
PCAPNG
```

## StringsParser

输出：

* 可打印字符串数量；
* 受限的可疑字符串；
* FlagCandidate；
* keyword Evidence。

不能把所有字符串都放入 State。

## ExifToolParser

解析：

```text
Comment
Description
UserComment
Software
Author
Creator
GPS
自定义字段
异常长字段
```

## BinwalkParser

解析：

* Decimal offset；
* Hex offset；
* Signature；
* Embedded type；
* Extracted path；
* no signatures。

## ZstegParser

区分：

* high-quality text；
* known file signature；
* binary noise；
* no meaningful result；
* unavailable。

## ChecksecParser

结构化：

```ts
{
  arch
  relro
  canary
  nx
  pie
  rpath
  runpath
  stripped
}
```

## EncodingParser

输出：

* codec；
* decode success；
* output hash；
* readability score；
* UTF-8 validity；
* next-layer codec guesses；
* FlagCandidate。

---

# 十五、建立 SuggestedAction

建议创建：

```text
src/core/ctfReasoning/suggestedAction.ts
```

定义：

```ts
export type CostTier = 'cheap' | 'normal' | 'expensive'

export type SuggestedAction =
  | {
      type: 'run_workflow'
      workflowId: string
      inputs: Record<string, unknown>
      reason: string
      priority: number
      costTier: CostTier
      hypothesisIds?: string[]
    }
  | {
      type: 'run_oneshot'
      manifestId: string
      inputArtifactIds: string[]
      options?: Record<string, unknown>
      reason: string
      priority: number
      costTier: CostTier
      hypothesisIds?: string[]
    }
  | {
      type: 'call_tool'
      toolId: string
      input: Record<string, unknown>
      reason: string
      priority: number
      costTier: CostTier
      hypothesisIds?: string[]
    }
  | {
      type: 'request_handoff'
      capability: string
      objective: string
      reason: string
      priority: number
      costTier: CostTier
      artifactIds: string[]
      findingIds?: string[]
      observationIds?: string[]
      evidenceIds?: string[]
      hypothesisIds?: string[]
    }
  | {
      type: 'verify_flag'
      candidateId: string
      reason: string
      priority: number
      costTier: CostTier
    }
  | {
      type: 'stop'
      reason: string
      priority: number
      costTier: CostTier
    }
```

Parser 和 Workflow 可以建议 Action。

它们不能直接执行 Action。

---

# 十六、建立 StrategyPlanner

建议创建：

```text
src/core/ctfReasoning/strategyPlanner.ts
```

接口：

```ts
export interface StrategyPlanningInput {
  state: Readonly<CTFTaskState>

  newObservationIds: string[]
  newEvidenceIds: string[]

  suggestedActions: SuggestedAction[]
}

export interface RejectedAction {
  action: SuggestedAction
  reason:
    | 'duplicate_attempt'
    | 'scope_denied'
    | 'profile_denied'
    | 'tool_unavailable'
    | 'budget_denied'
    | 'task_terminal'
    | 'missing_input'
    | 'lower_value_alternative'
    | 'hypothesis_rejected'
    | 'manual_approval_required'
}

export interface StrategyDecision {
  id: string
  taskId: string

  selectedAction?: SuggestedAction

  rejectedActions: RejectedAction[]

  reason: string

  basedOnObservationIds: string[]
  basedOnEvidenceIds: string[]
  basedOnHypothesisIds: string[]

  createdAt: number
}
```

Planner 本轮使用确定性规则，不额外调用 LLM。

优先级：

1. 已检测且未验证的高置信度 FlagCandidate。
2. 能直接验证高优先级 Hypothesis 的 cheap Action。
3. 能显著降低不确定性的 normal Action。
4. 新 Artifact 的类型化 Triage。
5. 明确目标的 Specialist Handoff。
6. expensive Action。

拒绝：

* 重复 Attempt。
* 超出 Scope。
* Profile 不允许。
* Tool/Manifest unavailable。
* Budget 不足。
* 输入缺失。
* Task terminal。
* 目标 Hypothesis 已 rejected。
* 存在成本更低且信息增益相近的行动。
* Heavy/Expensive 需要人工批准。

---

# 十七、ToolSelectionPolicy 与 CostPolicy

不要让 StrategyPlanner 同时承担所有准入判断。

建立：

```text
ToolAuthorization
ToolSelectionPolicy
AttemptDeduplicator
CostPolicy
```

## ToolAuthorization

负责：

* Profile；
* ContestScope；
* Permission；
* Manifest health；
* Tool availability。

## ToolSelectionPolicy

负责：

* 当前步骤是否值得执行；
* 已有 Evidence 是否足够；
* 是否存在更适合的 OneShot；
* 是否已经完成相同 Triage。

## AttemptDeduplicator

负责：

* 是否重复。

## CostPolicy

负责：

* cheap / normal / expensive；
* Heavy approval；
* 当前预算；
* 并发 Lane。

不要破坏现有 ToolBroker 的执行时安全复查。

---

# 十八、类型化 WorkflowCondition

替换新 Workflow 中的字符串条件。

定义：

```ts
export type WorkflowCondition =
  | {
      type: 'step_succeeded'
      stepId: string
    }
  | {
      type: 'step_failed'
      stepId: string
    }
  | {
      type: 'observation_exists'
      kind: ObservationKind
      where?: Record<string, unknown>
      minConfidence?: number
    }
  | {
      type: 'evidence_exists'
      kind: EvidenceKind
      polarity?: Evidence['polarity']
      minConfidence?: number
    }
  | {
      type: 'hypothesis_status'
      hypothesisId?: string
      category?: string
      status: CTFHypothesis['status']
    }
  | {
      type: 'flag_candidate_exists'
      minConfidence?: number
      validated?: boolean
    }
  | {
      type: 'artifact_exists'
      artifactType?: string
    }
  | {
      type: 'attempt_exists'
      fingerprint?: string
      targetId?: string
      statuses?: CTFAttempt['status'][]
    }
  | {
      type: 'all'
      conditions: WorkflowCondition[]
    }
  | {
      type: 'any'
      conditions: WorkflowCondition[]
    }
  | {
      type: 'not'
      condition: WorkflowCondition
    }
```

升级 Step：

```ts
{
  id: string
  kind: 'if'

  condition: WorkflowCondition

  then: WorkflowStep[]
  else?: WorkflowStep[]
}
```

旧：

```ts
when: string
```

允许 Legacy Adapter，但：

* 标记 deprecated；
* 仅供未迁移 Workflow；
* 三个目标 Workflow 禁止使用；
* 不创建第二个 Workflow Engine。

---

# 十九、实现 ConditionEvaluator

创建：

```text
src/core/ctfReasoning/conditionEvaluator.ts
```

接口：

```ts
export interface WorkflowConditionContext {
  state: Readonly<CTFTaskState>
  stepOutcomes: ReadonlyMap<string, StepOutcome>
}

export function evaluateWorkflowCondition(
  condition: WorkflowCondition,
  context: WorkflowConditionContext,
): boolean
```

要求：

* 纯函数。
* 无副作用。
* 不执行任意 JS。
* 不使用 eval。
* 不使用字符串表达式解释器。
* 所有分支具有单元测试。
* 缺失字段保守返回 false。
* 非法 Condition 在 Schema 阶段拒绝。

---

# 二十、真正的 Stop Condition

将：

```ts
stopConditions: string[]
```

升级为：

```ts
stopConditions: WorkflowCondition[]
```

执行规则：

1. 每个 Step Materialize 完成后重新评估。
2. 命中后不调度新 Step。
3. 已运行 Step 按当前取消策略收敛。
4. Result 记录：

   * stoppedEarly；
   * matchedStopCondition；
   * stopReason。
5. 命中 Stop Condition 不视为失败。
6. FlagCandidate 条件只能停止 Workflow，不自动将 Task solved。
7. Stop Condition 必须可以引用 Observation、Evidence、Candidate 和 Step Outcome。

扩展：

```ts
export interface WorkflowRunResult {
  ...

  stoppedEarly: boolean
  stopReason?: string

  matchedStopCondition?: WorkflowCondition

  observationIds: string[]
  evidenceIds: string[]
  strategyDecisionIds: string[]
}
```

---

# 二十一、实现真正 Retry

替换模糊：

```ts
onFailure: 'retry'
```

为：

```ts
retry?: {
  maxAttempts: number

  backoffMs?: number

  backoffMultiplier?: number

  retryOn?: Array<
    | 'timeout'
    | 'temporary_error'
    | 'tool_unavailable'
    | 'nonzero_exit'
  >
}
```

保留 `onFailure`：

```ts
onFailure?: 'continue' | 'abort'
```

规则：

* 默认不重试。
* `maxAttempts` 硬上限不超过 3。
* Retry 属于同一个 Attempt。
* 每次执行记录 AttemptExecution。
* Scope Denied 不重试。
* Permission Denied 不重试。
* 参数校验错误不重试。
* Duplicate Attempt 不重试。
* Task Abort 后不重试。
* Backoff 等待必须响应 AbortSignal。
* Tool unavailable 只有在配置明确允许时重试。
* 成功后立即停止 retry。

---

# 二十二、实现真正 DAG

为 Workflow Step 增加：

```ts
dependsOn?: string[]
```

顶层 `executionMode: 'dag'` 必须：

1. 校验所有 Step ID 唯一。
2. 校验 dependsOn 指向存在。
3. 检测环。
4. 只调度依赖已经完成的 Step。
5. 独立 Step 可以并行。
6. 依赖失败时按配置：

   * skip；
   * continue；
   * abort。
7. 不使用顶层 `Promise.allSettled(workflow.steps)` 代替 DAG。
8. Task Abort 后不调度新节点。
9. Stop Condition 命中后不调度新节点。
10. 结果顺序可追踪。
11. 并发修改 Outcome/Observation 时保持确定性。
12. 同一 Step 只执行一次。

建议增加：

```ts
dependencyFailurePolicy?:
  | 'skip'
  | 'continue'
  | 'abort'
```

---

# 二十三、升级 StepExecutionResult

Workflow Runner 不再只返回：

```ts
{
  content
  isError
  artifactIds
}
```

升级为：

```ts
export interface StepExecutionResult {
  content: string
  isError: boolean

  artifactIds: string[]

  observations: ObservationDraft[]
  evidence: EvidenceDraft[]
  suggestedActions: SuggestedAction[]
  flagCandidateDrafts: FlagCandidateDraft[]

  warnings: string[]

  metrics: {
    durationMs: number
    outputBytes?: number
    truncated?: boolean
  }

  error?: {
    code?: string
    message: string
    retryable: boolean
  }
}
```

WorkflowBrokerRunner：

```text
ToolBroker result
→ ResultMaterializer
→ StepExecutionResult
```

WorkflowEngine 不直接解析 Tool 字符串。

---

# 二十四、动态 Finding

升级 `emit_finding`。

新形式：

```ts
{
  kind: 'emit_finding'
  id: string

  category: string
  title: string

  fromEvidence?: {
    kinds?: EvidenceKind[]
    minConfidence?: number
    polarity?: Evidence['polarity']
  }

  fromObservations?: {
    kinds?: ObservationKind[]
    minConfidence?: number
  }

  summaryTemplate?: string

  includeSuggestedActions?: boolean
}
```

Finding 必须引用：

* Observation IDs；
* Evidence IDs；
* Artifact IDs；
* Producer Workflow；
* Producer Step；
* Confidence；
* Suggested Actions。

如果没有真实 Evidence：

* 不生成虚假 Finding；
* 或生成明确的“未发现有效证据”低置信度 Finding。

三个迁移 Workflow 禁止继续使用固定：

```text
“简要汇总”
“命中 / 失败列表”
“推荐 Agent”
```

---

# 二十五、迁移 unknown_file_triage

改成真实 DAG：

```text
file
├── hex_header
├── strings
└── entropy_optional

materialize
→ type-specific branch
→ strategy decision
→ dynamic finding
```

建议 Step：

```text
identify-file
read-magic
extract-strings
entropy
classify
emit-summary
```

分支：

## PNG/JPEG/GIF

建议：

```text
run_workflow: image_quick_scan
```

## ZIP/7z/GZIP/RAR

产生：

* embedded/archive Evidence；
* archive Artifact；
* 解包或列表 Action。

## ELF/PE

建议：

* binary triage；
* checksec OneShot；
* reverse Specialist。

## PCAP/PCAPNG

建议：

* pcap triage。

## Text

检测：

* Base16；
* Base32；
* Base64；
* URL Encoding；
* JSON；
* FlagCandidate。

## 未知高熵

建议：

* file-forensics Handoff；
* expensive Action 不自动执行。

Stop Conditions：

* 已产生 validated FlagCandidate；
* 已确认类型并选出下一 Workflow；
* Task cancelled。

禁止：

```ts
suggestedAgent: 'image-stego|crypto|file-forensics'
```

改成结构化 Capability Requirement。

---

# 二十六、迁移 image_quick_scan

改成：

```text
file + image metadata
→ integrity checks
→ parallel cheap scan
→ materialize
→ conditional extraction / specialist
```

Step：

```text
file
exiftool
strings
pngcheck/identify
binwalk
zsteg
```

真实分支：

## Metadata 异常

产生：

* suspicious_metadata Observation；
* Evidence；
* Candidate。

## Binwalk 发现嵌入内容

产生：

* embedded_data Observation；
* embedded_archive Evidence；
* 提取 Artifact；
* 对新 Artifact 运行 unknown_file_triage。

## Zsteg 有意义结果

产生：

* Evidence；
* Candidate；
* 支持“图片存在隐写载荷”Hypothesis。

## 无有效结果

产生：

* Negative Evidence；
* 请求 image-stego Specialist。

## Tool unavailable

记录：

* tool_unavailable Evidence；
* 不当作扫描成功；
* 不生成误导 Finding。

Stop Conditions：

* validated Candidate；
* 已提取新 Artifact 并派发 Triage；
* 初筛完成且 Handoff 已创建。

---

# 二十七、迁移 encoding_sweep

不要继续对全部编码无脑并行执行。

实现解码树：

```ts
export interface DecodeNode {
  id: string
  parentId?: string

  codec: string
  depth: number

  inputHash: string
  outputHash: string

  readabilityScore: number
  utf8Valid: boolean

  nextCodecCandidates: string[]

  observationIds: string[]
  evidenceIds: string[]
  flagCandidateIds: string[]
}
```

限制：

```ts
maxDepth: 4
maxBranchesPerDepth: 8
maxTotalAttempts: 24
maxOutputBytesPerNode: 1_048_576
```

步骤：

1. 输入字符集分析。
2. 只选择合理 Codec。
3. 解码。
4. 计算可读性。
5. 输出去重。
6. 下一层编码检测。
7. Candidate 检测。
8. 达到限制停止。

支持：

```text
Base16
Base32
Base64
Base64 URL-safe
Base85
URL Encoding
ROT13
```

规则：

* 相同 outputHash 不重复展开。
* 空输出不视为成功。
* Exit Code 0 不等于有效解码。
* 不可打印二进制可以保存 Artifact。
* Candidate 命中后停止低价值分支。
* 每个 Codec Attempt 有稳定 Fingerprint。
* 不无限递归。
* 不将完整输入写入日志。

---

# 二十八、FlagCandidate 闭环

扩展现有 FlagCandidate：

```ts
export interface FlagCandidate {
  id: string
  taskId: string

  value: string
  normalizedValue: string

  sourceObservationIds: string[]
  sourceEvidenceIds: string[]
  sourceArtifactIds: string[]
  sourceRunIds: string[]

  transformChain?: Array<{
    operation: string
    inputHash: string
    outputHash: string
  }>

  confidence: number

  validation: {
    patternMatched: boolean
    provenanceComplete: boolean
    locallyVerified: boolean
    platformVerified: boolean

    errors: string[]
  }

  status:
    | 'detected'
    | 'validated'
    | 'rejected'
    | 'submitted'
    | 'accepted'

  createdAt: number
  updatedAt: number
}
```

建立：

```text
flagCandidateDetector.ts
flagCandidateValidator.ts
```

Detector：

* Task challenge flagPattern；
* 可配置常见格式；
* Tool/OneShot 输出；
* Strings；
* Metadata；
* Decode output。

Validator：

* Pattern；
* 长度；
* 字符合法性；
* Provenance；
* Transform Chain；
* Source Artifact 是否存在。

本轮禁止自动提交真实比赛平台。

只有：

```text
patternMatched
&& provenanceComplete
&& locallyVerified
```

才能进入 `validated`。

即便 validated，也不自动将 Task solved，除非当前 Orchestrator 策略明确允许本地 CTF Fixture。

---

# 二十九、有限策略循环

在 Orchestrator 中建立：

```ts
runStrategyCycle(...)
```

但不要让 Orchestrator 成为新 God Object。

建议创建：

```text
src/core/ctfReasoning/reasoningCoordinator.ts
```

职责：

```text
接收新 Observation/Evidence
→ 更新 Hypothesis
→ 收集 SuggestedAction
→ StrategyPlanner
→ Policy 检查
→ AttemptDeduplicator
→ 执行一个 Action
→ Materialize
→ 下一循环
```

限制：

```ts
maxStrategyCycles: 8
maxActionsPerCycle: 1
```

允许一个明确安全的并行批次。

每轮前检查：

* Task terminal；
* AbortSignal；
* Budget；
* Scope；
* Profile；
* Duplicate Attempt；
* Tool/Manifest availability；
* Heavy approval。

不要无限自动运行。

---

# 三十、Handoff 上下文升级

Handoff 增加：

```ts
observationIds: string[]
evidenceIds: string[]
hypothesisIds: string[]
failedAttemptFingerprints: string[]
```

创建 Specialist Prompt 时只投影相关子集：

```text
目标
相关 Artifact
相关 Finding
相关 Observation
相关 Evidence
当前 Hypothesis
已失败 Attempt
约束
完成条件
```

不要将整个 TaskState 全量塞入 Prompt。

Prompt 明确：

```text
不要重复 listed failed attempts
不要重新执行已经完成的基础 triage
优先验证 current hypotheses
任何新结论必须关联 Evidence
没有证据时明确标记为 Hypothesis
```

Specialist 返回结果继续经过 ResultMaterializer。

---

# 三十一、兼容旧 Workflow

未迁移 Workflow：

```text
rsa_common_attacks
binary_triage
pwn_triage
web_triage
pcap_triage
```

可以暂时使用 Legacy Adapter。

要求：

* 标记 `legacy: true` 或等价元数据；
* 继续使用旧字符串 Condition 时发出一次 Warning；
* 不阻塞当前运行；
* 不创建第二个 Engine；
* 新 ConditionEvaluator 和新 WorkflowEngine 扩展应在同一主路径；
* 三个迁移 Workflow 必须完全使用新语义。

---

# 三十二、测试要求

## Observation

覆盖：

* 有 Source。
* Confidence 范围。
* Raw excerpt 截断。
* 等价 Observation 去重。
* Negative Observation。

## Evidence

覆盖：

* 无来源拒绝。
* 多 Observation 关联。
* 稳定去重。
* Supports / Contradicts。
* 多来源合并。

## Hypothesis

覆盖：

* proposed → testing → supported。
* testing → rejected。
* testing → inconclusive。
* 非法状态转换拒绝。
* Revision 保留历史。

## Attempt

覆盖：

* 稳定 Fingerprint。
* 成功 Attempt 不重复。
* Running Attempt 不并发重复。
* 失败 Attempt 不立即重复。
* 输入变化允许新 Attempt。
* Retry 不创建多个 Attempt。

## Parser

覆盖：

```text
file
hex header
strings
exiftool
binwalk
zsteg
checksec
encoding
generic
```

## Condition

覆盖：

```text
step_succeeded
step_failed
observation_exists
evidence_exists
hypothesis_status
flag_candidate_exists
artifact_exists
attempt_exists
all
any
not
```

## Stop Condition

* 每个 Step 后评估。
* 命中后不调度新 Step。
* 不当作失败。
* Result 记录原因。

## Retry

* Temporary error 重试。
* Scope denied 不重试。
* Permission denied 不重试。
* Abort 不重试。
* 达到上限结束。
* Backoff 响应取消。

## DAG

* 依赖顺序。
* 独立节点并行。
* 环检测。
* 缺失依赖拒绝。
* 依赖失败 skip。
* Stop 后不调度。
* Abort 后不调度。
* Step 只执行一次。

## Planner

* Candidate 验证优先。
* Cheap 高信息增益优先。
* Duplicate 拒绝。
* Scope 拒绝。
* Unavailable 拒绝。
* Budget 拒绝。
* Expensive 需要批准。
* Terminal 返回 stop。

---

# 三十三、三个 Workflow 集成测试

## unknown_file_triage

输入：

* PNG；
* ZIP；
* ELF；
* PCAP；
* Base64 text；
* unknown high entropy。

验证：

* Observation；
* Evidence；
* Hypothesis；
* StrategyDecision；
* SuggestedAction；
* Stop Condition。

## image_quick_scan

Fake 输出：

* Exif Comment；
* Binwalk ZIP；
* Zsteg text；
* Zsteg no finding；
* Tool unavailable。

验证动态分支和 Handoff。

## encoding_sweep

输入：

* 单层 Base64；
* Base64 → Hex；
* URL → Base64；
* 重复 Output；
* 二进制输出；
* 最大深度；
* Candidate。

验证：

* Attempt 数量受限；
* 不重复；
* Candidate 提前停止；
* Transform Chain 完整。

---

# 三十四、真实主路径集成测试

建立：

```text
Fake CTFTaskRuntime
→ run unknown_file_triage
→ ToolBroker Fake Tool
→ ResultMaterializer
→ Observation
→ Evidence
→ Hypothesis
→ StrategyPlanner
→ run image_quick_scan / OneShot
→ Candidate
→ local validation
→ TaskState
```

另一个测试：

```text
OneShot Result
→ unified ParserRegistry
→ Observation
→ Evidence
→ SuggestedAction
→ StrategyDecision
```

不要只调用各个纯函数。

必须经过真实 Runtime 主路径。

---

# 三十五、静态禁止检查

完成后执行：

```bash
rg -n "stopConditions:\s*z?\.?array\(z\.string|stopConditions:\s*\[\s*\]" src

rg -n "onFailure:\s*['\"]retry['\"]" src

rg -n "executionMode.*dag.*Promise\.allSettled|parallel.*dag" src/core/workflowEngine.ts

rg -n "when:\s*['\"]" src/workflows

rg -n "suggestedAgent:\s*['\"][^'\"]*\|" src/workflows

rg -n "summary:\s*['\"].*(简要汇总|命中 / 失败|推荐领域 Agent)" src/workflows

rg -n "readFileSync" src/core/ctfReasoning src/ctf/oneshot/outputParser.ts

rg -n "eval\(|new Function" src/core/ctfReasoning src/core/workflowEngine.ts

rg -n "WorkflowEngineV2|ReasoningRuntimeV2" src

rg -n "return state.*OBSERVATION|return state.*EVIDENCE" src/core/ctfRuntime
```

允许未迁移 Legacy Workflow 命中旧格式，但：

* 必须明确标记 Legacy；
* 三个目标 Workflow 不得命中；
* 最终报告逐项解释剩余命中。

---

# 三十六、验证命令

执行：

```bash
pnpm typecheck
pnpm build
pnpm lint
pnpm test
```

运行无网络 Smoke Test。

## Encoding

```bash
node dist/bin/ovogogogo-ctf.js \
  --profile crypto \
  --run-workflow encoding_sweep \
  --text 'RkxBR3t0ZXN0fQ=='
```

检查：

* Observation；
* Evidence；
* Hypothesis；
* Attempt；
* StrategyDecision；
* FlagCandidate；
* Stop Reason。

## Unknown file

创建本地 ZIP-like Fixture：

```bash
printf '\x50\x4b\x03\x04test' > /tmp/ctf-zip-like.bin
```

运行：

```bash
node dist/bin/ovogogogo-ctf.js \
  --profile triage \
  --run-workflow unknown_file_triage \
  --input /tmp/ctf-zip-like.bin
```

## Image

使用仓库内无害 PNG Fixture。

不得连接公共网络。

不得使用真实攻击目标。

---

# 三十七、完成标准

只有全部满足才能结束。

## 结构化结果

* 普通 Tool 可产生 Observation/Evidence。
* Workflow Step 可产生 Observation/Evidence。
* OneShot 可产生 Observation/Evidence。
* Specialist 可产生 Observation/Evidence。
* 所有 Evidence 有来源。
* Negative Result 被记录。

## 推理闭环

* Hypothesis 生命周期完整。
* Attempt 生命周期完整。
* 重复 Attempt 被阻止。
* StrategyDecision 有可解释原因。
* Planner 经过 Scope/Profile/Budget/Policy。
* 策略循环有硬上限。

## Workflow

* 三个 Workflow 已迁移。
* Typed Condition 工作。
* Stop Condition 工作。
* Retry 工作。
* DAG 依赖工作。
* Dynamic Finding 工作。
* SuggestedAction 工作。
* Legacy Workflow 明确标记。

## Flag

* Candidate 有 Observation/Evidence 来源。
* Candidate 有 Transform Chain。
* Validator 工作。
* 未验证 Candidate 不会导致 solved。
* 不自动提交真实平台。

## Handoff

* 传递结构化 Evidence 子集。
* 不重复失败 Attempt。
* Specialist 返回结果进入统一 Materializer。

## 工程质量

* 不存在 WorkflowEngineV2。
* 不存在 ReasoningRuntimeV2。
* 不使用 eval。
* 不使用大量 any。
* 不无限读取输出。
* Typecheck 通过。
* Build 通过。
* Lint 通过。
* Tests 通过。
* Smoke Test 通过。
* 文档与实现一致。

---

# 三十八、执行顺序

严格按照：

```text
1. 基线和审计
2. Observation / Evidence
3. TaskState 和 Events
4. Hypothesis 生命周期
5. Attempt 和 Fingerprint
6. AttemptDeduplicator
7. ParserRegistry
8. ResultMaterializer
9. OneShot Parser 统一
10. SuggestedAction
11. ToolSelectionPolicy / CostPolicy
12. StrategyPlanner
13. Typed Condition
14. Stop Condition
15. Retry
16. DAG Scheduler
17. Flag Detector / Validator
18. unknown_file_triage
19. image_quick_scan
20. encoding_sweep
21. ReasoningCoordinator
22. Orchestrator 集成
23. Handoff 上下文升级
24. 行为测试
25. 静态禁止检查
26. Smoke Test
27. 文档和最终报告
```

不要同时迁移全部 Workflow。

不要在创建类型后提前结束。

不要让结构化信息只存在于测试。

真实 CLI 和 CTFTaskRuntime 必须产生并使用：

```text
Observation
Evidence
Hypothesis
Attempt
StrategyDecision
```

本轮最终目标是：

> 每次执行都是可追踪的 Attempt；每个原始结果都被转化为 Observation；每个结论都绑定 Evidence；每个下一步都有可解释的 StrategyDecision；系统能够根据真实结果调整路线，并主动避免重复已经失败或已经完成的操作。
