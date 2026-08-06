# super2_plan.md — Competition Optimization Plan (竞速优化)

> **背景**: 比赛形式是给定一个接口导出大量 CTF 题目，要求以尽可能短的时间完成最多的题目来获胜。
> **核心指标**: 做题准确率 + 解题效率（单位时间内完成题目数 = throughput）
> **策略**: 5 轮迭代，每轮聚焦一个竞速维度 → 实现 → 审计 → 下一轮

---

## 总体评估基线（竞速视角）

| 维度      | 当前状态                                    | 目标状态                                |
| --------- | ------------------------------------------- | --------------------------------------- |
| 并发控制  | 固定 4，无自适应                            | 动态自适应（1-N），基于成功率自动调节   |
| 题目分类  | LLM 驱动（100% 走 chat 模式）               | 三层分流：fast-path → oneshot → LLM     |
| 超时控制  | 无硬超时（`maxTaskDurationMs` 仅 advisory） | 每任务硬超时 + 全局竞速 deadline        |
| 模型策略  | 单一模型（`gpt-4o`）全部题目                | 分层模型：easy→cheap/fast, hard→capable |
| 重试机制  | 无                                          | 失败自动换 profile 重试（最多 2 次）    |
| Flag 提取 | 单一路径（findings 扫描）                   | 多路径提取 + SHA256 验证                |
| 跨题学习  | 无（每个 task 完全隔离）                    | 共享模式缓存 + 热启动                   |
| 提交重试  | 无（429 直接报 error）                      | 指数退避重试                            |
| 启动开销  | subprocess spawn（solve.ts）或 runtime 创建 | 对象池复用                              |

---

## 架构总览：三层分流管道

```
Challenge API 导出题目
        │
        ▼
┌──────────────────────────────────────┐
│  Layer 0: Pre-flight Classifier      │  ← Round 1
│  分析题目描述 + 附件 + 类别的特征     │
│  输出: { tier: fast|medium|heavy }   │
└──────────┬───────────────────────────┘
           │
     ┌─────┼─────┐
     ▼     ▼     ▼
  fast   medium  heavy
     │     │       │
     ▼     ▼       ▼
┌────────┐ ┌──────────┐ ┌──────────┐
│OneShot │ │Shotgun   │ │LLM Agent │  ← Round 1 + 3
│Direct  │ │Coordinator│ │Dispatch  │
│(0 LLM) │ │(parallel) │ │(profile) │
└───┬────┘ └────┬─────┘ └────┬─────┘
    │           │            │
    └───────────┴────────────┘
                │
                ▼
┌──────────────────────────────────────┐
│  Multi-Pass Flag Extraction          │  ← Round 3
│  ① stdout regex ② findings scan      │
│  ③ SHA256 verify ④ confidence rank  │
└──────────┬───────────────────────────┘
           │
           ▼
┌──────────────────────────────────────┐
│  Submission Engine with Retry        │  ← Round 5
│  指数退避 + 429 handling + batch    │
└──────────────────────────────────────┘
```

---

## Round 1: 预检分流 & 快通道（Pre-flight Triage & Fast-Path）⚡

### 目标

将简单题（encoding/misc/基础 forensics）从 LLM 路径中剥离，用零 LLM 调用的 oneshot 工具直接求解，大幅降低延迟和 token 成本。

### 1.1 创建 `ChallengeClassifier`（新文件）

**文件**: `src/ctf/competition/challengeClassifier.ts`

```typescript
export type ChallengeTier = 'fast' | 'medium' | 'heavy'

export interface ClassificationResult {
  tier: ChallengeTier
  confidence: number // 0-1
  recommendedProfiles: string[]
  recommendedManifests: string[] // oneshot manifest IDs
  features: {
    hasAttachments: boolean
    attachmentTypes: string[]
    descriptionKeywords: string[]
    category: string
    estimatedComplexity: number // 1-10
  }
}
```

**分类逻辑（确定性规则，零 LLM 调用）**:

| 条件                                           | Tier     | 策略                                      |
| ---------------------------------------------- | -------- | ----------------------------------------- |
| category=encoding + base64/hex/rot13 关键词    | `fast`   | oneshot: `ciphey` + `cipher-identifier`   |
| category=misc + "strings"/"grep"/"find" 关键词 | `fast`   | oneshot: `strings` + `file`               |
| category=forensics + 单一文件附件(.png/.jpg)   | `fast`   | oneshot: `zsteg` + `exiftool` + `binwalk` |
| category=forensics + .pcap/.pcapng             | `medium` | shotgun: `nmap` + `strings` + `tcpdump`   |
| category=crypto + RSA 关键词                   | `medium` | oneshot: `rsactftool` + LLM 辅助          |
| category=reverse                               | `heavy`  | LLM agent (reverse profile)               |
| category=pwn                                   | `heavy`  | LLM agent (pwn profile)                   |
| category=web                                   | `heavy`  | LLM agent (web profile)                   |
| 无法确定                                       | `medium` | shotgun coordinator → LLM fallback        |

### 1.2 接入 `batchSolve` 管道

**修改**: `src/core/ctfRuntime/createCTFTaskRuntime.ts` — `batchSolve` 函数

在 `executor` 回调中插入分流逻辑：

```typescript
executor: async (challenge, handle, signal): Promise<TaskExecutorResult> => {
  // ── NEW: Pre-flight classification ──
  const classifier = createChallengeClassifier(oneShotRegistry, oneShotCatalog)
  const classification = classifier.classify({
    category: challenge.category,
    description: challenge.description,
    attachmentHints: challenge.attachmentPaths ?? [],
  })

  // Fast path: oneshot only (zero LLM calls)
  if (classification.tier === 'fast' && classification.recommendedManifests.length > 0) {
    return await runFastPath(challenge, classification, taskRuntime, signal)
  }

  // Medium: shotgun first, fallback to LLM
  if (classification.tier === 'medium') {
    const shotgunResult = await runShotgunFirst(challenge, classification, taskRuntime, signal)
    if (shotgunResult.flag) return shotgunResult
    // fall through to LLM
  }

  // Heavy: LLM agent
  const result = await taskRuntime.orchestrator.runMainAgent(challenge.description)
  // ... existing logic
}
```

### 1.3 快通道执行器 `runFastPath`

**文件**: `src/ctf/competition/fastPath.ts`

- 直接调用 `Dispatcher.runOne()` 执行 oneshot manifests（完全跳过 LLM）
- 超时：30s（fast tier 每题不应超过 30s）
- 结果直接送 `FlagDiscriminator`
- 如果 flag 置信度 >= 0.85，立即返回
- 如果失败，降级到 medium tier（走 shotgun）

### 涉及的现有文件

- `src/core/ctfRuntime/createCTFTaskRuntime.ts` — batchSolve executor 改造
- `src/ctf/competition/challengeClassifier.ts` (新建)
- `src/ctf/competition/fastPath.ts` (新建)
- `src/ctf/oneshot/selector.ts` — 可能需要增强 tag hints

### 验证方式

- 对已知简单题（base64 编码 flag）端到端测试，确认走 fast path 且不调用 LLM
- `batchSolve` 日志显示各 tier 分布

---

## Round 2: 自适应并发 & 硬超时（Adaptive Concurrency & Timeouts）⏱️

### 目标

从固定并发改为自适应并发：成功率高时增大并发，失败/超时多时减小并发；强制执行每任务硬超时。

### 2.1 创建 `AdaptiveConcurrencyController`

**文件**: `src/ctf/competition/adaptiveConcurrency.ts`

```typescript
export class AdaptiveConcurrencyController {
  private successWindow: boolean[] = [] // sliding window of recent results
  private readonly windowSize = 20
  private readonly minConcurrency: number
  private readonly maxConcurrency: number
  private currentConcurrency: number

  constructor(opts: {
    initialConcurrency: number
    minConcurrency?: number // default 1
    maxConcurrency?: number // default 16
    windowSize?: number // default 20
  })

  /** Call after each task completes. Returns the new recommended concurrency. */
  recordResult(success: boolean): number {
    this.successWindow.push(success)
    if (this.successWindow.length > this.windowSize) {
      this.successWindow.shift()
    }
    return this.recalculate()
  }

  private recalculate(): number {
    if (this.successWindow.length < 5) return this.currentConcurrency
    const successRate = this.successWindow.filter(Boolean).length / this.successWindow.length

    if (successRate > 0.85) {
      // High success → increase concurrency
      this.currentConcurrency = Math.min(this.maxConcurrency, this.currentConcurrency + 2)
    } else if (successRate < 0.4) {
      // Low success → decrease (maybe hitting rate limits)
      this.currentConcurrency = Math.max(this.minConcurrency, this.currentConcurrency - 1)
    }
    // 0.4-0.85: keep current

    return this.currentConcurrency
  }

  getConcurrency(): number {
    return this.currentConcurrency
  }
}
```

### 2.2 接入并发池

**修改**: `src/core/ctfRuntime/challengeConcurrencyPool.ts`

- 添加 `adjustConcurrency(newMax: number): void` — 动态调整 max slots
- 不会 kill 正在运行的任务，仅影响后续 `spawnNext()`
- 在 `executor` 完成后调用 `adaptiveController.recordResult(success)`

### 2.3 硬超时强制执行

**修改**: `src/core/ctfRuntime/challengeConcurrencyPool.ts`

- `QueuedChallenge` 添加 `timeoutMs?: number`
- `spawnNext()` 中创建 `AbortSignal.timeout(timeoutMs)` 并与原有 signal 合并
- 添加 pool-level `defaultTimeoutMs` 选项（默认 300s = 5min）
- 超时后 `handle.status = 'timeout'`，释放 slot

### 2.4 分类感知超时

**修改**: `src/ctf/competition/challengeClassifier.ts`

| Tier     | 默认超时 |
| -------- | -------- |
| `fast`   | 30s      |
| `medium` | 120s     |
| `heavy`  | 300s     |

超时在分类时分配，写入 `QueuedChallenge.timeoutMs`。

### 涉及的现有文件

- `src/core/ctfRuntime/challengeConcurrencyPool.ts` — 动态 concurrency + timeout 支持
- `src/ctf/competition/adaptiveConcurrency.ts` (新建)
- `src/core/ctfRuntime/createCTFTaskRuntime.ts` — 接入 adaptive controller

### 验证方式

- 模拟 50 题 batch，观察 concurrency 从 4 → N 自动增长（高成功率场景）
- 模拟连续失败，观察 concurrency 自动下降
- 单个任务超时不会阻塞整个 batch

---

## Round 3: 多路径 Flag 提取 & 验证（Multi-Pass Extraction & Verification）🎯

### 目标

解决当前 flag 提取过于脆弱的问题（依赖 `category === 'flag'` 或 `title.includes('flag')`），建立多路径提取 + 确定性验证。

### 3.1 创建 `FlagExtractionPipeline`

**文件**: `src/ctf/competition/flagExtractionPipeline.ts`

```typescript
export interface FlagExtractionInput {
  taskState: CTFTaskState // full state
  stdout?: string // agent stdout (solve.ts path)
  findingsJsonlPath?: string // findings.jsonl path
  expectedFlagSha256?: string // if available
}

export interface ExtractionAttempt {
  value: string
  source: 'stdout_regex' | 'findings_scan' | 'artifact_scan' | 'oneshot_candidate'
  confidence: number
  verified: boolean
  verificationMethod?: 'sha256' | 'pattern' | 'none'
}

export class FlagExtractionPipeline {
  extract(input: FlagExtractionInput): ExtractionAttempt[] {
    const attempts: ExtractionAttempt[] = []

    // Pass 1: stdout regex (fast, broad patterns)
    attempts.push(...this.extractFromStdout(input.stdout))

    // Pass 2: findings scan (structured, high precision)
    attempts.push(...this.extractFromFindings(input.taskState))

    // Pass 3: artifact content scan
    attempts.push(...this.extractFromArtifacts(input.taskState))

    // Pass 4: oneshot candidates
    attempts.push(...this.extractFromOneShots(input.taskState))

    // SHA256 verification (if expected hash available)
    if (input.expectedFlagSha256) {
      for (const a of attempts) {
        a.verified = this.verifySha256(a.value, input.expectedFlagSha256)
        a.verificationMethod = a.verified ? 'sha256' : 'none'
        if (a.verified) a.confidence = 1.0
      }
    }

    // Deduplicate & rank by confidence
    return this.deduplicateAndRank(attempts)
  }
}
```

### 3.2 增强 Stdout 正则

**修改**: `bin/ovogogogo-ctf.ts` 中的 flag 提取逻辑（或集中到 pipeline）

新增 pattern：

```
flag{...}, picoCTF{...}, CTF{...}, FLAG{...}, flag(...), flag[...]
CTFlearn{...}, HTB{...}, inctf{...}, 以及裸 {...} 中包含已知 flag 关键词
```

### 3.3 接入所有执行路径

在以下位置接入 `FlagExtractionPipeline`：

1. **`batchSolve` executor** (line 480-494 of createCTFTaskRuntime.ts) — 替换现有的单一 findings 扫描
2. **`solve.ts` `runSolveCommand`** (line 226-281) — 替换现有的手动正则逻辑

### 3.4 将 `maxTaskDurationMs` 从 advisory 改为 enforced

**修改**: `src/core/ctfRuntime/createCTFTaskRuntime.ts` — executor 中

```typescript
const timeoutMs = challenge.timeoutMs ?? contestScope.maxTaskDurationMs ?? 300_000
const timeoutSignal = AbortSignal.timeout(timeoutMs)
const mergedSignal = anyAbortSignal(signal, timeoutSignal)
```

### 涉及的现有文件

- `src/ctf/competition/flagExtractionPipeline.ts` (新建)
- `src/core/ctfRuntime/createCTFTaskRuntime.ts` — executor flag 提取逻辑替换
- `bin/ovogogogo-ctf.ts` — solve 命令 flag 提取替换（或保持不变，solve.ts 是独立 CLI shim）

### 验证方式

- 单元测试：各种 flag 格式的正则提取
- 集成测试：完整 batchSolve 流程，验证 flag 被正确提取
- 回归测试：现有的 solve.ts 流程不受影响

---

## Round 4: 智能重试 & Profile 切换（Smart Retry & Profile Switching）🔄

### 目标

当首次 LLM 解题失败时，自动切换 profile 重试，提高最终解题率。

### 4.1 创建 `RetryStrategy` 接口

**文件**: `src/ctf/competition/retryStrategy.ts`

```typescript
export interface RetryConfig {
  maxRetries: number // default 2
  retryProfiles: string[] // ordered list of profiles to try
  retryDelayMs: number // base delay between retries (default 0 = immediate)
  retryOn: Array<'failed' | 'timeout' | 'no_flag_found'>
  deadlineMs: number // hard deadline for all retries combined
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 2,
  retryProfiles: [], // filled by category
  retryDelayMs: 0,
  retryOn: ['failed', 'timeout'],
  deadlineMs: 600_000, // 10min total
}

export const CATEGORY_RETRY_PROFILES: Record<string, string[]> = {
  crypto: ['crypto', 'encoding', 'triage'],
  reverse: ['reverse', 'triage'],
  pwn: ['pwn', 'reverse', 'triage'],
  web: ['web', 'triage'],
  forensics: ['image-stego', 'file-forensics', 'triage'],
  traffic: ['traffic', 'triage'],
  encoding: ['encoding', 'crypto', 'triage'],
  misc: ['triage', 'orchestrator'],
}
```

### 4.2 接入 executor

**修改**: `src/core/ctfRuntime/createCTFTaskRuntime.ts` — executor

```typescript
executor: async (challenge, handle, signal): Promise<TaskExecutorResult> => {
  const retryConfig = getRetryConfigForCategory(challenge.category)
  const deadline = Date.now() + retryConfig.deadlineMs

  for (let attempt = 0; attempt <= retryConfig.maxRetries; attempt++) {
    if (Date.now() > deadline) break
    if (signal.aborted) break

    const profileId =
      attempt === 0
        ? getProfileForCategory(challenge.category)
        : retryConfig.retryProfiles[attempt - 1]

    if (!profileId) break
    if (attempt > 0) {
      await taskRuntime.orchestrator.switchProfile(profileId)
    }

    const result = await taskRuntime.orchestrator.runMainAgent(challenge.description)
    if (result.status === 'completed') {
      const flag = extractFlag(taskRuntime.orchestrator.store.getState())
      if (flag && flag !== 'unknown') {
        return { status: 'solved', flag, attempts: attempt + 1 }
      }
    }
    // continue to next retry profile
  }

  return { status: 'failed', flag: undefined }
}
```

### 4.3 重试去重

- 利用已有的 `AttemptDeduplicator`（SHA-256 fingerprinting）避免重复的工具调用
- 在 profile 切换时保留 `taskState`，让新 agent 看到之前的工作

### 涉及的现有文件

- `src/ctf/competition/retryStrategy.ts` (新建)
- `src/core/ctfRuntime/createCTFTaskRuntime.ts` — executor 重试循环
- `src/capabilityProfiles/builtin.ts` — 可能需要 profiles 对齐

### 验证方式

- 模拟首次失败场景，验证自动切换到 retry profile
- 验证 deadline 到期后不再重试
- 验证重试去重（不重复之前已尝试的工具调用）

---

## Round 5: 端到端管道 — 提交重试 & 跨题学习 & 热启动 🚀

### 目标

完善竞赛管道的最后环节：提交可靠性、跨题知识复用、启动性能。

### 5.1 提交重试

**修改**: `src/core/ctfPlatform/ctfPlatformAdapter.ts`

- 对 HTTP 429（rate limited）实现指数退避重试：1s → 2s → 4s → 8s（最多 4 次）
- 对 HTTP 5xx 实现 1 次重试（2s delay）
- 对 TimeoutError 实现 1 次重试（5s delay）
- 添加 `submitWithRetry()` 方法（保留原有的 `submitFlag` 作为单次调用）

```typescript
async submitWithRetry(req: FlagSubmissionRequest): Promise<FlagSubmissionResponse> {
  let lastResponse: FlagSubmissionResponse | null = null
  for (let attempt = 0; attempt < this.maxRetries; attempt++) {
    if (attempt > 0) {
      const delay = this.calculateBackoff(attempt, lastResponse)
      await sleep(delay)
    }
    const response = await this.submitFlag(req)
    if (response.verdict === 'accepted' || response.verdict === 'already_submitted') {
      return response
    }
    if (response.verdict === 'incorrect') {
      return response  // don't retry incorrect flags
    }
    lastResponse = response
  }
  return lastResponse ?? { verdict: 'error', ... }
}
```

### 5.2 跨题模式学习 `CrossChallengeCache`

**文件**: `src/ctf/competition/crossChallengeCache.ts`

```typescript
export class CrossChallengeCache {
  private successfulPatterns: Map<string, PatternRecord> = new Map()
  private toolSuccessRates: Map<string, { tries: number; successes: number }> = new Map()
  private commonPasswords: Set<string> = new Set(['password', 'admin', 'root', '123456', ...])

  /** Record what worked for a challenge category+keywords */
  recordSuccess(challenge: QueuedChallenge, solvingTool: string, elapsedMs: number): void

  /** Suggest optimal tool/profile for a similar challenge */
  suggest(challenge: QueuedChallenge): SuggestedApproach | null

  /** Get accumulated tool success rate */
  getToolSuccessRate(toolId: string): number
}
```

用途：

- 同类题目优先使用之前成功的工具/策略
- 预热 classifier 的决策表
- 减少"从头试错"的时间

### 5.3 运行时对象池 `RuntimePool`

**文件**: `src/ctf/competition/runtimePool.ts`

问题：每个 challenge 都要调用 `createCTFTaskRuntime()` 创建全新的 runtime（包括 harness、orchestrator、stores 等），开销大。

方案：

- 预先创建 N 个 runtime（N = max concurrency）
- 用完重置（清空 state）而不是销毁重建
- 或简化为：复用 harness/toolBroker/engine，只重建 task-specific 的 state

**实现（轻量版）**:

- `CTFTaskRuntime.reset(taskId, challenge)` — 重置 state 和 context，保留 harness 和 broker
- Pool 大小 = maxConcurrency
- `acquire()` → 取一个可用的 runtime
- `release()` → 重置并放回池中

### 5.4 预加载 & 热启动

**修改**: `src/core/ctfRuntime/createCTFTaskRuntime.ts` — `batchSolve`

- 在 `addChallenges` 之前，预先加载所有 oneshot manifests 的 binary 检查
- 预热 classifier 的 tag hints 正则缓存
- 预热 model registry（加载所有 capability profiles）

### 5.5 进度报告增强

**修改**: `bin/ovogogogo-ctf.ts` — `runBatchCommand`

实时进度（每完成一个 challenge 打印一行）:

```
[3/50] ✅ challenge_12 → flag{base64_is_not_crypto} (12.3s, encoding/fast)
[4/50] ❌ challenge_07 → timeout after 120s (crypto/medium)
[5/50] ✅ challenge_03 → flag{sql_injection_basic} (45.1s, web/heavy)
```

在 `ChallengeConcurrencyPool.onCompleted` hook 中接入。

### 涉及的现有文件

- `src/core/ctfPlatform/ctfPlatformAdapter.ts` — 提交重试
- `src/core/ctfRuntime/createCTFTaskRuntime.ts` — runtime pool + batchSolve 进度
- `src/core/ctfRuntime/challengeConcurrencyPool.ts` — onCompleted 进度回调
- `bin/ovogogogo-ctf.ts` — 实时进度输出
- `src/ctf/competition/crossChallengeCache.ts` (新建)
- `src/ctf/competition/runtimePool.ts` (新建)

### 验证方式

- 模拟 HTTP 429 响应，验证指数退避重试
- 跨题缓存：同类题目第二次求解更快
- 对象池：100 题 benchmark 对比使用/不使用池化的 wall-clock 时间

---

## 实施顺序与依赖

```
Round 1 (预检分流 + 快通道)
  │  产出: ChallengeClassifier, FastPath, 三层分流管道
  │  收益: 简单题延迟从 30-60s → 5-10s（无 LLM 调用）
  └─→ Round 2 (自适应并发 + 硬超时)
       │  产出: AdaptiveConcurrencyController, 超时强制
       │  收益: 吞吐量提升 2-4x，不受慢题阻塞
       └─→ Round 3 (多路径 Flag 提取)
            │  产出: FlagExtractionPipeline, SHA256 验证
            │  收益: 解题率提升 10-20%（减少漏报）
            └─→ Round 4 (智能重试 + Profile 切换)
                 │  产出: RetryStrategy, 自动重试
                 │  收益: 解题率再提升 10-15%（首次失败后补救）
                 └─→ Round 5 (提交重试 + 跨题学习 + 热启动)
                     产出: 提交可靠性, CrossChallengeCache, RuntimePool
                     收益: 端到端可靠性 + 竞速 overhead 降低
```

## 竞速指标对比（预估）

| 指标                   | 优化前                       | 优化后                   |
| ---------------------- | ---------------------------- | ------------------------ |
| 简单题延迟（encoding） | 30-60s (LLM)                 | 5-10s (fast path)        |
| 最大并发               | 固定 4                       | 自适应 1-16              |
| 单题超时保护           | 无                           | 30s/120s/300s（按 tier） |
| 解题率（首次）         | ~70%                         | ~85%（+重试 ~95%）       |
| 提交可靠性             | 一次失败即放弃               | 指数退避最多 4 次        |
| 启动 overhead          | 每次创建 runtime             | 对象池复用               |
| 100 题完成时间（est.） | ~25min (4 concurrency × 30s) | ~8-12min                 |

## 完成后审计清单

```bash
# 全量验证
pnpm run lint && pnpm run format:check && pnpm run build && pnpm run test

# 竞速验证
# 在 test fixtures 中准备 20 题 mixed batch（5 easy + 10 medium + 5 hard）
time pnpm run ovogogogo batch tests/fixtures/competition_mock/
# 预期：< 3min wall-clock，解题率 > 80%

# 快通道验证
grep -r "fast.path\|fastPath\|FastPath" src/ctf/competition/ --include='*.ts'
# 输出 → 确保分类器被实际调用

# 重试验证
grep -rn "switchProfile" src/core/ctfRuntime/createCTFTaskRuntime.ts
# 输出 → 确保在 retry 路径中

# 没有未接线的"plan-to-implement"
grep -rn "TODO\|FIXME.*competition\|FIXME.*speed" src/ctf/competition/ --include='*.ts'
# 输出 → 应为空

# 确认 no subprocess per challenge in batch mode
# batchSolve 走 createCTFTaskRuntime 直接创建，不是 solve.ts 的 spawn 模式
```
