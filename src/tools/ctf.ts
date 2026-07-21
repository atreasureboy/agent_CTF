/**
 * CTF Tools — wrappers around external binaries (zsteg, binwalk, exiftool,
 * pngcheck, identify, steghide, nmap, RsaCtfTool).
 *
 * Every tool follows the same pattern:
 *   1. Check binary availability (`which`).
 *   2. Execute via BashTool-equivalent logic (spawn/exec with signal support).
 *   3. Convert long output to Artifact (the Broker does this automatically for
 *      `outputMode: 'artifact'`).
 *
 * Tools register with requiredBinaries so the Workflow / ToolRegistry can
 * fail fast with a structured "unavailable" message when binaries are missing.
 */

import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { promisify } from 'util'

import type { Tool, ToolContext, ToolDefinition, ToolResult } from '../core/types.js'
import { TOOL_METADATA } from '../core/toolMetadata.js'

const execAsync = promisify(spawn)

interface BinaryToolOptions {
  name: string
  description: string
  binary: string
  requiredBinaries: string[]
  domains: ('image' | 'crypto' | 'forensics' | 'network' | 'reverse' | 'pwn' | 'web')[]
  riskLevel?: 'low' | 'medium' | 'high'
  /** Build the bash command line from tool input. */
  buildCommand: (input: Record<string, unknown>) => string
  /** Convert raw output (stdout) into the tool result content. */
  formatOutput?: (stdout: string, stderr: string) => string
}

function which(bin: string, envPath: string = process.env.PATH ?? ''): string | null {
  const dirs = envPath.split(/[:;]+/).filter(Boolean)
  for (const dir of dirs) {
    if (existsSync(join(dir, bin))) return join(dir, bin)
  }
  // Common fallback locations (Windows / Mac / WSL)
  for (const dir of ['/usr/local/bin', '/usr/bin', '/opt/homebrew/bin', 'C:\\Program Files\\Git\\usr\\bin']) {
    if (existsSync(join(dir, bin))) return join(dir, bin)
  }
  return null
}

/**
 * Generic shell wrapper tool — invokes a binary with a deterministic command
 * shape and surfaces availability, output, and timeout uniformly.
 */
class BinaryTool implements Tool {
  readonly name: string
  readonly definition: ToolDefinition
  readonly concurrencySafe: boolean = true

  constructor(private readonly opts: BinaryToolOptions) {
    this.name = opts.name
    this.definition = {
      type: 'function',
      function: {
        name: opts.name,
        description: opts.description,
        parameters: {
          type: 'object',
          properties: {
            command: {
              type: 'string',
              description: `Optional raw command to append after \`${opts.binary}\`.`,
            },
            target: { type: 'string', description: 'Target file / host / value (the primary input).' },
            args: { type: 'array', items: { type: 'string' }, description: 'Additional raw CLI args.' },
            timeout: { type: 'number', description: 'Timeout in milliseconds (default 60 000).' },
          },
        },
      },
    }
    TOOL_METADATA[opts.name] = {
      domains: ['forensics', ...opts.domains],
      executionMode: 'foreground',
      costClass: 'medium',
      outputMode: 'artifact',
      riskLevel: opts.riskLevel ?? 'low',
      requiredBinaries: opts.requiredBinaries,
    }
  }

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const missing = this.opts.requiredBinaries
      .map((b) => ({ bin: b, path: which(b) }))
      .filter((x) => x.path === null)
    if (missing.length > 0) {
      return {
        isError: false,
        content: `[${this.name}] unavailable: missing binaries on PATH: ${missing.map((m) => m.bin).join(', ')}`,
      }
    }

    let cmd = this.opts.buildCommand(input)
    const userCmd = typeof input.command === 'string' ? input.command : null
    if (userCmd) cmd = `${cmd} ${userCmd}`
    const extraArgs = Array.isArray(input.args) ? input.args.filter((v): v is string => typeof v === 'string') : []
    if (extraArgs.length > 0) cmd = `${cmd} ${extraArgs.join(' ')}`

    const timeoutMs = typeof input.timeout === 'number' ? Math.max(1000, input.timeout) : 60_000

    return await new Promise<ToolResult>((resolve) => {
      let settled = false
      const proc = spawn(cmd, { shell: '/bin/bash', cwd: context.cwd, env: process.env, signal: context.signal })
      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        try { proc.kill('SIGTERM') } catch { /* best-effort */ }
        resolve({ content: `${this.name} timed out after ${timeoutMs}ms. First 1KB:\n${stdout.slice(0, 1024)}\n[stderr]\n${stderr.slice(0, 512)}`, isError: true })
      }, timeoutMs)
      proc.stdout.on('data', (chunk) => { stdout += chunk.toString() })
      proc.stderr.on('data', (chunk) => { stderr += chunk.toString() })
      proc.on('error', (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ content: `${this.name} failed: ${err.message}`, isError: true })
      })
      proc.on('close', (code) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        const formatted = this.opts.formatOutput
          ? this.opts.formatOutput(stdout, stderr)
          : (stdout + (stderr ? `\n[stderr]\n${stderr}` : '')).trim() || '(no output)'
        const isError = code !== 0 && !stdout
        resolve({ content: formatted + (code !== 0 ? `\n[exit ${code}]` : ''), isError })
      })
      if (context.signal) {
        context.signal.addEventListener('abort', () => {
          if (settled) return
          settled = true
          try { proc.kill('SIGTERM') } catch { /* best-effort */ }
          resolve({ content: `${this.name} cancelled.`, isError: true })
        }, { once: true })
      }
    })
  }
}

// ─── Image / Stego ──────────────────────────────────────────────────────

export function createCTFTools(): Tool[] {
  const tools: Tool[] = []

  tools.push(new BinaryTool({
    name: 'zsteg',
    description: 'PNG/BMP 隐写扫描(zsteg)。建议先用 image_quick_scan 工作流。',
    binary: 'zsteg',
    requiredBinaries: ['zsteg'],
    domains: ['image'],
    buildCommand: (input) => {
      const target = typeof input.target === 'string' ? input.target : ''
      return `zsteg -a ${JSON.stringify(target)}`
    },
  }))

  tools.push(new BinaryTool({
    name: 'binwalk',
    description: 'binwalk 文件嵌套/嵌入扫描,支持 -e 自动解包。',
    binary: 'binwalk',
    requiredBinaries: ['binwalk'],
    domains: ['forensics'],
    buildCommand: (input) => {
      const target = typeof input.target === 'string' ? input.target : ''
      const extract = typeof input.command === 'string' && input.command.includes('-e') ? '' : '-e'
      return `binwalk ${extract} ${JSON.stringify(target)}`.trim()
    },
  }))

  tools.push(new BinaryTool({
    name: 'exiftool',
    description: '读取文件 metadata;优先于 strings 猜测。',
    binary: 'exiftool',
    requiredBinaries: ['exiftool'],
    domains: ['forensics'],
    buildCommand: (input) => {
      const target = typeof input.target === 'string' ? input.target : ''
      return `exiftool ${JSON.stringify(target)}`
    },
  }))

  tools.push(new BinaryTool({
    name: 'pngcheck',
    description: 'PNG 结构完整性检查(pngcheck -v)。',
    binary: 'pngcheck',
    requiredBinaries: ['pngcheck'],
    domains: ['image'],
    buildCommand: (input) => {
      const target = typeof input.target === 'string' ? input.target : ''
      return `pngcheck -v ${JSON.stringify(target)}`
    },
  }))

  tools.push(new BinaryTool({
    name: 'identify',
    description: 'ImageMagick identify 读取图片基本信息。',
    binary: 'identify',
    requiredBinaries: ['identify'],
    domains: ['image'],
    buildCommand: (input) => {
      const target = typeof input.target === 'string' ? input.target : ''
      return `identify -verbose ${JSON.stringify(target)}`
    },
  }))

  tools.push(new BinaryTool({
    name: 'steghide',
    description: 'steghide 隐写提取(需要 passphrase)。',
    binary: 'steghide',
    requiredBinaries: ['steghide'],
    domains: ['image'],
    riskLevel: 'medium',
    buildCommand: (input) => {
      const target = typeof input.target === 'string' ? input.target : ''
      const passphrase = typeof input.passphrase === 'string' ? input.passphrase : ''
      return `steghide extract -sf ${JSON.stringify(target)} -p ${JSON.stringify(passphrase)} -xf ./extracted.bin`
    },
    formatOutput: (stdout) => `extracted to ./extracted.bin\n${stdout}`,
  }))

  // ─── Crypto / Crypto tools ────────────────────────────────────────────

  tools.push(new BinaryTool({
    name: 'rsactftool',
    description: 'RsaCtfTool 公共 RSA 攻击(因子库 / Fermat / Wiener / ...)。',
    binary: 'RsaCtfTool',
    requiredBinaries: ['RsaCtfTool', 'openssl'],
    domains: ['crypto'],
    riskLevel: 'medium',
    buildCommand: (input) => {
      const n = String(input.n ?? '')
      const e = String(input.e ?? '')
      const c = String(input.c ?? '')
      return `RsaCtfTool -n ${n} -e ${e} --uncipherfile <(printf %s "${c}") --attack all 2>&1 | head -n 60 || true`
    },
  }))

  tools.push(new BinaryTool({
    name: 'yafu',
    description: 'yafu 大整数分解 — RSA 因子基础工具。',
    binary: 'yafu',
    requiredBinaries: ['yafu'],
    domains: ['crypto'],
    buildCommand: (input) => {
      const n = String(input.n ?? '')
      return `echo "factor(${n})" | yafu 2>&1 | head -n 40 || true`
    },
  }))

  tools.push(new BinaryTool({
    name: 'openssl-rsa',
    description: 'openssl RSA 解密/签验;若私钥可用,直接 decrypt。',
    binary: 'openssl',
    requiredBinaries: ['openssl'],
    domains: ['crypto'],
    buildCommand: (input) => {
      const c = String(input.c ?? '')
      const keyPath = String(input.privateKey ?? '')
      return `printf %s "${c}" | openssl rsautl -decrypt -inkey ${JSON.stringify(keyPath)} 2>&1 || true`
    },
  }))

  // ─── Network (Web) tools ──────────────────────────────────────────────

  tools.push(new BinaryTool({
    name: 'nmap',
    description: 'nmap 端口/服务扫描(可用 --top-ports / -sV 等)。建议入后台任务。',
    binary: 'nmap',
    requiredBinaries: ['nmap'],
    domains: ['network', 'web'],
    riskLevel: 'medium',
    buildCommand: (input) => {
      const target = typeof input.target === 'string' ? input.target : ''
      const flags = typeof input.flags === 'string' ? input.flags : '-sV --top-ports 1000'
      return `nmap ${flags} ${JSON.stringify(target)}`
    },
  }))

  tools.push(new BinaryTool({
    name: 'nikto',
    description: 'nikto Web 漏洞扫描。',
    binary: 'nikto',
    requiredBinaries: ['nikto', 'perl'],
    domains: ['web'],
    riskLevel: 'medium',
    buildCommand: (input) => {
      const target = typeof input.target === 'string' ? input.target : ''
      return `nikto -h ${JSON.stringify(target)} -Tuning 123bde 2>&1 | head -n 200`
    },
  }))

  tools.push(new BinaryTool({
    name: 'sqlmap',
    description: 'sqlmap SQL 注入扫描。',
    binary: 'sqlmap',
    requiredBinaries: ['sqlmap', 'python3'],
    domains: ['web'],
    riskLevel: 'high',
    buildCommand: (input) => {
      const target = typeof input.target === 'string' ? input.target : ''
      return `sqlmap -u ${JSON.stringify(target)} --batch --level 2 --risk 1 2>&1 | head -n 100`
    },
  }))

  // ─── Reverse Engineering tools ─────────────────────────────────────────

  tools.push(new BinaryTool({
    name: 'gdb',
    description: 'gdb 调试器 — 断点/寄存器/内存读写。建议 -batch -ex 模式。',
    binary: 'gdb',
    requiredBinaries: ['gdb'],
    domains: ['reverse', 'pwn'],
    riskLevel: 'medium',
    buildCommand: (input) => {
      const target = typeof input.target === 'string' ? input.target : ''
      const script = typeof input.command === 'string' ? input.command : 'info functions'
      return `gdb -batch -ex ${JSON.stringify(script)} ${JSON.stringify(target)} 2>&1 | head -n 200`
    },
  }))

  tools.push(new BinaryTool({
    name: 'objdump',
    description: 'objdump 反汇编 — 用于静态分析函数入口/段表。',
    binary: 'objdump',
    requiredBinaries: ['objdump'],
    domains: ['reverse'],
    buildCommand: (input) => {
      const target = typeof input.target === 'string' ? input.target : ''
      const flags = typeof input.command === 'string' ? input.command : '-d -M intel'
      return `objdump ${flags} ${JSON.stringify(target)} 2>&1 | head -n 300`
    },
  }))

  tools.push(new BinaryTool({
    name: 'strings',
    description: 'strings 提取可读字符串 — CTF 速查。',
    binary: 'strings',
    requiredBinaries: ['strings'],
    domains: ['reverse', 'forensics'],
    buildCommand: (input) => {
      const target = typeof input.target === 'string' ? input.target : ''
      const minLen = typeof input.command === 'string' ? input.command : '-n 6'
      return `strings ${minLen} ${JSON.stringify(target)} 2>&1 | head -n 200`
    },
  }))

  tools.push(new BinaryTool({
    name: 'file',
    description: 'file 魔数识别 — CTF 第一步。',
    binary: 'file',
    requiredBinaries: ['file'],
    domains: ['forensics', 'reverse'],
    buildCommand: (input) => {
      const target = typeof input.target === 'string' ? input.target : ''
      return `file ${JSON.stringify(target)}`
    },
  }))

  tools.push(new BinaryTool({
    name: 'nm',
    description: 'nm 符号表 — 找关键函数/变量。',
    binary: 'nm',
    requiredBinaries: ['nm'],
    domains: ['reverse'],
    buildCommand: (input) => {
      const target = typeof input.target === 'string' ? input.target : ''
      const flags = typeof input.command === 'string' ? input.command : '-C'
      return `nm ${flags} ${JSON.stringify(target)} 2>&1 | head -n 200`
    },
  }))

  tools.push(new BinaryTool({
    name: 'radare2',
    description: 'r2 反汇编 / 反编译 / 图分析。',
    binary: 'r2',
    requiredBinaries: ['r2'],
    domains: ['reverse'],
    riskLevel: 'medium',
    buildCommand: (input) => {
      const target = typeof input.target === 'string' ? input.target : ''
      const script = typeof input.command === 'string' ? input.command : 'aaa;afl'
      return `r2 -q -c ${JSON.stringify(script)} ${JSON.stringify(target)} 2>&1 | head -n 200`
    },
  }))

  // ─── Web tools (补充) ─────────────────────────────────────────────────

  tools.push(new BinaryTool({
    name: 'curl',
    description: 'curl HTTP 客户端 — 重定向/方法/头控制。',
    binary: 'curl',
    requiredBinaries: ['curl'],
    domains: ['web'],
    riskLevel: 'low',
    buildCommand: (input) => {
      const target = typeof input.target === 'string' ? input.target : ''
      const flags = typeof input.command === 'string' ? input.command : '-i -L -s'
      return `curl ${flags} ${JSON.stringify(target)} 2>&1 | head -n 100`
    },
  }))

  tools.push(new BinaryTool({
    name: 'gobuster',
    description: 'gobuster 目录/子域暴力枚举。',
    binary: 'gobuster',
    requiredBinaries: ['gobuster'],
    domains: ['web'],
    riskLevel: 'medium',
    buildCommand: (input) => {
      const target = typeof input.target === 'string' ? input.target : ''
      const wordlist = typeof input.command === 'string' ? input.command : '/usr/share/wordlists/dirb/common.txt'
      return `gobuster dir -u ${JSON.stringify(target)} -w ${JSON.stringify(wordlist)} -t 30 -q 2>&1 | head -n 200`
    },
  }))

  // ─── Network Traffic tools ────────────────────────────────────────────

  tools.push(new BinaryTool({
    name: 'tshark',
    description: 'tshark 数据包分析 — 协议/过滤/导出。',
    binary: 'tshark',
    requiredBinaries: ['tshark'],
    domains: ['network'],
    riskLevel: 'medium',
    buildCommand: (input) => {
      const target = typeof input.target === 'string' ? input.target : ''
      const flags = typeof input.command === 'string' ? input.command : '-r'
      return `tshark ${flags} ${JSON.stringify(target)} 2>&1 | head -n 200`
    },
  }))

  tools.push(new BinaryTool({
    name: 'tcpdump',
    description: 'tcpdump 抓包/过滤 (需 root 能力)。',
    binary: 'tcpdump',
    requiredBinaries: ['tcpdump'],
    domains: ['network'],
    riskLevel: 'medium',
    buildCommand: (input) => {
      const target = typeof input.target === 'string' ? input.target : ''
      const filter = typeof input.command === 'string' ? input.command : ''
      return `tcpdump -nn -r ${JSON.stringify(target)} ${filter} 2>&1 | head -n 200`
    },
  }))

  return tools
}

export { BinaryTool }

// Workaround for the import hoisting of promisify in this file
// (we kept it; the spy from vitest sometimes warns otherwise).
export const _internals = { execAsync }
