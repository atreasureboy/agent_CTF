# CTF Agent Reference Matrix (Clean-Room Behavioral Analysis)

This matrix compares behavioral mechanisms from leading external CTF Agent implementations. All features incorporated in `agent_CTF` Phase 3.0 are clean-room reimplementations of high-level concepts with strict independence from external source code.

| 参考项目 | 机制 | 解决的问题 | 本项目已有能力 | 借鉴方式 | 不借鉴原因 | License |
| ---- | -- | ----- | ------- | ---- | ----- | ------- |
| **yhy0/CHYing-agent** | PromptCompiler / ProgressCompiler / RetryHandoffCompiler | 模型长上下文中的注意力和重复探索 | 简单的 text compact | 引入两阶段 `ContextCompiler`（确定性投影 + 可选渲染），包含 5 种结构化简报 | 不借鉴其特定的 Python/Prompt 模板格式，采用 TypeScript + Zod 模式 | MIT |
| **yhy0/CHYing-agent** | MCP Tool Visibility | 工具冗余导致低端模型误用 | 简单的 profile 匹配 | 建立角色维度的 `ToolVisibilityPolicy` 与 MCP server 隔离 | 原项目为硬编码工具表，本项目建立声明式规则 | MIT |
| **verialabs/ctf-agent** | 多 Solver 抽象与 Cross-solver Message Bus | 单一模型陷入局部最优或单线程卡顿 | 单线 Runtime | 抽象 `ExternalSolverAdapter` 协议与 `CrossSolverEvidenceBus`，以 Cursor 增量共享已确认 Evidence | 不借鉴其全局 Redis/MQ，仅作为 `CTFTaskState` 的增量投影 | Apache-2.0 |
| **verialabs/ctf-agent** | Stagnation & Operator Messaging | 无进展死循环与人工引导断层 | 简单 loop detector | 实现 `StagnationDetector` 支持 (continue / nudge / switch_model / spawn_branch / pause) 与 `OperatorMessage` | 源码架构不同，本项目完全基于 TaskState | Apache-2.0 |
| **aliasrobotics/CAI** | Handoff as Tool & Flag Discriminator | 权限边界模糊，低端模型误提交或提权 | 基础 Specialist Handoff | 实现独立 `FlagDiscriminator` + `SubmissionController` 边界；M3 禁止操作任何敏感/提交接口 | 不直接复用其 Python 依赖库与特定沙盒逻辑 | AGPL-3.0 (仅借鉴概念，绝对禁止复制代码) |
| **aielte-research/HackSynth** | Planner / Summarizer 分离与 有界 Observation | 模型自主总结偏差与 Token 浪费 | 单模型 ReasoningCoordinator | 区分 Planner、Scout 与 Summarizer 角色，`ProgressCompiler` 不由当前 Solver 自行总结 | 采用纯 TypeScript Zod 校验，不借鉴其 Python CLI 架构 | MIT |
| **amazon-science/cyber-zero** | challenge.json & Docker Benchmark Trajectory | 缺乏标准化 benchmark 与轨迹评估 | 无 Trajectory | 实现 `ChallengeBenchmarkAdapter` 与结构化 JSONL `TrajectoryRecorder` | 不直接依赖 AWS 专用评测服务 | MIT |
| **passer-W/ctfSolver** / **MuWinds/BUUCTF_Agent** | 平台 Adapter & 模型路由 | 自动化平台的接口适配与多模型分工 | 无平台 Adapter | 抽象 `ModelRouter` 与 `ModelCapabilityRegistry`，以角色/成本驱动模型路由 | 不实现真实平台自动登录与真实提交，防止规则风险 | MIT / GPL-3.0 |

---

## 借鉴总结与准则
1. **吸收的核心机制**：
   - 上下文编译（两阶段，确定性投影优先）
   - 工具可见性隔离（按角色/模型能力进行受控过滤）
   - Solver Portfolio & Cross-Solver Evidence 共享
   - 停滞检测与受控升级
   - 严格的 FlagDiscriminator 与 SubmissionController 提交隔离
   - 结构化 Trajectory 与 Model Reliability Benchmark
2. **严禁直接复制**：任何 AGPL / GPL 代码库与 Prompt 文本均不得在本项目中复制。
