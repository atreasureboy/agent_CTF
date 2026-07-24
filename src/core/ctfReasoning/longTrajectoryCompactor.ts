/**
 * LongTrajectoryCompactor — Phase borrow-plan Tier B3 (swe-agent
 * pattern).
 *
 * swe-agent v0.7's `LMSummarizer` swaps a `file_pointer: 100-200 in
 * <file>` for the truncated observations. The LLM is told to read the
 * file if needed. This avoids losing context entirely (unlike a plain
 * summary) while keeping the active context window bounded.
 *
 * Our compactor:
 *   1. Writes the old observations to a `compactor-archives/<at>.jsonl`
 *      file under the task's workspace.
 *   2. Returns a `compaction_token` observation whose summary is a
 *      pointer like `compactor-archives/<at>.jsonl: <N> lines`.
 *   3. The original observations are still in TaskState, but marked
 *      with a `compacted: true` flag (we don't drop them).
 *
 * Companion: `ContextCompactor` is the deterministic summary
 * version. This module is the file-pointer version.
 */

import { mkdir, writeFile, stat } from 'fs/promises'
import { join } from 'path'
import type { CTFTaskState } from '../ctfRuntime/taskState.js'

export interface LongTrajectoryCompactionResult {
  /** Where the old observations were written. */
  archivePath: string
  /** Number of old observations written. */
  archiveCount: number
  /** Size of the archive in bytes. */
  archiveSize: number
  /** The summary observation text. */
  summary: string
}

export interface LongTrajectoryCompactionOptions {
  /** Workspace directory (typically `taskState.context.workspaceDir`). */
  workspaceDir: string
  /** ISO timestamp or epoch ms used in the archive filename. */
  at?: number
}

export async function compactToFile(
  state: Readonly<CTFTaskState>,
  observationsToArchive: ReadonlyArray<CTFTaskState['observations'][number]>,
  options: LongTrajectoryCompactionOptions,
): Promise<LongTrajectoryCompactionResult> {
  const at = options.at ?? Date.now()
  const dir = join(options.workspaceDir, 'compactor-archives')
  await mkdir(dir, { recursive: true })
  const filename = `obs-${new Date(at).toISOString().replace(/[:.]/g, '-')}.jsonl`
  const archivePath = join(dir, filename)
  const lines = observationsToArchive.map((o) => JSON.stringify({
    id: o.id,
    taskId: o.taskId,
    kind: o.kind,
    source: o.source,
    summary: o.summary,
    attributes: o.attributes,
    confidence: o.confidence,
    createdAt: o.createdAt,
  })).join('\n') + '\n'
  await writeFile(archivePath, lines, 'utf-8')
  const archiveSize = (await stat(archivePath)).size
  const summary = `compactor-archives/${filename}: ${observationsToArchive.length} observations, ${archiveSize} bytes (task=${state.taskId} at=${at})`
  return {
    archivePath,
    archiveCount: observationsToArchive.length,
    archiveSize,
    summary,
  }
}
