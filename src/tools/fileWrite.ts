/**
 * FileWriteTool — write/create files
 * Reference: src/tools/FileWriteTool/
 */

import { writeFile, mkdir, rename } from 'fs/promises'
import { dirname, resolve } from 'path'
import type { Tool, ToolContext, ToolDefinition, ToolResult } from '../core/types.js'
import type { ContestScopeChecker } from '../core/contestScope.js'
import { WRITE_FILE_DESCRIPTION } from '../prompts/tools.js'

export interface WriteFileInput {
  file_path: string
  content: string
}

export class FileWriteTool implements Tool {
  name = 'Write'

  definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'Write',
      description: WRITE_FILE_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: 'Absolute path to write to',
          },
          content: {
            type: 'string',
            description: 'Content to write',
          },
        },
        required: ['file_path', 'content'],
      },
    },
  }

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const { file_path, content } = input as unknown as WriteFileInput

    if (!file_path || typeof file_path !== 'string') {
      return { content: 'Error: file_path is required', isError: true }
    }
    if (typeof content !== 'string') {
      return { content: 'Error: content must be a string', isError: true }
    }

    // Audit P1 — SSRF-style file-write gate. Even though file_path is
    // typically trusted, an LLM that hallucinates /etc/passwd or escapes
    // the workspace via `../../` must be refused by the contest scope.
    const ctfCtx = (context as unknown as {
      __ctf?: { contestScope?: ContestScopeChecker }
    }).__ctf
    const scope = ctfCtx?.contestScope
    if (scope && typeof scope.assertFile === 'function') {
      try {
        scope.assertFile(resolve(file_path))
      } catch (err) {
        return { content: `Write refused: ${(err as Error).message}`, isError: true }
      }
    }

    try {
      // Audit P0 #11 — atomic write via temp + rename. A mid-write crash
      // previously left a half-written file behind; the next read would
      // see corrupt content. rename() is atomic on POSIX so readers
      // either see the old file or the new file, never a partial.
      // Mirrors BackgroundJobManager.persist / SessionStore.saveConversation.
      const absPath = resolve(file_path)
      await mkdir(dirname(absPath), { recursive: true })
      const tmp = `${absPath}.tmp.${process.pid}`
      await writeFile(tmp, content, 'utf8')
      try {
        await rename(tmp, absPath)
      } catch (renameErr) {
        // Best-effort cleanup of the temp file on rename failure so we
        // don't leak .tmp.<pid> files in the user's workspace.
        try {
          const { unlink } = await import('fs/promises')
          await unlink(tmp)
        } catch { /* ignore */ }
        throw renameErr
      }

      const lines = content.split('\n').length
      return {
        content: `File written: ${file_path} (${lines} lines, ${content.length} bytes)`,
        isError: false,
      }
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException
      return { content: `Error writing file: ${error.message}`, isError: true }
    }
  }
}