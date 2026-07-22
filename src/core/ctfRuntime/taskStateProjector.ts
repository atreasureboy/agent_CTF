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

import {
  appendFileSync,
  statSync,
} from 'fs'
import { join } from 'path'

import type { ArtifactMeta } from '../artifacts.js'
import { hashContentSync } from '../artifacts.js'
import type { ArtifactStore } from '../artifacts.js'
import type { FindingStore } from '../findings.js'
import type { CTFTaskEvent } from './taskEvents.js'
import type { CTFTaskOrchestrator } from './taskOrchestrator.js'
import type { BackgroundJobEvent } from '../backgroundJobs.js'
import type { JobRecord } from './taskState.js'

/**
 * Phase 1.7 §十三 — ProjectionError. Carries the stage at which the
 * projection failed so the Orchestrator can decide whether to surface it
 * to the caller (Main / Workflow / Specialist) or downgrade to a
 * non-fatal Handoff `projection` failure.
 */
export class ProjectionError extends Error {
  constructor(
    message: string,
    readonly stage:
      | 'snapshot'
      | 'finding'
      | 'artifact-copy'
      | 'artifact-store'
      | 'state',
    readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'ProjectionError'
  }
}

export interface ProjectorStorages {
  findingStore: FindingStore
  artifactStore: ArtifactStore
  /** When set, Specialist artifacts are copied into this parent store. */
  parentArtifactStore?: ArtifactStore
  /** Optional root for the parent artifact dir (used for the lineage sidecar). */
  parentArtifactRoot?: string
  /**
   * Phase 1.7 §十二 — when present, the projector reads from this
   * CHILD store to compute the diff (the Specialist writes here instead
   * of the parent store). Each specialist owns one.
   */
  childFindingStore?: FindingStore
  childArtifactStore?: ArtifactStore
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
  /** Workflow run id (when projecting a Workflow's outputs). */
  workflowRunId?: string
}

export interface ProjectionResult {
  events: CTFTaskEvent[]
  newFindingIds: string[]
  newArtifactIds: string[]
}

export class TaskStateProjector {
  constructor(private readonly storages: ProjectorStorages) {}

  /**
   * Phase 1.7 §十二 — return a new projector view scoped to a
   * Specialist's independent child stores. Reads from the child stores;
   * writes to the parent's parentArtifactStore + lineage sidecar.
   */
  withChildStores(childFinding: FindingStore, childArtifact: ArtifactStore): TaskStateProjector {
    return new TaskStateProjector({
      ...this.storages,
      childFindingStore: childFinding,
      childArtifactStore: childArtifact,
    })
  }

  /** Capture the current set of finding/artifact ids. Cheap: just lists.
   *  Phase 1.7 — surfaces real read errors as ProjectionError('snapshot')
   *  instead of silently returning an empty snapshot. Empty snapshots
   *  remain valid when the store genuinely has no entries.
   *  Optional `childFindingStore` / `childArtifactStore` override the
   *  default stores so callers (handoffCoordinator) can snapshot a
   *  specialist's independent child store. */
  captureSnapshot(
    childFindingStore?: FindingStore,
    childArtifactStore?: ArtifactStore,
  ): TaskOutputSnapshot {
    const findingIds = new Set<string>()
    const findingSrc = childFindingStore ?? this.storages.findingStore
    try {
      for (const f of findingSrc.list()) findingIds.add(f.id)
    } catch (err) {
      throw new ProjectionError(
        `finding snapshot failed: ${(err as Error).message}`,
        'snapshot',
        err,
      )
    }
    const artifactIds = new Set<string>()
    const artifactSrc = childArtifactStore ?? this.storages.artifactStore
    try {
      for (const a of artifactSrc.list()) artifactIds.add(a.id)
    } catch (err) {
      throw new ProjectionError(
        `artifact snapshot failed: ${(err as Error).message}`,
        'snapshot',
        err,
      )
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

    // Phase 1.7 §十二 — when the Specialist uses an independent store,
    // we read from the CHILD store and copy into the parent.
    const readingFindingStore =
      this.storages.childFindingStore ?? this.storages.findingStore
    const readingArtifactStore =
      this.storages.childArtifactStore ?? this.storages.artifactStore

    // §十三.3 — when a run-id is supplied, prefer filtering by it.
    // Items lacking run-id metadata still pass (legacy snapshot diff).
    const matchesRun = <T extends { agentRunId?: string; workflowRunId?: string; handoffId?: string }>(
      item: T,
      md: ProjectionMetadata,
    ): boolean => {
      // No run-id metadata → pass everything (snapshot diff is the truth).
      if (!md.agentRunId && !md.workflowRunId && !md.handoffId) return true
      // Items without run-id metadata pass when metadata is set so we
      // don't break the legacy path that emits without run-id.
      const itemHas = item.agentRunId || item.workflowRunId || item.handoffId
      if (!itemHas) return true
      if (md.agentRunId && item.agentRunId === md.agentRunId) return true
      if (md.workflowRunId && item.workflowRunId === md.workflowRunId) return true
      if (md.handoffId && item.handoffId === md.handoffId) return true
      return false
    }

    try {
      for (const f of readingFindingStore.list()) {
        if (before.findingIds.has(f.id)) continue
        if (!matchesRun(f, metadata)) continue
        const rewritten =
          metadata.producerProfileId && f.producerAgentId !== metadata.producerProfileId
            ? { ...f, producerAgentId: metadata.producerProfileId }
            : f
        events.push({ type: 'FINDING_ADDED', finding: rewritten })
        newFindingIds.push(rewritten.id)
      }
    } catch (err) {
      throw new ProjectionError(
        `finding projection failed: ${(err as Error).message}`,
        'finding',
        err,
      )
    }

    const parent = this.storages.parentArtifactStore
    try {
      for (const a of readingArtifactStore.list()) {
        if (before.artifactIds.has(a.id)) continue
        if (parent && metadata.handoffId) {
          // Specialist artifact path — copy into parent store. We don't
          // filter by run-id here because the child meta may not yet
          // carry the handoffId field; the parent copy propagates the
          // run-id onto the parent's meta for future filtering.
          const parentMeta = this.copyArtifactIntoParent(a, metadata)
          if (!parentMeta) {
            throw new ProjectionError(
              `artifact copy failed for ${a.id} (handoff=${metadata.handoffId})`,
              'artifact-copy',
            )
          }
          newArtifactIds.push(parentMeta.id)
          events.push({ type: 'ARTIFACT_ADDED', artifactId: parentMeta.id })
          continue
        }
        if (!matchesRun(a, metadata)) continue
        events.push({ type: 'ARTIFACT_ADDED', artifactId: a.id })
        newArtifactIds.push(a.id)
      }
    } catch (err) {
      if (err instanceof ProjectionError) throw err
      throw new ProjectionError(
        `artifact projection failed: ${(err as Error).message}`,
        'artifact-store',
        err,
      )
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
      // Audit rounds 6-10 — read from the configured child store
      // (withChildStores scopes the projector) so the child's artifact
      // is found at the right path. The previous code used
      // `this.storages.artifactStore` (the parent store) which made
      // every Specialist artifact projection fail with ENOENT.
      const childStore = this.storages.childArtifactStore ?? this.storages.artifactStore
      const childAbs = childStore.resolvePath(childMeta)
      const ext = childMeta.path.split('.').pop() ?? 'bin'
      // §十七 — streaming copy via fs streams so we never load the
      // whole file into memory. Use statSync for size + sha256 (we
      // can't hash a stream from outside the file API without
      // re-reading, so we accept a single read for metadata; the
      // payload itself is streamed).
      const stat = statSync(childAbs)
      const sha = hashContentSync(childAbs)
      const newMeta = parent.writeStreamingSync({
        taskId: childMeta.taskId,
        producerAgentId: metadata.producerProfileId ?? childMeta.producerAgentId,
        type: childMeta.type,
        mimeType: childMeta.mimeType,
        agentRunId: metadata.agentRunId ?? childMeta.agentRunId,
        workflowRunId: metadata.workflowRunId ?? childMeta.workflowRunId,
        handoffId: metadata.handoffId ?? childMeta.handoffId,
        source: {
          toolId: childMeta.source?.toolId,
          inputSummary: childMeta.source?.inputSummary,
        },
        size: stat.size,
        sha256: sha,
        suggestedExt: ext,
        sourcePath: childAbs,
      })
      // Persist lineage sidecar: <parentArtifactsDir>/.lineage.jsonl
      // mapping parentId → { originalArtifactId, handoffId,
      // producerAgentId, sourcePath }.
      if (this.storages.parentArtifactRoot) {
        this.appendLineage(this.storages.parentArtifactRoot, {
          parentArtifactId: newMeta.id,
          originalArtifactId: childMeta.id,
          handoffId: metadata.handoffId,
          producerAgentId: metadata.producerProfileId ?? childMeta.producerAgentId,
          sourcePath: childMeta.path,
          copiedAt: new Date().toISOString(),
        })
      }
      void metadata.agentRunId
      return newMeta
    } catch (err) {
      throw new ProjectionError(
        `artifact copy failed for ${childMeta.id}: ${(err as Error).message}`,
        'artifact-copy',
        err,
      )
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

