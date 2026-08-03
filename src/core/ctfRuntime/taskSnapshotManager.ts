import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { CTFTaskState } from './taskState.js'
import { CTFTaskStateStore } from './taskStateStore.js'

export interface TaskSnapshotMetadata {
  snapshotId: string
  taskId: string
  phase: string
  revision: number
  timestamp: string
  activeProfileId: string
  version: string
  checksum: string
}

export interface TaskSnapshotBundle {
  metadata: TaskSnapshotMetadata
  state: CTFTaskState
}

export class TaskSnapshotManager {
  public static readonly SNAPSHOT_VERSION = '1.0.0'

  /**
   * Serialize current CTFTaskStateStore to a JSON snapshot string.
   */
  public static exportSnapshotJSON(store: CTFTaskStateStore): string {
    const state = store.getState()
    const revision = store.getRevision()
    const rawContent = JSON.stringify(state)
    const checksum = createHash('sha256').update(rawContent).digest('hex')

    const bundle: TaskSnapshotBundle = {
      metadata: {
        snapshotId: `snap_${state.taskId}_rev${revision}_${Date.now()}`,
        taskId: state.taskId,
        phase: state.phase,
        revision,
        timestamp: new Date().toISOString(),
        activeProfileId: state.activeProfileId,
        version: TaskSnapshotManager.SNAPSHOT_VERSION,
        checksum,
      },
      state,
    }
    return JSON.stringify(bundle, null, 2)
  }

  /**
   * Restore a new CTFTaskStateStore instance from a JSON snapshot string with SHA-256 checksum verification.
   */
  public static restoreStoreFromJSON(json: string): CTFTaskStateStore {
    const bundle = JSON.parse(json) as TaskSnapshotBundle
    if (!bundle.metadata || !bundle.state) {
      throw new Error('[TaskSnapshotManager] Invalid snapshot bundle: missing metadata or state.')
    }
    if (bundle.metadata.checksum) {
      const computedChecksum = createHash('sha256')
        .update(JSON.stringify(bundle.state))
        .digest('hex')
      if (computedChecksum !== bundle.metadata.checksum) {
        throw new Error(
          `[TaskSnapshotManager] Snapshot Checksum Verification Failed! Computed: ${computedChecksum}, Metadata: ${bundle.metadata.checksum}`,
        )
      }
    }
    return new CTFTaskStateStore(bundle.state)
  }

  /**
   * Save snapshot file directly to disk directory.
   */
  public static saveSnapshot(store: CTFTaskStateStore, snapshotDir: string): string {
    if (!existsSync(snapshotDir)) {
      mkdirSync(snapshotDir, { recursive: true })
    }
    const state = store.getState()
    const json = TaskSnapshotManager.exportSnapshotJSON(store)
    const filepath = join(snapshotDir, `${state.taskId}.snapshot.json`)
    writeFileSync(filepath, json, 'utf-8')
    return filepath
  }

  /**
   * Load snapshot file from disk directory.
   */
  public static loadSnapshot(filepath: string): CTFTaskStateStore {
    if (!existsSync(filepath)) {
      throw new Error(`[TaskSnapshotManager] Snapshot file not found: "${filepath}"`)
    }
    const json = readFileSync(filepath, 'utf-8')
    return TaskSnapshotManager.restoreStoreFromJSON(json)
  }
}
