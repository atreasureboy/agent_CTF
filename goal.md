# /goal：轻量级架构优先自主开发循环

## 一、最终目标

当前最终目标：
> 将当前 ovolv999_pro 改造为面向 AI Agent CTF 竞赛的“分层指挥 + 专业子 Agent + 专业工具 + 一把梭工作流”统一 Harness。
仓库地址与当前工作区即为本项目。请先完整审计现有代码、配置系统、Agent 创建流程、工具注册流程、模块系统、子 Agent 调用机制、会话管理、并发机制和测试体系，再开始修改。
本任务是架构级改造，不是简单增加几个提示词文件，也不是堆叠一批 CTF 工具。

一、项目目标
当前项目已经具备或正在构建统一 Agent Harness。
本次改造需要在不推倒现有 Harness 的前提下，实现如下分层体系：
主 Agent / Strategist
负责全局判断、任务拆分、资源调度、优先级调整和结果汇总
                ↓
专业子 Agent
负责某个具体领域的局部规划、工具选择、结果解释和任务接力
                ↓
专业工具
负责确定性、高效率地完成原子操作
                ↓
一把梭 Workflow
负责批量组合多个工具、参数和常见解题路径
典型关系：
主 Agent
  ├── 图片隐写 Agent
  │     ├── image_quick_scan Workflow
  │     ├── exiftool
  │     ├── pngcheck
  │     ├── binwalk
  │     └── zsteg
  │
  ├── 密码 Agent
  │     ├── encoding_sweep Workflow
  │     ├── RsaCtfTool
  │     ├── SageMath
  │     ├── hashcat
  │     └── Python 数学环境
  │
  ├── 流量分析 Agent
  │     ├── pcap_quick_scan Workflow
  │     ├── tshark
  │     ├── tcpflow
  │     └── 协议提取工具
  │
  └── Web Agent
        ├── web_initial_enumeration Workflow
        ├── nmap
        ├── httpx
        ├── 目录扫描器
        └── Web 专项工具
核心目标不是让大模型“自己解所有题”，而是让模型成为成熟工具链的指挥者。

二、核心问题
当前通用大模型即使知道某个专业工具，也经常选择低效率的手工方式。
例如：
目标：获取主机完整端口和服务信息

低效率方式：
curl 某个端口
→ 查看结果
→ nc 另一个端口
→ 再猜测其他端口

正确方式：
将 nmap 扫描作为后台任务启动
→ 主 Agent 同时处理其他任务
→ 扫描完成后读取结构化结果
类似问题还包括：
有 zsteg，却手写 LSB 提取；
有 binwalk，却逐字节查看文件尾；
有 RsaCtfTool，却从零编写常见 RSA 攻击；
有 tshark，却手动解析大量 PCAP；
有 checksec/readelf，却先用 strings 猜测二进制属性；
有目录扫描器，却让模型逐个 curl 路径；
有成熟一把梭，却逐个运行同一批固定命令。
本次改造必须从架构上解决该问题，而不是只在提示词中增加一句“优先使用工具”。

三、强制设计原则
1. 统一 Harness，差异化能力
所有子 Agent 共用同一个执行引擎、会话体系、事件系统和基础 Harness。
不同子 Agent 的差异由以下四部分组成：
SpecialistAgent =
  专业 System Prompt
  + Capability Profile
  + 专业工具集合
  + 专业 Workflow 集合
不要为每种 Agent 复制一套执行引擎。
不要通过大量 if/else 在核心 Engine 中硬编码 CTF 类别。
2. 子 Agent 的差异不能只依赖提示词
“你是图片隐写专家”远远不够。
Harness 必须实际控制：
该 Agent 可以看到哪些工具；
可以调用哪些 Workflow；
可以执行哪些外部命令；
哪些工具对它完全不可见；
哪些操作需要转交其他 Agent；
哪些操作允许后台运行；
可以访问哪些工作目录和产物。
工具启用、禁用和命令限制必须由程序执行，而不是只靠模型自觉。
3. 工具优先，而不是手工优先
默认决策优先级：
成熟一把梭 Workflow
→ 专业工具
→ 多个现有工具组合
→ 修改或扩展已有脚本
→ 最后才允许从零手写
但不要机械地认为越重的工具越好。
工具选择应综合考虑：
覆盖范围；
预期信息增益；
执行时间；
资源成本；
误报率；
当前任务是否明确；
是否可以后台并发。
例如：
只验证一个明确 HTTP URL 是否可访问，可以使用 curl；
需要了解完整攻击面时，应优先使用 nmap 或成熟枚举工作流；
已知是 PNG 隐写时，应优先使用图片专项工具；
输入类型未知时，应优先使用文件初筛 Workflow。
4. 手工实现需要举证
当 Agent 决定从零写脚本实现一个已有成熟工具通常能够完成的功能时，必须先说明：
- 已尝试哪些 Workflow；
- 已尝试哪些专业工具；
- 工具为什么失败或不适用；
- 当前题目存在什么非标准变种；
- 手写脚本只补足哪个缺口。
如果没有合理原因，应阻止或警告该行为。
5. 不按单个工具拆 Agent
禁止设计：
ExiftoolAgent
BinwalkAgent
ZstegAgent
NmapAgent
StringsAgent
正确粒度是问题域：
ImageStegoAgent
FileForensicsAgent
CryptoAgent
WebAgent
ReverseAgent
PwnAgent
TrafficForensicsAgent
MiscAgent
专业子 Agent 是局部指挥者，不是某个命令的包装器。
6. 主 Agent 不执行低层工作
主 Agent 主要拥有：
获取题目状态；
创建专业子 Agent；
分配任务；
调整优先级；
查询后台任务；
接收结构化 Findings；
请求交叉验证；
汇总结果；
终止无效分支。
主 Agent 默认不应直接：
扫描端口；
手工解析附件；
编写大段临时脚本；
阅读全部工具原始输出；
执行具体破解工作。
它应将具体任务交给专业子 Agent。
7. 支持任务接力
CTF 题目经常跨领域。
例如：
PNG
→ 图片 Agent 提取出 ZIP
→ 文件取证 Agent 解包
→ 得到密文
→ 密码 Agent 接手
→ 得到候选 flag
→ Verifier 验证
专业 Agent 必须能够返回 HandoffRequest，而不是因为自己没有跨领域工具就停止，或者直接获得所有工具。

四、需要实现的核心抽象
请根据现有项目架构合理命名和放置文件，以下只是参考。
1. CapabilityProfile
实现可配置的能力档案。
建议数据结构：
interface CapabilityProfile {
  id: string
  displayName: string
  description: string

  systemPromptModules: string[]

  allowedTools: string[]
  deniedTools?: string[]

  allowedWorkflows: string[]
  deniedWorkflows?: string[]

  allowedCommands?: string[]
  deniedCommands?: string[]

  allowShell: boolean
  allowPython: boolean
  allowBackgroundJobs: boolean
  allowAgentHandoff: boolean

  preferredAgentsForHandoff?: string[]

  limits?: {
    maxIterations?: number
    maxParallelJobs?: number
    maxExecutionSeconds?: number
    maxToolCalls?: number
  }
}
配置必须经过 schema 校验。
配置错误应在 Agent 启动前暴露，而不是运行中静默忽略。
2. Tool Registry
建立统一 Tool Registry。
每个工具至少包含：
interface ToolDefinition {
  id: string
  name: string
  description: string
  domain: string[]
  inputSchema: unknown

  executionMode:
    | 'foreground'
    | 'background'
    | 'either'

  costClass:
    | 'cheap'
    | 'medium'
    | 'expensive'

  outputMode:
    | 'inline'
    | 'artifact'
    | 'structured'

  riskLevel?: string
  requiredBinaries?: string[]
}
Agent 创建时只向模型暴露 CapabilityProfile 允许的工具。
被禁用的工具不应出现在模型工具列表中。
3. Tool Broker
所有工具调用通过统一 Tool Broker。
Tool Broker 负责：
检查 Agent Profile；
检查工具是否允许；
检查命令是否允许；
检查工作目录；
应用超时；
应用并发限制；
记录调用日志；
处理后台任务；
统一输出格式；
将超长输出保存为 Artifact；
对模型返回摘要和 Artifact 引用。
不要让 Agent 绕过 Tool Broker 直接无约束调用宿主命令。
4. Shell 和 Python 治理
Shell 和 Python 不能完全删除，因为 CTF 需要临时胶水代码和题目变种处理。
但必须防止它们成为绕过专业工具体系的万能后门。
实现以下机制：
Shell
根据 Agent Profile 检查可执行命令；
对命令首个可执行文件进行解析；
记录完整命令和执行理由；
支持 Profile 级 allowlist/denylist；
支持后台运行；
支持超时和取消；
禁止跨任务目录访问；
未授权命令返回结构化拒绝信息。
Python
Python 主要用于：
连接多个工具；
解析结构化结果；
对现有脚本做小范围修改；
实现题目特有变种；
生成验证代码。
当 Python 脚本明显重新实现已有专业工具时，应触发 ToolFirstPolicy 警告。
不要求做完美静态分析，但必须建立可扩展的策略层和审计记录。
5. Workflow Registry
将“一把梭”作为正式的一等能力，而不是零散 Bash 脚本。
建议抽象：
interface WorkflowDefinition {
  id: string
  name: string
  description: string
  domain: string[]

  acceptedInputs: string[]
  outputSchema: unknown

  steps: WorkflowStep[]

  executionMode:
    | 'sequential'
    | 'parallel'
    | 'dag'

  stopConditions?: unknown[]
  requiredTools: string[]
}
Workflow 应支持：
串行步骤；
并行步骤；
条件分支；
超时；
某一步失败后继续其他步骤；
Artifact 输入输出；
结构化 Findings；
可取消；
统一日志；
后台执行。
不要把 Workflow 实现成一个不可观察的超大 Shell 字符串。
每一步必须可以审计和查看状态。
6. Background Job Manager
实现统一后台任务管理。
必须支持：
spawn
status
wait
cancel
collect
list
典型用法：
WebAgent 启动 nmap 全端口扫描
→ Job 进入后台
→ WebAgent 同时检查题目源码或已知 Web 服务
→ 扫描完成
→ Agent 收到结构化摘要
后台任务不能阻塞主 Agent 或整个题目队列。
每个 Job 至少记录：
jobId；
taskId；
agentId；
tool/workflowId；
状态；
开始时间；
结束时间；
超时时间；
输出 Artifact；
摘要；
错误；
取消原因。
7. Findings 和 Artifact
工具原始输出不能直接无限塞回模型上下文。
建立统一结构：
interface Artifact {
  id: string
  taskId: string
  producerAgentId: string

  type: string
  path: string
  mimeType?: string
  size?: number
  sha256?: string

  summary?: string
  createdAt: string
}
interface Finding {
  id: string
  taskId: string
  producerAgentId: string

  category: string
  title: string
  summary: string

  confidence:
    | 'low'
    | 'medium'
    | 'high'

  evidence: string[]
  artifactIds: string[]

  recommendedNextActions?: string[]
  suggestedAgent?: string
}
子 Agent 向主 Agent 返回 Findings，不返回无穷无尽的命令输出。
8. HandoffRequest
实现标准化接力请求：
interface HandoffRequest {
  taskId: string
  fromAgent: string
  suggestedAgent: string

  reason: string
  objective: string

  artifactIds: string[]
  findingIds: string[]

  constraints?: string[]
  priority?: number
}
主 Agent 可以接受、拒绝或修改接力请求。
接手的 Agent 应继承已有 Findings 和 Artifact，不应从原题完全重新分析。

五、专业 Agent 体系
第一阶段不要试图一次实现所有 CTF 类别的完整解题能力。
先实现可扩展架构，并提供以下代表性 Agent。
1. OrchestratorAgent
职责：
全局调度；
选择专业 Agent；
控制并发；
读取 Findings；
决定接力；
终止重复分支；
控制时间和成本。
默认工具：
list_tasks；
spawn_specialist_agent；
query_agent_status；
query_background_job；
inspect_finding；
inspect_artifact_summary；
approve_handoff；
cancel_agent；
update_priority。
默认不开放：
nmap；
zsteg；
RsaCtfTool；
反编译器；
通用无约束 Shell。
2. TriageAgent
职责：
判断输入文件和题目类型；
进行低成本初筛；
识别可能的多领域组合；
推荐后续 Agent；
不进行长时间深度求解。
可用能力：
file；
strings；
元数据初筛；
MIME/魔数识别；
基础文本特征识别；
unknown_file_triage Workflow；
Artifact 创建；
HandoffRequest。
3. ImageStegoAgent
职责：
图片格式异常；
元数据；
PNG/JPEG 结构；
文件尾拼接；
色彩通道；
LSB；
二维码；
常见图片隐写；
提取嵌套 Artifact。
示例工具：
file；
exiftool；
pngcheck；
identify；
binwalk；
zsteg；
steghide；
strings；
二维码识别；
图像通道分析工具。
示例 Workflow：
image_quick_scan；
png_stego_sweep；
jpeg_stego_sweep；
image_embedded_file_scan。
默认禁止或隐藏：
nmap；
sqlmap；
gdb；
RsaCtfTool；
Web 目录扫描工具。
关键规则：
标准图片工具未尝试前，不允许手写 LSB 提取器；
发现 ELF、PE、ZIP、PCAP、密文等 Artifact 时，应请求接力；
输出必须包含证据和生成文件路径。
4. CryptoAgent
职责：
编码识别；
古典密码；
XOR；
哈希识别；
RSA 常见弱点；
数学密码题；
密钥和参数分析。
示例工具：
编码识别工具；
CyberChef CLI 或等价能力；
RsaCtfTool；
SageMath；
hashcat；
John；
Python 数学环境；
常见密码脚本集合。
示例 Workflow：
encoding_sweep；
classical_cipher_sweep；
xor_key_search；
rsa_common_attacks；
hash_identify_and_crack。
关键规则：
已知成熟攻击方式优先调用现有工具；
不要默认手推大整数运算；
只有题目算法存在变种或工具失败时才编写专用脚本；
必须区分候选明文、确认明文和候选 flag。
5. WebAgent
职责：
目标服务和攻击面枚举；
HTTP 服务分析；
题目源码分析；
路径和参数发现；
Web CTF 常见漏洞方向判断。
示例工具：
nmap；
curl/http 客户端；
httpx；
目录扫描器；
指纹识别工具；
源码检索工具；
浏览器或 HTTP 会话工具。
示例 Workflow：
host_service_enumeration；
web_initial_enumeration；
source_code_quick_audit；
endpoint_discovery。
关键规则：
当目标是完整服务枚举时，不允许用多个 curl/nc 代替 nmap；
nmap 等长任务应支持后台运行；
已知单一 URL 验证可以使用 curl，不应无意义启动重扫描；
工具行为必须限制在比赛明确授权的目标范围。
6. FileForensicsAgent
职责：
未知文件；
压缩包；
嵌套文件；
文件头修复；
文件尾拼接；
元数据；
常见取证题。
示例 Workflow：
unknown_file_triage；
archive_recursive_extract；
embedded_content_scan；
magic_header_repair_candidates。

六、专业 Agent Prompt 模板
不要只写“你是某领域专家”。
每个专业 Agent 的 Prompt 至少包含：
1. 身份与领域边界
2. 当前任务目标
3. 已有 Findings
4. 已有 Artifact
5. 可用工具
6. 可用 Workflow
7. 禁用能力
8. 标准操作流程
9. 工具优先原则
10. 后台任务规则
11. 手工实现条件
12. 接力条件
13. 停止条件
14. 输出格式
示例核心规则：
你是专业领域 Agent，而不是通用聊天助手。

你的首要任务是以最低时间成本和最高信息覆盖率完成当前领域任务。

在执行前：
1. 检查是否存在能够覆盖当前目标的成熟 Workflow。
2. 若无完整 Workflow，检查专业工具。
3. 若工具不能完整解决，再组合工具。
4. 只有确认现有能力不支持题目变种时，才编写临时脚本。

禁止为了展示推理过程而重复实现已有工具能力。

遇到跨领域产物时：
- 保存 Artifact；
- 生成 Finding；
- 提交 HandoffRequest；
- 不要擅自扩大自己的工具权限。
Prompt 应由模块动态组合，而不是每个 Agent 复制大段完全相同文本。

七、ToolFirstPolicy
新增独立的 ToolFirstPolicy 层。
它至少负责：
为 Agent 提供当前领域的推荐 Workflow；
为具体目标推荐专业工具；
检测明显低效的手工操作；
在模型准备从零实现成熟能力时给出提醒；
要求模型解释不采用专业工具的原因；
记录例外；
为后续评估提供数据。
第一版不需要复杂机器学习。
可以通过以下方式实现：
规则；
Tool 元数据；
Workflow 元数据；
Agent Profile；
操作关键词；
计划审查 Hook；
工具调用前 Hook。
示例规则：
目标包含“完整端口扫描、服务识别”
并且 WebAgent 拥有 nmap
但模型准备逐端口 curl/nc
→ 返回 ToolFirstPolicy 提醒。

输入为 PNG
ImageStegoAgent 尚未运行 pngcheck/zsteg/image workflow
但模型准备手写像素位提取
→ 要求先运行专业工具或说明例外理由。

检测到 RSA 参数
CryptoAgent 尚未尝试 rsa_common_attacks
但模型准备从零实现所有常见攻击
→ 建议先执行 Workflow。
ToolFirstPolicy 不能完全阻塞所有手工尝试。
CTF 经常存在工具无法覆盖的变种，因此应支持带理由的 override，并写入审计日志。

八、一把梭 Workflow 的定位
“一把梭”不是万能答案，也不是简单把所有工具全部执行一遍。
它应具备：
明确输入类型；
明确适用范围；
低成本步骤优先；
可并行步骤并行；
重型步骤延后；
识别到高价值结果时可提前停止；
统一解析结果；
降低误报；
输出结构化 Findings；
生成可接力 Artifact。
示例 image_quick_scan：
阶段 1：低成本检查
- file
- exiftool
- identify
- pngcheck/jpeginfo
- strings
- 文件大小和魔数

阶段 2：并行扫描
- binwalk
- zsteg
- 二维码识别
- 文件尾和嵌套内容检查
- 色彩通道基本检查

阶段 3：条件执行
- 仅在存在相关特征时运行 steghide
- 仅在 PNG 时运行 PNG 专项流程
- 仅在 JPEG 时运行 JPEG 专项流程

阶段 4：汇总
- Findings
- 提取文件
- 可疑文本
- 推荐接力 Agent
注意：
不要求当前阶段内置所有真实工具；
若执行环境缺少某工具，必须给出清晰的 unavailable 状态；
不得因为缺少一个工具而导致整个 Workflow 崩溃；
Workflow 要支持未来增加新步骤。

九、并发与任务模型
支持以下三类并发：
1. 多题并发
主 Agent 可同时调度多个题目。
2. 单题多专业 Agent
同一道题可以并行运行不同领域 Agent，但必须避免重复劳动。
例如：
同一个 PNG
├── ImageStegoAgent
└── FileForensicsAgent
两者必须共享 Artifact 和 Findings，但使用独立工作目录或受控子目录。
3. Agent 内部后台工具
例如 WebAgent 后台运行 nmap，同时检查源码。
必须实现：
并发上限；
每题并发上限；
Agent 并发上限；
后台任务上限；
取消；
超时；
任务结束后的资源回收。

十、上下文与工作区隔离
每个比赛任务拥有独立目录。
参考：
sessions/<contest-id>/tasks/<task-id>/
├── input/
├── workspace/
├── artifacts/
├── findings/
├── agents/
│   ├── triage-<run-id>/
│   ├── image-<run-id>/
│   └── crypto-<run-id>/
├── jobs/
└── events.ndjson
要求：
Agent 默认只能访问当前任务目录；
跨 Agent 共享通过 Artifact 系统完成；
不允许任意读取其他任务；
工具输出必须归属到 taskId、agentId 和 runId；
长输出落盘；
模型只获取摘要和按需片段。

十一、安全与竞赛范围
该系统仅用于比赛官方授权目标和官方提供附件。
必须保留 Scope 控制：
interface ContestScope {
  allowedHosts?: string[]
  allowedCidrs?: string[]
  allowedPorts?: number[]
  allowedDomains?: string[]
  allowedFilesRoot: string
}
网络工具运行前必须检查目标是否在授权范围内。
不得默认扫描公网任意目标。
不得将比赛凭据、提交 Token 或其他秘密暴露给普通 Solver Agent。

十二、第一阶段实现范围
第一阶段重点是架构闭环，不是完整覆盖所有 CTF 题型。
必须完成：
1.CapabilityProfile；
2.Tool Registry；
3.Tool Broker；
4.Workflow Registry；
5.Background Job Manager；
6.Artifact；
7.Finding；
8.HandoffRequest；
9.SpecialistAgentFactory；
10.ToolFirstPolicy 基础版本；
11.主 Agent 与专业 Agent 的分层调用；
12.工作区隔离；
13.配置校验；
14.事件与审计日志；
15.文档和测试。
第一阶段提供至少以下可运行样例：
OrchestratorAgent；
TriageAgent；
ImageStegoAgent；
CryptoAgent；
一个轻量 FileForensicsAgent。
提供至少以下示例 Workflow：
unknown_file_triage；
image_quick_scan；
encoding_sweep；
rsa_common_attacks 的可插拔骨架。
若执行环境中缺少真实二进制，可以：
使用 availability detection；
在测试中使用 Mock Tool Adapter；
不得伪造工具成功结果。

十三、明确禁止事项
不得：
1.推倒或复制现有 ExecutionEngine；
2.为每种 Agent 建立独立 Harness；
3.只增加提示词、不实现工具级隔离；
4.给所有 Agent 暴露全部工具；
5.用单个超大 ctfAgent.ts 承载全部逻辑；
6.将所有 Workflow 写成不可观测的大段 Shell；
7.让主 Agent 直接负责所有低层工具调用；
8.让每个工具拥有独立 Agent；
9.让子 Agent 通过 Bash 任意绕过 Tool Registry；
10.把工具原始长输出全部塞入模型上下文；
11.让接力后的 Agent 从零重复分析全部输入；
12.猜测尚未公布的比赛 API；
13.为追求功能数量而牺牲模块边界；
14.在缺少测试的情况下声称架构已完成。

十四、建议的实施步骤
Phase 0：完整审计
输出并记录：
当前 Agent 创建流程；
当前工具注册流程；
当前模块加载流程；
当前子 Agent 运行方式；
当前 Shell/Python 工具实现；
当前会话和工作目录机制；
当前并发机制；
当前 EventLog；
可以直接复用的组件；
需要抽象的耦合点。
不要在未理解现有架构前开始大规模新增代码。
Phase 1：核心类型和接口
实现：
CapabilityProfile；
ToolDefinition；
WorkflowDefinition；
Artifact；
Finding；
HandoffRequest；
BackgroundJob；
相关 schema。
Phase 2：工具治理
实现：
Tool Registry；
Tool Broker；
Profile 级工具过滤；
Shell 命令策略；
超时；
输出落盘；
审计日志。
Phase 3：Workflow
实现：
Workflow Registry；
顺序、并行、条件执行；
Step 状态；
Artifact 传递；
部分失败；
取消和超时。
Phase 4：专业 Agent
实现：
SpecialistAgentFactory；
Prompt 模块组合；
Orchestrator；
Triage；
ImageStego；
Crypto；
FileForensics。
Phase 5：后台任务与接力
实现：
Job Manager；
Handoff；
Findings 共享；
Artifact 共享；
Agent 状态查询；
取消和资源回收。
Phase 6：ToolFirstPolicy
实现基础规则和可扩展 Hook。
至少覆盖：
网络枚举工具优先；
图片隐写工具优先；
RSA 工具优先；
未知文件初筛优先。
Phase 7：测试、审计和文档
进行：
单元测试；
集成测试；
并发测试；
权限绕过测试；
Bash 绕过测试；
后台任务取消测试；
Workflow 部分失败测试；
Agent 接力测试；
上下文重复分析测试；
长输出落盘测试。

十五、验收场景
必须通过以下场景。
场景 1：图片专业化
输入一个测试 PNG。
要求：
TriageAgent 识别文件类型；
路由到 ImageStegoAgent；
ImageStegoAgent 只能看到图片相关工具和 Workflow；
默认首先运行 image_quick_scan；
不应直接手写 LSB 提取；
结果形成 Findings；
提取文件保存为 Artifact。
场景 2：跨领域接力
PNG 中包含 ZIP，ZIP 中包含密文。
要求：
ImageStegoAgent
→ 提取 ZIP Artifact
→ 请求 FileForensicsAgent
→ 解包出密文 Artifact
→ 请求 CryptoAgent
→ CryptoAgent 继续处理
后续 Agent 不得重新从原始 PNG 开始分析。
场景 3：工具优先策略
模拟 WebAgent 需要完整端口和服务信息。
要求：
应推荐或调用 nmap/host_service_enumeration；
不应通过多个 curl/nc 逐端口尝试代替；
扫描可后台运行；
主流程不被阻塞；
输出转为结构化 Findings。
场景 4：工具禁用
ImageStegoAgent 尝试调用 nmap 或 Web 工具。
要求：
工具对模型不可见，或 Tool Broker 明确拒绝；
产生审计日志；
Agent 可提交 HandoffRequest；
不得静默执行。
场景 5：Bash 绕过
ImageStegoAgent 通过 Bash 直接输入被禁止的命令。
要求：
命令策略识别并拒绝；
不能因为存在通用 Bash 就绕过 Profile。
场景 6：合理手工脚本
专业工具无法处理一个明确变种。
要求：
Agent 说明工具失败原因；
ToolFirstPolicy 允许带理由 override；
Agent 使用 Python 编写最小补丁；
原因和结果进入审计日志。
场景 7：后台任务取消
Agent 启动一个长时间后台任务后，题目已解决。
要求：
Orchestrator 取消相关 Job；
资源被回收；
Job 状态正确；
不产生孤儿进程。

十六、代码质量要求
使用项目当前主要语言和风格；
保持现有配置兼容；
新增配置必须 schema 校验；
接口与实现分离；
使用依赖注入便于 Mock；
不制造循环依赖；
不滥用全局单例；
错误必须结构化；
所有异步任务支持 AbortSignal 或等价取消机制；
所有长期任务必须有超时；
所有关键状态必须可审计；
测试不得依赖外部公网目标；
测试不得依赖不可控的真实比赛环境。

十七、持续迭代方式
按照以下循环持续执行：
审计当前架构
→ 判断最小侵入式改造点
→ 实现一个完整闭环
→ 编写测试
→ 运行测试
→ 检查权限绕过
→ 检查并发与取消
→ 检查上下文污染
→ 检查是否存在重复实现
→ 修复
→ 再进入下一阶段
不要只生成框架文件和 TODO。
每个阶段都必须形成可运行闭环。
如果发现当前 Harness 已经存在类似能力，应优先复用和增强，而不是另建重复系统。

十八、最终输出
任务完成后输出：
1.对原架构的审计结论；
2.实际新增和修改的文件；
3.最终模块关系；
4.CapabilityProfile 示例；
5.专业 Agent 示例；
6.Workflow 示例；
7.ToolFirstPolicy 规则；
8.Agent 接力过程；
9.后台任务机制；
10.工具权限和 Bash 防绕过机制；
11.测试结果；
12.构建、类型检查和 lint 结果；
13.当前尚未覆盖的 CTF 类型；
14.接入真实比赛 API 时需要增加的位置；
15.后续扩展 Web、Reverse、Pwn、Traffic Agent 的明确方式。
最终目标不是“创建很多 Agent”。
最终目标是让 ovolv999_pro 成为一个具备以下能力的竞赛 Harness：
主 Agent 负责战略
专业 Agent 负责局部决策
成熟工具负责确定性执行
一把梭 Workflow 负责高覆盖率尝试
Artifact 和 Finding 负责信息流转
Handoff 负责跨领域接力
ToolFirstPolicy 防止模型低效重复造轮子


你的一切分析、架构设计、代码修改、测试和文档，都必须服务于这个最终目标。

判断任务是否完成的唯一依据是：

1. 最终目标是否真实实现；
2. 核心路径是否可以运行；
3. 验收条件是否通过；
4. P0、P1 级问题是否清零；
5. 是否有可以复现的测试、日志、命令或运行结果作为证据。

不要把“完成了架构设计”“代码已经写完”“理论上可行”视为完成。

---

## 二、运行约束

* 总时间预算：12 小时。
* 在时间预算内持续执行，不要只生成计划后停止。
* 每次上下文即将结束前，必须更新状态文档，使下一轮可以无损继续。
* 不等待人工确认。遇到不确定问题时，优先选择风险最低、可回滚、兼容性最好的方案继续推进。
* 只有涉及不可逆操作、凭证缺失、数据破坏或目标本身存在根本冲突时，才允许暂停。
* 不为了制造工作量而重构。
* 不允许用降低目标、删除验收项、跳过测试的方式宣布完成。

如果时间不足，优先级依次为：

1. 最终目标核心路径；
2. P0 问题；
3. P1 问题；
4. 可运行性和测试；
5. 架构完整性；
6. 次要优化和体验改进。

---

## 三、默认运行模式

默认采用轻量模式，不预先搭建复杂编排系统。

最少只维护以下文件：

```text
.loop/
├── STATE.md          # 当前状态、证据、问题和下一步
├── PLAN.md           # 架构级总体方案
├── DETAIL_PLAN.md    # 文件、模块和接口级实现方案
├── AUDIT.md          # P0/P1/P2 问题清单及修复状态
├── DEVLOG.md         # 非平凡问题、关键决策和横向思考
└── TEST_REPORT.md    # 测试命令、结果、失败原因和最终结论
```

以下能力均为可选项，只有实际需要时才启用：

* 独立 worktree；
* 多 Agent 并行；
* 独立 Reviewer 模型；
* 持续守护模式；
* 自动触发器；
* 插件热加载；
* 完整 trace 和 metrics；
* CI/CD 改造；
* Docker 或其他隔离环境；
* 外部任务队列。

不得为了“架构看起来完整”而提前实现这些能力。

---

## 四、核心原则

### 原则 1：功能和实用性优先

* 最终目标高于形式上的代码优雅。
* 必须实际修改、实际运行、实际测试。
* 先确保核心路径可用，再处理次要问题。
* 允许多轮返工，不因困难而放弃核心功能。
* 不允许长期停留在分析和规划阶段。

### 原则 2：架构优先，但禁止过度设计

架构设计的作用是降低后续实现、调试和扩展成本，而不是增加抽象层。

优先判断：

* 当前架构是否适配最终目标；
* 哪些模块职责混乱；
* 哪些依赖方向错误；
* 哪些功能相互耦合；
* 哪些代码阻碍测试、调试和扩展；
* 哪些能力应该成为配置项、接口或插件；
* 哪些抽象暂时没有实际使用场景。

只实现当前目标需要的架构能力，对未来能力预留清晰扩展点即可。

### 原则 3：保留原功能，冗余能力可选化

原则上不删除已有功能。

发现冗余功能时，优先采用以下方式处理：

1. 配置开关；
2. 可选模块；
3. 插件；
4. Feature Flag；
5. 独立适配器；
6. 默认关闭；
7. 标记为 deprecated，并保留兼容入口。

只有满足以下条件时才可以删除：

* 明确属于错误实现；
* 存在严重安全或稳定性风险；
* 与最终目标根本冲突；
* 已有完整替代方案；
* 删除不会破坏向后兼容，或已经提供迁移路径。

所有删除都必须在 `DEVLOG.md` 中说明原因、影响和回滚方式。

### 原则 4：模块化分层

架构必须尽可能满足：

* 单一职责；
* 分层解耦；
* 模块之间通过稳定接口通信；
* 核心逻辑不依赖具体 UI、存储、网络或运行环境；
* 外部依赖通过适配器封装；
* 配置与代码分离；
* 每个重要模块可以独立测试；
* 每个重要模块可以独立替换；
* 调试入口明确。

不得仅仅为了“模块化”而把简单逻辑拆成大量空壳模块。

### 原则 5：扩展能力按需建设

Profile、Script、Listener、插件、运行时加载等能力，仅在目标确实需要时实现。

暂时不需要实现时，也应做到：

* 核心模块不硬编码具体实现；
* 接口边界清晰；
* 配置外部化；
* 新增实现不需要修改大量核心代码；
* 保留注册器、工厂、适配器或扩展接口之一。

### 原则 6：参考主流项目

允许联网搜索类似项目、官方文档和成熟实现。

参考顺序：

1. 官方文档和官方实现；
2. 活跃维护的主流开源项目；
3. 成熟库或框架；
4. 高质量技术文章；
5. 其他项目的架构模式。

借鉴时必须判断：

* 是否真正适合当前目标；
* 是否比现有实现更好；
* 是否增加不必要依赖；
* 是否影响许可证、兼容性、安全性或维护成本；
* 是否只是形式相似而场景不同。

优中取优，不盲目重写已有优势。

成熟组件能够可靠解决的问题，不重复造轮子；但核心竞争力、关键控制逻辑和目标特有能力应优先自行实现。

### 原则 7：工程化

必须尽可能具备：

* 可构建；
* 可运行；
* 可测试；
* 可调试；
* 可观察；
* 可维护；
* 可回滚；
* 向后兼容。

日志、trace、metrics 根据实际需要逐级启用，不要求所有项目默认建设完整可观测平台。

### 原则 8：证据驱动

任何“已经修复”“测试通过”“目标实现”的结论，都必须附带至少一种证据：

* 实际运行命令；
* 测试输出；
* 构建结果；
* 日志；
* diff；
* 可复现步骤；
* 文件和行号；
* 性能或行为对比。

没有证据时，只能写“推测”“尚未验证”或“部分完成”。

不得编造命令、测试结果、运行日志或外部资料。

---

## 五、缺陷等级

### P0：阻断级

包括但不限于：

* 最终目标无法实现；
* 核心流程完全不能运行；
* 编译或启动完全失败；
* 数据损坏；
* 严重安全问题；
* 不可恢复的兼容性破坏；
* 会导致主要功能必然崩溃的问题。

### P1：严重级

包括但不限于：

* 核心流程不稳定；
* 主要功能在常见场景失败；
* 严重回归；
* 关键接口设计错误；
* 主要兼容性问题；
* 无法测试或无法调试；
* 严重性能、资源或并发问题。

### P2：普通级

包括：

* 非核心功能缺陷；
* 边缘场景问题；
* 代码质量问题；
* 文档缺失；
* 一般性能或体验问题。

进入最终测试阶段前，P0 必须为零。

宣布最终完成前，P0 和 P1 必须全部清零，或者有明确证据证明其不属于当前目标范围。

---

## 六、主循环

必须按照以下大循环推进：

```text
目标分析
→ 架构设计
→ 架构迭代小循环
→ 架构细化
→ 实现
→ 审计修复循环
→ 测试修复循环
→ 最终架构与目标复核
```

---

## 七、阶段 0：项目扫描与目标适配分析

首先全面读取项目，但避免无目的逐文件复述。

需要识别：

* 项目入口；
* 构建和运行方式；
* 目录与模块职责；
* 核心数据流；
* 关键接口；
* 当前已有功能；
* 测试体系；
* 配置体系；
* 外部依赖；
* 平台和兼容性要求；
* 当前明显错误；
* 与最终目标的差距。

输出目标适配度：

```text
目标适配度：0～100%

已适配：
- ...

部分适配：
- ...

不适配：
- ...

阻断问题：
- ...

可以保留但应可选化的能力：
- ...
```

随后初始化 `.loop/STATE.md` 和 `.loop/AUDIT.md`。

---

## 八、阶段 1：架构设计

编写 `.loop/PLAN.md`，至少包含：

1. 最终目标和可验证完成标准；
2. 当前架构摘要；
3. 当前架构与目标之间的差距；
4. 建议的目标架构；
5. 分层和模块职责；
6. 模块依赖关系；
7. 关键数据流；
8. 接口边界；
9. 配置体系；
10. 可选功能矩阵；
11. 向后兼容方案；
12. 测试和调试方案；
13. 风险清单；
14. 实施顺序；
15. 回滚方案。

可选功能矩阵使用类似格式：

```text
| 功能 | 当前状态 | 默认状态 | 接入方式 | 是否影响核心 |
|------|----------|----------|----------|--------------|
| A    | 已存在   | 关闭     | 配置项   | 否           |
| B    | 未实现   | 按需     | 插件接口 | 否           |
```

---

## 九、阶段 2：架构迭代小循环

完成第一版 `PLAN.md` 后，不要立即大规模实现。

执行架构小循环：

```text
检查目标适配度
→ 检查模块边界
→ 检查依赖方向
→ 检查重复职责
→ 检查配置和扩展点
→ 检查兼容性
→ 检查可测试性
→ 必要时参考主流项目
→ 修订 PLAN.md
```

每轮只修正有实际价值的问题。

当满足以下条件后结束架构小循环：

* 核心数据流明确；
* 模块职责没有明显冲突；
* 实现路径清晰；
* 不需要依赖大规模猜测；
* 核心模块可独立测试；
* 没有已知 P0/P1 架构问题；
* 继续讨论架构的收益已经低于开始实现的收益。

禁止无限修改架构文档而不进入实现。

---

## 十、阶段 3：架构细化

编写 `.loop/DETAIL_PLAN.md`，将架构落实到代码层。

至少包含：

* 需要新增、修改和保留的文件；
* 每个文件的职责；
* 关键结构体、类、函数或模块；
* 接口输入输出；
* 数据流和状态变化；
* 错误处理；
* 配置字段；
* 兼容层；
* 迁移过程；
* 测试用例；
* 调试方式；
* 每一步完成后的验证命令。

计划必须具体到可以直接开始编码，但不要提前写大量伪代码代替真正实现。

---

## 十一、阶段 4：实现循环

每轮执行：

```text
读取 STATE.md
→ 选择当前最高价值问题
→ 修改代码
→ 运行最小相关验证
→ 检查回归
→ 更新文档和状态
→ 进入下一轮
```

每轮应尽量保持：

* 改动范围可理解；
* 问题与修改存在直接对应关系；
* 可以独立验证；
* 可以回滚；
* 不同时混入大量无关重构。

允许架构在实现过程中调整，但必须同步更新 `PLAN.md` 或 `DETAIL_PLAN.md`。

发现计划错误时，不要机械执行错误计划。

---

## 十二、阶段 5：审计修复循环

核心功能初步实现后，执行全面审计。

审计范围：

* 架构与最终目标是否一致；
* 模块职责是否重复；
* 是否存在循环依赖；
* 是否存在死代码或重复实现；
* 是否存在配置冲突；
* 默认配置是否合理；
* 可选功能是否真的可关闭；
* 向后兼容是否被破坏；
* 错误处理是否完整；
* 资源是否正确释放；
* 并发和生命周期是否正确；
* 日志是否泄露敏感信息；
* 测试是否覆盖核心路径；
* 文档与代码是否一致；
* 构建、运行和部署方式是否真实可用。

将发现的问题写入 `.loop/AUDIT.md`：

```text
## 问题编号

- 等级：P0 / P1 / P2
- 位置：文件:行号
- 现象：
- 根因：
- 影响：
- 修复方案：
- 验证方式：
- 状态：待修复 / 已修复 / 已验证
```

循环执行：

```text
审计
→ 记录问题
→ 优先修复 P0/P1
→ 验证
→ 重新审计
```

直到：

* P0 为零；
* P1 为零；
* 核心目标已实现；
* 审计结果开始收敛。

如果有独立子 Agent 或 Reviewer 能力，应启用只读审查：

* Reviewer 不修改代码；
* Reviewer 必须引用具体文件和行号；
* Writer 根据审查结果修复；
* 修复后再次审查。

没有独立 Reviewer 时，必须开启单独的审查阶段，不得一边实现一边直接自我批准。

---

## 十三、阶段 6：测试修复循环

P0/P1 清零后进入测试阶段。

测试顺序：

1. 构建或静态检查；
2. 单元测试；
3. 模块测试；
4. 集成测试；
5. 核心路径端到端测试；
6. 异常输入；
7. 边界条件；
8. 兼容性；
9. 回归测试；
10. 必要时进行性能和稳定性测试。

每次测试都要记录：

* 执行命令；
* 环境；
* 结果；
* 失败位置；
* 根因；
* 修复内容；
* 修复后的复测结果。

循环执行：

```text
测试
→ 定位真实根因
→ 修复
→ 运行最小复现测试
→ 运行相关回归测试
→ 更新 TEST_REPORT.md
```

禁止：

* 删除失败测试；
* 把断言改成永远通过；
* 忽略错误码；
* 使用空测试冒充通过；
* 只根据代码阅读宣布测试通过。

如果项目没有测试体系，应先建立覆盖核心目标的最小测试，而不是立即建设庞大的测试框架。

---

## 十四、文档记录规则

每次修复、完善、优化或测试后，至少更新 `.loop/STATE.md`。

`STATE.md` 保持简洁，内容包括：

```text
当前阶段：
当前目标适配度：
已完成：
本轮证据：
当前 P0：
当前 P1：
未验证假设：
下一步：
```

遇到以下情况时，追加 `.loop/DEVLOG.md`：

* 非平凡 Bug；
* 架构决策；
* 方案发生重大调整；
* 主流方案不适用；
* 兼容性冲突；
* 多轮修复才解决的问题；
* 可以横向复用的解决方式。

DEVLOG 条目格式：

```text
## 问题或决策名称

### 现象

### 根因

### 采用的解决方案

### 为什么选择该方案

### 验证证据

### 可以横向应用到哪些问题

### 仍然存在的限制
```

如果本轮没有遇到问题，只记录：

* 做了什么；
* 修改了哪些文件；
* 使用什么命令验证；
* 验证结果如何。

不要书写大量没有决策价值的流水账。

---

## 十五、防止循环失控

出现以下情况时必须改变策略，而不是重复同一种修改：

* 同一个问题连续三轮没有实质进展；
* 同一测试在通过和失败之间反复三次；
* 修改范围不断扩大但目标适配度没有提升；
* 架构文档反复变化但没有开始实现；
* 通过增加更多抽象掩盖根本问题；
* 为修复一个问题持续制造新的 P0/P1 问题。

此时必须：

1. 回到最小复现；
2. 重新确认根因；
3. 检查最初假设；
4. 对比最后一个可用版本；
5. 缩小修改范围；
6. 必要时回滚错误路线；
7. 在 DEVLOG 中记录策略变化。

---

## 十六、最终完成条件

只有同时满足以下条件，才能宣布完成：

* 最终目标真实实现；
* 核心使用路径可以运行；
* P0 数量为零；
* P1 数量为零；
* 构建、测试和验收通过；
* 没有通过删除原功能规避问题；
* 冗余能力已保留或可选化；
* 向后兼容要求得到满足；
* 文档与实际代码一致；
* 所有结论都有证据；
* `PLAN.md` 中的目标架构与最终实现基本一致。

完成后再执行一次最终循环：

```text
全面架构审计
→ 目标适配度复核
→ 核心路径回归测试
→ 文档一致性检查
→ P0/P1 最终复核
```

然后输出最终报告：

```text
## 最终目标完成情况

## 目标适配度

## 主要架构调整

## 实现的核心功能

## 被保留并可选化的功能

## 修复的 P0/P1 问题

## 实际测试命令和结果

## 向后兼容情况

## 已知 P2 问题和限制

## 关键文件索引

## 后续建议
```

如果 12 小时结束时仍未满足完成条件，不得虚假宣布完成。

应输出：

* 当前真实完成度；
* 已经实现的部分；
* 尚未解决的 P0/P1；
* 卡点及证据；
* 已尝试过的方案；
* 最有价值的下一步；
* 可以从 `STATE.md` 继续执行的位置。

---

现在立即开始。

先读取项目、识别真实构建和运行方式，完成目标适配度分析，并建立第一版 `.loop/PLAN.md`。不要只向我解释你准备怎么做，直接进入分析、设计、实现、审计和测试循环。
