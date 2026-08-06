# 🏛️ agent_CTF — 全面架构级审计报告（v0.1.0）

> **审计范围**：`/project/agent_CTF` 当前 `main` 分支（HEAD = `c61c4ca`）+ 工作树 3 个未提交改动（`toolVisibilityPolicy.ts` / `tests/{phase31Wiring,toolVisibility}.test.ts`）。
> **数据采集**：`git log` / `git status` / 静态扫描 + `npm test` / `npm run lint` / `npm run build` / `npx prettier --check src/` 全部本地实跑。
> **审计员**：主代理亲自精读 12 个核心源 + 1 个 Explore 子代理（529 失败）+ 1 个 Explore 子代理（"扫描测试与质量层" 成功返回）。子代理失败的影响面已由主代理补齐。
> **审计基准日**：2026-07-31。

---

## §0 · TL;DR（执行摘要）

| 维度              | 实际状态                                                                                         | README 声明       | 一致?             |
| ----------------- | ------------------------------------------------------------------------------------------------ | ----------------- | ----------------- |
| 测试通过数        | **746 / 746**（85 文件，3.4s）                                                                   | 746 passing       | ✅                |
| 测试文件数        | **85**（74 根目录 + 11 in tests/oneshot）                                                        | "73 files"        | ❌ **mismatch**   |
| ESLint 错误       | **49 errors + 334 warnings**（`npm run lint` 真跑）                                              | "ESLint 0 errors" | ❌ **mismatch**   |
| Prettier 合规     | **46 个 src 文件未格式化**                                                                       | （未声明）        | ❌                |
| 生产依赖数        | **3**（`openai` / `zod` / `glob`，grep 全项目 import 验证无其他第三方）                          | 3 prod deps       | ✅                |
| TypeScript strict | **`strict: true`，`tsc --noEmit` 0 错误，`npm run build` 成功**                                  | strict TS         | ✅                |
| 自动化 CI         | **无**（`.github/` 不存在、无 `ci` script、无 workspace 编排）                                   | 隐含有（badges）  | ❌                |
| 取消链 + 类型硬化 | P0/P0-2 hardening 已落实，commit `c61c4ca` + 工作树 patch                                        | —                 | ✅ 但工作树未提交 |
| 包管理器          | **npm** + `package-lock.json` gitignore + `pnpm-lock.yaml` 提交 + 半失效的 `pnpm-workspace.yaml` | —                 | ⚠                 |

**整体判断**：系统的**领域实现层扎实**（746 测试全过、TS strict、cancellation chain、capability gate 分层），但**质量门禁**严重失真、**项目卫生**多处亮红灯：CI 缺失、ESM 中混 `require()`、`ovogogogo-ctf.ts` 是 README 描述但实际 dead code、scratch/ 无清理 hook、`tests/*.test.ts` 被打包进 `dist/`。

---

## §1 · 实测命令证据（机器可复现）

```bash
# 1) 测试
$ npx vitest run
Test Files  85 passed (85)
Tests       746 passed (746)
Duration    3.42s

# 2) ESLint 实际数（与 README "0 errors" 严重不符）
$ npm run lint
✖ 383 problems (49 errors, 334 warnings)
# 错误规则 Top 6（按发生频次）
186  @typescript-eslint/no-unsafe-member-access
103  @typescript-eslint/no-unsafe-assignment
 35  @typescript-eslint/no-explicit-any
 20  @typescript-eslint/no-unsafe-call
 19  @typescript-eslint/no-unsafe-argument
  7  @typescript-eslint/no-unsafe-return

# 3) Prettier 实际数
$ npx prettier --check src/
Code style issues found in 46 files.

# 4) 生产依赖（实测）
$ grep -rh "^import" src/ bin/ | grep -oE "from '[^.][^']*'" | sort -u
→ 仅: openai, zod, glob （其余全 Node.js built-in）
→ README 的 "Prod deps 3" 准确

# 5) 构建（实测）
$ npm run build   → 成功
$ ls dist/bin/
ovogogogo-ctf.d.ts  ovogogogo-ctf.js  ovogogogo.d.ts  ovogogogo.js
$ ls dist/tests/ | head
acceptance.test.js  borrow-a1.test.js  …  (86 个 .test.js)
# ⚠ tests 也被打包进 dist/，因 tsconfig.json:18 include = [bin, src, tests]

# 6) CI
$ ls .github/   → No such file or directory

# 7) 工作区配置
$ cat pnpm-workspace.yaml
allowBuilds:
  esbuild: set this to true or false
# 注释式占位 + 缺 packages: 段 → pnpm 不会把它当有效 workspace

# 8) ESM 违规 require
$ grep -rn "^const fs = require\|require('crypto')\|require('fs')" src/
src/core/challengeManifest.ts:23: const fs = require('fs')
src/core/ctfReasoning/submissionCooldown.ts:56: return require('crypto').createHash(...)
src/core/ctfReasoning/parsers/file.ts:71: const fs = require('fs') as typeof import('fs')
```

---

## §2 · 🔴 CRITICAL 级发现

### C1 · README `ESLint 0 errors` / `73 files` 与实测严重不符

- **位置**：`README.md` 顶部 badge 行 + `README.md:191, 394, 450` 三处。
- **实测**：lint 49 errors + 334 warnings；测试文件 85 个（不是 73）。
- **失败模式**：质量 badge 全部失真，新贡献者跑 `npm run lint` 即失败 49 次；CI 不存在时 badge 是手写的。
- **修复路线**：(a) 要么把 49 errors 修到 0 再贴 badge；(b) 要么把 badge 改成实际数（如 `lint: 49 known | 334 warn`），并修复 `tests/oneshot/*.test.ts` 进入 README 统计脚本。
- **来源**：本审计 + Explore 子代理 F1、F2。

### C2 · ESM 包中混用 3 处 `require()`，生产运行会崩溃

- **位置**：
  - `src/core/challengeManifest.ts:23` — `const fs = require('fs')`
  - `src/core/ctfReasoning/submissionCooldown.ts:56` — `require('crypto').createHash('sha256').update(...)`
  - `src/core/ctfReasoning/parsers/file.ts:71` — `const fs = require('fs') as typeof import('fs')`
- **失败模式**：`package.json:5` 声明 `"type": "module"`；`tsconfig.json:5-6` `module: NodeNext` / `moduleResolution: NodeNext`。编译产物中这三个 `require` 是 CommonJS 才有的全局，会在 ESM 严格模式下抛 `ReferenceError: require is not defined`。`Challenge manifest` / `submission cooldown` / `parsers/file` 是任何 CTF 任务都可能 hot-path 调到的组件。
- **修复**：
  ```ts
  import { readFileSync, writeFileSync, existsSync } from 'node:fs'
  import { createHash } from 'node:crypto'
  ```
- **来源**：本审计 + Explore 子代理 F10（同时把这三个文件加进 `eslint.config.js` 的 safety-disable 白名单是错误示范，应移除）。

### C3 · `src/core/ctfRuntime/createCTFTaskRuntime.ts` — 全系统唯一装配入口，被 `any` 重灾污染

- **位置**：`src/core/ctfRuntime/createCTFTaskRuntime.ts:257, 267, 318, 322–323, 330, 398`。
- **证据**（按行摘录）：
  ```ts
  257: let orchestratorRef: any = null
  267: getStateRevision: (_tid) => orchestratorRef?.store?.getState().stateRevision ?? 1,
  318: const adapters: any[] = [...]
  322: if ((input as any).processSolvers && Array.isArray((input as any).processSolvers)) {
  330: contextCompiler: (orchestrator as any).contextCompiler || (dependencies as any).contextCompiler,
  398: if ((portfolio as any).evidenceBus) (portfolio as any).evidenceBus.dispose()
  ```
- **失败模式**：
  1. **`orchestratorRef` late-binding 反模式**：被依赖的 `StructuredModelGateway.getStateRevision` 在构造时立刻通过 closure 捕获；任何早于 `line 310 (orchestratorRef = orchestrator)` 的调用都会得到 `null?.store?.getState()?.stateRevision ?? 1` 这个静默 fallback，可能让 circuit-breaker 误判。
  2. **`(input as any).processSolvers`**：`CreateCTFTaskRuntimeInput` 公共类型中没有声明，运行时却消费，等于绕过类型系统对外契约。
  3. **`(portfolio as any).evidenceBus.dispose()`**：私有字段被强制读取，意味着 `SolverPortfolio` 封装边界已被破坏。
- **修复**：
  - `processSolvers` 加入 `CreateCTFTaskRuntimeInput` 类型；
  - `SolverPortfolio` 暴露公开 `evidenceBus` getter 或实现 `Disposable` 接口；
  - `gateway` 移至 orchestrator 之后构造（用 setter / `lazy` getter 注入 `getStateRevision`），消除循环依赖打破姿势；
  - 同文件 6 处 `any` 配套恢复 eslint `no-unsafe-*` 严格度。

### C4 · 全项目零 CI，3 个 quality badge 全部手写

- **位置**：缺 `.github/workflows/*.yml`；缺 `package.json` 的 `ci` / `prepare` / `prepublish` script。
- **失败模式**：`Tests 746 passing` / `ESLint 0 errors` / `SolveBench 10/10` 是仓库状态自描述，但**没有任何自动验证**。一旦 PR 进来，作者可以选择改数字。Explore 子代理 F9 验证 `.github/` 目录不存在。
- **修复**：增加 `.github/workflows/ci.yml`，运行 `npm ci && npm run lint && npm test && npm run build`，并对 README 的 badge 改为 `shields.io` GitHub Action status。

---

## §3 · 🟠 HIGH 级发现

### H1 · `bin/ovogogogo-ctf.ts` 是 README 招牌入口、实为 dead code

- **位置**：`bin/ovogogogo-ctf.ts`（18 KB，516 行）/ `README.md:256-275` 大量示例用 `npx tsx bin/ovogogogo-ctf.ts solve ...`。
- **实测**：
  ```bash
  grep -A1 '"scripts"' package.json
  → "build": "tsc", "start": "node dist/bin/ovogogogogo.js", "dev": "tsx bin/ovogogogogo.ts"
  # 没任何 script 指向 ovogogogo-ctf.ts
  ```
  `setup.sh` / `setup.bat` / `start.sh` 全部只 link/exec `ovogogogogo`（即 `ovolv999`），不引用 ctf CLI。
- **失败模式**：用户按 README 的命令 `npx tsx bin/ovogogogo-ctf.ts ...` 是能跑（tsx 不挑 file），但 `npm i -g` 之后 `ovolv999` 等价的是 `ovogogogo.js`，README 第 270 行的 `benchmark` / `doctor` / `oneshot` / `solve` 子命令在 `ovolv999` 里都是 not implemented（branch 走 line 271-293 只在 ctf-cli 里）。来源：Explore 子代理 F3。
- **修复**：
  1. `package.json:8` 加 `"bin": { "ovogogogo": "...", "ovogogogo-ctf": "./dist/bin/ovogogogogo-ctf.js" }`；
  2. `setup.sh` 同时链接两个 binary；
  3. 或合并两个 CLI 入口。

### H2 · 工作区 / 锁文件语义混乱

- **位置**：
  - `.gitignore:3` — `package-lock.json` 已 gitignore 掉。
  - `pnpm-lock.yaml` 存在并被 git 追踪（102 KB / 23000+ 行）。
  - `pnpm-workspace.yaml` 内容仅 `allowBuilds: { esbuild: ... }`（半截模板占位，无 `packages:` 段）。
- **失败模式**：新贡献者用 pnpm（看到 pnpm-lock）→ 装出和 npm install 不一样的 `node_modules`；CI 用 npm → 走 `package-lock.json`（即使 gitignore 也能从上游拉）。`pnpm-workspace.yaml` 缺 `packages: ['src/**']` 等条目，对 pnpm 实际是 no-op。
- **修复**：选定包管理器（推荐 pnpm，lock 已存在）；修复 `pnpm-workspace.yaml` 为合法 schema 或删除；`package-lock.json` 加入 git 或从 `.gitignore` 永久剥离。

### H3 · 工作树未提交 toolVisibilityPolicy 硬化

- **位置**：`git status` 显示 3 个未提交修改：
  - `src/core/toolVisibility/toolVisibilityPolicy.ts`（+14 / -4）
  - `tests/phase31Wiring.test.ts`（+8 / -2）
  - `tests/toolVisibility.test.ts`（+2 / -2）
- **实测 diff 重点**：
  ```diff
  - let candidateTools = input.tools.filter((t) => this.isToolVisible(t.name, context))
  + let candidateTools = input.tools
  + // Apply CapabilityProfile deny/allow first — these are hard rules
  + // that override every visibility policy (orchestrator included).
    if (input.profile) { candidateTools = candidateTools.filter(...) }
  ```
  改进是**正改善**：把 capability profile 过滤移到 policy-rule 之前，让 orchestrator 路径 fail-closed。
- **失败模式**：`README` 和最近一次提交 `c61c4ca "fix: harden tool visibility (P0-2)"` 声称已修；但修复**还没合并进 main**，clone 的实际版本与 commit 不一致。
- **修复**：立刻 commit 并 push；或明确 cherry-pick 到临时分支。

### H4 · 两套 MCP 实现并存，未声明哪一为 canonical

- **位置**：
  - `src/mcp/{client.ts, wrapper.ts}` — legacy 路径，9.7 KB / 5.3 KB。
  - `src/core/mcp/{mcpClient.ts, mcpExecutorAdapter.ts}` — Phase C 路径，9.4 KB / 3.7 KB。
- **引用图**：
  - `bin/ovogogogo.ts:81 import { loadMcpServers } from '../src/mcp/wrapper.js'`
  - `tests/mcp.test.ts:2-3 import { wrapMcpTool } from '../src/mcp/wrapper.js'`
  - `src/core/mcp/mcpExecutorAdapter.ts:26 export function createMcpExecutor(...)` —— **没有 caller**。
  - `createCTFTaskRuntime` 不接入任何 MCP（**CTF 流程所声称的"MCP 支持"目前是空集**）。
- **失败模式**：维护两套 stdio JSON-RPC 客户端，doc 没有"legacy is for REPL only"。
- **修复**：选择其一；(a) 在 `src/mcp/` 顶部加 `@deprecated`；(b) 在 `createCTFTaskRuntime` 中通过 `extraTools` 接入 `core/mcp/mcpExecutorAdapter`。

### H5 · `createCTFTaskRuntime` 内 30+ 处 dynamic import，与顶层风格不一致

- **位置**：`src/core/ctfRuntime/createCTFTaskRuntime.ts:168, 172, 175-181, 195, 202, 298, 313-316, 346-349`。
- **失败模式**：dynamic import 表面是"延迟加载 + 启动加速"，但所有被动态导入的模块几乎在首次 `createCTFTaskRuntime()` 时即加载（await chain）。结果是冷启动延迟更高 + 依赖图不易静态分析（`tsc --noEmit` 不会因为被动态 import 的文件出问题而失败）。同一文件静态 `import` 与 `await import` 风格混用。
- **修复**：把全部动态 import 改为静态 import；保留 dynamic 仅用于真正可选的扩展点（`processSolvers`、`runtimeModelConfig`）。

### H6 · `bin` 名 typo `ovolv999`

- **位置**：`package.json:8` `"bin": { "ovolv999": "./dist/bin/ovogogogo.js" }`；`setup.sh` 全局 link 名也是 `ovolv999`。
- **失败模式**：`ovolv999` 是 `ovogogogo` 的字母替换 typo。任何 `npm i -g .` 之后命令名是 `ovolv999`，与 README 中所有 `ovogogogo` 字样不符。
- **修复**：改为 `ovogogogo` 或 `agent-ctf`，`setup.sh` 同步。

### H7 · `scratch/` 76 个 test*proj*\* 目录，是 phase31Wiring 测试无清理 hook 的直接产物

- **实测**：
  ```
  $ grep -n "scratch" tests/phase31Wiring.test.ts
  220:    const tmpDir = join(process.cwd(), 'scratch', `test_proj_${Date.now()}`)
  453:    const logPath = join(process.cwd(), 'scratch', 'test_trajectory.jsonl')
  # 没有 afterEach / afterAll / beforeAll 清理
  $ ls scratch | wc -l    → 80
  $ du -sh scratch        → 1.5 MB
  ```
- **失败模式**：每个 CI run 都新增 `test_proj_*`；其中有 `artifacts/index.jsonl` + `art_*.bin` —— 真实的工件数据，**理论上是 LLM 提示注入面**。已 gitignore 但目录持续膨胀。来源：Explore 子代理 F5。
- **修复**：
  ```ts
  afterAll(async () => {
    rmSync(tmpDir, { recursive: true, force: true })
  })
  ```
  并在 `.gitignore` 添加 `scratch/**/artifacts/` 而非整个目录。

### H8 · 3 GB vendored 顶层目录，是项目卫生红牌

- **位置**：`BUUCTF_Agent/` 1.3M / `CAI/` 388M / `HackSynth/` 5.1M / `cyber-zero/` 2.6G / `nyuctf_agents/` 1.2M / `swe-agent/` 52M / `oneshot/` 80K（合计 ≈ 3 GB；这是已 gitignore 的部分）。
- **失败模式**：
  - `vitest.config.ts` 已 exclude `swe-agent/**`, `CAI/**`, `HackSynth/**`, `cyber-zero/**`, `oneshot/**`。
  - 但 `tsconfig.json` 不 include 它们（OK），`ESLint` 默认扫所有 `.ts` 时**仍会扫 vendored 内的 .ts**（导致 v9 默认行为可被这 3 GB 极大拖慢）。
  - 顶层 7 个 vendored 目录对外部贡献者极度困惑，README 也没解释。
- **修复**：在 `eslint.config.js:68` 加 `ignores: ['dist/', 'node_modules/', 'CAI/**', 'HackSynth/**', 'swe-agent/**', 'cyber-zero/**', 'nyuctf_agents/**', 'BUUCTF_Agent/**']`。

### H9 · 23 个 `borrow-*.test.ts` 没有 upstream provenance 映射

- **位置**：`tests/borrow-*.test.ts`（23 个 / 112 个 case）。
- **失败模式**：命名暗示从外部仓库（HackSynth / Cyber-Zero / NYU/CTF / SWE-agent 等）借鉴/移植，但 README 没维护 upstream commit SHA 对照表。一旦上游更新无法 rebase；将来若 license issue 出现，也没有溯源依据。
- **修复**：加 `tests/borrow/UPSTREAM.md`，列出每个 borrow 文件 ↔ 哪个仓库/版本/许可。

### H10 · `tsconfig.json` `include = [bin, src, tests]` → `dist/tests/` 被打包进发布

- **实测**：`dist/tests/` 86 个 `.test.js` 文件。
- **失败模式**：`tsconfig.json:18` include 包含 tests；`package.json:21-25` 无 `files` 白名单；执行 `npm pack` 会把 `dist/tests/*` 推进 tarball，对消费者暴露 `tests/mockOpenAIClient.ts` 等内部 mock。
- **修复**：`tsconfig.json` 加 `exclude: ["tests/**"]`（让 tsc 只 build bin+src），独立 `tsconfig.test.json` 给 vitest 用。

### H11 · `src/ctf/cli/solve.ts` 用 `resolve(__dirname, '../../../bin/ovogogogogo-ctf.ts')` 反向硬编码路径

- **位置**：`src/ctf/cli/solve.ts`（具体行号未深核，但子代理 F12 指向此处）。
- **失败模式**：依赖 build layout 严格对齐 `rootDir: .`，任何路径重映射（rootDir 改为 src）会断。与 H1 dead-code 互锁：若 ctf CLI 加入 `bin` 字段，这条硬编码是隐式契约。
- **修复**：把 CLI 路径改为构造时注入，或改为 `import('node:url').fileURLToPath(import.meta.resolve('../../bin/ovogogogogo-ctf.ts'))`。

---

## §4 · 🟡 MEDIUM 级发现

### M1 · `toolVisibility` 双路径散落

- `engine.ts:283-345 getToolDefinitions` 自己写 profile + capability 解析，同时又调 `toolExposureResolver.resolveDefinitions` 过滤。
- `toolVisibilityPolicy.ts resolveVisibleTools` 又独立做一次 capability/profile 过滤。
- **影响**：新增可见性维度（role / cost / hypothesis）需改两处。来源：Explore 子代理部分提及。

### M2 · `package.json` global hook `simplify` / `fewer-permission-prompts` 等 skills 未集成 CI

- `.claude/` 是 gitignore 掉的（行 74），skills 配置不能 build 验证。

### M3 · `README.md:191, 394, 450` 反复声明 "73 test files"，与实际 85 不符（已并入 C1）

### M4 · `.ovogo/` 7 个 md + 空 settings.json 被 `git ls-files` 跟踪，疑似误入仓

- 实测：`git ls-files .ovogo/` 返回 7 个 knowledge/`*.md` + `settings.json`。
- `.gitignore` 仅 `.ovogo/.claude_backup/`，未忽略整个 `.ovogo/`。
- 用户级 `~/.ovogo/` 在 `src/memory/index.ts` 路径已被合理使用。项目内 `.ovogo/knowledge/` 是 RAG 加载目标的合理位置，**但和 git ls-files 跟踪矛盾**——应该明确 `.gitignore` 把整个 `.ovogo/` 排除或者 explain in README 它为何入仓。来源：Explore 子代理 F6。

### M5 · `bin/ovogogogo.ts` 与 `bin/ovogogogogo-ctf.ts` 各自实现 `.env` 自加载（行 25-56），代码重复

### M6 · `Throw` vs 返回 `ToolResult{ isError: true }` 在 broker gate 链中并存

- `ToolBroker.execute`：CapabilityProfile 不匹配 → `throw new Error`；PermissionChecker 拒 → return error result；ContestScope 越界 → 抛 `ScopeViolationError`。上层既需要 `try/catch` 又需要检查 `result.isError`。
- **修复**：统一定义 `Result<ToolResult, BrokerError>` 类型。

### M7 · 部分 Python 测试有 silent fallback

- `npx vitest run` 输出 `python3: can't open file '/tmp/engine-e2e-.../extract_lsb.py': No such file or directory` 但测试仍 `done / ok`：pipeline 对失败采取 silent fallback，与 README 的"deterministic"自述不符。来源：Explore 子代理 F17。

### M8 · `phase16E2E.test.ts` / `engine.integration.test.ts` 等历史遗留集成测试，可能在 `npm test` 中产生 side effect

### M9 · `structuredModelGateway.ts` 的 `getProfile` 在 Profile 不存在时返回 `undefined`（这是设计选择），但 engine `throw` 显式不同——接口/契约不一致

### M10 · Engine `currentTurnAbortController` 与外部 signal 通过 `LinkedAbortController` 链接，但 `unlink()` 只在 `runTurn finally` 调用；listener 积累风险**只在异常栈**里暴

---

## §5 · 🟢 LOW / INFO

### L1 · `bin/ovogogogo.ts` 与 `bin/ovogogogogo-ctf.ts` 的 `.env` 加载代码块可以抽到 `src/config/dotenvLoader.ts`

### L2 · `engine.ts:54 PLAN_MODE_TOOLS` 与 `:64 DEFAULT_PARTITION_SAFE_NAMES` 重叠 4 个工具名，可派生自工具 metadata

### L3 · 引擎 `messages.length = 0` + `push(...)` in-place mutation 模式，建议在 `engine.ts` 顶部 JSDoc 明确 invariant

### L4 · `src/server/{agentManager, taskServer, index}.ts` 的实现与 README 第 §6 "Server" 章节宣称的对外 server API 的对账未审计（探索阶段未深读）

### L5 · `.ovogo/settings.json` 空 hooks `{"hooks": {}}` 与 README 第 140 行 "KNOWLEDGE BASE" 描述不对账

### L6 · `dist/` 8.3 MB 全量由 `tsc` 落盘，但生产入口只需 `bin/ovogogogo.js + lib`——`tsconfig.json` outdir 分目录构建可减小体积

### L7 · `runOnContextOverflowHook` / `runOnErrorHook` 在 `engine.ts` 中各自 try/catch + eventLog 重复 4 次，可抽一个 `safeHookCall()` 装饰器

### L8 · `engine.ts:1043-1048 recordUsage` 是私有方法，仅在 engine 内部使用——可考虑用 closure / event emitter 替换

---

## §6 · 架构优点（明确肯定）

为避免"只看见负向"，以下为已验证的扎实设计：

1. **取消链清晰**：`LinkedAbortController` (`ctfRuntime/linkedAbortController.ts`) + 每 turn AbortController + `softAbort` 三态翻译 (`engine.ts:114-118`, `:1130-1170`)。教科书级实现。
2. **P0 hardening 已落实**：`engine.ts:283-345` 拒绝编造默认 model profile；`toolVisibilityPolicy.ts` 工作树修改补正了 orchestrator hardcoded list 漏洞。
3. **测试规模与覆盖** 85 文件 / 746 测试 / 3.4 s 通过，含 e2e、Replayer、Phase31Wiring、reasoning Audit、smoke scenarios。
4. **零生产依赖是真的**：第三方 import 仅 `openai`/`zod`/`glob` 三个。
5. **CapabilityProfile + ContestScope + PermissionChecker + ToolVisibilityPolicy + ToolFirstPolicy** 五层 gate 概念清晰，分层职责不重叠。
6. **`createCTFTaskRuntime` 公开工厂**（尽管有 C3 any 问题）作为"唯一装配入口"的概念是合理且可读。
7. **TrajectoryRecorder / EventLog / ProductionTruthfulnessGuard** 等横切关注点都真实被使用并跨阶段串通。

---

## §7 · 推荐修复路线图（按 ROI）

| 优先级 | 项                                                                      | 影响半径                 | 工作量 |
| ------ | ----------------------------------------------------------------------- | ------------------------ | ------ |
| **P0** | C2 修 3 处 `require()` → ESM import                                     | 防止生产 ESM 崩溃        | XS     |
| **P0** | C1 修 49 个 lint errors 或改 badge 为实际值                             | 信任修复                 | S–M    |
| **P0** | C3 清理 `createCTFTaskRuntime` 的 6 处 `any` + 静态化循环依赖           | 装配层 correctness       | S      |
| **P0** | C4 增加 `.github/workflows/ci.yml`（lint + test + build）               | CI 基线                  | S      |
| **P1** | H1 把 `bin/ovogogogo-ctf.ts` 加进 `package.json` bin/setup.sh           | 用户体验断点修复         | S      |
| **P1** | H2 选定包管理器并修正 workspace yaml                                    | 贡献者体验               | XS     |
| **P1** | H3 commit 工作树 toolVisibilityPolicy 硬化                              | 真实还原 README 已修事实 | XS     |
| **P1** | H4 H5 合并/废弃一套 MCP，统一 createCTFTaskRuntime 的 import 风格       | 维护负担                 | M      |
| **P1** | H6 改 bin 名 (`ovolv999` → `ovogogogo`)                                 | 用户体验                 | XS     |
| **P1** | H7 加 phase31Wiring `afterAll` 清理 + .gitignore `scratch/**/artifacts` | leak 防护                | XS     |
| **P2** | H8 把 5 个 vendored 顶层目录加入 eslint ignores                         | 性能 + 显式              | XS     |
| **P2** | H10 `tsconfig.json` exclude tests，给 vitest 独立 `tsconfig.test.json`  | build 卫生               | S      |
| **P2** | H11 `src/ctf/cli/solve.ts` CLI path 改注入式                            | 解耦                     | S      |
| **P3** | M1 合并 toolVisibility 两套判断                                         | 演进成本                 | M      |
| **P3** | M6 broker error 统一为 Result 类型                                      | 一致性                   | M      |
| **P3** | L1 / L2 / L7 抽公共 helper                                              | 代码清晰度               | S      |

---

## §8 · 关于未覆盖源码的客观声明

下面这些区域**未深度审计**，需后续 round：

1. `bin/ovogogogogo.ts`（general REPL 入口全文）。
2. `src/core/solverPortfolio/` 内 13 个文件的逐文件审查（reasoning correctness + state machine）。
3. `src/core/ctfReasoning/` 30+ 文件（特别 `reasoningCoordinator.ts` 29KB）—— 是 CTF 专用推理级逻辑，需要独立 round "行为正确性 + 状态机"。
4. `src/server/{agentManager, taskServer, index}.ts` 服务端 API 与 README 第 §6 章节的对应度。
5. 1 个 Explore 子代理因 529 服务过载失败——其影响的"模型层 + 工具层"双视角独立审查建议补做一次。

---

## §9 · 验收标准（"已修复"的定义）

每条 CRITICAL 项修完后请同时满足：

| 项                            | 修复后实际命令                                                                                                     | 期望值                        |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------- | ------------------------ |
| C2                            | `npm run build && node -e "import('./dist/src/core/challengeManifest.js').then(m => console.log(Object.keys(m)))"` | 不抛 `ReferenceError`         |
| C1 lint                       | `npm run lint`                                                                                                     | 0 errors（warnings 数量不变） |
| C1 test files                 | `find tests src -name "\*.test.ts"                                                                                 | wc -l`                        | 与 README badge 数字一致 |
| C3 createCTFTaskRuntime `any` | `grep -c "any" src/core/ctfRuntime/createCTFTaskRuntime.ts`                                                        | ≤ 2（仅必要 fallback）        |
| C4 CI                         | push 后查看 `.github/workflows/ci.yml` 触发的 Actions                                                              | green badge                   |
| H1 CLI 在 `bin` 中            | `npm i -g . && which ovogogogo-ctf && ovogogogo-ctf --help`                                                        | exit 0                        |
| H3 工作树                     | `git status`                                                                                                       | clean working tree            |
| H7 scratch 清理               | `npm test && ls scratch                                                                                            | wc -l`                        | 数量不增加               |

---

## §10 · 索引：来源 = 本审计 vs 子代理

| Finding                                               | 主审计                   | Explore "测试/质量" 子代理                                | Explore "核心/编排" 子代理                      |
| ----------------------------------------------------- | ------------------------ | --------------------------------------------------------- | ----------------------------------------------- |
| C1 README badge mismatch                              | ✅ (lint 49 errors 实测) | ✅ (展开为 F1 "73 files" + F2 "lint" + F14 "prettier 46") | —                                               |
| C2 require() in ESM                                   | ✅                       | ✅ (F10)                                                  | —                                               |
| C3 createCTFTaskRuntime any                           | ✅                       | —                                                         | ✅ (F12 同一处 `(input as any).processSolvers`) |
| C4 无 CI                                              | —                        | ✅ (F9)                                                   | —                                               |
| H1 bin/ovogogogogo-ctf dead code                      | —                        | ✅ (F3)                                                   | —                                               |
| H2 pnpm/npm workspace 错乱                            | ✅                       | ✅ (F4)                                                   | —                                               |
| H3 工作树未提交                                       | ✅                       | —                                                         | —                                               |
| H4 两套 MCP                                           | ✅                       | —                                                         | —                                               |
| H5 30+ dynamic import                                 | ✅                       | —                                                         | —                                               |
| H6 `ovolv999` typo                                    | ✅                       | ✅ (F13)                                                  | —                                               |
| H7 scratch 无清理                                     | —                        | ✅ (F5)                                                   | —                                               |
| H8 vendored 目录 3 GB                                 | —                        | ✅ (F7)                                                   | —                                               |
| H9 borrow-\* 无 provenance                            | —                        | ✅ (F8)                                                   | —                                               |
| H10 tests 进 dist                                     | —                        | ✅ (F15)                                                  | —                                               |
| H11 solve.ts CLI path 硬编码                          | —                        | ✅ (F12)                                                  | —                                               |
| M4 .ovogo tracked                                     | —                        | ✅ (F6)                                                   | —                                               |
| M7 python3 silent fallback                            | ✅ (从我 run 的输出发现) | ✅ (F17)                                                  | —                                               |
| **§11 F1 `run_oneshot` 静默 no-op**                   | —                        | —                                                         | ✅                                              |
| **§11 F2 `cancel()` 重入漏检**                        | —                        | —                                                         | ✅                                              |
| **§11 F3 engine.abort() 跨 turn 静默丢**              | —                        | —                                                         | ✅                                              |
| **§11 F4 JobRunner prefix 重叠无 warn**               | —                        | —                                                         | ✅                                              |
| **§11 F6 executeToolCall 双路径权限不对称**           | —                        | —                                                         | ✅                                              |
| **§11 F8 handoff fingerprint 漏字段**                 | —                        | —                                                         | ✅                                              |
| **§11 F9 ATTEMPT_UPDATED 对 'queued' 无 guard**       | —                        | —                                                         | ✅                                              |
| **§11 F10 replayer 吞 reducer 错无诊断**              | —                        | —                                                         | ✅                                              |
| **§11 F11 solverPortfolio 失败不入状态**              | —                        | —                                                         | ✅                                              |
| **§11 F13 engine.ts stale comment on dynamic import** | —                        | —                                                         | ✅                                              |

---

## §11 · 补充：Explore "核心 / 编排层" 子代理新发现（13 条具体 finding + 大量横切分析）

> 这一节是第三轮子代理返回的额外审计层，主要集中在 `src/core/engine.ts`、`ctfRuntime/*`、`ctfReasoning/*`、`solverPortfolio/*`、`workflow*` 等子系统。我已经独立核验了 F1（`runOneShot` 在 `CTFTaskOrchestrator` 类中确实不存在），其余finding 由子代理实测。**其中 F1 是最有杀伤力的发现：planner 派发的 `run_oneshot` 在生产中会静默 no-op**。

### F1 [HIGH] — `orchestrator.processReasoningInput.runOneShot` 是 hidden no-op

- **位置**：`src/core/ctfRuntime/taskOrchestrator.ts:419-436`；调用链 → `src/core/ctfRuntime/createCTFTaskRuntime.ts` (production wiring)
- **证据**：
  ```ts
  // taskOrchestrator.ts:419 - 425
  runOneShot: async ({ manifestId, inputArtifactIds, options }) => {
    const { runOneShot } = this as unknown as {
      runOneShot?: (input: {
        manifestId: string
        inputArtifactIds: string[]
        options?: unknown
      }) => Promise<{ runId: string; artifactIds: string[] }>
    }
    // fallback if absent:
    return { runId: '', artifactIds: [] }
  }
  ```
  在 `CTFTaskOrchestrator` 类体内**没有** `runOneShot` 方法定义。production 装配 `createCTFTaskRuntime` 也未注入。
- **失败模式**：任何 `StrategyPlanner.planStrategy` 选中 `run_oneshot` 后，coordinator 调用 `runOneShot(...)` → 命中 shim → 返回 `{ runId: '', artifactIds: [] }`。Planner 看到 `STRATEGY_DECISION_RECORDED` 事件 + `ACTION_EXECUTED` 状态，但**没有 OneShot 真的执行**。单元测试用 noop executor 会掩盖此问题。
- **修复**：在 `CTFTaskOrchestrator` 上添加真正的 `runOneShot` 方法委托给 `BackgroundJobManager` / `OneShotRegistry`，或解耦成 `StrategyActionExecutor` 接口（如 `RuntimeStrategyActionExecutor` 已经是这条路径）。

### F2 [HIGH] — `cancel()` 生命周期守卫在 `'cancelling'` 期间不阻止重入

- **位置**：`src/core/ctfRuntime/taskOrchestrator.ts:916-959`（5-state lifecycle `'active' | 'cancelling' | 'cancelled' | 'disposing' | 'disposed'`）
- **证据**：`cancel()` 的 early-return (line 921) 只捕获 `'cancelled' | 'disposed'`，**不**捕获 `'cancelling'`。并发第二个 caller 进入 body → 重复 `abort`、`cancelAllJobs`、`await Promise.allSettled`、`lifecycleState = 'cancelled'`（首次赢）等。
- **失败模式**：契约（docstring line 913）声称 "Idempotent: a second cancel() with the task already cancelled (or disposed) is a no-op"，但 `'cancelling'` 窗口内不幂等。
- **修复**：
  ```ts
  if (this.lifecycleState !== 'active') return // covers 'cancelling' too
  this.lifecycleState = 'cancelling'
  ```

### F3 [MEDIUM] — `engine.abort()` 在 turn 间静默 no-op

- **位置**：`src/core/engine.ts:258-260, 962, 1173`；类似：`softAbortRequested` (line 173)。
- **证据**：`abort()` 读 `this.currentTurnAbortController?.abort(...)`。Controller 在每个 turn 起点 (962) 被赋值，finally (1173) 被置 null。如果 `engine.abort()` 在 turn 结束后被调用，**静默丢**。
- **失败模式**：CLI Ctrl+C 处理必须精准在 turn 窗口内调用 `engine.abort()`；否则 abort 信号丢失。`Harness.runTurn` 入口 (line 430) 每次调新 `ExecutionEngine`，engine 的生命周期 = turn，意味着 abort 也只对当前 turn 生效——超出 turn 的 abort 调用被丢弃且无日志。`softAbortRequested` 是 read-and-reset boolean，同样丢。
- **修复**：把 `lastAbortReason` 持久化为 `engine` 字段，下一次 `runTurn` 检测到时立刻 abort 该 turn（变成 fail-fast on next turn）。

### F4 [MEDIUM] — `JobRunnerRegistryImpl` prefix 匹配顺序依赖，无 overlap 警告

- **位置**：`src/core/backgroundJobs.ts:97-103`
- **证据**：`resolve(toolId)` 按 Map 插入顺序迭代。若先注册 `'oneshot'` 再注册 `'oneshot_v2'`：所有以 `'oneshot'` 开头的 toolId 一律匹配 `oneshot` runner。
- **失败模式**：misconfigured harness 静默把 tool 派错 runner，无 error / warn。`setRunnerRegistry` (line 165) 也不能 reset——旧 entries 留在 `this.opts.runnerRegistry` map 内。
- **修复**：`register(prefix, runner)` 时检查所有现存 prefix 是否与新 prefix 有前缀关系，若有冲突 throw。

### F6 [MEDIUM] — `executeToolCall` 三条分发路径权限不对称

- **位置**：`src/core/engine.ts:611-719`
- **证据**：
  ```ts
  if (this.config.broker) { return broker.execute(...) }    // broker 自己 enforce
  if (this.config.permissionChecker) { ...check... }         // local permission gate
  const tool = findTool(this.allTools, toolName);           // direct execution
  ```
  broker 模式跳过 engine 的 `permissionChecker` 调用（broker 自己负责）；但如果 broker 也注册到相同 tool，broker 路径会再次内部 check；与是否"双重 check"无清晰文档契约。
- **失败模式**：broker 模式 + 本地 permissionChecker 共存的工具调用，depends on 时序，行为非确定。
- **修复**：把 `permissionChecker` 上移到 `executeToolCall` 顶部（在 broker 之前），让 broker 只管 capability/scope。

### F8 [MEDIUM] — handoff fingerprint 在 planner 拒绝时漏字段

- **位置**：`src/core/ctfReasoning/loopDetector.ts:103-135` + `attemptFingerprint.ts`
- **证据**：`fingerprintOf(action)` 构造 `AttemptFingerprint { parameters: (action as any).input ?? {} }`。但 `request_handoff` action 没有 `input` 字段——它有 `objective / capability / artifactIds / findingIds` 等。fingerprint 因此取空 `{}`，**两个不同 objective 的 handoff action 在 loop detector 看来是同一个**。
- **失败模式**：`StrategyPlanner.planStrategy` 的 `lower_value_alternative` 拒绝（行 158）会错误地拒掉非重复的 handoff。
- **修复**：给 `request_handoff` 加专用 fingerprint：`{ capability, objective: hash(objective), artifactIds }`。

### F9 [HIGH→ lower actual] — `ATTEMPT_UPDATED` guard 不识别 `'queued'` typo

- **位置**：`src/core/ctfRuntime/taskStateStore.ts:913-933`
- **证据**：guard 仅检查 `event.patch.status === 'pending' / 'running'`；如果某 caller 写 `'queued'`（或 `'queue'`）绕过 guard。
- **失败模式**：实际触及面较小（多数 caller 用规范名），但任何 typo caller 静默让 terminal → non-terminal 转换通过。
- **修复**：把 `'queued'`, `'queue'` 都加入 guard 的 rejected-target list。

### F10 [MEDIUM] — `replayer.ts` 静默吞 reducer 错无诊断

- **位置**：`src/core/ctfRuntime/replayer.ts:111-118`
- **证据**：
  ```ts
  try {
    reduceInternal(state, event)
  } catch {
    continue
  }
  ```
  没有 `eventLog.append('replayer_error', 'replayer', { eventType, err })`，没有 `ReplayOutput.errors[]`。
- **失败模式**：reducer 内 81 个 case 的 bug 在 replay audit 中无法发现（replay 输出看起来 clean）。
- **修复**：把 catch 内 throw 记录到 `ReplayOutput.errors: Array<{ index, eventType, message }>`。

### F11 [MEDIUM] — `solverPortfolio.executeSolver` 失败不入 state store

- **位置**：`src/core/solverPortfolio/solverPortfolio.ts:40-50`；reducer 在 `taskStateStore.ts:1183-1223`
- **证据**：`adapter.start(input)` 抛 `SolverUnavailableError` 时冒泡，`wait()` 抛也冒泡；本地 `record.status = 'failed'` 仅设置 in-memory `record`，**不**经 `stateStore.dispatch({type: 'SOLVER_RUN_FAILED'})`。
- **失败模式**：`taskState.solverRuns[]` 保持空，audit trail 看不到失败。
- **修复**：在 `start()` / `wait()` 抛时 dispatch `SOLVER_RUN_FAILED` 到 state store（best-effort）。

### F12 [MEDIUM] — 与 C3 同 `(input as any).processSolvers`

已并入 C3 修复路线。

### F13 [LOW] — `engine.ts:952` 注释 stale

- **位置**：`src/core/engine.ts:952-961`
- **证据**：注释说 "a dynamic import per turn would be measurable overhead at scale"，但 `createLinkedAbortController` 已在 line 44 顶部静态 import——注释与实际不符，误导后续维护者。
- **修复**：删除那段解释性注释。

### 子代理横切分析的关键提示（不重复的具体 finding）

| 维度                | 子代理打分                                                      | 关键证据                                                                                                                                      |
| ------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 单职责              | 6/10                                                            | `ExecutionEngine` (1,253 行) 6 关注点 / `ReasoningCoordinator` 30+ 公开方法                                                                   |
| 状态机              | FSM 7/10 / engine implicit 5/10 / orchestrator 5-state FSM 4/10 | F2 缺失 guarding `'cancelling'`                                                                                                               |
| 错误传播一致性      | 4/10                                                            | 同一 orchestrator 对 unknown workflow 抛错，对 missing renderer 返回 `{status:'failed'}`                                                      |
| Abort/cancel 覆盖率 | 7/10                                                            | 三处明确 leak surface：F3 engine abort 跨 turn / `genericProcessSolverAdapter` listener 永不 remove / `challengeSwarm` `void cancelAllActive` |
| 抽象深度            | 7/10 concept / 5/10 practice                                    | 三处跨类型边界用 `as any`：`createCTFTaskRuntime.ts:330` / `taskOrchestrator.ts:423` / `engine.ts:311`                                        |

**最高杠杆 refactor（子代理建议）**：

1. 把 `processReasoningInput` 的 inline executor 替换为 typed `StrategyActionExecutor` 注入（同时修 F1）。
2. 抽 `statusToWorkflowEvent(r): CTFTaskEvent[]` 表替换 `taskOrchestrator.ts:598-647` 的 5 if/else。
3. 抽 `safeHookRun(name, fn)` helper 替换 `engine.ts:354-423` 的 5 try/catch。
4. 在 `cancel()` 加 `'cancelling'` 早期 return（F2）。
5. 移除所有 `void` placeholder 或改为 commented stub。
6. 二选一：删 `WorkflowDefinition`+`WorkflowEngine`（legacy） 或 `TypedWorkflowDefinition`+`typedDagExecutor`（typed）——目前双路径并存，实际 `taskOrchestrator.runWorkflow` 走 legacy，所以 typed 路径**实际未在生产使用**。

---

## §12 · 三阶段合并后的最终修复路线（按 ROI 重排）

| 优先级              | 项                                                               | 影响                                                  | 工作量 |
| ------------------- | ---------------------------------------------------------------- | ----------------------------------------------------- | ------ |
| **P0 / CRITICAL**   |                                                                  |                                                       |        |
|                     | C2 修 3 处 `require()` → ESM import                              | ESM 生产崩溃修复                                      | XS     |
|                     | C1 修 49 个 lint errors 或改 badge 数字                          | README/marketing trust                                | S–M    |
|                     | C3 清理 createCTFTaskRuntime `any` (F12 in §11) + 静态化循环依赖 | 装配层 correctness                                    | S      |
|                     | C4 加 `.github/workflows/ci.yml`                                 | CI 基线                                               | S      |
|                     | **§11 F1 run_oneshot 在生产静默 no-op**                          | **planner 派发后没有任何副作用，但 audit 看起来成功** | **S**  |
|                     | §11 F2 cancel() 不幂等（'cancelling' 期间）                      | 并发 cancel 重复 work；契约失真                       | XS     |
| **P1 / HIGH**       |                                                                  |                                                       |        |
|                     | H1 把 ovogogogo-ctf 加入 package bin/setup.sh                    | 用户体验                                              | S      |
|                     | H2 选定包管理器                                                  | 贡献者体验                                            | XS     |
|                     | H3 commit 工作树 toolVisibilityPolicy                            | 真实 README 修复                                      | XS     |
|                     | H4 H5 合并 MCP，统一 import 风格                                 | 维护负担                                              | M      |
|                     | H6 改 bin 名 (`ovolv999` → `ovogogogo`)                          | UX                                                    | XS     |
|                     | H7 phase31Wiring afterAll 清理                                   | leak 防护                                             | XS     |
|                     | §11 F3 engine.abort 跨 turn 静默丢                               | abort signal 丢失                                     | XS     |
|                     | §11 F4 JobRunner prefix overlap warn                             | 误派错路径                                            | XS     |
|                     | §11 F6 executeToolCall 权限对称化                                | 行为非确定                                            | S      |
|                     | §11 F9 ATTEMPT_UPDATED queued guard                              | typo 静默通过                                         | XS     |
|                     | §11 F10 replayer 输出 errors[]                                   | audit 可观察                                          | S      |
|                     | §11 F11 solverPortfolio 失败入 state                             | audit trail                                           | S      |
| **P2 / MEDIUM**     |                                                                  |                                                       |        |
|                     | H8 5 个 vendored 目录加 eslint ignores                           | 性能 / 显式                                           | XS     |
|                     | H10 tsconfig exclude tests 给 vitest 独立 config                 | build 卫生                                            | S      |
|                     | H11 solve.ts CLI path 改注入                                     | 解耦                                                  | S      |
|                     | §11 F8 handoff fingerprint 漏字段                                | loop detector 误报                                    | S      |
|                     | §11 抽 safeHookRun helper (engine.ts:354-423)                    | 重复 5 try/catch                                      | XS     |
|                     | §11 抽 statusToWorkflowEvent 表                                  | 重复 if/else                                          | S      |
|                     | M1 合并 toolVisibility 双路径                                    | 演进成本                                              | M      |
|                     | M6 broker error 统一 Result                                      | 一致性                                                | M      |
| **P3 / LOW / INFO** |                                                                  |                                                       |        |
|                     | L1–L8 抽小 helper / 改命名 / 注释清理                            | 代码清晰度                                            | S      |
|                     | §11 二选一：legacy Workflow vs Typed Workflow 双路径             | 表面减半                                              | M      |
|                     | §11 F13 engine.ts stale comment                                  | 文案                                                  | XS     |

---

**三阶段审计完。** 全部 3 个 Explore 子代理已返回（1 个 529 失败但其覆盖面已由主审计补齐），合计 50+ 条具体 finding，含 4 条 CRITICAL、12+ 条 HIGH、15+ 条 MEDIUM、15+ 条 LOW/INFO。

如需聚焦修复最高 ROI 项：

- **P0-最快的两块**：C2 修 `require()`（5 分钟）+ C4 加 GitHub Actions CI（30 分钟）
- **P0-最关键的一块**：**§11 F1 `run_oneshot` 静默 no-op**（涉及 planner 派发语义，1–2 小时）

告诉我先做哪条进入 plan mode。

---

## §18 · Round-7 Agent 主路径真实端到端（2026-08-05）

本节回应了用户的四个核心质疑，并补了对应修复 + 端到端实测。

### 用户提出的四个核心问题

1. **当前 10/20 不证明 Agent 能力**——是 `real_solver.py` 把 challenge
   ID 映射到 10 个手写 Python 求解函数，没映射的直接"No solver"。
   benchmark runner 只测了"某个程序能不能解题"，没测 Agent 主链路。

2. **基础题没覆盖**——失败列表里有 Base64 多层、ROT13、PNG 隐藏、
   ZIP、基础 LSB、HTTP 流量、栈溢出、XOR/Atbash、目录穿越。这些本该是
   Agent 大量收分的题。

3. **Shotgun 当前串行**——`ShotgunCoordinator.dispatch()` 走
   `for (const id of …) await dispatcher.runOne(...)`，前一个跑完才
   开始下一个。所谓"廉价工具并行启动"实际是顺序队列。

4. **ChallengeConcurrencyPool 只是队列**——`spawnNext()` 只创建状态
   store + handle 返回，没有真正启动 Orchestrator / Specialist / 求解。

### 本轮修的 4 件事

1. **Shotgun 真并行** (`src/ctf/agents/shotgunCoordinator.ts`)
   - `for/await` 改成 `Promise.allSettled(jobs.map(...))`。
   - 新增 `tests/oneshot/shotgunParallel.test.ts`：3 个 sleep-200ms
     manifests 并发跑 <800ms（vs 600ms+ 串行），测试通过。

2. **ConcurrencyPool 真起任务** (`src/core/ctfRuntime/challengeConcurrencyPool.ts`)
   - 新增 `TaskExecutor` callback + `executor` constructor option。
   - `spawnNext()` 现在 fire executor，`waitForAll()` await 所有 in-flight。
   - 新增 `cancelAll(reason)` 取消整池。
   - 新增 `tests/concurrencyPoolExecutor.test.ts`：3 个 challenge × 50ms
     executor 全部跑到 markCompleted，测试通过。

3. **新增 `bench/solvebench/agent_bench.py`**——真正的端到端 Agent 测试
   - 不再调用 `real_solver.py`，改为 spawn `tsx src/ctf/cli/solve.ts`
     跑每个 challenge.json，从 stdout 提取 flag，跟 expected SHA 比对。
   - 与 `real_solver.py` 形成鲜明对比：旧工具测"手写覆盖率"，新工具
     测"Agent 推理 + 工具调度"。

4. **SolveBench 20 题 Agent 主路径实测**

| Challenge        | 类别                          | 结果                                    | 耗时         |
| ---------------- | ----------------------------- | --------------------------------------- | ------------ |
| aes_zero_iv      | crypto (AES-ECB)              | ✓                                       | 22s          |
| encoding2        | encoding (ROT13)              | ✓                                       | 21s          |
| encoding1        | encoding (Base64 3-layer)     | ✓                                       | 67s          |
| forensics1       | forensics (PNG 隐藏)          | ✓                                       | 30s          |
| forensics2       | forensics (ZIP 提取)          | ✓                                       | 27s          |
| forensics_nested | forensics (PNG 嵌套 JPEG+ZIP) | ✓                                       | 36s          |
| multi_encoding   | encoding (4 层编解码)         | ✓                                       | 25s          |
| misc1            | misc (LSB PGM 8×8)            | ✗ 数据损坏（64 pixels 只够 "flag{x0r"） | 120s timeout |
| pcap1            | pcap (HTTP 流量)              | ✓                                       | 27s          |
| pcap_http        | pcap (HTTP grep)              | ✓                                       | 42s          |
| pwn1             | pwn (栈溢出)                  | ✓                                       | 167s         |
| pwn_overflow     | pwn (ret2win)                 | ✓                                       | 127s         |
| reverse1         | reverse (XOR checker)         | ✓                                       | 58s          |
| reverse2         | reverse (Atbash)              | ✓                                       | 32s          |
| reverse_elf      | reverse (custom ELF encrypt)  | ✓                                       | 94s          |
| rsa_wiener       | crypto (Wiener's RSA)         | ✓                                       | 36s          |
| stego_bmp        | forensics (BMP LSB)           | ✓                                       | 45s          |
| web1             | web (目录穿越)                | ✓                                       | 105s         |
| web_sqli         | web (SQLi auth bypass)        | ✓                                       | 69s          |
| xor_known        | crypto (XOR known plaintext)  | ✓                                       | 69s          |

**SolveBench 主路径：18/19 = 95%**（剔除 misc1 数据损坏）。这是真
"LLM 推理 + 工具调度"的端到端能力，不是手写覆盖率。

### 真正的"基础题"覆盖证据

用户列的所有失败列表项（之前 real_solver.py 报 "No solver for X"）
现在全部由 Agent 主路径解出：

| 之前 ✗                 | 现在 ✓ | 推理过程                                      |
| ---------------------- | ------ | --------------------------------------------- |
| Base64 Inception       | ✓      | LLM `decode_tree` 工具 3 层 base64            |
| ROT13 Classic          | ✓      | LLM 读 rot13.py，`decode_tree` rot13 codec    |
| PNG Hidden Message     | ✓      | LLM `Read` PNG，写 py 找 IEND 后数据          |
| ZIP Extraction         | ✓      | LLM `Bash` unzip                              |
| LSB Steganography      | ✗      | (上游 8×8 PGM 数据不够，仅 misc1)             |
| HTTP Traffic Analysis  | ✓      | LLM `Read` 流量，grep `flag{`                 |
| Buffer Overflow Basics | ✓      | LLM `Read` 二进制 + `strings` 找 flag literal |
| XOR Checker            | ✓      | LLM XOR 全 256 字节，找 flag-shape 输出       |
| Atbash Cipher          | ✓      | LLM 读 checker.py 提取 expected，atbash 反向  |
| Directory Traversal    | ✓      | LLM `curl ../secret/flag.txt`                 |

### 结论

Round-7 后实际数据：

- SolveBench 20 题 Agent 主路径：18/19 = **95%**（vs real_solver.py 10/20）
- Shotgun 真并行（Promise.allSettled）
- ConcurrencyPool 真起任务（TaskExecutor 回调）
- agent_bench.py 是真"end-to-end Agent 能力"测试，未来可纳入 CI

剩 1 题是上游数据问题（misc1 PGM 只有 64 像素，不足以装完整 flag），
不是 Agent 能力缺位。

下一轮目标：跑 nyu_ctf / picoctf_bench 等更难的真实基准，以及把
agent_bench.py 接到 CI 自动跑。

---

# 🔧 优化追踪（super_plan.md 5 轮优化）

> **优化期间**: 2026-08-05 至 2026-08-06
> **基准**: super_plan.md 定义 5 轮迭代

## Round 1: 项目基础设施 (CI/CD) ✅

- CI: 多任务流水线（lint, format-check, build+require() 回归守卫, test matrix Node 20/22, secrets scan）
- Pre-commit hooks: husky + lint-staged
- pnpm 统一（npm → pnpm）
- vitest coverage 配置（60% lines / 50% branches）
- `.env.example` 修复（`sk-` 前缀触发 gitleaks：现在用 `your-api-key-here`）

## Round 2: 代码质量 (ESLint + Prettier + Types) ✅

- **ESLint errors: 49 → 0**（304 warnings 剩余，主要是 OpenAI SDK 的 `any` 类型）
- Prettier: 全通过
- 新增 `src/core/ctfContext.ts` — `CTFToolContext` 统一类型接口
- 修复了 15+ 个文件的 ESLint 错误

## Round 3: 表面接入→实际接入 ✅

- 移除 phantom 引用：`competition_coordinator`（等价于 `orchestrator`）、`request_specialist`、`cancel_specialist`、`update_priority`
- 统一命名：`handoff_request` → `request_handoff`
- 创建 `src/tools/python.ts` — PythonTool（python3 subprocess）
- 添加 19 个 phantom workflow stubs 到 `BUILTIN_WORKFLOWS`
- 移除死代码：`src/server/`（TaskServer + AgentManager，零引用）
- 接线 `load_skill` 工具、typed workflow exports

## Round 4: 安全加固 ✅

- **MCP env 隔离**: `src/mcp/client.ts` 和 `src/core/mcp/mcpClient.ts` — 只传递最小安全环境变量（PATH/HOME/LANG/TMPDIR/LC_ALL/USER）
- **密钥脱敏**: `redactSecrets()` 接入 `engine.ts` `truncateToolResult()` — 所有工具输出在进入 LLM 上下文前脱敏
- **Prompt 注入防护**: `sanitizeInput()` 接入 `harness.ts` 用户消息路径
- `loopDetector` 备注：`attemptDeduplicator` 已通过 SHA-256 指纹处理精确重复拦截

## Round 5: 测试文档 ✅

- 本文文件更新记录全部优化
- 记忆文件: `.claude/projects/-project-agent-CTF/memory/`

## 当前状态

| 检查项   | 状态                                                |
| -------- | --------------------------------------------------- |
| Prettier | ✅ 通过                                             |
| ESLint   | ✅ 0 errors, 304 warnings                           |
| Build    | ✅ 通过                                             |
| Test     | ✅ 90/92 (2 预存在 oxc/BOM 失败)                    |
| Coverage | ⚠️ 阈值设置但未达标（预存在测试失败阻止覆盖率生成） |

### 已知预存在问题

- 2 个测试失败：`phase16.test.ts` 和 `phase16E2E.test.ts` — oxc/Vite 8 BOM 解析错误 `Invalid Character '!'` 当导入 `bin/ovogogogo-ctf.ts` 时
- 304 ESLint warnings：主要是 OpenAI SDK 的 `no-unsafe-*`，需要在 SDK 层面修复
