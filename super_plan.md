# super_plan.md — agent_CTF 全面优化计划（第一轮：大方向结构性完善）

> **目标**: 将 agent_CTF 从"个人项目级别"提升到"成熟开源项目级别"
> **策略**: 5 轮迭代，每轮聚焦一个维度 → 实现 → 审计 → 进入下一轮
> **后续**: 完成后创建 super2_plan.md 进行第二轮（细节层面）完善

---

## 总体评估基线

| 维度       | 当前状态                 | 目标状态                 |
| ---------- | ------------------------ | ------------------------ |
| CI/CD      | 无                       | GitHub Actions 自动化    |
| Lint       | 49 errors / 334 warnings | 0 errors / warnings ≤ 20 |
| 格式化     | 46 文件不合规            | 0 文件不合规             |
| 测试       | 92 文件通过              | 92 文件 + 覆盖率报告     |
| 包管理     | npm/pnpm 混用            | 统一 pnpm                |
| 类型安全   | 大量 any/as              | 显式类型接口             |
| 文档       | README badge 失真        | 真实自动更新             |
| 接入完整性 | **大量 phantom 声明**    | 全部实际接入或移除       |

---

## 表面接入审计总发现

经 `Explore` agent 全面扫描，发现以下"表面接入"模式：

| 严重度    | 数量 | 类型                                                          |
| --------- | ---- | ------------------------------------------------------------- |
| 🔴 HIGH   | 18   | 工作流在 allowedWorkflows 中声明但 BUILTIN_WORKFLOWS 中不存在 |
| 🔴 HIGH   | 5    | 工具名在 profile allowedTools 中但无 Tool class 实现          |
| 🔴 HIGH   | 1    | Server 层完全孤立（TaskServer + AgentManager，0 引用）        |
| 🔴 HIGH   | 1    | `competition_coordinator` profile ID 被引用但从未声明         |
| 🔴 HIGH   | 3    | 安全护栏文件（inputSanitizer, redaction, loopDetector）0 引用 |
| 🟡 MEDIUM | 2    | `misc` / `encoding` profile 声明但无 runtime 选择路径         |
| 🟡 MEDIUM | 3    | Typed workflows (Phase 2.1) 脱离生产代码                      |
| 🟡 MEDIUM | 1    | `load_skill` 在 CTF path 中未注册                             |
| 🟢 LOW    | 2    | `critic` / `reflection` 模块注册但被显式过滤                  |
| 🟢 LOW    | 1    | `harness.approveHandoff()` 标注为 LEGACY shim                 |

---

## Round 1: 项目基础设施（CI/CD + 质量门禁）🏗️

### 目标

建立自动化质量门禁，让 README badge 不再靠手写。

### 具体任务

#### 1.1 GitHub Actions CI Pipeline

创建 `.github/workflows/ci.yml`:

- **触发**: push/PR to main
- **Job 1 — Lint**: `pnpm install → pnpm run lint`
- **Job 2 — Format**: `pnpm run format:check`
- **Job 3 — Build**: `pnpm run build`
- **Job 4 — Test**: `pnpm run test` (Node 20 + 22)
- **Job 5 — Secret Scan**: `gitleaks detect`

#### 1.2 Pre-commit Hooks

- 安装 `husky` + `lint-staged`
- `.husky/pre-commit`: `pnpm run format:check` + `pnpm run lint` (仅 staged 文件)

#### 1.3 README Badge 修复

- 手写 badge 改为 shields.io 动态 URL
- 测试文件数 73 → 92

#### 1.4 包管理器统一

- 删除 `package-lock.json`
- 修复 `pnpm-workspace.yaml`（移除或补全 packages 段）
- README: `npm install` → `pnpm install`
- CI 使用 `pnpm`

#### 1.5 .env.example 修复

- `OPENAI_API_KEY=sk-your-key-here` → `OPENAI_API_KEY=your-api-key-here`（避免 `sk-` 前缀触发密钥扫描误报）

#### 1.6 pnpm scripts 增强

- 新增 `"test:coverage": "vitest run --coverage"`
- 新增 `"ci": "pnpm run lint && pnpm run format:check && pnpm run build && pnpm run test"`
- 新增 `"prepare": "husky"`（husky v9 install）

### 涉及文件

- `.github/workflows/ci.yml` (新建)
- `.husky/pre-commit` (新建)
- `README.md`
- `pnpm-workspace.yaml`
- `package.json`
- `.env.example`
- `.gitleaks.toml` (新建)

### 验证方式

- Push 触发 CI 全绿
- `pnpm run ci` 本地全通过

---

## Round 2: 代码质量攻坚（ESLint + Prettier + 类型）🧹

### 目标

将 ESLint errors 降到 0，Prettier 全通过，消灭 `as unknown as` 链。

### 具体任务

#### 2.1 Prettier 全量格式化

```bash
npx prettier --write src/ bin/ tests/
```

#### 2.2 ESLint Errors 归零（分批）

修复策略：创建 `src/core/ctfContext.ts` — `CTFToolContext` 显式类型接口，消除所有 `as unknown as { __ctf?: ... }` 模式。

**Batch A**: `src/tools/` (~30 errors)

- `bash.ts`, `webFetch.ts`, `webSearch.ts`, `meta.ts`, `fileWrite.ts`
- 使用 `CTFToolContext` 接口替代

**Batch B**: `src/core/ctfRuntime/` (~40 errors)

- `createCTFTaskRuntime.ts`, `taskOrchestrator.ts`, `replayer.ts`

**Batch C**: `src/core/contextCompiler/` (~30 errors)

- `taskStateProjectionBuilder.ts`, `specialistContextCompiler.ts`

**Batch D**: 其余 (~86 errors)

- `engine.ts`, `harness.ts`, solverPortfolio 文件

#### 2.3 tsconfig 分离

- `tsconfig.json`: 仅 `src/` + `bin/`（IDE + lint）
- `tsconfig.test.json`: extends + `tests/`（test runner）
- 移除主 tsconfig 的 `tests/**/*.ts`

#### 2.4 消除 `as any` 模式

在 eslint.config.js 中标记为 suppress 的文件（当前 15 个）分批转换为显式类型。

### 涉及文件

- `src/core/ctfContext.ts` (新建 — 共享类型定义)
- `tsconfig.json`, `tsconfig.test.json`
- `src/tools/bash.ts`, `src/tools/webFetch.ts`, `src/tools/webSearch.ts`, `src/tools/meta.ts`
- `src/core/engine.ts`, `src/core/harness.ts`, `src/core/toolBroker.ts`

### 验证方式

- `pnpm run lint` → 0 errors, ≤ 20 warnings
- `pnpm run format:check` → 0 issues
- `pnpm run build && pnpm run test` → 通过

---

## Round 3: "表面接入" → "实际接入" (全面清扫) 🔌

### 目标

消除所有"声明了但从未实际使用"的 phantom profile、phantom 工具、phantom 工作流、孤立代码。

### 3.1 🔴 Phantom Profiles（删除或补全）

| Profile                   | 问题                                                      | 修复                                                                                                                   |
| ------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `misc`                    | 声明完整的 CapabilityProfile（53 allowedTools）但无人选择 | 如果 CTF 需要 misc 类别，在 `challengeManifest` 映射中添加 `'misc' → 'misc'`；否则删除 profile，用 `orchestrator` 代替 |
| `encoding`                | 同上（仅被用作 category string）                          | 同 `misc` 处理                                                                                                         |
| `competition_coordinator` | 被 6 个文件引用但**从未在 PROFILES 中声明**               | **创建一个 lightweight profile** 或在引用处 fallback 到 `orchestrator`                                                 |

### 3.2 🔴 Phantom Tools（删除声明或补全实现）

| 工具名                 | 被哪些 profile 引用         | 修复                                                                                  |
| ---------------------- | --------------------------- | ------------------------------------------------------------------------------------- |
| `'Python'`             | crypto, pwn, encoding, misc | 创建 `src/tools/python.ts`（简单的 python3 subprocess wrapper，与 BashTool 模式一致） |
| `'handoff_request'`    | orchestrator                | 已存在 `request_handoff` in meta.ts — 统一命名                                        |
| `'request_specialist'` | orchestrator                | 已存在 HandoffCoordinator 逻辑 — 添加 meta tool 桥接                                  |
| `'cancel_specialist'`  | orchestrator                | 添加 meta tool                                                                        |
| `'update_priority'`    | orchestrator                | 如果不需要，从 allowedTools 中移除                                                    |

**命名统一**: `handoff_request` → `request_handoff`（与已有实现一致）

### 3.3 🔴 Phantom Workflows（18 个在 allowedWorkflows 中但无实现）

完整列表:

| 缺失工作流                       | 被哪些 profile 引用 |
| -------------------------------- | ------------------- |
| `classical_cipher_sweep`         | crypto, encoding    |
| `xor_key_search`                 | crypto, encoding    |
| `hash_identify_and_crack`        | crypto              |
| `function_disassembly`           | reverse             |
| `embedded_string_search`         | reverse             |
| `archive_recursive_extract`      | file-forensics      |
| `embedded_content_scan`          | file-forensics      |
| `magic_header_repair_candidates` | file-forensics      |
| `register_state_capture`         | pwn                 |
| `segfault_backtrace`             | pwn                 |
| `tcp_follow`                     | traffic             |
| `pcap_object_export`             | traffic             |
| `web_dir_enum`                   | web                 |
| `web_vuln_scan`                  | web                 |
| `http_method_fuzz`               | web                 |
| `png_stego_sweep`                | image-stego         |
| `jpeg_stego_sweep`               | image-stego         |
| `image_embedded_file_scan`       | image-stego         |

**修复策略**: 这些工作流代表了"理想意图"但对当前 SolveBench 来说过于细分。采用以下策略：

- **Top 8（保留 + 快速实现）**: `classical_cipher_sweep`, `xor_key_search`, `hash_identify_and_crack`, `png_stego_sweep`, `jpeg_stego_sweep`, `image_embedded_file_scan`, `web_dir_enum`, `tcp_follow` — 创建 Oneshot manifest 替代（更快，零 LLM 轮次）
- **Bottom 10（从 profile 中移除）**: rest — 从 `allowedWorkflows` 中删除，等需要时再实现

### 3.4 🔴 Server 层（完全孤立 → 移除或桥接）

`src/server/taskServer.ts` + `src/server/agentManager.ts` — **0 references in entire codebase**.

**修复**: 在 `bin/ovogogogo.ts` 中添加 `--server` 模式，将 TaskServer 的 REST API 作为可选功能暴露。或者移除 server 目录（TaskServer 实现了完整的 CRUD REST API 但从未启动）。

### 3.5 🔴 Orphaned Typed Workflows（桥接到生产代码）

3 个 typed workflow 文件 (`src/workflows/typed/`) 仅在测试中引用：

- `unknownFileTriage.ts`, `imageQuickScan.ts`, `encodingSweep.ts`

**修复**:

1. 在 `ensureWorkflowsRegistered()` 中注册 typed workflow 变体
2. 在 `solve.ts` 的 `planSolveDispatch()` 中使用 typed 变体（支持并行 DAG 执行）
3. 将 `triage` profile 的 `allowedWorkflows` 指向 typed 变体

### 3.6 🟡 `load_skill` 在 CTF path 未注册

**修复**: 在 `src/tools/index.ts` 的 `createCTFTools()` 中添加 `LoadSkill` tool。

### 3.7 🟢 Critic/Reflection 模块（微调）

注册但被 `bin/ovogogogo.ts:1008` 显式过滤。保留代码（设计良好），在注释中说明是"可选增强，需要评估 token 成本后启用"。

### 涉及文件

- `src/capabilityProfiles/builtin.ts` (phantom workflows/tools/profiles 清理)
- `src/tools/python.ts` (新建 Python tool)
- `src/tools/meta.ts` (添加 handoff/priority tools)
- `src/workflows/builtins.ts` (注册 typed workflows)
- `src/ctf/cli/solve.ts` (dispatch typed workflows)
- `src/tools/index.ts` (添加 LoadSkill to CTF tools)
- `bin/ovogogogo.ts` (server 模式)
- `src/server/` (如果保留)

### 验证方式

- `doctor` 命令输出所有已注册的 workflow/profile/tool，无 "undefined" 项
- 每个新实现的 workflow 对应的 Oneshot 端到端测试通过

---

## Round 4: 安全防御深度加固 🛡️

### 目标

将 3 个完全未接入的安全护栏文件接入执行管道，修复 env 泄露。

### 具体任务

#### 4.1 🔴 接入 inputSanitizer

**文件**: `src/core/ctfReasoning/guardrails/inputSanitizer.ts` — **0 处外部引用**
**接入**: 在 `toolBroker.execute()` Step 1.5 与 Step 1.8 之间:

```typescript
const sanitized = sanitizeInput(JSON.stringify(input))
if (sanitized.detected.length > 0) {
  this.opts.eventLog?.append('sanitization', 'broker', { detected: sanitized.detected })
}
```

同时在 `ToolBrokerOptions` 中添加 `inputSanitizer?: { sanitizeInput: ... }` 可选字段。

#### 4.2 🔴 接入 redactSecrets

**文件**: `src/core/ctfReasoning/redaction.ts` — **0 处外部引用**
**接入位置**:

1. `resultMaterializer.ts` — 写入 Observation 前 `redactSecrets(rawText)`
2. `taskStateProjector.ts` — emit Findings 前 `redactSecretsDeep(finding)`

#### 4.3 🔴 接入 loopDetector

**文件**: `src/core/ctfReasoning/loopDetector.ts` — **0 处外部引用**
**接入**: `engine.runTurn()` 主循环 → 通过 `module.onIteration` pattern:

```typescript
// 在 engine 的 onIteration 循环中添加
if (this.loopDetector) {
  const loopResult = this.loopDetector.check(iterations, messages)
  if (loopResult.stuck) {
    messages.push({ role: 'user', content: `[System] ${loopResult.message}` })
  }
}
```

#### 4.4 🔴 MCP Client Env Isolation

**文件**: `src/mcp/client.ts:98`

```diff
- env: { ...process.env, ...(env ?? {}) }
+ env: {
+   PATH: process.env['PATH'] ?? '',
+   HOME: process.env['HOME'] ?? '',
+   LANG: process.env['LANG'] ?? '',
+   TMPDIR: process.env['TMPDIR'] ?? '',
+   ...(env ?? {}),
+ }
```

#### 4.5 ⚠️ vulnDetection 工具 actual wiring

当前注册但无 profile 引用 → 在 `web` profile 的 `allowedTools` 中添加:

- `plan_vuln_detection`, `sql_injection_test`, `xss_test`, `idor_test`, `lfi_test`

### 涉及文件

- `src/core/toolBroker.ts` (inputSanitizer 接入)
- `src/core/ctfReasoning/resultMaterializer.ts` (redaction 接入)
- `src/core/ctfRuntime/taskStateProjector.ts` (redaction 接入)
- `src/core/engine.ts` (loopDetector 接入)
- `src/mcp/client.ts` (env isolation)
- `src/capabilityProfiles/builtin.ts` (vulnDetection allowedTools)

### 验证方式

- 每个安全层的单元测试
- 注入攻击模拟测试

---

## Round 5: 测试 & 文档 & Doctor 命令完善 📚

### 目标

测试覆盖率可视化 + 文档真实可信 + doctor 命令成为真正的健康检查。

### 具体任务

#### 5.1 测试覆盖率

- vitest.config.ts: 添加 `coverage` 配置（v8 provider）
- `package.json`: 添加 `"test:coverage"` script
- threshold: 60% lines, 50% branches

#### 5.2 集成测试

- `ToolBroker + inputSanitizer` 集成测试
- `Bash command policy bypass attempt` 攻击测试
- `WebFetch + SSRF redirect bypass` 集成测试
- `redactSecrets pipeline` 端到端测试

#### 5.3 Doctor 命令增强

添加检查:

- `tmux` binary 可用性检查
- 缺失的 workflow 检查（对比 profile.allowedWorkflows vs registry.list()）
- 缺失的 tool 检查（对比 profile.allowedTools vs registry keys）
- 安全护栏接入状态检查（inputSanitizer/redaction/loopDetector 是否 wired）
- `oneshot doctor` — 每个 manifest 的 binary 可用性
- 输出格式：表格化，绿色✅ / 红色❌

#### 5.4 文档

- `README.md`: 全部 badge 替换为动态 URL
- `AUDIT.md`: 更新为本次审计结果
- `CONTRIBUTING.md`: 开发指南
- `CHANGELOG.md`: 版本记录
- `ARCHITECTURE.md`: 提取 README 架构图 + 更新

### 涉及文件

- `vitest.config.ts`
- `package.json`
- `src/ctf/cli/doctor.ts`
- `README.md`
- `AUDIT.md`
- `CONTRIBUTING.md` (新建)
- `CHANGELOG.md` (新建)
- `ARCHITECTURE.md` (新建)

### 验证方式

- `pnpm run test:coverage` → 覆盖率报告
- `pnpm run doctor` → 全绿色 ✅
- CI badge 全部绿色

---

## 实施顺序与依赖

```
Round 1 (CI/CD + 基础设施)
  │  产出: ci.yml, husky, pnpm 统一, .env fix
  └─→ Round 2 (Lint + 格式化 + 类型)
       │  产出: 0 errors, prettier 通过, CTFToolContext 类型
       └─→ Round 3 (表面接入 → 实际接入)
            │  产出: phantom profiles/tools/workflows 清理, 18 workflows 决策
            └─→ Round 4 (安全护栏接入)
                 │  产出: inputSanitizer/redaction/loopDetector 实际生效
                 └─→ Round 5 (测试 + 文档 + doctor)
                     产出: coverage, 集成测试, 真实 badge
```

每轮完成后:

1. `pnpm run lint && pnpm run format:check && pnpm run build && pnpm run test`
2. 更新 AUDIT.md 记录本轮变更
3. Git commit
4. 进入下一轮

---

## 完成后审计清单

```bash
# 全面验证
pnpm run lint && pnpm run format:check && pnpm run build && pnpm run test

# "表面接入"验证
grep -rn "allowedWorkflows\|allowedTools" src/capabilityProfiles/ | sort
# 输出 → 与 registry list 对比，确保无 undefined

# 安全护栏验证
grep -rn "inputSanitizer\|sanitizeInput" src/ | grep -v "__tests__" | grep -v "inputSanitizer.ts"
grep -rn "redactSecret" src/ | grep -v "__tests__" | grep -v "redaction.ts"
grep -rn "loopDetector\|LoopDetector" src/ | grep -v "__tests__" | grep -v "loopDetector.ts"
# 输出 → 确保有实际引用（非自身文件）

# Env 泄露检查
grep -rn "process.env" src/ | grep -v OVOGO_ | grep -v NODE_ENV | grep -v "\.d\.ts"
# 输出 → 应为空或仅在 config 文件中

# require() 检查（ESM 项目不应有）
grep -rn "require(" src/ | grep -v node_modules | grep -v "\.d\.ts" | grep -v "^.*://.*require"
# 输出 → 应为空

# dead server 检查
grep -rn "from.*server/\|import.*server/" bin/ src/ --include='*.ts'
# 输出 → 空 or 新接入了 server 模式
```
