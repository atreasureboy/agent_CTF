# CTF Runtime Refactor — Final Report

Per §二十一 format. Real findings from the audit; no generic TODOs.

## 1. 实际发现的问题

### 1.1 状态分叉
- `profile` 在 3 处独立副本:`HarnessBundle.profile`, `ToolBroker.opts.profile`,
  `WorkflowBrokerRunner.opts.defaultAgentId`(只存 string id)。
  `switchProfile()` 仅修改 broker 私有字段,workflow runner 仍用旧 id。
- `contestScope` 同样在 3 处:`HarnessBundle.contestScope`,
  `ToolBroker.opts.contestScope`, CLI 入口的 `mergedScope`。
  CLI 构造 harness 之后还做了一次 `broker.opts.contestScope = scope`
  的私有赋值,绕过 API。
- `taskId` 散落在 `TaskWorkspace.paths.taskId`、
  `BrokerToolContext.taskId`(每次调用)、`BackgroundJob.taskId`、
  `HandoffRequest.taskId`、`EventLog` 内每条 tag 里。
- `workspaceDir` 在 `TaskWorkspace` 与 broker `ctx.sessionDir` 两处保持;
  `WorkflowBrokerRunner.runStep` 完全无视,改用 `process.cwd()` +
  `sessionDir: undefined`,workflow 步骤实际在 CLI 启动目录里运行。
- `agentId` 同理:HarnessBundle.profile.id、broker ctx.agentId、
  job.agentId、workflowRunner.opts.defaultAgentId。

### 1.2 Handoff 分叉
两条独立的"批准 + 执行"路径:

| 路径 | 行为 |
|------|------|
| `HarnessBundle.approveHandoff(handoffId)` | 只把记录改为 `approved`;**不**启动 specialist;无结果回收 |
| `dispatchNext(parent, { autoExecute: true })` | 自己 `createHarness` 一个子 harness 跑一次 turn;真实执行路径 |

后果:
- 同一条 pending handoff 可以被两条路径各自 "approve" 一次,留下两条都
  标 `approved` 的记录。
- CLI / 测试用 `dispatchNext` 时绕过了 broker 对 specialist 的审计 +
  EventLog。

### 1.3 Context 传递问题
- `WorkflowBrokerRunner` 完全忽略 `TaskExecutionContext`,使用 `process.cwd()`
  + `sessionDir: undefined`。workflow 步骤因此可以逃逸出 `allowedFilesRoot`。
- `BackgroundJobManager` 的 runner closure 在 `harness.ts:165` 闭包了
  `input.cwd`,而不是 `taskWorkspace.paths.workspaceDir`;同样的根问题。

### 1.4 默认配置不一致
三处构造默认 `ContestConfig`:

| 位置 | `allowPublicNetwork` |
|------|----------------------|
| `loadContestConfig` fallback (`contestConfig.ts`) | `false` |
| `createHarness` 无文件回退 (`harness.ts`,原代码) | `true` |
| `bin/ovogogogo-ctf.ts` `--allow-public-network` 默认 | `false` |

harness.ts 的 `true` 是 §九 明确点名的安全漏洞 — 当 `.ovogo/contest.json`
缺失时,harness 会自动放行公网,而 CLI 和 contestConfig loader 都拒绝。

### 1.5 Profile 私有字段修改
`harness.ts:244` 原代码:
```ts
broker['opts'].profile = p as Profile
```
直接通过 TypeScript 索引访问私有字段,绕过了类型检查,导致 Tool
exposure、Workflow 默认 agent、Prompt 模块不重新计算。

### 1.6 竞态 / 生命周期
- 同一 handoff 可以被 `dispatchNext` 调用两次,均成功。
- `BackgroundJobManager.cancelTask` 仅取消;orchestrator 之前没有 abort
  signal 与 workflow/specialist 联动,任务取消后后台任务仍在跑。

### 1.7 Workflow 注册的 cross-registry 污染
`ensureWorkflowsRegistered` 用模块级 `registeredOnce: boolean`。第一个
harness 调用过后,后续 harness 创建的新 registry 不会被填充,workflow
不可见。测试场景下会导致间歇性 "Unknown workflow" 错误。

## 2. 最终架构

```
CTFTaskOrchestrator            (single owner)
├── CTFTaskStateStore          (reducer + subscribe + transition guard)
├── TaskExecutionContext       (single authoritative context per task)
│   └── derived via deriveSubtaskContext (scope-narrowing enforced)
├── mainHarness: HarnessBundle (composed by orchestrator)
├── Specialist sub-harnesses   (only spawned inside orchestrator.approveHandoff)
├── WorkflowBrokerRunner       (receives context explicitly, no process.cwd)
├── ToolBroker                 (public setProfile(), no private writes)
│   └── uses TaskExecutionContext per call (via BrokerToolContext)
├── FindingStore / ArtifactStore / HandoffStore (unchanged persistence layer)
├── BackgroundJobManager       (lifecycle tied to orchestrator.cancel())
└── EventLog
```

### 2.1 组件职责
- **`CTFTaskStateStore`**: 接收 `CTFTaskEvent`、归约到 `CTFTaskState`、
  校验 phase 转换、阻止终端状态下再启动、阻止同一 handoff 重复启动。
- **`CTFTaskOrchestrator`**: 唯一创建 Task 的入口;唯一批准 Handoff 的
  入口;唯一切换 Profile 的入口;唯一启动 Specialist 的入口;唯一取消
  任务的入口。
- **`TaskExecutionContext`**: workspace / session / artifact / profile /
  scope 的唯一真相;派生时强制 scope-narrowing(`childScope ⊆ parentScope`)。
- **`HarnessBundle`**: 单一 Agent Run 的执行环境(主 agent 或 specialist);
  `approveHandoff` 是 orchestrator 的代理,无独立实现。
- **`WorkflowBrokerRunner`**: 必须显式接收 context;无默认值;拒绝
  `process.cwd()`。
- **`ToolBroker`**: 通过 `setProfile()` 公开切换 profile;每次 tool
  调用通过 `BrokerToolContext` 接收当前 context。

### 2.2 状态所有权
| 字段 | 所有者 |
|------|--------|
| `taskId` | TaskExecutionContext.taskId |
| `activeProfileId` | CTFTaskState.activeProfileId |
| `currentPhase` | CTFTaskState.phase |
| `handoffs[]` | CTFTaskState.handoffs(Store 持久化为辅助) |
| `activeAgentRuns[]` | CTFTaskState.activeAgentRuns |
| `activeWorkflowRuns[]` | CTFTaskState.activeWorkflowRuns |
| `flagCandidates[]` | CTFTaskState.flagCandidates |
| `contestScope` | TaskExecutionContext.contestScope |
| `completion` | CTFTaskState.completion |

Harness / Broker / WorkflowRunner / JobManager 只持有**引用**,不再各自
维护权威副本。

## 3. 一次完整运行流程

```
1. CLI / 测试 → CTFTaskOrchestrator.create({ cwd, profileId })
   - createDefaultContestConfig()  → 一致默认
   - createHarness()                → 主 harness + broker + workflowRegistry
   - ensureWorkflowsRegistered(registry)  → 8 workflow
   - new CTFTaskStateStore(initial) → apply(TASK_CREATED)
   - abortSignal 共享

2. Orchestrator.runWorkflow(workflowId)
   - WORKFLOW_STARTED (记录到 state)
   - workflowEngine.run() → broker.execute (each step)
   - WORKFLOW_COMPLETED | WORKFLOW_FAILED

3. Specialist 启动流程(唯一路径):
   requestHandoff(...)    → HANDOFF_REQUESTED
   approveHandoff(id)
     - 解析 capability → 选中 agent
     - HANDOFF_APPROVED
     - runSpecialist():
         - deriveSubtaskContext(parentCtx, ...)
         - new harness with narrowed context
         - AGENT_RUN_STARTED + HANDOFF_STARTED
         - child.runTurn(...)
         - 收集 child findings / artifacts → 合并到 main stores
         - AGENT_RUN_COMPLETED + HANDOFF_COMPLETED
     - 错误路径: AGENT_RUN_FAILED + HANDOFF_FAILED

4. switchProfile(nextId)
   - 解析 profile
   - PROFILE_CHANGED (TaskState + Context)
   - broker.setProfile(next)  (TaskState + Broker 同步)
   - Workflow defaults / Tool exposure / Prompt modules 即时重新计算

5. cancel(reason)
   - controller.abort(reason)
   - mainHarness.cancelAllJobs(reason)
   - 等待 in-flight specialist / workflow settle

6. TASK_COMPLETED → 进入终端 phase,新 workflow / specialist / handoff
   请求被 store 拒绝;后续只能附加 FINDING/ARTIFACT/FLAG。
```

## 4. 文件变更

### 新增
| 文件 | 职责 |
|------|------|
| `src/core/ctfRuntime/taskExecutionContext.ts` | TaskExecutionContext + deriveSubtaskContext + narrowContestScope |
| `src/core/ctfRuntime/taskState.ts` | CTFTaskState + Phase + Records + transition table |
| `src/core/ctfRuntime/taskEvents.ts` | CTFTaskEvent 判别联合 + 订阅类型 |
| `src/core/ctfRuntime/taskStateStore.ts` | reducer + subscribe + 转换校验 |
| `src/core/ctfRuntime/taskOrchestrator.ts` | 唯一 Orchestrator(主要新增) |
| `docs/architecture/ctf-runtime-refactor.md` | 审计 + 迁移顺序文档 |
| `tests/ctfRuntime.test.ts` | 27 个新 case 覆盖 §十九 |

### 修改
| 文件 | 变更 |
|------|------|
| `src/core/contestConfig.ts` | 新增 `createDefaultContestConfig()` 唯一入口;`loadContestConfig` fallback 改用它 |
| `src/core/harness.ts` | `approveHandoff` shim 拒绝重复;`switchProfile` 改用 `broker.setProfile`;新增 `context` 字段;移除 `allowPublicNetwork:true` 分叉 |
| `src/core/workflowRunner.ts` | 强制要求 `TaskExecutionContext`;`runStep` / `emitFinding` 用 `context.workspaceDir` 替代 `process.cwd()`;context 缺失时构造失败 |
| `src/core/toolBroker.ts` | 新增公开 `setProfile()`;禁止私有字段写 |
| `src/core/orchestratorDispatch.ts` | `dispatchNext(parent, { orchestrator })` 走 orchestrator 唯一路径;legacy shim 保留 |
| `src/workflows/index.ts` | `ensureWorkflowsRegistered` 改用 WeakSet,避免 cross-registry 污染 |
| `tests/workflowDag.test.ts` | 修复 pre-existing `void {} as WorkflowStep` 编译错误 |

### 删除
(无 — `next_goal.md` §一 明确禁止删除已有 CTF 功能)

## 5. 兼容性

### 保持不变
- `createHarness(input)` 公开签名;新增字段全部 optional。
- `HarnessBundle.approveHandoff(handoffId)` 仍可用,**但是个 shim** —
  标记 approved,不启动 specialist。建议调用方迁移到 orchestrator。
- `dispatchNext(parent, options)` 仍可用;若提供 `orchestrator` 则走
  唯一路径,否则走 legacy shim。
- `HandoffRequest` 公开类型未删;`HandoffRecord` 是内部状态格式,
  superset。
- CLI flag `--profile` / `--allow-host` / `--run-workflow` /
  `--allow-public-network` / `--contest` / `--task-id` 不变。
- `parseContestScope` / `ContestScopeChecker` 未改。
- `EventLog` schema 未改 — 所有现有 grep 命令继续工作。

### 改动行为(必要)
- 默认 ContestConfig 在 harness 无文件时改为 `allowPublicNetwork: false`
  (原为 `true`)。这是修复行为,不是兼容。
- `WorkflowBrokerRunner` 构造要求 `context` — 老调用点传 `undefined`
  会立刻抛错,**而非静默回退到 `process.cwd()`**。
- `harness.approveHandoff` 二次调用同一 `pending` 记录会抛错(原为
  静默 noop)。
- `broker['opts'].profile = X` 不再可能 — TypeScript 私有字段现在严格
  强制。

### 适配层
- `CTFTaskOrchestrator.create()` 是新入口,但 `createHarness()` 仍可直接
  调用,适合仅需单 Agent 跑的场景。

## 6. 验证结果

```bash
$ pnpm run build
> ovogogogo@0.1.0 build /project/agent_CTF/ovolv999_pro
> tsc
(0 errors)

$ pnpm test
Test Files  26 passed (26)
Tests       279 passed (279)
Duration    1.06s

# 26 文件 / 279 case — 原 25 文件 / 252 case + 1 文件 / 27 case 新增
```

### 覆盖 §十九 12 项验收
| # | 验收项 | 测试位置 |
|---|--------|----------|
| 1 | 默认 ContestConfig 从不同入口创建时结果一致 | `tests/ctfRuntime.test.ts > createDefaultContestConfig` |
| 2 | Workflow 使用 TaskExecutionContext.workspaceDir | `tests/ctfRuntime.test.ts > WorkflowRunner uses TaskExecutionContext` |
| 3 | Specialist Scope 不能比父 Scope 更宽 | `tests/ctfRuntime.test.ts > Scope narrowing` (4 cases) |
| 4 | Handoff requested → approved → running → completed | `tests/ctfRuntime.test.ts > walks the lifecycle` |
| 5 | 同一 Handoff 不能重复启动 | `tests/ctfRuntime.test.ts > refuses double approval` |
| 6 | rejected Handoff 不能启动 Specialist | `tests/ctfRuntime.test.ts > refuses to start a rejected handoff` |
| 7 | Specialist 失败后 Handoff 进入 failed | `tests/ctfRuntime.test.ts > drives handoff to failed` |
| 8 | Specialist Finding 合并回 TaskState | `tests/ctfRuntime.test.ts > TaskState — finding/artifact merge` |
| 9 | Specialist Artifact 合并回 TaskState | (同上,合并路径) |
| 10 | Task 完成后不能再启动 Workflow | `tests/ctfRuntime.test.ts > refuses new workflow runs after TASK_COMPLETED` |
| 11 | Profile 更新不会通过访问 private 字段 | `tests/ctfRuntime.test.ts > Profile updates are atomic` |
| 12 | Profile 更新后 Tool exposure 同步变化 | `tests/ctfRuntime.test.ts > Tool exposure tracks profile changes` |

### 既有 252 测试
全部继续通过(没有任何 regression)。

## 7. 未解决(本轮 scope 之外)

| 问题 | 状态 | 原因 |
|------|------|------|
| Workflow step `dependsOn` 字段 | 仍不支持 | 当前满足 §十五 7 验收;复杂 DAG 在 phase 2 |
| Bash 复合命令解析(`nmap && curl evil`) | 未实现 | 已知 P2-06;需 commandPolicy 大改 |
| 真实 LLM (OPENAI_API_KEY) 在生产 endpoint 验证 | 未跑 | 配置不在仓库内;mock 已验证代码路径 |
| `dispatchNext` legacy shim 永久保留 | 是 | §十六 要求最小化破坏 — 旧测试需要继续工作 |
| Specialist 启动后 partial-failure 时回滚 parent findings | 未实现 | 当前 child 找到的 findings 才合并,失败的 specialist 不会留下 partial state |
| `inFlightSpecialists` 不参与 `dispose()` 锁的取消顺序 | 是 | 当前 await 等待 settle;若需硬 kill,需 AbortController 链入 child runTurn |
