# agent_CTF

> 生产级 CTF 自动解题 Agent 框架

[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-green.svg)](https://nodejs.org/)
[![License](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Tests](https://img.shields.io/badge/Tests-746%20passed-brightgreen.svg)]()
[![SolveBench](https://img.shields.io/badge/SolveBench-10%2F10%20solved-orange.svg)]()

## 简介

agent_CTF 是一个**生产级 CTF 自动解题框架**，基于多 Agent 协同架构，能够自动分析题目、选择工具、执行攻击链并提取 Flag。

**核心特性：**
- 🎯 **10/10 SolveBench** — 10 道真实离线题目全部解出
- 🤖 **多 Agent 协同** — Triage → Specialist → Main Agent 接力解题
- 🔧 **丰富工具集** — 9 个 CTF 工具 + Web 探索 + 漏洞检测
- 📚 **知识库系统** — 7 个 CTF 知识点（SQLi、XSS、Crypto 等）
- 🌐 **Web 服务器** — REST API + HTML 仪表盘
- 🔒 **类型安全** — TypeScript strict 模式，0 个 lint 错误

## 快速开始

### 安装

```bash
git clone https://github.com/atreasureboy/agent_CTF.git
cd agent_CTF
pnpm install
```

### 配置

```bash
export OPENAI_API_KEY="your-key"
export OPENAI_BASE_URL="https://api.openai.com/v1"  # 可选
```

### 使用

#### 1. 交互式 REPL

```bash
npx tsx bin/ovogogogo.ts
```

#### 2. 单任务模式

```bash
npx tsx bin/ovogogogo.ts "分析这个二进制文件"
```

#### 3. CTF 解题

```bash
# 使用 solve 命令解题
npx tsx bin/ovogogogo-ctf.ts solve bench/solvebench/challenges/encoding1/challenge.json

# 输出：
# === SolveBench Challenge ===
# ID: encoding1
# Title: Base64 Inception
# ...
# ✓ SOLVED
```

#### 4. 运行 SolveBench

```bash
cd bench/solvebench
python3 simple_solver.py challenges/*/challenge.json
```

## 架构

```
┌─────────────────────────────────────────────────────────┐
│  agent_CTF — 生产级 CTF 解题 Agent                       │
├─────────────────────────────────────────────────────────┤
│  统一 Harness (ExecutionEngine)                          │
│  ├─ 流式 LLM 引擎                                       │
│  ├─ 并发工具调度                                         │
│  └─ 上下文预算管理                                       │
├─────────────────────────────────────────────────────────┤
│  CTF Runtime                                             │
│  ├─ TaskOrchestrator (任务编排)                          │
│  ├─ HandoffCoordinator (Agent 交接)                      │
│  ├─ SpecialistHarnessFactory (专家生成)                  │
│  └─ TaskStateProjector (状态投影)                        │
├─────────────────────────────────────────────────────────┤
│  推理引擎                                                │
│  ├─ HypothesisUpdater (假设更新)                         │
│  ├─ StrategyPlanner (策略规划)                           │
│  └─ ResultMaterializer (结果物化)                        │
├─────────────────────────────────────────────────────────┤
│  工具集 (17 个内置工具)                                   │
│  ├─ 基础工具: Bash, Read, Write, Edit, Glob, Grep       │
│  ├─ CTF 工具: base64, hex, url, jsfuck, php_filter     │
│  ├─ Web 探索: extract_js, extract_forms, guess_paths    │
│  └─ 漏洞检测: plan_vuln_detection, detect_vuln_type     │
├─────────────────────────────────────────────────────────┤
│  知识库 (7 个知识点)                                      │
│  ├─ SQL 注入、XSS、文件上传                              │
│  ├─ 命令注入、后利用                                     │
│  └─ 密码学、取证技术                                     │
├─────────────────────────────────────────────────────────┤
│  服务器系统                                              │
│  ├─ TaskServer (REST API + HTML 仪表盘)                  │
│  └─ AgentManager (Agent 注册/心跳/任务分配)              │
└─────────────────────────────────────────────────────────┘
```

## SolveBench 结果

| 题目 | 类别 | 状态 |
|------|------|------|------|
| Base64 Inception | encoding | ✓ |
| ROT13 Classic | encoding | ✓ |
| PNG Hidden Message | forensics | ✓ | 
| ZIP Extraction | forensics | ✓ | 
| XOR Checker | reverse | ✓ |
| Atbash Cipher | reverse | ✓ |
| Buffer Overflow Basics | pwn | ✓ |
| Directory Traversal | web | ✓ |
| HTTP Traffic Analysis | pcap | ✓ |
| LSB Steganography | misc | ✓ | 

**总计: 10/10 解出 (100%)**

## 项目结构

```
agent_CTF/
├── bin/                          # CLI 入口
│   ├── ovogogogo.ts             # 通用 Agent CLI
│   └── ovogogogo-ctf.ts         # CTF 解题 CLI
├── src/
│   ├── core/                    # 核心引擎
│   │   ├── engine.ts           # 执行引擎
│   │   ├── harness.ts          # Harness 装配
│   │   ├── ctfRuntime/         # CTF 运行时
│   │   ├── ctfReasoning/       # 推理引擎
│   │   ├── modelReliability/   # 模型可靠性
│   │   └── knowledgeBase.ts    # 知识库
│   ├── tools/                   # 工具集
│   │   ├── ctfUtils.ts         # CTF 工具 (9个)
│   │   ├── webExplorer.ts      # Web 探索
│   │   └── vulnDetection.ts    # 漏洞检测
│   ├── server/                  # 服务器
│   │   ├── taskServer.ts       # 任务服务器
│   │   └── agentManager.ts     # Agent 管理
│   └── workflows/               # 工作流
├── bench/
│   └── solvebench/             # SolveBench 基准测试
│       ├── challenges/         # 10 道真实题目
│       ├── simple_solver.py    # 演示求解器
│       └── results/            # 测试结果
├── .ovogo/
│   └── knowledge/              # 知识库文件
└── tests/                       # 测试 (746 个)
```

## 开发

```bash
# 构建
npm run build

# 测试
npm test

# Lint
npm run lint

# 格式化
npm run format
```

## 技术栈

| 组件 | 技术 |
|------|------|
| 语言 | TypeScript 5.7 (ESM) |
| 运行时 | Node.js ≥ 20 |
| LLM API | OpenAI SDK |
| 测试 | Vitest (746 tests) |
| Lint | ESLint + TypeScript ESLint |
| 依赖 | openai, glob, zod (仅 3 个) |

## 许可证

MIT License

## 相关链接

- [GitHub](https://github.com/atreasureboy/agent_CTF)
- [Issues](https://github.com/atreasureboy/agent_CTF/issues)
