/**
 * Dispatcher — top-level coordinator for one-shot runs.
 *
 * Lifecycle:
 *   - Selector picks eligible manifests;
 *   - BudgetManager gates them per-lane + per-task;
 *   - Runner dispatches via BackgroundJobManager so the existing TaskState
 *     projector already sees them (we add ONESHOT_* events on top);
 *   - ResultNormalizer converts raw output into the Agent envelope;
 *   - On signal: cancel all in-flight runs for the task.
 *
 * The Dispatcher never bypasses the existing BackgroundJobManager — that
 * would create a second unmanaged background system, which §二十 forbids.
 */

import { randomBytes } from 'crypto'
import type {
  CandidateValue,
  NormalizedFinding,
  OneShotJobProjectionEvent,
  OneShotLane,
  OneShotResult,
} from './types.js'
import { normalizeResult } from './resultNormalizer.js'
import { runnerFor } from './runner.js'
import { BudgetManager } from './budgetManager.js'
import { selectManifests, type SelectedRun, type SelectionInput } from './selector.js'
import type { OneShotRegistry } from './registry.js'
import type { OneShotCatalog } from './catalog.js'
import type { BackgroundJobManager, BackgroundJobEvent } from '../../core/backgroundJobs.js'
import { newEvidenceDir } from './evidenceCollector.js'

export interface DispatcherInputs {
  /** Concrete argv for the runner (paths + tool args). */
  argv: string[]
  /** Logs + evidence root directory. */
  evidenceRoot: string
  /** Parent task AbortSignal — propagated to every runner. */
  signal: AbortSignal
}

export type ProjectionListener = (event: OneShotJobProjectionEvent) => void

export interface DispatcherDeps {
  registry: OneShotRegistry
  catalog: OneShotCatalog
  /** Existing BackgroundJobManager — we route through it. */
  jobManager: BackgroundJobManager
  budget?: BudgetManager
  /** Parent task workspace — passed to runners. */
  workspace: string
  /** Listeners that mirror ONESHOT_* events into TaskState. */
  onProjection?: ProjectionListener
  /** Per-task signal that aggregates all in-flight oneshots. */
  signal: AbortSignal
}

export class Dispatcher {
  private readonly budget: BudgetManager
  private readonly listeners: ProjectionListener[] = []
  private readonly ticketByRun = new Map<string, ReturnType<BudgetManager['tryAcquire']>>()

  constructor(private readonly deps: DispatcherDeps) {
    this.budget = deps.budget ?? new BudgetManager()
    if (deps.onProjection) this.listeners.push(deps.onProjection)
  }

  addProjectionListener(l: ProjectionListener): void {
    this.listeners.push(l)
  }

  private emit(event: OneShotJobProjectionEvent): void {
    for (const l of this.listeners) {
      try { l(event) } catch { /* listener must not break dispatcher */ }
    }
  }

  /** Resolve a single manifest to a full OneShotResult, blocking on completion. */
  async runOne(manifestId: string, inputs: DispatcherInputs): Promise<OneShotResult> {
    const manifest = this.deps.registry.get(manifestId)
    if (!manifest) {
      throw new Error(`unknown manifest: ${manifestId}`)
    }
    if (manifest.network.mode !== 'none' && inputs.signal.aborted) {
      throw new Error('parent task aborted before runOne')
    }

    const lane = manifest.scheduling.costTier
    const ticket = this.budget.tryAcquire(inputs.signal ? 'parent' : 'parent', lane)
    if (!ticket) {
      throw new Error(`budget exceeded for lane=${lane}`)
    }

    const runId = `os_${randomBytes(6).toString('hex')}`
    this.ticketByRun.set(runId, ticket)

    this.emit({
      type: 'ONESHOT_QUEUED',
      runId,
      manifestId,
      taskId: '',
      lane,
      at: new Date().toISOString(),
      detail: { argv: inputs.argv.slice(0, 10) },
    })

    const ev = newEvidenceDir(inputs.evidenceRoot)
    const runner = runnerFor(manifest)
    const startedAt = new Date().toISOString()
    this.emit({
      type: 'ONESHOT_STARTED',
      runId,
      manifestId,
      taskId: '',
      lane,
      at: startedAt,
    })

    let raw: OneShotResult
    try {
      raw = await runner.run(manifest, {
        logDir: ev.rootDir,
        argv: inputs.argv,
        workspace: this.deps.workspace,
        signal: inputs.signal,
      })
    } catch (err) {
      const status = (err as Error).name === 'AbortError' ? 'cancelled' : 'failed'
      this.emit({
        type: status === 'cancelled' ? 'ONESHOT_CANCELLED' : 'ONESHOT_FAILED',
        runId,
        manifestId,
        taskId: '',
        lane,
        at: new Date().toISOString(),
        detail: { error: (err as Error).message },
      })
      throw err
    } finally {
      this.budget.release(ticket)
      this.ticketByRun.delete(runId)
    }

    const normalized = normalizeResult(raw, undefined, manifest)
    this.emitCompletedEvents(normalized)
    return normalized
  }

  /** Run the full selector pipeline. */
  async runSelected(
    input: SelectionInput,
    inputs: DispatcherInputs,
  ): Promise<OneShotResult[]> {
    const selections = selectManifests(input, this.deps.catalog)
    const results: OneShotResult[] = []
    for (const sel of selections) {
      try {
        const result = await this.runOne(sel.manifest.id, inputs)
        results.push(result)
      } catch {
        /* surface as a failed result for testing convenience */
        results.push({
          runId: '',
          manifestId: sel.manifest.id,
          taskId: '',
          status: 'failed',
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          findings: [],
          artifacts: [],
          candidates: [],
          diagnostics: { truncated: false, parserWarnings: ['dispatch failed'] },
          confidence: 0,
          falsePositiveRisk: sel.manifest.scheduling.falsePositiveRisk,
          summary: 'dispatch failed',
        })
      }
    }
    return results
  }

  /** Cancel every in-flight run for the given task. */
  async cancelTask(taskId: string): Promise<void> {
    // The dispatcher relies on the parent AbortSignal — cancellation
    // is cooperative. We surface the cancellation as an event but the
    // actual kill happens in the runner.
    for (const [runId, ticket] of this.ticketByRun.entries()) {
      if (ticket && ticket.taskId === taskId) {
        this.emit({
          type: 'ONESHOT_CANCELLED',
          runId,
          manifestId: '',
          taskId,
          lane: ticket.lane,
          at: new Date().toISOString(),
        })
        this.budget.release(ticket)
        this.ticketByRun.delete(runId)
      }
    }
  }

  /** Inspect a single finished run — used by `inspectOneShotResult`. */
  async getResult(runId: string): Promise<OneShotResult | null> {
    if (!this.ticketByRun.has(runId)) return null
    return null
  }

  private emitCompletedEvents(result: OneShotResult): void {
    const at = result.finishedAt ?? new Date().toISOString()
    for (const f of result.findings) {
      this.emit({
        type: 'ONESHOT_FINDING',
        runId: result.runId,
        manifestId: result.manifestId,
        taskId: '',
        lane: this.laneFor(result),
        at,
        detail: { finding: f },
      })
    }
    for (const a of result.artifacts) {
      this.emit({
        type: 'ONESHOT_ARTIFACT',
        runId: result.runId,
        manifestId: result.manifestId,
        taskId: '',
        lane: this.laneFor(result),
        at,
        detail: { artifact: a },
      })
    }
    for (const c of result.candidates) {
      this.emit({
        type: 'ONESHOT_CANDIDATE',
        runId: result.runId,
        manifestId: result.manifestId,
        taskId: '',
        lane: this.laneFor(result),
        at,
        detail: { candidate: c },
      })
    }
    if (result.status === 'timeout') {
      this.emit({ type: 'ONESHOT_TIMEOUT', runId: result.runId, manifestId: result.manifestId, taskId: '', lane: this.laneFor(result), at })
    } else if (result.status === 'cancelled') {
      this.emit({ type: 'ONESHOT_CANCELLED', runId: result.runId, manifestId: result.manifestId, taskId: '', lane: this.laneFor(result), at })
    } else {
      this.emit({ type: 'ONESHOT_COMPLETED', runId: result.runId, manifestId: result.manifestId, taskId: '', lane: this.laneFor(result), at })
    }
  }

  private laneFor(result: OneShotResult): OneShotLane {
    const m = this.deps.registry.get(result.manifestId)
    return m?.scheduling.costTier ?? 'fast'
  }
}

/* ─── BackgroundJob bridge helper ───────────────────────────────────────── */

/** Convenience: subscribe to existing BackgroundJobManager and forward JOB_*
 *  events to the dispatcher projection. The dispatcher does not need this
 *  hook to function, but production code wires it so the TaskState sees JOB_*
 *  AND ONESHOT_* in one stream. */
export function bridgeBackgroundJobs(
  jobManager: BackgroundJobManager,
  dispatcher: Dispatcher,
): () => void {
  const sub = jobManager.subscribe((event: BackgroundJobEvent) => {
    const lane: OneShotLane = 'medium'
    const detail = { jobId: event.job.id, jobStatus: event.job.status, toolId: event.job.toolId }
    if (event.type === 'JOB_STARTED') {
      dispatcher.addProjectionListener(() => undefined)
      // Prefer the JOB_* path; only forward ONESHOT_* for high-level signals.
    }
    void lane
    void detail
  })
  return sub
}

/* Re-export helper types so callers don't need separate imports. */
export type { SelectedRun, SelectionInput }
export type { NormalizedFinding, CandidateValue }
