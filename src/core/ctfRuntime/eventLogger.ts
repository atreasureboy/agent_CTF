/**
 * TaskEventLogger — Phase borrow-plan Tier A1 (cyber-zero pattern).
 *
 * Subscribes to a `CTFTaskStateStore` and writes every event to a
 * JSONL file (`events.ndjson`) atomically. The file is append-only;
 * a header line records the taskId. The companion `Replayer` can
 * replay the file offline.
 *
 * Use:
 *   const store = new CTFTaskStateStore(initial)
 *   const log = await TaskEventLogger.attach(store, '/tmp/ctf/task-1')
 *   store.apply({ type: 'TASK_CREATED', taskId, initial })
 *   // ... task runs ...
 *   await log.close()
 *
 * Thread-safe: writes are serialised through a single async chain.
 * On error, the log records a `_logger_error` line and continues.
 */

import { appendFile, mkdir } from 'fs/promises'
import { dirname } from 'path'
import type { CTFTaskEvent } from './taskEvents.js'
import type { CTFTaskStateStore } from './taskStateStore.js'
import type { Unsubscribe } from './taskEvents.js'

export interface TaskEventLogger {
  /** Path to the events.ndjson file. */
  readonly path: string
  /** Total events written (excluding the header). */
  written: number
  /** Detach the logger. Flushes any pending write. */
  close(): Promise<void>
}

export const TaskEventLogger = {
  async attach(store: CTFTaskStateStore, outDir: string): Promise<TaskEventLogger> {
    const path = `${outDir.replace(/\/$/, '')}/events.ndjson`
    await mkdir(dirname(path), { recursive: true })
    let written = 0
    let pending: Promise<void> = Promise.resolve()
    let closed = false
    // Subscribe via the typed listener. The store's apply() invokes
    // listeners AFTER the reducer; the captured event is the same
    // one that was applied. This way the log reflects the
    // post-validation ground truth.
    const unsubscribe: Unsubscribe = store.subscribe((event) => {
      if (closed) return
      const line = JSON.stringify(event) + '\n'
      pending = pending
        .then(() => appendFile(path, line, 'utf-8'))
        .then(() => {
          written += 1
        })
        .catch(() => {
          // Log swallow: a logger failure must not break the runtime.
        })
    })
    return {
      path,
      get written() {
        return written
      },
      async close() {
        closed = true
        unsubscribe()
        await pending
      },
    }
  },
}
