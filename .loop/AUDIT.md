# AUDIT — P0/P1/P2 审计与修复状态

## 目标适配度

```text
目标适配度：约 30%
```

### 已适配

- 统一 Harness（ExecutionEngine 单引擎） — 直接复用
- Tool 子系统（`src/tools/*` Tool 类 + ToolContext） — 复用为底层
- AgentConfig 可组合（preset + 模块 + tools + maxIterations） — 复用为 Agent 身份层
- ModuleRegistry 与生命周期（boot/onIteration/onToolCall/onComplete） — 复用
- EventLog（NDJSON 追加审计） — 复用
- PermissionChecker（auto/ask/deny + 规则 + approver 注入） — 复用为治理基座
- ToolContext（signal、cwd、sessionDir、eventLog、semanticMemory、episodicMemory、availableToolNames）
- AgentTool 子 Agent 工厂 + AsyncLocalStorage 深度跟踪 + 并发安全 — 复用
- OVOGO.md loader + settings.json + agent.json（含 zod schema 校验） — 复用并扩展
- Hooks 系统（Pre/Post/UserPrompt/OnError/OnComplete/OnContextOverflow） — 复用
- MCP 集成（stdio） — 复用
- Tmux spectator / follow_mode — 复用

### 部分适配

- "Agent 类型" 仅 4 个通用 preset，无 CTF 领域身份 → 需要扩展为 CapabilityProfile + 5+ 个 CTF Agent
- 工具白名单机制在 AgentConfig.tools 中，但工具本身没有 domain / executionMode / costClass 元数据 → 需要 ToolRegistry
- 无 Workflow 抽象、无 Background Job Manager → 需要新增
- 无 Artifact / Finding / HandoffRequest 一等对象 → 需要新增
- Bash 工具支持 run_in_background，但是字符串标记，不进入 Job Manager → 需要接入 JobManager
- Bash 策略仅按 pattern 拒绝，无命令级 allowlist / denylist → 需要 ToolBroker 接入 Profile

### 不适配

- Workflow Registry（一把梭）
- Background Job Manager（spawn/status/wait/cancel/collect/list）
- Artifact / Finding / Handoff 一等对象 + 摘要回模型
- ToolFirstPolicy 层
- ContestScope（allowedHosts / Cidrs / Ports / FilesRoot）
- 每任务工作区隔离 `sessions/<contestId>/tasks/<taskId>/...`
- 5 个 CTF Agent profile
- 4 个示例 Workflow 骨架
- Shell 命令 allowlist/denylist（按可执行文件，而不是 pattern）

### 阻断问题

暂无 P0（架构核心循环可用）。需在实现阶段避免引入新 P0。

### 可保留但应可选化的能力

- 现有 prompt 模板已含"编码"语义（system.ts） — 不删除，但新身份应通过 OVOGO.md/AgentProfile 注入
- Tmux spectator mode 是调试辅助，保留但默认关闭
- reflection 模块为 API 消费，默认 opt-in — 不需要修改

## 问题清单

> 记录策略：实现阶段产生的真实问题加到下方，并按 P0/P1/P2 分级。

### P0

（暂无）

### P1

（暂无）

### P2

（暂无）
