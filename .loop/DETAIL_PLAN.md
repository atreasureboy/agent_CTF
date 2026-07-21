# DETAIL_PLAN.md

将 PLAN.md 落实到代码层。文件 / 模块 / 接口级实现方案。

## 文件清单(实际新增/修改)

### 新增
| 文件 | 职责 | LOC |
|------|------|-----|
| `src/core/capabilityProfile.ts` | zod schema + deny precedence | ~140 |
| `src/core/toolDefinition.ts` | CTFToolMetadata + Tool domain | ~115 |
| `src/core/toolMetadata.ts` | 工具 metadata catalogue | ~125 |
| `src/core/toolRegistry.ts` | 注册 + Profile filter | ~145 |
| `src/core/toolBroker.ts` | 单网关 | ~390 |
| `src/core/toolFirstPolicy.ts` | 7 规则 | ~225 |
| `src/core/workflowDefinition.ts` | WorkflowStep union + schema | ~175 |
| `src/core/workflowRegistry.ts` | upsert 注册 | ~70 |
| `src/core/workflowEngine.ts` | sequential/parallel/dag | ~300 |
| `src/core/workflowRunner.ts` | 桥接 broker | ~110 |
| `src/core/backgroundJobs.ts` | spawn/cancel/list | ~280 |
| `src/core/artifacts.ts` | ArtifactStore | ~120 |
| `src/core/findings.ts` | FindingStore | ~95 |
| `src/core/handoff.ts` | HandoffStore | ~115 |
| `src/core/orchestratorDispatch.ts` | inspect + 真注入继承 | ~210 |
| `src/core/contestScope.ts` | Scope 检查 | ~145 |
| `src/core/contestConfig.ts` | .ovogo/contest.json | ~140 |
| `src/core/eventLog.ts` | NDJSON 不可变 | ~95 |
| `src/core/harness.ts` | createHarness 工厂 | ~310 |
| `src/modules/taskWorkspace.ts` | sessions/<c>/tasks/<t>/... | ~110 |
| `src/capabilityProfiles/builtin.ts` | 10 Profile | ~280 |
| `src/capabilityProfiles/promptModules.ts` | 12 模块 | ~165 |
| `src/capabilityProfiles/index.ts` | ensureProfilesRegistered | ~25 |
| `src/workflows/builtins.ts` | 8 Workflow | ~360 |
| `src/workflows/index.ts` | ensureWorkflowsRegistered | ~30 |
| `src/tools/ctf.ts` | 21 CTF 工具 | ~520 |
| `src/tools/meta.ts` | 10 meta 工具 | ~280 |
| `src/tools/commandPolicy.ts` | 4 层防御 | ~220 |
| `src/tools/bash.ts` | BashTool + commandPolicy 集成 | ~140 |
| `bin/ovogogogo-ctf.ts` | CLI 入口 | ~250 |

### 修改
| 文件 | 修改内容 |
|------|---------|
| `src/core/engine.ts` | executeToolCall 增加 broker 路由 |
| `src/core/types.ts` | EngineConfig 增加 broker/taskId/agentId/systemPrompt |
| `src/core/eventLog.ts` | 增加 EventType (policy_advisory, handoff_requested, ...) |
| `src/core/specialistAgent.ts` | composeSystemPrompt + 模块组合 |
| `src/tools/index.ts` | createTools 聚合 legacy + meta + ctf |
| `src/tools/bash.ts` | BashTool 调 commandPolicy |

### Tests (25 文件 / 252 case)
- 单元: capabilityProfile / toolRegistry / toolFirstPolicy / workflow / backgroundJobs / handoff / finding / artifact / commandPolicy
- 集成: toolBroker / workflow / e2eHarness / orchestratorDispatch / contestConfig / workflowDag
- 端到端: e2eEngine (mock LLM)
- 验收: acceptance / codeReview / handoffInheritance

## 关键结构体

```ts
interface CapabilityProfile {
  id: string
  displayName: string
  description?: string
  systemPromptModules: string[]
  allowedTools?: string[]
  deniedTools?: string[]
  allowedWorkflows?: string[]
  deniedWorkflows?: string[]
  allowedCommands?: string[]
  deniedCommands?: string[]
  allowShell: boolean
  allowPython: boolean
  allowBackgroundJobs: boolean
  allowAgentHandoff: boolean
  preferredAgentsForHandoff?: string[]
  limits?: { maxIterations?, maxParallelJobs?, maxExecutionSeconds?, maxToolCalls? }
}

interface WorkflowDefinition {
  id: string
  name: string
  description?: string
  domains: string[]
  acceptedInputs: string[]
  outputSchema?: unknown
  steps: WorkflowStep[]
  executionMode: 'sequential' | 'parallel' | 'dag'
  requiredTools: string[]
  stopConditions: string[]
  partialFailurePolicy: 'continue' | 'abort'
}

interface WorkflowStep {
  kind: 'tool' | 'shell' | 'if' | 'parallel' | 'sequence' | 'emit_finding'
  // ... discriminated union
}

interface Finding {
  id: string
  taskId: string
  producerAgentId: string
  category: string
  title: string
  summary: string
  confidence: 'low' | 'medium' | 'high'
  evidence: string[]
  artifactIds: string[]
  recommendedNextActions?: string[]
  suggestedAgent?: string
}

interface HandoffRequest {
  id: string
  taskId: string
  fromAgent: string
  suggestedAgent: string
  reason: string
  objective: string
  artifactIds: string[]
  findingIds: string[]
  constraints?: string[]
  priority?: number
  createdAt: string
  status: 'pending' | 'approved' | 'rejected' | 'modified'
}
```

## 数据流(简化)

```
LLM tool_call(name, args)
  → Engine.executeToolCall
    → Broker.execute(name, args, ctx)
      → profileToolDenialReason   (deny wins)
      → toolFirstPolicy.advise    (audit)
      → hookPre
      → executionMode: background / inline
        background → JobManager.spawn → broker.execute (recursive)
        inline → reg.impl.execute → Artifact 转换
      → hookPost
      → EventLog.append(tool_call, tool_result, permission, policy_advisory, ...)
      → BrokerExecutionResult(content, isError, artifactId?, policyVerdict?)
    → Engine returns tool message to LLM
```

## 错误处理

| 错误类型 | 处理位置 | 输出 |
|---------|---------|------|
| Profile 拒绝 | broker | isError + HandoffRequest hint |
| Bash 命令被 policy 拒绝 | bash.ts → commandPolicy | isError + 替代工具提示 |
| ContestScope 越界 | contestScope → broker | ScopeViolationError → isError |
| 工具二进制缺失 | ctf.ts BinaryTool | `[tool] unavailable: missing ...` |
| 未知工具 | broker | `Unknown tool "X".` |
| Workflow step 失败 | workflowEngine | partialFailurePolicy 决定 |

## 配置字段

- `.ovogo/contest.json` — `allowedHosts`/`allowedCidrs`/`allowedDomains`/`allowedPorts`/`allowedFilesRoot`/`allowPublicNetwork`/`notes`/`maxTaskDurationMs`
- `process.env.OPENAI_API_KEY` — 真 LLM 接入
- CLI flag — `--profile` / `--run-workflow` / `--allow-host` / `--allow-public-network` / `--contest` / `--task-id` / `--input` / `--text`

## 测试用例(每类至少 1 个)

- capabilityProfile: overlap 检测 / deny precedence / parse fail
- toolRegistry: register / resolveFor
- toolBroker: profile deny / artifact convert / job spawn
- commandPolicy: 4 层各自
- backgroundJobs: spawn / cancel / task cancel
- workflow: sequential / parallel / dag / partial
- e2e: 真实 Engine.runTurn + mock LLM
- acceptance: §十五 7 场景
- codeReview: §十六 11 case
- handoffInheritance: 5 case
- contestConfig: 13 case
- workflowDag: 4 case

## 调试方式

```bash
# grep 权限拒绝
grep '"type":"permission"' sessions/*/tasks/*/events.ndjson

# grep 策略提醒
grep '"type":"policy_advisory"' sessions/*/tasks/*/events.ndjson

# 列出所有 artifacts
ls sessions/*/tasks/*/artifacts/

# 列出所有 findings
cat sessions/*/tasks/*/findings.jsonl | jq .

# 列出所有 handoffs
cat sessions/*/tasks/*/handoffs.jsonl | jq .
```

## 验证命令(每完成一个阶段)

```bash
pnpm run build     # 0 errors
pnpm test          # 全绿
```
