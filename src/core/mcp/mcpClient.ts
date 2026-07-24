/**
 * MCPClient — Phase borrow-plan Phase C.
 *
 * Minimal Model Context Protocol (stdio transport) client. Inspired by
 * CHYing-agent and CAI: each MCP server is spawned as a subprocess and
 * we exchange JSON-RPC 2.0 over its stdin/stdout. The remote tool
 * surface is exposed to the local ToolBroker as a single composite
 * tool ("mcp:<server>:<tool>") so the StrategyActionExecutor can call
 * it through the existing executor path.
 *
 * Scope: tools/list + tools/call. We do NOT implement the full MCP
 * spec (no resources, no prompts, no sampling, no SSE transport). This
 * is enough to integrate community MCP servers with our deterministic
 * planner and event-sourced state.
 */

import { spawn, ChildProcessWithoutNullStreams } from 'child_process'
import { randomBytes } from 'crypto'
import { redactSecrets } from '../ctfReasoning/redaction.js'

export interface McpToolDescriptor {
  name: string
  description?: string
  inputSchema?: unknown
}

export interface McpServerConfig {
  name: string
  command: string
  args: string[]
  env?: Record<string, string>
  cwd?: string
}

export interface McpCallResult {
  content: Array<{ type: 'text' | 'image' | 'resource'; text?: string; data?: string; mimeType?: string }>
  isError?: boolean
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
}

export interface McpClient {
  serverName: string
  start(): Promise<void>
  stop(): Promise<void>
  listTools(): Promise<McpToolDescriptor[]>
  callTool(toolName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult>
}

export function createMcpClient(config: McpServerConfig): McpClient {
  let child: ChildProcessWithoutNullStreams | null = null
  let nextId = 1
  const pending = new Map<number, PendingRequest>()
  const started = { value: false }
  let buffer = ''
  let stderrTail = ''

  const state: { started: Promise<void> | null } = { started: null }

  const start = (): Promise<void> => {
    if (started.value) return Promise.resolve()
    if (state.started) return state.started
    state.started = new Promise<void>((resolve, reject) => {
      try {
        child = spawn(config.command, config.args, {
          env: { ...process.env, ...config.env },
          cwd: config.cwd,
          stdio: ['pipe', 'pipe', 'pipe'],
        })
      } catch (err) {
        reject(err as Error)
        return
      }
      const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        // Reject any pending requests.
        const reason = new Error(`mcp server ${config.name} exited (code=${code}, signal=${signal})`)
        for (const p of pending.values()) p.reject(reason)
        pending.clear()
        started.value = false
        child = null
      }
      child.on('exit', onExit)
      child.on('error', (err) => {
        for (const p of pending.values()) p.reject(err)
        pending.clear()
        reject(err)
      })
      child.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf-8')
        // MCP uses Content-Length framed JSON-RPC. Some servers use
        // newline-delimited JSON; we try both.
        let processed = true
        while (processed) {
          processed = false
          // Try Content-Length framing first.
          const headerEnd = buffer.indexOf('\r\n\r\n')
          if (headerEnd > 0) {
            const header = buffer.slice(0, headerEnd)
            const m = /Content-Length:\s*(\d+)/i.exec(header)
            if (m) {
              const len = Number(m[1])
              const bodyStart = headerEnd + 4
              if (buffer.length >= bodyStart + len) {
                const body = buffer.slice(bodyStart, bodyStart + len)
                buffer = buffer.slice(bodyStart + len)
                handleMessage(body)
                processed = true
                continue
              }
            }
          }
          // Fall back to newline-delimited JSON.
          const nl = buffer.indexOf('\n')
          if (nl >= 0) {
            const line = buffer.slice(0, nl).trim()
            if (line.length > 0) {
              try {
                JSON.parse(line)
                buffer = buffer.slice(nl + 1)
                handleMessage(line)
                processed = true
                continue
              } catch {
                /* not JSON yet */
              }
            } else {
              buffer = buffer.slice(nl + 1)
              processed = true
            }
          }
        }
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        // Cap stderr tail to last 4 KB; surface via warnings.
        stderrTail = (stderrTail + chunk.toString('utf-8')).slice(-4096)
      })
      // Send `initialize`.
      const initId = nextId++
      const initMsg = {
        jsonrpc: '2.0',
        id: initId,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'agent_CTF', version: '0.1' },
        },
      }
      pending.set(initId, {
        resolve: () => {
          // Send `initialized` notification then resolve.
          if (child) {
            child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
          }
          started.value = true
          resolve()
        },
        reject,
      })
      child.stdin.write(JSON.stringify(initMsg) + '\n')
    })
    return state.started
  }

  const stop = async (): Promise<void> => {
    if (!child) return
    return new Promise<void>((resolve) => {
      const done = (): void => {
        child = null
        started.value = false
        resolve()
      }
      child!.once('exit', done)
      try {
        child!.kill('SIGTERM')
      } catch {
        done()
      }
      setTimeout(() => {
        try {
          child!.kill('SIGKILL')
        } catch {
          /* already dead */
        }
        done()
      }, 1000).unref()
    })
  }

  const send = (method: string, params: unknown): Promise<unknown> => {
    return new Promise((resolve, reject) => {
      if (!child) {
        reject(new Error(`mcp server ${config.name} not started`))
        return
      }
      const id = nextId++
      pending.set(id, { resolve, reject })
      try {
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      } catch (err) {
        pending.delete(id)
        reject(err as Error)
      }
    })
  }

  const handleMessage = (body: string): void => {
    let msg: { id?: number; result?: unknown; error?: { code?: number; message: string; data?: unknown } }
    try {
      msg = JSON.parse(body) as typeof msg
    } catch {
      return
    }
    if (msg.id === undefined) {
      // Notification — ignore (MCP servers send `notifications/cancelled`, `notifications/progress`).
      return
    }
    const handler = pending.get(msg.id)
    if (!handler) return
    pending.delete(msg.id)
    if (msg.error) {
      handler.reject(new Error(`mcp ${config.name} error ${msg.error.code ?? '?'}: ${msg.error.message}`))
    } else {
      handler.resolve(msg.result)
    }
  }

  const listTools = async (): Promise<McpToolDescriptor[]> => {
    const result = (await send('tools/list', {})) as { tools?: McpToolDescriptor[] }
    return result.tools ?? []
  }

  const callTool = async (
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpCallResult> => {
    const id = nextId++
    if (!child) throw new Error(`mcp server ${config.name} not started`)
    return new Promise<McpCallResult>((resolve, reject) => {
      pending.set(id, { resolve: (v) => resolve(v as McpCallResult), reject })
      const onAbort = (): void => {
        pending.delete(id)
        // Best-effort cancel notification.
        try {
          child!.stdin.write(
            JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'client aborted' } }) + '\n',
          )
        } catch {
          /* socket closed */
        }
        reject(new Error(`mcp call ${toolName} aborted`))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      try {
        child!.stdin.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id,
            method: 'tools/call',
            params: { name: toolName, arguments: args },
          }) + '\n',
        )
      } catch (err) {
        pending.delete(id)
        signal?.removeEventListener('abort', onAbort)
        reject(err as Error)
      }
    }).finally(() => {
      // Cleanup of abort listener happens in resolve/reject paths.
    }) as Promise<McpCallResult>
  }

  return {
    serverName: config.name,
    start,
    stop,
    listTools,
    callTool,
  }
}

/** Public: redact MCP server stderr before logging it. */
export function safeMcpStderr(tail: string): string {
  return redactSecrets(tail)
}

let _mcpIdCounter = 0
export function uniqueMcpRequestId(): string {
  _mcpIdCounter = (_mcpIdCounter + 1) >>> 0
  return `mcp_${randomBytes(4).toString('hex')}_${_mcpIdCounter}`
}
