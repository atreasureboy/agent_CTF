/**
 * FileReadTool — read file contents with line numbers
 * Reference: src/tools/FileReadTool/
 */

import { readFile } from 'fs/promises'
import { resolve } from 'path'
import type { Tool, ToolContext, ToolDefinition, ToolResult } from '../core/types.js'
import type { ContestScopeChecker } from '../core/contestScope.js'
import { READ_FILE_DESCRIPTION } from '../prompts/tools.js'

export interface ReadFileInput {
  file_path: string
  offset?: number
  limit?: number
}

const MAX_LINES_DEFAULT = 2000

export class FileReadTool implements Tool {
  name = 'Read'
  concurrencySafe = true

  definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'Read',
      description: READ_FILE_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: 'Absolute path to the file to read',
          },
          offset: {
            type: 'number',
            description: 'Line number to start reading from (1-indexed)',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of lines to read',
          },
        },
        required: ['file_path'],
      },
    },
  }

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const { file_path, offset, limit } = input as unknown as ReadFileInput

    if (!file_path || typeof file_path !== 'string') {
      return { content: 'Error: file_path is required', isError: true }
    }

    // Audit P1 — file-scope gate. Refuse reads outside the contest's
    // allowedFilesRoot BEFORE opening the file. Mirrors the
    // WebFetch SSRF pattern: read context.__ctf, consult contestScope.
    const ctfCtx = (
      context as unknown as {
        __ctf?: { contestScope?: ContestScopeChecker }
      }
    ).__ctf
    const scope = ctfCtx?.contestScope
    if (scope && typeof scope.assertFile === 'function') {
      try {
        scope.assertFile(resolve(file_path))
      } catch (err) {
        return { content: `Read refused: ${(err as Error).message}`, isError: true }
      }
    }

    try {
      // Audit P1 — pass the context's AbortSignal to fs.readFile so a
      // Ctrl+C during a slow file read (e.g. over a network mount)
      // actually cancels the read instead of blocking the turn.
      const raw = await readFile(resolve(file_path), { encoding: 'utf8', signal: context.signal })
      const lines = raw.split('\n')
      const total = lines.length

      const startLine = typeof offset === 'number' ? Math.max(1, offset) : 1
      const maxLines = typeof limit === 'number' ? limit : MAX_LINES_DEFAULT
      const endLine = Math.min(startLine - 1 + maxLines, total)

      const slice = lines.slice(startLine - 1, endLine)
      const numbered = slice.map((line, i) => `${startLine + i}\t${line}`).join('\n')

      const header =
        total > maxLines
          ? `File: ${file_path} (showing lines ${startLine}-${endLine} of ${total})\n`
          : `File: ${file_path}\n`

      return { content: header + numbered, isError: false }
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException
      if (error.code === 'ENOENT') {
        return { content: `File not found: ${file_path}`, isError: true }
      }
      if (error.code === 'EACCES') {
        return { content: `Permission denied: ${file_path}`, isError: true }
      }
      if ((error as { name?: string }).name === 'AbortError') {
        return { content: 'Read cancelled.', isError: true }
      }
      return { content: `Error reading file: ${error.message}`, isError: true }
    }
  }
}
