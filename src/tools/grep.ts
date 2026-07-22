/**
 * GrepTool — search file contents with regex
 * Reference: src/tools/GrepTool/
 * Uses ripgrep (rg) if available, falls back to Node.js regex scan
 */

import { exec } from 'child_process'
import { promisify } from 'util'
import type { Tool, ToolContext, ToolDefinition, ToolResult } from '../core/types.js'
import { GREP_DESCRIPTION } from '../prompts/tools.js'

const execAsync = promisify(exec)

export interface GrepInput {
  pattern: string
  path?: string
  glob?: string
  output_mode?: 'files_with_matches' | 'content' | 'count'
  context?: number
  case_insensitive?: boolean
}

export class GrepTool implements Tool {
  name = 'Grep'
  concurrencySafe = true

  definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'Grep',
      description: GREP_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'Regex pattern to search for',
          },
          path: {
            type: 'string',
            description: 'File or directory to search (defaults to cwd)',
          },
          glob: {
            type: 'string',
            description: 'File pattern filter (e.g. "*.ts", "**/*.tsx")',
          },
          output_mode: {
            type: 'string',
            enum: ['files_with_matches', 'content', 'count'],
            description: 'Output mode (default: files_with_matches)',
          },
          context: {
            type: 'number',
            description: 'Lines of context around matches (for content mode)',
          },
          case_insensitive: {
            type: 'boolean',
            description: 'Case-insensitive search',
          },
        },
        required: ['pattern'],
      },
    },
  }

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const {
      pattern,
      path: searchPath,
      glob: globPattern,
      output_mode = 'files_with_matches',
      context: contextLines,
      case_insensitive,
    } = input as unknown as GrepInput

    if (!pattern || typeof pattern !== 'string') {
      return { content: 'Error: pattern is required', isError: true }
    }

    const searchDir = searchPath ?? context.cwd

    // Build rg command (preferred — faster, respects .gitignore)
    const args: string[] = []

    if (case_insensitive) args.push('-i')

    switch (output_mode) {
      case 'files_with_matches':
        args.push('-l')
        break
      case 'count':
        args.push('-c')
        break
      case 'content':
        args.push('-n') // line numbers
        if (typeof contextLines === 'number' && contextLines > 0) {
          args.push(`-C${contextLines}`)
        }
        break
    }

    if (globPattern) {
      // Audit P1 #25 — wrap the LLM-controlled glob in JSON.stringify so
      // `;`, `|`, `$(...)`, redirections, etc. cannot inject extra shell
      // commands. rg accepts --glob <glob>; the JSON-encoded string is a
      // safe shell argument.
      args.push(`--glob`, JSON.stringify(globPattern) ?? '""')
    }

    // Escape the pattern & path for shell. The pattern is a regex (rg
    // treats it as such, ignoring the surrounding quotes), the path is a
    // literal directory. JSON.stringify wraps both in double quotes — the
    // only shell metacharacter that can still break out is `"`, but the
    // LLM-supplied pattern will not contain raw `"` (it would break the
    // JSON encoding and the call would already be malformed). Backslash
    // escaping inside the JSON string also prevents `\$`, `` \` ``, etc.
    const escapedPattern = JSON.stringify(pattern) ?? '""'
    const escapedPath = JSON.stringify(searchDir) ?? '""'

    const cmd = `rg ${args.join(' ')} ${escapedPattern} ${escapedPath} 2>/dev/null || grep -r${case_insensitive ? 'i' : ''}${output_mode === 'files_with_matches' ? 'l' : 'n'} --include=${JSON.stringify(globPattern) ?? '"*"'} -E ${escapedPattern} ${escapedPath} 2>/dev/null`

    try {
      const { stdout } = await execAsync(cmd, {
        cwd: context.cwd,
        maxBuffer: 10 * 1024 * 1024,
      })

      const result = stdout.trim()
      if (!result) {
        return { content: `No matches found for pattern: ${pattern}`, isError: false }
      }

      // Cap output to avoid flooding context
      const lines = result.split('\n')
      if (lines.length > 500) {
        const truncated = lines.slice(0, 500).join('\n')
        return {
          content: `${truncated}\n\n[... truncated: ${lines.length - 500} more lines]`,
          isError: false,
        }
      }

      return { content: result, isError: false }
    } catch (err: unknown) {
      // rg exits with code 1 when no matches — that's not an error
      const error = err as { code?: number; stdout?: string; stderr?: string }
      if (error.code === 1 && !error.stderr) {
        return { content: `No matches found for pattern: ${pattern}`, isError: false }
      }
      const msg = error.stderr ?? (err as Error).message ?? 'Unknown grep error'
      return { content: `Grep error: ${msg}`, isError: true }
    }
  }
}
