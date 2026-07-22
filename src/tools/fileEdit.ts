/**
 * FileEditTool — exact string replacement in files
 * Reference: src/tools/FileEditTool/
 *
 * File edits must be EXACT string matches (including whitespace/indentation).
 * This prevents accidental changes and makes diffs reviewable.
 */

import { readFile, writeFile, rename, copyFile, unlink } from 'fs/promises'
import { resolve } from 'path'
import type { Tool, ToolContext, ToolDefinition, ToolResult } from '../core/types.js'
import type { ContestScopeChecker } from '../core/contestScope.js'
import { EDIT_FILE_DESCRIPTION } from '../prompts/tools.js'

export interface EditFileInput {
  file_path: string
  old_string: string
  new_string: string
  replace_all?: boolean
}

export class FileEditTool implements Tool {
  name = 'Edit'

  definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'Edit',
      description: EDIT_FILE_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: 'Absolute path to the file to edit',
          },
          old_string: {
            type: 'string',
            description: 'Exact string to find (must be unique in the file unless replace_all=true)',
          },
          new_string: {
            type: 'string',
            description: 'Replacement string',
          },
          replace_all: {
            type: 'boolean',
            description: 'Replace all occurrences (default: false)',
          },
        },
        required: ['file_path', 'old_string', 'new_string'],
      },
    },
  }

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const { file_path, old_string, new_string, replace_all } = input as unknown as EditFileInput

    if (!file_path || typeof file_path !== 'string') {
      return { content: 'Error: file_path is required', isError: true }
    }
    if (typeof old_string !== 'string') {
      return { content: 'Error: old_string must be a string', isError: true }
    }
    if (typeof new_string !== 'string') {
      return { content: 'Error: new_string must be a string', isError: true }
    }
    if (old_string === new_string) {
      return { content: 'Error: old_string and new_string are identical — no change needed', isError: true }
    }

    // Audit P1 — file-scope gate (mirrors fileWrite / fileRead). Refuse
    // writes that escape the contest's allowedFilesRoot before we even
    // open the source file.
    const ctfCtx = (context as unknown as {
      __ctf?: { contestScope?: ContestScopeChecker }
    }).__ctf
    const scope = ctfCtx?.contestScope
    if (scope && typeof scope.assertFile === 'function') {
      try {
        scope.assertFile(resolve(file_path))
      } catch (err) {
        return { content: `Edit refused: ${(err as Error).message}`, isError: true }
      }
    }

    try {
      const absPath = resolve(file_path)
      const content = await readFile(absPath, 'utf8')

      const occurrences = countOccurrences(content, old_string)

      if (occurrences === 0) {
        // Provide diagnostic info to help the LLM fix its edit
        const suggestion = findClosestMatch(content, old_string)
        return {
          content: `Error: old_string not found in ${file_path}.\n${suggestion}`,
          isError: true,
        }
      }

      if (!replace_all && occurrences > 1) {
        return {
          content: `Error: old_string appears ${occurrences} times in ${file_path}. Provide more surrounding context to make it unique, or use replace_all=true.`,
          isError: true,
        }
      }

      const newContent = replace_all
        ? content.split(old_string).join(new_string)
        : content.replace(old_string, new_string)

      // Audit P0 #12 — atomic edit via temp + rename. We snapshot the
      // original file to `<file>.bak.<pid>` first so a crash mid-rename
      // leaves a recoverable copy, then write to `<file>.tmp.<pid>` and
      // rename over the original. Mirrors BackgroundJobManager.persist
      // and SessionStore.saveConversation.
      const tmp = `${absPath}.tmp.${process.pid}`
      const backup = `${absPath}.bak.${process.pid}`
      let backupMade = false
      try {
        await copyFile(absPath, backup)
        backupMade = true
      } catch (copyErr) {
        // copyFile failure (e.g. read-only fs) — fail loud before mutating.
        return { content: `Edit refused: cannot snapshot ${file_path}: ${(copyErr as Error).message}`, isError: true }
      }
      try {
        await writeFile(tmp, newContent, 'utf8')
        try {
          await rename(tmp, absPath)
        } catch (renameErr) {
          // Restore from backup so the user does not end up with a
          // half-modified file on disk.
          if (backupMade) {
            try { await copyFile(backup, absPath) } catch { /* best-effort */ }
          }
          try { await unlink(tmp) } catch { /* ignore */ }
          throw renameErr
        }
      } catch (err) {
        return { content: `Error editing file: ${(err as Error).message}`, isError: true }
      } finally {
        // Leave the backup behind — it is small, named clearly, and the
        // user can decide to delete it. (We could clean up here but
        // preserving the .bak gives a free undo path.)
      }

      const count = replace_all ? occurrences : 1
      return {
        content: `Edited ${file_path}: replaced ${count} occurrence${count !== 1 ? 's' : ''}`,
        isError: false,
      }
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException
      if (error.code === 'ENOENT') {
        return { content: `File not found: ${file_path}`, isError: true }
      }
      return { content: `Error editing file: ${error.message}`, isError: true }
    }
  }
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0
  let count = 0
  let pos = 0
  while ((pos = haystack.indexOf(needle, pos)) !== -1) {
    count++
    pos += needle.length
  }
  return count
}

/**
 * Find a close match to help the LLM understand why the exact match failed.
 * Strips leading/trailing whitespace and checks if that version exists.
 */
function findClosestMatch(content: string, target: string): string {
  const trimmed = target.trim()
  if (content.includes(trimmed)) {
    return `Hint: A version with different whitespace was found. Check indentation — old_string must match exactly.`
  }

  // Try to find first non-trivial line of the target
  const firstLine = trimmed.split('\n')[0]?.trim()
  if (firstLine && firstLine.length > 10 && content.includes(firstLine)) {
    return `Hint: The first line "${firstLine.slice(0, 60)}..." exists in the file, but the surrounding context doesn't match. Read the file around that line to get the exact content.`
  }

  return `Hint: Use Read to view the current file content and ensure old_string matches exactly.`
}