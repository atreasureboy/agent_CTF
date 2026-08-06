/**
 * PythonTool — execute Python 3 code in a subprocess.
 *
 * Follows the same pattern as BashTool: spawn via child_process with
 * proper abort support, timeout clamping, and output truncation.
 * Useful for crypto math, data processing, and quick scripting that
 * the LLM encodes as inline Python snippets.
 */

import { exec } from 'child_process'
import type { Tool, ToolContext, ToolDefinition, ToolResult } from '../core/types.js'

const MAX_OUTPUT_LENGTH = 30_000
const DEFAULT_TIMEOUT_MS = 60_000 // 1 min — typical Python snippets are short
const MAX_TIMEOUT_MS = 300_000 // 5 min max
const MIN_TIMEOUT_MS = 500

export interface PythonInput {
  code: string
  timeout?: number
  description?: string
}

function truncateOutput(output: string, maxLen: number): string {
  if (output.length <= maxLen) return output
  const half = Math.floor(maxLen / 2)
  const head = output.slice(0, half)
  const tail = output.slice(output.length - half)
  return `${head}\n\n[... ${output.length - maxLen} characters truncated ...]\n\n${tail}`
}

export class PythonTool implements Tool {
  name = 'Python'
  concurrencySafe = true

  definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'Python',
      description:
        'Execute Python 3 code and return stdout. Use for crypto math (modular arithmetic, integer factorisation, discrete log), data parsing, or quick one-shot scripts. The code runs in an isolated subprocess — no persistent state between calls. Use Bash for system commands (apt, pip, git, etc.).',
      parameters: {
        type: 'object',
        properties: {
          code: {
            type: 'string',
            description:
              'Python 3 code to execute. The script receives no arguments; use print() to emit output.',
          },
          timeout: {
            type: 'number',
            description: `Timeout in MILLISECONDS. Default: ${DEFAULT_TIMEOUT_MS} (1 min). Max: ${MAX_TIMEOUT_MS} (5 min). Values below ${MIN_TIMEOUT_MS} are clamped to the default.`,
          },
          description: {
            type: 'string',
            description: 'Brief description of what this code does (shown in audit trail).',
          },
        },
        required: ['code'],
      },
    },
  }

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const { code, description } = input as unknown as PythonInput
    let timeout = (input as unknown as PythonInput).timeout

    if (!code || typeof code !== 'string') {
      return { content: 'Error: code is required and must be a string', isError: true }
    }

    // Clamp timeout
    if (timeout === undefined || timeout === null) {
      timeout = DEFAULT_TIMEOUT_MS
    } else if (typeof timeout !== 'number' || !Number.isFinite(timeout)) {
      timeout = DEFAULT_TIMEOUT_MS
    } else if (timeout < MIN_TIMEOUT_MS) {
      timeout = DEFAULT_TIMEOUT_MS
    } else if (timeout > MAX_TIMEOUT_MS) {
      timeout = MAX_TIMEOUT_MS
    }

    // Audit trail
    if (description) {
      const ev = (
        context as unknown as {
          __ctf?: {
            eventLog?: {
              append: (type: string, source: string, detail: Record<string, unknown>) => unknown
            }
          }
        }
      ).__ctf?.eventLog
      ev?.append('tool_call', 'Python', {
        tool: 'Python',
        description,
        intent: description,
      })
    }

    return new Promise<ToolResult>((resolve) => {
      // Use -S to read from stdin; pass code via stdin to avoid shell escaping issues
      const child = exec(
        'python3 -S',
        {
          timeout,
          maxBuffer: 10 * 1024 * 1024, // 10 MB
          signal: context.signal ?? undefined,
          env: {
            PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
            HOME: process.env.HOME ?? '/root',
            LANG: 'en_US.UTF-8',
            PYTHONDONTWRITEBYTECODE: '1',
          },
        },
        (error, stdout, stderr) => {
          const out = truncateOutput(stdout, MAX_OUTPUT_LENGTH)
          const err = stderr ? `\n[stderr]\n${truncateOutput(stderr, 4000)}` : ''

          if (error) {
            // Killed by signal (abort/timeout)
            if (error.signal !== null && error.signal !== undefined) {
              resolve({
                content: `Python process killed by signal ${error.signal}${err ? err : ''}`,
                isError: true,
              })
              return
            }
            // Non-zero exit
            resolve({
              content: `${out}${err}\n[exit code: ${error.code}]`,
              isError: true,
            })
            return
          }

          resolve({
            content: out + (err ? err : ''),
            isError: false,
          })
        },
      )

      // Write code to stdin
      if (child.stdin) {
        child.stdin.write(code)
        child.stdin.end()
      }
    })
  }
}
