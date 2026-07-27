# Phase 3.3 Production Truthfulness Audit Report

## 1. 审计摘要 (Audit Summary)

为了实现 Agent_CTF Phase 3.3 的真实性收口 (Production Truthfulness Closure)，本次针对当前代码库进行了全量工程审计，识别所有“架构声明强于生产行为”的问题点。

---

## 2. 详细审计项分类 (Detailed Findings Classification)

### A. StructuredModelGateway 构造与依赖注入异常 (Constructors & Dependency Injections)
* **类别**: G (类型或构造签名异常), F (声明能力与实际行为不一致)
* **位置**: `src/core/modelReliability/structuredModelGateway.ts`, `src/core/ctfRuntime/createCTFTaskRuntime.ts:167`
* **现状**: `StructuredModelGateway` 构造函数接收 5 个位置参数（(router, healthStore, circuitBreaker, registry, trajectoryRecorder)），但在某些实例化位置或者组合中缺乏统一接口对象（`StructuredModelGatewayDependencies`），且缺乏强制断言。
* **风险/暴露**: 位置参数易错位，未强制提供 `getStateRevision` 导致 trajectory record 或 stream 监控上下文可能传错或缺失。

---

### B. 自动化占位模型与未限制的 Provider 默认注册 (Placeholder Models & Unbound Providers)
* **类别**: D (模拟成功), F (声明能力与实际行为不一致)
* **位置**: `src/core/modelReliability/modelRegistry.ts:66-198`, `src/core/ctfRuntime/createCTFTaskRuntime.ts:163`
* **现状**: `ModelCapabilityRegistry.registerDefaults()` 自动注册了 `high-tier-model`, `gpt-4o`, `m3-low-cost-tier` 等默认模型 Profile。当用户没有配置真实 Provider 时，系统自动套用硬编码默认模型；如果 provider 不存在，甚至使用 fallback 或降级模拟。
* **要求**: 彻底删除生产代码中的默认占位模型。无配置时 LLM Runtime 启动即明确拒绝 (`Runtime creation failed: No configured model/provider available`)。

---

### C. Provider 选择与降级隐匿逻辑 (Provider Selection & Arbitrary Provider Fallback)
* **类别**: D (模拟成功), E (双重真相源)
* **位置**: `src/core/modelReliability/structuredModelGateway.ts:210, 349`, `src/core/modelReliability/structuredModelGateway.ts:123, 259`
* **现状**:
  1. `providers.get(providerId) || Array.from(this.providers.values())[0]`：如果匹配不到指定 Profile 的 providerId，直接任意使用 `values()[0]` 备用 Provider，导致真实 Profile 与真实 Provider 解绑！
  2. `if (this.providers.size === 0) return true`：当未配置任何 Provider 时，`hasProvider` 直接返回 `true`，导致 ModelRouter 假装 Provider 可用并成功路由到无 Provider 的模型！
* **要求**: 彻底移除 `values()[0]` 与 `size === 0 ? true` 分支，当 Provider 不存在时必须抛出 `MissingModelProviderError` 并中断。

---

### D. MonitoredAgentTurnStream 未真正监控 Stream 生命周期的 EOF 与失败 (Unmonitored Agent Turn Stream)
* **类别**: F (声明能力与实际行为不一致), D (模拟成功)
* **位置**: `src/core/modelReliability/monitoredStream.ts`, `src/core/modelReliability/structuredModelGateway.ts:425`
* **现状**: Gateway 或 Stream 在输出 Chunk 之前即调用 `recordSuccess()`，或者在流中途发生 Error 时无法正确区分未输出 Chunk 的 Provider 级 Failure (可 fallback) 与已输出部分 Chunk 的 Partial Stream Failure (不可隐匿 fallback)。
* **要求**: 接入 `MonitoredAgentTurnStream` 控制 EOF 逻辑，仅在正常 EOF 且有有效 Chunk、未 abort 时才记录 `recordSuccess`。

---

### E. ExecutionEngine 模型调用旁路 (Engine Model Calling Bypass)
* **类别**: E (双重真相源), C (仅测试/临时使用)
* **位置**: `src/modules/critic.ts:52`, `src/modules/reflection.ts:65, 217`, `src/core/engine.ts:483`, `src/core/compact.ts:249`
* **现状**: `critic`, `reflection`, `compact` 以及 `engine.ts` 中存在直接 `new OpenAICompatibleProvider(client)` 手动构造 Provider 的旁路，绕过了 `ModelGateway`、`ModelRouter`、`ModelHealthStore` 和 `CircuitBreaker`。
* **要求**: 彻底清理所有直接实例化 `OpenAICompatibleProvider` 的旁路，集中归一为通过 `ModelGateway.streamAgentTurn()` 或 `execute()` 调度，按 ModelRole 分配。

---

### F. Tool Exposure Resolver 与 Agent Engine 剥离 (Tool Exposure & Visibility)
* **类别**: F (声明能力与实际行为不一致)
* **位置**: `src/core/engine.ts:306`, `src/core/toolBroker.ts:204`
* **现状**: Engine 和 ToolBroker 仍然直接调用 `policy.isToolVisible()` 逐个过滤工具，未统一经过 `ToolExposureResolver.resolveDefinitions()` 与 `assertExecutable()`，且 Orchestrator 未做 Fail-closed 控制。
* **要求**: 统一 `ToolExposureResolver` 成为 Tool 定义获取与 Tool 执行断言的唯一入口。

---

### G. SolverPortfolio / NativeSolverAdapter 模拟成功与隐匿 Ready (Synthetic Solver Success)
* **类别**: D (模拟成功), B (仅实例化但未调用)
* **位置**: `src/core/solverPortfolio/nativeSolverAdapter.ts:56`, `src/core/ctfRuntime/createCTFTaskRuntime.ts:218`
* **现状**:
  1. `NativeSolverAdapter` 默认 `status: 'ready'`，且在缺乏真实 `NativeSolverRuntimeDelegate` 时能够假装 `ready` 并可能返回 `completed`。
  2. `SolverPortfolio` 存在无参构造函数 `new SolverPortfolio()`。
* **要求**: `SolverPortfolio` 强制依赖注入。`NativeSolverAdapter` 在没有真实 Delegate 时 probe 必须返回 `unavailable`，调用 `start()` 抛出 `SolverUnavailableError`。

---

### H. ChallengeSwarm 缺乏在线事件消费与静态等待 (ChallengeSwarm Event Stream Inactivity)
* **类别**: F (声明能力与实际行为不一致)
* **位置**: `src/core/solverPortfolio/challengeSwarm.ts:99`
* **现状**: `ChallengeSwarm` 使用 `Promise.race(handles.map(h => h.wait()))` 仅等待终态结果，而忽略了 `handle.events()` 暴露的在线 AsyncIterable 流。
* **要求**: Swarm 必须并发启动 `events()` 消费迭代器，实时更新 TaskState、触发 StagnationDetector 以及执行 PreActionGuard 止损。

---

### I. CrossSolverEvidenceBus 的双重真相源与未接地自然语言 (Dual Source of Truth for Evidence)
* **类别**: E (双重真相源), F (声明能力与实际行为不一致)
* **位置**: `src/core/solverPortfolio/crossSolverEvidenceBus.ts:22`
* **现状**: `CrossSolverEvidenceBus` 维护私有数组 `private messages: SolverEvidenceMessage[] = []`，形成了 TaskState 之外的第二真相源；且允许广播空的 `evidenceIds: []` 纯文本 message 作为“可靠信息”。
* **要求**: 废除独立 `CrossSolverEvidenceBus` 数据存储，重构为 `CrossSolverKnowledgeView` 视图，以 `CTFTaskStateStore` 为唯一真相源，所有跨 Solver 消息必须具备接地 ID (`evidenceIds`, `observationIds`, `artifactIds`)。

---

### J. Trajectory Replay 伪重放与固定 State Revision (Fake Replay & Fixed Revisions)
* **类别**: D (模拟成功), F (声明能力与实际行为不一致)
* **位置**: `src/core/trajectory/trajectoryRecorder.ts:67`, `src/core/trajectory/trajectoryReplay.ts:41`
* **现状**:
  1. `trajectoryRecorder` 中有多处 fallback 将 `stateRevision` 硬编码为 `1`。
  2. `trajectoryReplay` 在 `state-rebuild` 和 `mock-execution` 模式中未完全使用 TaskState Reducer 重新推算最终 State Hash 并与记录 Hash 比对。
* **要求**: Trajectory Event Schema 强类型化；Recorder Buffer 有界化；Revision 从 StateStore 实时获取；Replay 真正执行状态重建与 Mock Execution 推理逻辑比较。

---

## 3. 审计结论 (Audit Conclusion)

当前代码库中共有 10 大核心不真实性隐患 (A - J)。接下来的各步骤将按照 `mix_goal.md` 中第 6 至 46 节的要求，逐一进行根治性重构与修复，确保生产环境中不存在任何假成功、假 Provider、假 Solver 或隐藏降级路径。
