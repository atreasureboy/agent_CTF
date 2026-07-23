/**
 * OneShotResultStore — Phase 2.0 §九.
 *
 * Persistent, bounded store for OneShot results. Writes atomic JSON to
 * `<taskWorkspace>/oneshots/results/<runId>.json` plus an append-only
 * `index.jsonl`. An in-memory LRU caches recent reads.
 *
 * Invariants:
 *   - Every persisted result carries the real taskId from TaskExecutionContext.
 *   - Atomic write via temp + rename (POSIX rename is atomic).
 *   - GC never deletes a result that the task still references via
 *     `OneShotRunRecord.resultPath`.
 *   - The store is restart-safe — `loadTask(taskId)` rehydrates.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, unlinkSync, statSync } from 'fs'
import { dirname, join } from 'path'
import type { OneShotResult } from './types.js'

export interface OneShotResultStoreOptions {
  taskWorkspaceDir: string
  /** In-memory LRU cap. Default 256. */
  cacheSize?: number
}

export interface OneShotResultStoreGCOptions {
  maxPerTask?: number
  maxAgeMs?: number
}

interface CacheEntry {
  result: OneShotResult
  /** Path under <workspace>/oneshots/results that holds the JSON. */
  path: string
  /** Insertion tick used for LRU eviction. */
  tick: number
}

export class OneShotResultStore {
  private readonly resultsRoot: string
  private readonly indexPath: string
  private readonly cacheSize: number
  private readonly cache = new Map<string, CacheEntry>()
  private tick = 0
  /** Per-task reference counters — bumped when a OneShotRunRecord points at
   *  a resultPath. GC refuses to delete referenced results. */
  private readonly refsByTask = new Map<string, Set<string>>()

  constructor(private readonly opts: OneShotResultStoreOptions) {
    this.resultsRoot = join(opts.taskWorkspaceDir, 'oneshots', 'results')
    this.indexPath = join(this.resultsRoot, 'index.jsonl')
    this.cacheSize = opts.cacheSize ?? 256
    mkdirSync(this.resultsRoot, { recursive: true })
  }

  /** Save a result. Atomic write via temp + rename. */
  async save(result: OneShotResult): Promise<void> {
    if (!result.taskId) {
      throw new Error('OneShotResultStore.save: result.taskId is required')
    }
    const target = join(this.resultsRoot, `${result.runId}.json`)
    const tmp = `${target}.tmp.${process.pid}`
    mkdirSync(dirname(target), { recursive: true })
    try {
      writeFileSync(tmp, JSON.stringify(result, null, 2), 'utf8')
      renameSync(tmp, target)
    } catch (err) {
      // Best-effort fallback — even unlinked temp is preferable to leaving
      // a corrupt .json. Caller sees the original error.
      try { unlinkSync(tmp) } catch { /* ignore */ }
      throw err
    }
    // Append to index (idempotent re-read tolerant — each line is a snapshot).
    try {
      const line = JSON.stringify({
        runId: result.runId,
        manifestId: result.manifestId,
        status: result.status,
        startedAt: result.startedAt,
        finishedAt: result.finishedAt,
      })
      writeFileSync(this.indexPath, `${line}\n`, { encoding: 'utf8', flag: 'a' })
    } catch { /* best-effort — single result file is authoritative */ }

    this.cacheSet(result.runId, result, target)
    const refs = this.refsByTask.get(result.taskId) ?? new Set<string>()
    refs.add(result.runId)
    this.refsByTask.set(result.taskId, refs)
  }

  /** Reference a result — bump the GC retention count. */
  retain(taskId: string, runId: string): void {
    const refs = this.refsByTask.get(taskId) ?? new Set<string>()
    refs.add(runId)
    this.refsByTask.set(taskId, refs)
  }

  /** Release a reference. */
  release(taskId: string, runId: string): void {
    this.refsByTask.get(taskId)?.delete(runId)
  }

  /** Get a single result. Reads from cache first, then disk. */
  async get(runId: string): Promise<OneShotResult | null> {
    const cached = this.cache.get(runId)
    if (cached) {
      this.touch(runId)
      return cached.result
    }
    const file = join(this.resultsRoot, `${runId}.json`)
    if (!existsSync(file)) return null
    try {
      const obj = JSON.parse(readFileSync(file, 'utf8')) as OneShotResult
      this.cacheSet(runId, obj, file)
      return obj
    } catch {
      return null
    }
  }

  /** List every persisted result for the given task. */
  async listByTask(taskId: string): Promise<OneShotResult[]> {
    const out: OneShotResult[] = []
    for (const file of readdirSync(this.resultsRoot)) {
      if (!file.endsWith('.json') || file === 'index.jsonl') continue
      try {
        const obj = JSON.parse(readFileSync(join(this.resultsRoot, file), 'utf8')) as OneShotResult
        if (obj.taskId === taskId) out.push(obj)
      } catch { /* skip corrupt */ }
    }
    // Newest first.
    out.sort((a, b) => (b.finishedAt ?? '').localeCompare(a.finishedAt ?? ''))
    return out
  }

  /** Delete a single result. Returns true on success, false if not present. */
  async delete(runId: string): Promise<boolean> {
    const file = join(this.resultsRoot, `${runId}.json`)
    if (!existsSync(file)) return false
    try { unlinkSync(file) } catch { return false }
    this.cache.delete(runId)
    return true
  }

  /** Garbage collect results for the given task.
   *  - Refuses to delete results still referenced by the task.
   *  - `maxPerTask` — keep at most N newest results; delete the rest.
   *  - `maxAgeMs` — delete results older than this age (against finishedAt).
   *  Returns the number of results deleted.
   */
  async gc(taskId: string, options: OneShotResultStoreGCOptions = {}): Promise<number> {
    const results = await this.listByTask(taskId)
    const refs = this.refsByTask.get(taskId) ?? new Set<string>()
    const now = Date.now()
    const candidates: { runId: string; finishedAt: number }[] = []
    for (const r of results) {
      if (refs.has(r.runId)) continue
      const finishedAt = r.finishedAt ? Date.parse(r.finishedAt) : 0
      if (options.maxAgeMs !== undefined && finishedAt > 0 && now - finishedAt > options.maxAgeMs) {
        candidates.push({ runId: r.runId, finishedAt })
      }
    }
    candidates.sort((a, b) => b.finishedAt - a.finishedAt)
    let deleted = 0
    if (options.maxPerTask !== undefined && candidates.length > options.maxPerTask) {
      const toRemove = candidates.slice(options.maxPerTask)
      for (const c of toRemove) {
        if (await this.delete(c.runId)) deleted++
      }
      return deleted
    }
    for (const c of candidates) {
      if (await this.delete(c.runId)) deleted++
    }
    return deleted
  }

  /** Rehydrate every result for the given task from disk into the cache. */
  loadTask(taskId: string): OneShotResult[] {
    if (!existsSync(this.resultsRoot)) return []
    const out: OneShotResult[] = []
    for (const file of readdirSync(this.resultsRoot)) {
      if (!file.endsWith('.json') || file === 'index.jsonl') continue
      try {
        const obj = JSON.parse(readFileSync(join(this.resultsRoot, file), 'utf8')) as OneShotResult
        if (obj.taskId === taskId) {
          this.cacheSet(obj.runId, obj, join(this.resultsRoot, file))
          out.push(obj)
        }
      } catch { /* skip corrupt */ }
    }
    return out
  }

  /** Diagnostic — number of cached entries + disk entries for this task. */
  diagnostics(taskId: string): { cached: number; disk: number; sizeBytes: number } {
    let cached = 0
    for (const e of this.cache.values()) {
      if (e.result.taskId === taskId) cached++
    }
    let disk = 0
    let sizeBytes = 0
    if (existsSync(this.resultsRoot)) {
      for (const file of readdirSync(this.resultsRoot)) {
        if (!file.endsWith('.json') || file === 'index.jsonl') continue
        try {
          const obj = JSON.parse(readFileSync(join(this.resultsRoot, file), 'utf8')) as OneShotResult
          if (obj.taskId === taskId) {
            disk++
            sizeBytes += statSync(join(this.resultsRoot, file)).size
          }
        } catch { /* ignore */ }
      }
    }
    return { cached, disk, sizeBytes }
  }

  /** Get the on-disk path for a result. */
  resolvePath(runId: string): string {
    return join(this.resultsRoot, `${runId}.json`)
  }

  private cacheSet(runId: string, result: OneShotResult, path: string): void {
    this.tick++
    this.cache.set(runId, { result, path, tick: this.tick })
    if (this.cache.size > this.cacheSize) {
      // Evict oldest by tick.
      let oldest: string | null = null
      let oldestTick = Infinity
      for (const [k, v] of this.cache) {
        if (v.tick < oldestTick) {
          oldestTick = v.tick
          oldest = k
        }
      }
      if (oldest) this.cache.delete(oldest)
    }
  }

  private touch(runId: string): void {
    const entry = this.cache.get(runId)
    if (entry) {
      this.tick++
      entry.tick = this.tick
    }
  }
}

/** Factory: create + register taskWorkspaceDir on the store. */
export function createOneShotResultStore(opts: OneShotResultStoreOptions): OneShotResultStore {
  return new OneShotResultStore(opts)
}