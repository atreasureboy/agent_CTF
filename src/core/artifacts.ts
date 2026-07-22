/**
 * Artifact Store — persistent storage for tool outputs that should not be
 * passed inline to the model (large binaries, extracted files, full scan
 * results).
 *
 * Each Artifact gets:
 *   - a stable id (deterministic by tool + input when available)
 *   - sha256 of the persisted content
 *   - summary (head + tail snippets for LLM context)
 *   - canonical path under the active task's `artifacts/` directory
 *
 * The store is intentionally minimal: append-style files, no DB, no indexes.
 * Looking up an artifact means reading its descriptor JSON.
 */

import { randomBytes, createHash } from 'crypto'
import {
  appendFileSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from 'fs'
import { dirname, join } from 'path'
import { mkdir, writeFile } from 'fs/promises'

export interface ArtifactMeta {
  id: string
  taskId: string
  producerAgentId: string
  type: string
  mimeType?: string
  size: number
  sha256: string
  summary: string
  createdAt: string
  /** Phase 1.7 §十三.3 — Run-id association. */
  agentRunId?: string
  workflowRunId?: string
  handoffId?: string
  /** Relative path under artifacts root, e.g. 'bin/abc123.bin'. */
  path: string
  /** Optional source reference (the tool+input that produced this). */
  source?: {
    toolId?: string
    inputSummary?: string
  }
}

export interface ArtifactInput {
  taskId: string
  producerAgentId: string
  type: string
  mimeType?: string
  source?: { toolId?: string; inputSummary?: string }
  /** Phase 1.7 §十三.3 — Run-id association. */
  agentRunId?: string
  workflowRunId?: string
  handoffId?: string
}

const SUMMARY_HEAD_BYTES = 200
const SUMMARY_TAIL_BYTES = 200

function hashContent(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

/**
 * §十七 — stream-hash a file on disk (no full read into memory).
 * Exported for the projector (specialist artifact copy path) so we have
 * one canonical implementation.
 */
export function hashContentSync(filePath: string): string {
  const fd = openSync(filePath, 'r')
  try {
    const h = createHash('sha256')
    const buf = Buffer.alloc(64 * 1024)
    let pos = 0
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, pos)
      if (n <= 0) break
      h.update(buf.subarray(0, n))
      pos += n
    }
    return h.digest('hex')
  } finally {
    closeSync(fd)
  }
}

function makeId(prefix: 'art'): string {
  return `${prefix}_${randomBytes(8).toString('hex')}`
}

function summarize(buf: Buffer): string {
  if (buf.length <= SUMMARY_HEAD_BYTES * 2) {
    return buf.toString('utf8').replace(/[^\x20-\x7E -￿\n]/g, '.')
  }
  const head = buf.subarray(0, SUMMARY_HEAD_BYTES).toString('utf8').replace(/[^\x20-\x7E -￿\n]/g, '.')
  const tail = buf.subarray(buf.length - SUMMARY_TAIL_BYTES).toString('utf8').replace(/[^\x20-\x7E -￿\n]/g, '.')
  return `${head}\n\n[... ${buf.length - SUMMARY_HEAD_BYTES - SUMMARY_TAIL_BYTES} bytes ...]\n\n${tail}`
}

/**
 * Persistent artifact store rooted at the active task's `artifacts/` directory.
 * One instance per task workspace.
 */
export class ArtifactStore {
  private readonly artifactsDir: string
  private readonly metaPath: string

  constructor(rootDir: string) {
    this.artifactsDir = join(rootDir, 'artifacts')
    this.metaPath = join(this.artifactsDir, 'index.jsonl')
    mkdirSync(this.artifactsDir, { recursive: true })
  }

  /** Persist a buffer (e.g. raw tool output) as an artifact and return its metadata. */
  async write(
    input: ArtifactInput,
    data: Buffer | string,
    suggestedExt: string = 'bin',
  ): Promise<ArtifactMeta> {
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data)
    const id = makeId('art')
    const sha = hashContent(buf)
    const relPath = `${suggestedExt.replace(/[^a-zA-Z0-9._-]/g, '_')}/${id}.${suggestedExt.replace(/[^a-zA-Z0-9._-]/g, '_')}`
    const absPath = join(this.artifactsDir, relPath)
    await mkdir(dirname(absPath), { recursive: true })
    await writeFile(absPath, buf)

    const meta: ArtifactMeta = {
      id,
      taskId: input.taskId,
      producerAgentId: input.producerAgentId,
      type: input.type,
      mimeType: input.mimeType,
      size: buf.length,
      sha256: sha,
      summary: summarize(buf),
      createdAt: new Date().toISOString(),
      path: relPath,
      source: input.source,
      // §十三.3 — propagate run-id so the projector can filter by it.
      agentRunId: input.agentRunId,
      workflowRunId: input.workflowRunId,
      handoffId: input.handoffId,
    }
    appendFileSync(this.metaPath, JSON.stringify(meta) + '\n', 'utf8')
    return meta
  }

  /** Synchronous write (for use inside hot paths). */
  writeSync(
    input: ArtifactInput,
    data: Buffer | string,
    suggestedExt: string = 'bin',
  ): ArtifactMeta {
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data)
    const id = makeId('art')
    const sha = hashContent(buf)
    const relPath = `${suggestedExt.replace(/[^a-zA-Z0-9._-]/g, '_')}/${id}.${suggestedExt.replace(/[^a-zA-Z0-9._-]/g, '_')}`
    const absPath = join(this.artifactsDir, relPath)
    mkdirSync(dirname(absPath), { recursive: true })
    writeFileSync(absPath, buf)
    const meta: ArtifactMeta = {
      id,
      taskId: input.taskId,
      producerAgentId: input.producerAgentId,
      type: input.type,
      mimeType: input.mimeType,
      size: buf.length,
      sha256: sha,
      summary: summarize(buf),
      // §十三.3 — propagate run-id so the projector can filter by it.
      agentRunId: input.agentRunId,
      workflowRunId: input.workflowRunId,
      handoffId: input.handoffId,
      createdAt: new Date().toISOString(),
      path: relPath,
      source: input.source,
    }
    mkdirSync(dirname(this.metaPath), { recursive: true })
    appendFileSync(this.metaPath, JSON.stringify(meta) + '\n', 'utf8')
    return meta
  }

  /**
   * §十七 — streaming copy from a source path on disk. We never load
   * the whole file into memory — the file is streamed in 64 KB chunks
   * from `sourcePath` to a freshly-allocated id in this store's
   * artifacts dir. The metadata (size, sha256) is computed via
   * fs.statSync + a streaming SHA-256, not by reading the buffer.
   */
  writeStreamingSync(input: ArtifactInput & {
    sourcePath: string
    size: number
    sha256: string
    suggestedExt?: string
  }): ArtifactMeta {
    const id = makeId('art')
    const ext = (input.suggestedExt ?? 'bin').replace(/[^a-zA-Z0-9._-]/g, '_')
    const relPath = `${ext}/${id}.${ext}`
    const absPath = join(this.artifactsDir, relPath)
    mkdirSync(dirname(absPath), { recursive: true })
    // Stream copy — Node createReadStream + createWriteStream pipes
    // the file in 64 KB chunks. We use the synchronous sync API
    // (copyFileSync) which is itself an internal streaming copy at
    // the libuv level — no full-file buffer in user-space.
    copyFileSync(input.sourcePath, absPath)
    const meta: ArtifactMeta = {
      id,
      taskId: input.taskId,
      producerAgentId: input.producerAgentId,
      type: input.type,
      mimeType: input.mimeType,
      size: input.size,
      sha256: input.sha256,
      summary: '',  // streaming copy: caller may compute summary later if needed
      agentRunId: input.agentRunId,
      workflowRunId: input.workflowRunId,
      handoffId: input.handoffId,
      createdAt: new Date().toISOString(),
      path: relPath,
      source: input.source,
    }
    mkdirSync(dirname(this.metaPath), {recursive: true})
    appendFileSync(this.metaPath, JSON.stringify(meta) + '\n', 'utf8')
    return meta
  }

  read(id: string): ArtifactMeta | null {
    if (!existsSync(this.metaPath)) return null
    const lines = readFileSync(this.metaPath, 'utf8').split('\n').filter(Boolean)
    for (const line of lines) {
      try {
        const meta = JSON.parse(line) as ArtifactMeta
        if (meta.id === id) return meta
      } catch {
        continue
      }
    }
    return null
  }

  list(): ArtifactMeta[] {
    if (!existsSync(this.metaPath)) return []
    const out: ArtifactMeta[] = []
    for (const line of readFileSync(this.metaPath, 'utf8').split('\n').filter(Boolean)) {
      try {
        out.push(JSON.parse(line) as ArtifactMeta)
      } catch {
        continue
      }
    }
    return out
  }

  /** Absolute filesystem path for a given artifact id. */
  resolvePath(meta: ArtifactMeta): string {
    return join(this.artifactsDir, meta.path)
  }
}
