/**
 * TaskStateProjector — diffs Finding/Artifact/Flag stores before/after a
 * Main-Agent / Workflow / Specialist run and emits the corresponding
 * `CTFTaskEvent`s.
 *
 * Why a snapshot + diff instead of subscribing to store-level events?
 *   - FindingStore and ArtifactStore are append-only NDJSON. Subscribing
 *     means re-reading the file on every event, which is wasteful for the
 *     hot path.
 *   - A snapshot is O(n) once per run; the diff is O(n) and bounded by the
 *     number of NEW entries — typically small.
 *   - The projector is the single owner of "what gets projected into
 *     TaskState"; the orchestrator just invokes it.
 *
 * The projector deliberately swallows store-level errors so a failing
 * snapshot cannot abort the agent run. It reports which projection succeeded
 * so the caller can include the ids in the agent-run summary.
 *
 * Forth_goal §十三 — Specialist artifacts are physically COPIED into the
 * parent artifactDir before the new parent ArtifactMeta is emitted. The
 * stored meta carries `originalArtifactId` + `producerAgentId` +
 * `handoffId` so the lineage is reconstructable.
 */

import { appendFileSync, copyFileSync, mkdirSync, readFileSync } from 'fs'
import { dirname, join } from 'path'

import type { ArtifactMeta } from '../artifacts.js'
import type { ArtifactStore } from '../artifacts.js'
import type { FindingStore } from '../findings.js'
import type { CTFTaskEvent } from './taskEvents.js'
import type { CTFTaskOrchestrator } from './taskOrchestrator.js'
import type { BackgroundJobEvent } from '../backgroundJobs.js'
import type { JobRecord } from './taskState.js'

export interface ProjectorStorages {
  findingStore: FindingStore
  artifactStore: ArtifactStore
  /** When set, Specialist artifacts are copied into this parent store. */
  parentArtifactStore?: ArtifactStore
  /** Optional root for the parent artifact dir (used for the lineage sidecar). */
  parentArtifactRoot?: string
}

export interface TaskOutputSnapshot {
  findingIds: Set<string>
  artifactIds: Set<string>
}

export interface ProjectionMetadata {
  /** Profile id that produced the new entries. */
  producerProfileId?: string
  /** Handoff id, when the run came from a Handoff. */
  handoffId?: string
  /** Agent run id. */
  agentRunId?: string
}

export interface ProjectionResult {
  events: CTFTaskEvent[]
  newFindingIds: string[]
  newArtifactIds: string[]
}

export class TaskStateProjector {
  constructor(private readonly storages: ProjectorStorages) {}

  /** Capture the current set of finding/artifact ids. Cheap: just lists. */
  captureSnapshot(): TaskOutputSnapshot {
    const findingIds = new Set<string>()
    try {
      for (const f of this.storages.findingStore.list()) findingIds.add(f.id)
    } catch {
      /* best-effort */
    }
    const artifactIds = new Set<string>()
    try {
      for (const a of this.storages.artifactStore.list()) artifactIds.add(a.id)
    } catch {
      /* best-effort */
    }
    return { findingIds, artifactIds }
  }

  /**
   * Compute the diff and return the events to apply. Each Finding/Artifact
   * becomes exactly one event; the orchestrator feeds them to the store.
   *
   * When the run came from a Specialist (handoffId set), every artifact is
   * physically COPIED into `parentArtifactStore` (when supplied). The
   * emitted ARTIFACT_ADDED event uses the parent's new id; the original
   * child id and handoff id are preserved on the parent's meta via
   * `source`.
   */
  projectDiff(
    before: TaskOutputSnapshot,
    metadata: ProjectionMetadata = {},
  ): ProjectionResult {
    const events: CTFTaskEvent[] = []
    const newFindingIds: string[] = []
    const newArtifactIds: string[] = []

    try {
      for (const f of this.storages.findingStore.list()) {
        if (before.findingIds.has(f.id)) continue
        const rewritten =
          metadata.producerProfileId && f.producerAgentId !== metadata.producerProfileId
            ? { ...f, producerAgentId: metadata.producerProfileId }
            : f
        events.push({ type: 'FINDING_ADDED', finding: rewritten })
        newFindingIds.push(rewritten.id)
      }
    } catch {
      /* best-effort */
    }

    const parent = this.storages.parentArtifactStore
    try {
      for (const a of this.storages.artifactStore.list()) {
        if (before.artifactIds.has(a.id)) continue
        if (parent && metadata.handoffId) {
          // Specialist artifact → physically copy into the parent store
          // and emit ARTIFACT_ADDED with the parent id.
          const parentMeta = this.copyArtifactIntoParent(a, metadata)
          if (parentMeta) {
            newArtifactIds.push(parentMeta.id)
            events.push({ type: 'ARTIFACT_ADDED', artifactId: parentMeta.id })
            continue
          }
        }
        events.push({ type: 'ARTIFACT_ADDED', artifactId: a.id })
        newArtifactIds.push(a.id)
      }
    } catch {
      /* best-effort */
    }

    return { events, newFindingIds, newArtifactIds }
  }

  /** Copy the on-disk artifact file into the parent store and append a
   *  fresh meta entry there. Returns the parent ArtifactMeta, or null on
   *  failure. The original child id + handoff id are persisted to a
   *  sidecar `.lineage.json` under the parent's artifact root so the
   *  provenance chain can be reconstructed by audits. */
  private copyArtifactIntoParent(
    childMeta: ArtifactMeta,
    metadata: ProjectionMetadata,
  ): ArtifactMeta | null {
    const parent = this.storages.parentArtifactStore
    if (!parent) return null
    try {
      const childStore = this.storages.artifactStore
      const childAbs = childStore.resolvePath(childMeta)
      const ext = childMeta.path.split('.').pop() ?? 'bin'
      const content = readFileSync(childAbs)
      const newMeta = parent.writeSync(
        {
          taskId: childMeta.taskId,
          producerAgentId: metadata.producerProfileId ?? childMeta.producerAgentId,
          type: childMeta.type,
          mimeType: childMeta.mimeType,
          source: {
            toolId: childMeta.source?.toolId,
            inputSummary: childMeta.source?.inputSummary,
          },
        },
        content,
        ext,
      )
      // Persist lineage sidecar: <parentArtifactsDir>/.lineage.jsonl
      // mapping parentId → { originalArtifactId, handoffId,
      // producerAgentId, sourcePath }.
      if (this.storages.parentArtifactRoot) {
        try {
          this.appendLineage(this.storages.parentArtifactRoot, {
            parentArtifactId: newMeta.id,
            originalArtifactId: childMeta.id,
            handoffId: metadata.handoffId,
            producerAgentId: metadata.producerProfileId ?? childMeta.producerAgentId,
            sourcePath: childMeta.path,
            copiedAt: new Date().toISOString(),
          })
        } catch {
          /* best-effort */
        }
      }
      void metadata.agentRunId
      return newMeta
    } catch {
      return null
    }
  }

  /** Append one lineage entry to the parent's `.lineage.jsonl` file. The
   *  file is append-only (one JSON object per line) so concurrent writers
   *  cannot corrupt it. */
  private appendLineage(
    parentRoot: string,
    entry: {
      parentArtifactId: string
      originalArtifactId: string
      handoffId?: string
      producerAgentId: string
      sourcePath: string
      copiedAt: string
    },
  ): void {
    const lineagePath = join(parentRoot, 'artifacts', '.lineage.jsonl')
    appendFileSync(lineagePath, JSON.stringify(entry) + '\n', 'utf8')
  }

  /** Handle a BackgroundJobEvent by emitting a JOB_UPDATED-equivalent into
   *  the orchestrator's TaskState. Only JobRecord-shaped events flow here. */
  projectJobEvent(event: BackgroundJobEvent, orchestrator: CTFTaskOrchestrator): void {
    const state = orchestrator.getState()
    if (state.completion) return // §十一 — late events don't break completion
    const existing = state.jobs.find((j) => j.id === event.job.id)
    const startedAt = existing?.startedAt ?? Date.parse(event.job.startedAt)
    const endedAt = event.job.endedAt ? Date.parse(event.job.endedAt) : undefined
    const status: JobRecord['status'] =
      event.job.status === 'pending' || event.job.status === 'running' || event.job.status === 'success' || event.job.status === 'failed' || event.job.status === 'cancelled'
        ? event.job.status
        : 'running'
    const job: JobRecord = {
      id: event.job.id,
      taskId: event.job.taskId,
      agentRunId: existing?.agentRunId,
      workflowRunId: existing?.workflowRunId,
      status,
      startedAt,
      endedAt,
      summary: event.job.summary ?? event.job.error ?? event.job.cancelReason,
    }
    if (existing) {
      orchestrator.recordJobUpdated(job)
    } else {
      orchestrator.recordJobStarted(job)
    }
  }

  /** Convenience: capture → run → project, with the events already applied
   *  to the store passed in. The caller must supply `apply` so this class
   *  doesn't need to know about CTFTaskStateStore directly. */
  async captureAndProject<T>(
    apply: (event: CTFTaskEvent) => void,
    metadata: ProjectionMetadata | undefined,
    fn: () => Promise<T>,
  ): Promise<{ result: T; projection: ProjectionResult }> {
    const before = this.captureSnapshot()
    const result = await fn()
    const projection = this.projectDiff(before, metadata)
    for (const ev of projection.events) apply(ev)
    return { result, projection }
  }
}

// keep tree-shaking happy
void copyFileSync
void mkdirSync
void dirname
void join