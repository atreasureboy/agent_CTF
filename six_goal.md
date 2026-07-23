/goal 对当前 agent_CTF 仓库进行下一阶段工程化增强：建立“专业子 Agent + 专业工具 + 一把梭工作流”的 CTF 高吞吐执行体系。

## 一、项目定位

当前项目已经具备：

* 统一 Harness
* CTFTaskRuntime 单入口
* Main Agent / Specialist Agent
* Capability Profile
* Workflow
* BackgroundJobManager
* ArtifactStore / FindingStore
* TaskStateProjector
* HandoffCoordinator
* AbortSignal 取消链
* Tool-first 提示和工具策略
* 差异化 Agent 工具白名单

这些能力必须保留。

不得推倒重写 Harness，不得重新制造另一套 Agent Runtime，不得让新增的一把梭工具直接侵入 ExecutionEngine。

本阶段需要新增的是：

> OneShot / Shotgun 外部工作流层。

由一个专门的后台子 Agent 负责选择和调度多个现成 CTF 工具链；底层执行、超时、隔离、输出解析和结果去重由确定性 TypeScript 代码负责。

目标运行层次：

主 Agent
→ 专业 Specialist
→ Shotgun Agent / OneShot Dispatcher
→ 一把梭 Workflow
→ 专业 CLI、容器或本地服务

## 二、核心目标

1. 尽可能接入成熟的 CTF 一把梭和自动化分析项目。
2. 一把梭全部支持后台运行，不能阻塞主 Agent。
3. 一把梭命中率可以不高，但必须低干扰、可取消、有限时、不会污染其他任务。
4. 所有一把梭输出必须归一化为 Finding、Artifact 和 Candidate。
5. Agent 在已有成熟工具覆盖时，不得优先手写相同功能。
6. 一把梭失败后，专业 Agent仍可继续调用单项工具或编写适配脚本。
7. 不将所有第三方工具安装到同一个宿主环境。
8. 所有主动网络能力只能作用于比赛平台明确下发的目标。
9. 真实比赛 Token、API Key 和提交权限不得进入一把梭容器。
10. 每个第三方项目必须记录版本、许可证、来源和健康状态。

## 三、总体架构

新增：

src/ctf/oneshot/

* types.ts
* manifestSchema.ts
* catalog.ts
* registry.ts
* selector.ts
* dispatcher.ts
* runner.ts
* serviceRunner.ts
* containerRunner.ts
* processRunner.ts
* resultNormalizer.ts
* outputParser.ts
* evidenceCollector.ts
* budgetManager.ts
* healthChecker.ts
* scopeGate.ts
* index.ts

src/ctf/agents/

* shotgunProfile.ts
* shotgunPrompt.ts
* shotgunCoordinator.ts

src/ctf/tools/

* runOneShot.ts
* listOneShots.ts
* inspectOneShotResult.ts
* cancelOneShot.ts

oneshot/

* manifests/
* parsers/
* fixtures/
* docker/
* services/

tests/oneshot/

* manifest.test.ts
* selector.test.ts
* dispatcher.test.ts
* runner.test.ts
* cancellation.test.ts
* normalization.test.ts
* scopeGate.test.ts
* toolFirstEnforcement.test.ts
* integration.test.ts

目录名称可根据当前仓库结构微调，但必须维持清晰的接口边界。

## 四、Shotgun Agent

新增专门的 `shotgun-runner` Profile。

它不是通用解题 Agent，也不是主 Agent。

职责：

* 根据任务类型、文件类型和已有 Findings 选择适用的一把梭；
* 请求 Dispatcher 在后台运行；
* 观察已完成任务；
* 识别高价值结果；
* 将命中结果回灌专业 Specialist；
* 不亲自手写解题脚本；
* 不直接提交 Flag；
* 不拥有无关领域工具；
* 不读取比赛凭据。

Shotgun Agent 可被以下 Profile 调用：

* orchestrator
* triage
* image-stego
* crypto
* file-forensics
* traffic
* reverse
* pwn
* web
* misc

允许同一个任务启动多个一把梭，但必须经过预算控制。

## 五、OneShot Manifest

每个第三方项目通过声明式 Manifest 接入，不得为每个项目在核心代码里写大量 if/else。

Manifest 至少包括：

```ts
interface OneShotManifest {
  id: string
  displayName: string
  category: string
  description: string

  source: {
    repository: string
    license?: string
    pinnedRef?: string
    imageDigest?: string
  }

  maturity: 'stable' | 'candidate' | 'experimental'
  enabledByDefault: boolean

  inputMatchers: {
    mimeTypes?: string[]
    extensions?: string[]
    magicPatterns?: string[]
    requiredArtifacts?: string[]
    taskTags?: string[]
  }

  allowedProfiles: string[]
  excludedProfiles?: string[]

  runner: {
    type: 'process' | 'container' | 'service'
    command?: string[]
    image?: string
    endpoint?: string
  }

  resources: {
    timeoutSeconds: number
    cpuLimit?: number
    memoryMb?: number
    pidsLimit?: number
    maxOutputBytes: number
    maxArtifactBytes?: number
  }

  network: {
    mode: 'none' | 'contest-target-only' | 'outbound-readonly'
    requiresScopeApproval: boolean
  }

  output: {
    parser: string
    artifactGlobs?: string[]
    flagPatterns?: string[]
    successPatterns?: string[]
    ignorePatterns?: string[]
  }

  scheduling: {
    costTier: 'fast' | 'medium' | 'heavy'
    estimatedSeconds?: number
    concurrencyGroup?: string
    falsePositiveRisk: 'low' | 'medium' | 'high'
  }

  healthcheck: {
    command?: string[]
    endpoint?: string
    expectedPattern?: string
  }
}
```

Manifest 必须使用 zod 校验。

无效 Manifest 不得导致整个 Runtime 启动失败，应禁用该项并记录明确错误。

## 六、统一结果模型

定义：

```ts
interface OneShotResult {
  runId: string
  manifestId: string
  taskId: string

  status:
    | 'queued'
    | 'running'
    | 'completed'
    | 'partial'
    | 'timeout'
    | 'cancelled'
    | 'failed'
    | 'unavailable'

  startedAt: string
  finishedAt?: string
  durationMs?: number

  findings: NormalizedFinding[]
  artifacts: NormalizedArtifact[]
  candidates: CandidateValue[]

  diagnostics: {
    exitCode?: number
    signal?: string
    stdoutPath?: string
    stderrPath?: string
    truncated: boolean
    parserWarnings: string[]
  }

  confidence: number
  falsePositiveRisk: 'low' | 'medium' | 'high'
}
```

所有原始 stdout/stderr 保存为 Artifact。

不得把数万行原始输出直接塞进 LLM 上下文。

只向 Agent返回：

* 简短摘要；
* 关键 Findings；
* 候选 Flag；
* 产物路径；
* 失败原因；
* 可继续调查的方向。

## 七、执行通道

实现三种 Runner：

### ProcessRunner

只用于已审核、依赖简单、不会污染环境的本地 CLI。

### ContainerRunner

默认方式。

要求：

* 只读挂载原始附件；
* 单独挂载结果目录；
* 不挂载主仓库、Home、SSH、API Key；
* 默认无网络；
* 限制 CPU、内存、PID 和磁盘输出；
* 超时后杀死整个进程组或容器；
* 支持父任务 AbortSignal；
* 记录镜像 Digest。

### ServiceRunner

用于：

* AperiSolve
* MobSF
* FACT
* 其他长期运行的本地分析服务

要求：

* 提交任务；
* 轮询状态；
* 获取结果；
* 支持取消；
* 服务不可用时返回 unavailable；
* 不阻塞其他 Workflow。

## 八、调度策略

实现三级执行通道。

### Fast Lane

低成本、本地、默认运行，目标时间约数秒到几十秒。

例如：

* file
* strings
* exiftool
* pngcheck
* binwalk 快速扫描
* CyberChef Magic
* Ciphey 快速模式
* Hash/编码识别
* checksec
* capa
* FLOSS 快速模式

默认并发较高。

### Medium Lane

明确匹配类别后运行：

* 图片隐写组合扫描
* RsaCtfTool
* StegSeek
* BruteShark/PCaptor
* oletools
* pwninit
* ROPgadget
* Nuclei 的受限模板集
* AutoRecon 的受限枚举
* Volatility 基础插件组合

默认并发中等。

### Heavy Lane

高资源、低命中率、运行时间较长：

* crypto-attacks / Sage 重型攻击
* angr 符号执行
* Hashcat/John 大字典
* Volatility 全量插件
* MobSF
* FACT/EMBA
* reconFTW
* 固件模拟或大型流量分析

默认每个任务同时最多运行一个 Heavy Workflow。

默认建议：

```text
fastConcurrency = 8
mediumConcurrency = 3
heavyConcurrency = 1
perTaskMaxRuns = 12
perTaskHeavyRuns = 1
```

这些值必须可配置。

任务 solved、被取消或到达 deadline 后，立即取消剩余一把梭。

## 九、首批候选项目

不要一次性把所有项目紧耦合实现。

先建立 Catalog 和 Manifest，再分批接入。

### P0：优先完成真实 Adapter

通用：

* MysterionRise/ctf-kit
* GCHQ/CyberChef
* ReFirmLabs/binwalk

图片隐写：

* Real-C3ngH/pic-all-in-one
* Zeecka/AperiSolve
* DominicBreuker/stego-toolkit
* stegseek
* zsteg
* stegoveritas

密码与编码：

* Ciphey/Ciphey
* RsaCtfTool/RsaCtfTool
* hellman/xortool
* hashcat
* John the Ripper

取证：

* odedshimon/BruteShark
* bidhata/PCaptor
* volatilityfoundation/volatility3
* decalage2/oletools
* DidierStevens/DidierStevensSuite

逆向与文件分析：

* mandiant/capa
* mandiant/flare-floss
* CYB3RMX/Qu1cksc0pe
* io12/pwninit
* JonathanSalwan/ROPgadget

Web和网络：

* nmap
* AutoRecon/AutoRecon
* projectdiscovery/nuclei
* ffuf
* feroxbuster
* dirsearch
* sqlmap
* commix

### P1：建立 Manifest，但默认关闭或标记 candidate

* jvdsn/crypto-attacks
* angr/angr
* MobSF/Mobile-Security-Framework-MobSF
* fkie-cad/FACT_core
* e-m-b-a/emba
* six2dez/reconftw
* spq/pkappa2
* OpenAttackDefenseTools/tulip
* StegoForge
* ST3GG

### P2：仅作为知识、安装和 Workflow 设计参考

* ljagiello/ctf-skills
* zardus/ctf-tools
* apsdehal/awesome-ctf
* JohnHammond/ctf-katana

P2 项目不得直接替换现有 Harness。

可以提取：

* 工具清单；
* 类别检查表；
* 推荐参数；
* 安装方式；
* 输出解析经验；
* Specialist 提示词。

## 十、第三方项目接入规则

对每个候选项目执行：

1. 阅读官方 README、CLI 文档和许可证。
2. 确认是否仍可构建和运行。
3. 记录 pinned commit、release tag 或镜像 Digest。
4. 创建独立 Manifest。
5. 创建最小健康检查。
6. 创建至少一个合法测试 Fixture。
7. 编写输出 Parser。
8. 验证超时和取消。
9. 验证空结果不会被误判为命中。
10. 验证异常输出不会污染 TaskState。
11. 不复制 GPL 项目源码进入核心仓库，除非明确完成许可证评估。
12. 优先使用外部进程、容器或服务方式集成。
13. 无维护、无许可证或来源可疑的项目标记 experimental，默认关闭。

## 十一、Tool-first 强制化

当前 Tool-first 不得只停留在 advisory。

实现三种策略：

```text
advisory
require_reason
enforced
```

专业 Profile 默认使用 `require_reason`。

以下场景使用 `enforced`：

* 图片附件存在但图片快速 Workflow 从未运行；
* RSA 参数存在但 RsaCtfTool 从未运行；
* 未知编码文本存在但 CyberChef/Ciphey 从未运行；
* PCAP 存在但基础流量 Workflow 从未运行；
* ELF/PE 存在但 file/checksec/capa/FLOSS 从未运行；
* Office 文档存在但 oletools 从未运行；
* 网络目标存在但基础枚举从未运行。

在 enforced 模式下：

* Agent首次尝试用 Bash/Python 重写已有工具功能时拒绝；
* 返回推荐 Workflow；
* 现有 Workflow 已失败并产生失败证据后，允许手写；
* 允许手写时必须记录 overrideReason；
* Critic 可以审计不合理 override。

禁止永久封死 Python/Bash，因为它们仍然是处理题目变种的最终工具。

## 十二、修复命令策略

完整审计现有 command policy。

不得因第一个命令是 shell builtin 就提前放行整个命令串。

必须正确检查：

* `echo ok; nmap ...`
* `true && tool ...`
* 管道；
* command substitution；
* subshell；
* process substitution；
* backtick；
* 多行脚本；
* shell function；
* `env VAR=x command`；
* `timeout command`；
* `sudo command`。

优先使用成熟 Bash Parser 或 AST，例如 tree-sitter-bash。

不要继续使用不断叠加正则表达式的方式模拟 Shell 语法。

所有解析失败的复杂命令默认拒绝或要求审批，不能 fail-open。

## 十三、比赛范围闸门

网络型一把梭执行前必须经过 ScopeGate。

Scope 只能来自：

* 比赛 API 下发的主机、域名和端口；
* 当前任务明确提供的目标；
* 人工明确批准的比赛目标。

禁止模型自行扩大目标范围。

ScopeGate 应支持：

* Host/IP allowlist；
* Domain allowlist；
* Port allowlist；
* Redirect 后重新校验；
* DNS 解析结果校验；
* 私有地址和比赛网络规则；
* 运行期网络审计。

以下工具必须强制 ScopeGate：

* nmap
* AutoRecon
* reconFTW
* nuclei
* ffuf
* feroxbuster
* dirsearch
* sqlmap
* commix
* 任何主动 HTTP、TCP、UDP 扫描工具

## 十四、Doctor 与可复现环境

新增：

```text
ovolv999-ctf doctor
ovolv999-ctf doctor --oneshot
ovolv999-ctf oneshot list
ovolv999-ctf oneshot check <id>
ovolv999-ctf oneshot run <id> <artifact>
```

Doctor 输出：

* 工具是否安装；
* 服务是否在线；
* 镜像是否存在；
* 当前版本；
* Manifest 状态；
* Parser 状态；
* Fixture Smoke Test；
* 缺少的依赖；
* 当前可用 Profile；
* 网络权限要求。

输出示例：

```text
image/pic-all-in-one       READY
image/aperisolve           READY
crypto/ciphey              READY
crypto/rsactftool          DEGRADED
traffic/bruteshark         READY
reverse/angr               DISABLED_HEAVY
web/reconftw               DISABLED_SCOPE_REQUIRED
mobile/mobsf               UNAVAILABLE
```

缺少某个一把梭不能导致整个 Agent 不可用。

## 十五、结果去重和候选 Flag

多个一把梭可能返回相同结果。

必须实现：

* Artifact 内容 Hash 去重；
* Finding 语义键去重；
* Candidate Flag 规范化；
* 相同 Flag 不重复报告；
* 记录每个 Candidate 的所有来源；
* 高风险工具结果标记为未验证；
* 不因字符串中出现 `flag` 就自动认为已解题；
* Solver 不得直接提交；
* 只报告 candidate 给后续 Verifier。

Candidate 至少记录：

```ts
{
  value: string
  sourceRuns: string[]
  sourceArtifacts: string[]
  confidence: number
  needsVerification: boolean
}
```

## 十六、后台任务与状态投影

所有 OneShot 运行必须通过现有 BackgroundJobManager 或其正式扩展执行。

不得创建第二套不受管理的后台任务系统。

需要投影以下事件：

* ONESHOT_QUEUED
* ONESHOT_STARTED
* ONESHOT_PROGRESS
* ONESHOT_FINDING
* ONESHOT_ARTIFACT
* ONESHOT_CANDIDATE
* ONESHOT_COMPLETED
* ONESHOT_TIMEOUT
* ONESHOT_FAILED
* ONESHOT_CANCELLED

事件必须进入现有 TaskState 和审计日志。

任务进入 terminal 状态后，丢弃迟到事件，但保留底层原始日志。

## 十七、实战 Benchmark

建立小型真实 Fixture 集：

* PNG 隐写
* JPEG 隐写
* 多层 Base 编码
* XOR
* 弱 RSA
* ZIP 嵌套
* 文件尾拼接
* PCAP HTTP
* USB HID PCAP
* Office 宏文档
* Windows 内存样本
* 基础 ELF
* 基础 Pwn 环境
* APK
* 简单 Web 靶场

比较：

A. 纯 Agent + Bash/Python
B. 专业 Agent + 单项工具
C. 专业 Agent + 一把梭后台层

统计：

* timeToFirstToolCall
* timeToFirstFinding
* timeToCandidate
* solveRate
* workflowUsageRate
* manualScriptCount
* duplicateAttemptRate
* toolFailureRate
* timeoutRate
* tokenUsage
* falsePositiveCount

重点验证：

> 推荐一把梭存在时，模型是否仍然优先手写。

## 十八、测试要求

必须覆盖：

1. Manifest schema。
2. Profile 工具权限。
3. 一把梭选择。
4. 后台并发限制。
5. Fast/Medium/Heavy 预算。
6. 超时和强制终止。
7. AbortSignal 传播。
8. 容器隔离。
9. 大输出截断与落盘。
10. Parser 异常。
11. 空结果。
12. 重复 Finding。
13. 重复 Candidate。
14. ScopeGate。
15. 任务 solved 后取消。
16. 服务不可用降级。
17. command policy 组合命令绕过。
18. Tool-first enforced。
19. 进程重启后的任务恢复。
20. 原有测试全部通过。

## 十九、实施顺序

按以下顺序实施，不要一次性盲目安装所有项目：

Phase A：

* Manifest
* Catalog
* Runner
* Dispatcher
* Normalizer
* ScopeGate
* Doctor
* Mock Adapter

Phase B：
接入 P0 中每个类别至少一个真实工具：

* pic-all-in-one
* Ciphey
* RsaCtfTool
* BruteShark 或 PCaptor
* oletools
* capa 或 FLOSS
* AutoRecon
* pwninit

Phase C：

* Shotgun Agent
* Tool-first 强制化
* BackgroundJob 投影
* 结果回灌
* Benchmark

Phase D：

* 其余 P0 工具
* P1 重型工具
* Contest Runtime/API Adapter

每完成一个阶段，执行：

架构审计
→ 单元测试
→ Fixture 集成测试
→ 并发和取消审计
→ 权限与范围审计
→ 修复
→ 文档更新

## 二十、禁止事项

* 禁止重写现有 Harness。
* 禁止创建第二套 TaskState。
* 禁止让 LLM 自己维护后台进程表。
* 禁止把所有工具安装到宿主机全局 PATH。
* 禁止在单个 Docker 镜像塞入所有工具。
* 禁止直接信任第三方工具输出。
* 禁止一把梭直接提交 Flag。
* 禁止将比赛 Token 放进子 Agent环境。
* 禁止让网络扫描超出比赛 Scope。
* 禁止因为工具失败就终止整个题目。
* 禁止为了接入数量牺牲可取消性和可观测性。
* 禁止仅依靠 Prompt 实现工具权限。
* 禁止用正则继续模拟完整 Shell 语法。
* 禁止删除现有功能以简化实现。

## 二十一、最终交付

完成后输出：

1. 实际修改和新增文件。
2. 新架构数据流。
3. OneShot Manifest 示例。
4. 已接入工具清单。
5. READY/DEGRADED/UNAVAILABLE 状态。
6. 每个第三方项目的版本和许可证。
7. Docker 镜像与服务列表。
8. Tool-first 强制策略。
9. ScopeGate 实现。
10. Benchmark 结果。
11. 全部测试结果。
12. 尚未接入的候选项目。
13. 测试赛后接入比赛 API 的明确位置。
14. 当前已知风险与回滚方式。
