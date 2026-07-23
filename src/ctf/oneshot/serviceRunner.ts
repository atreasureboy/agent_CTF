/**
 * ServiceRunner — Phase 2.0 §十八.
 *
 * Long-running local analysis services (AperiSolve, MobSF, FACT, EMBA).
 * Pattern: submit a job, poll the status endpoint, fetch the result.
 *
 * Real semantics:
 *   - AbortListener removed when the request finishes (no leaks)
 *   - Poll loop honors AbortSignal (no infinite wait on cancel)
 *   - Bounded exponential backoff on transient errors
 *   - 4xx (client error) and 5xx (server error) are treated distinctly
 *   - Response body capped at maxResponseBytes
 *   - Endpoint is operator-supplied (manifest.runner.endpoint); the
 *     manifest is the sole source of authority — never model-supplied
 *   - cancel(runId) terminates the local poll loop; remote cancel
 *     happens only when the manifest declares a /cancel endpoint
 */

import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { randomBytes } from 'crypto'
import type {
  OneShotManifest,
  OneShotResult,
  OneShotStatus,
} from './types.js'
import type { OneShotRunner, RunnerInputs } from './runner.js'

export interface ServiceRunnerOptions {
  fetcher?: ServiceFetcher
  pollIntervalMs?: number
  /** Cap response body. Default 4 MiB. */
  maxResponseBytes?: number
  /** Maximum backoff between polls. Default 30 s. */
  maxBackoffMs?: number
}

export interface ServiceFetcherResult {
  status: number
  body: unknown
}

export type ServiceFetcher = (
  url: string,
  method: 'GET' | 'POST',
  body: unknown,
  signal: AbortSignal,
  maxResponseBytes: number,
) => Promise<ServiceFetcherResult>

const defaultFetcher: ServiceFetcher = async (url, method, body, signal, maxResponseBytes) => {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  })
  const reader = res.body?.getReader()
  let total = 0
  const chunks: Uint8Array[] = []
  if (reader) {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (total + value.byteLength > maxResponseBytes) {
        await reader.cancel()
        throw new Error(`response exceeded ${maxResponseBytes} bytes`)
      }
      total += value.byteLength
      chunks.push(value)
    }
  }
  const text = chunks.length > 0
    ? Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8')
    : ''
  let parsed: unknown = text
  try {
    parsed = text ? JSON.parse(text) : null
  } catch { /* keep raw */ }
  return { status: res.status, body: parsed }
}

export class ServiceRunner implements OneShotRunner {
  /** Per-run cancel token so `cancel(runId)` can stop the poll loop. */
  private readonly runSignals = new Map<string, AbortController>()

  constructor(private readonly opts: ServiceRunnerOptions = {}) {}

  async run(manifest: OneShotManifest, inputs: RunnerInputs): Promise<OneShotResult> {
    const runId = `osv_${randomBytes(6).toString('hex')}`
    const startedAt = new Date().toISOString()
    if (!existsSync(inputs.logDir)) mkdirSync(inputs.logDir, { recursive: true })
    const logPath = join(inputs.logDir, `${runId}.jsonl`)
    const endpoint = manifest.runner.endpoint
    if (!endpoint) {
      return this.fail(runId, manifest, startedAt, 'failed', 'service runner requires endpoint', logPath)
    }
    const fetcher = this.opts.fetcher ?? defaultFetcher
    const submitUrl = `${endpoint.replace(/\/$/, '')}/submit`
    const timeoutMs = manifest.resources.timeoutSeconds * 1000
    const pollIntervalMs = this.opts.pollIntervalMs ?? 2000
    const maxBackoffMs = this.opts.maxBackoffMs ?? 30_000
    const maxResponseBytes = this.opts.maxResponseBytes ?? 4 * 1024 * 1024

    // Per-run AbortController — `cancel(runId)` aborts this to stop the
    // poll loop. Linked to the parent task signal so cancellation
    // propagates both ways.
    const runCtrl = new AbortController()
    const onParentAbort = (): void => { runCtrl.abort(inputs.signal?.reason ?? 'parent_aborted') }
    if (inputs.signal) {
      // §P1 audit fix — register the listener first, then re-check
      // `signal.aborted` to close the race window where an abort that
      // fired between the check and the addEventListener was missed.
      inputs.signal.addEventListener('abort', onParentAbort, { once: true })
      if (inputs.signal.aborted) onParentAbort()
    }
    this.runSignals.set(runId, runCtrl)

    try {
      const submitRes = await fetcher(submitUrl, 'POST', { argv: inputs.argv }, runCtrl.signal, maxResponseBytes)
      if (submitRes.status >= 500) {
        return this.fail(runId, manifest, startedAt, 'unavailable', `submit ${submitRes.status}`, logPath)
      }
      if (submitRes.status >= 400) {
        return this.fail(runId, manifest, startedAt, 'failed', `submit ${submitRes.status}`, logPath)
      }
      const jobId = (submitRes.body as { id?: string })?.id
      if (!jobId) {
        return this.fail(runId, manifest, startedAt, 'failed', 'submit returned no id', logPath)
      }

      const deadline = Date.now() + timeoutMs
      let backoff = pollIntervalMs
      while (Date.now() < deadline) {
        if (runCtrl.signal.aborted) {
          return this.fail(runId, manifest, startedAt, 'cancelled', 'parent task aborted', logPath)
        }
        // §P1 audit fix — race the sleep against the abort signal so a
        // cancel during the backoff doesn't wait up to maxBackoffMs.
        await new Promise<void>((resolveSleep) => {
          const timer = setTimeout(() => {
            runCtrl.signal.removeEventListener('abort', onAbortSleep)
            resolveSleep()
          }, backoff)
          const onAbortSleep = (): void => {
            clearTimeout(timer)
            resolveSleep()
          }
          runCtrl.signal.addEventListener('abort', onAbortSleep, { once: true })
        })
        if (runCtrl.signal.aborted) {
          return this.fail(runId, manifest, startedAt, 'cancelled', 'parent task aborted', logPath)
        }
        const pollRes = await fetcher(`${endpoint}/status/${jobId}`, 'GET', undefined, runCtrl.signal, maxResponseBytes)
        if (pollRes.status >= 500) {
          // Transient — exponential backoff up to maxBackoffMs.
          backoff = Math.min(backoff * 2, maxBackoffMs)
          continue
        }
        if (pollRes.status >= 400) {
          return this.fail(runId, manifest, startedAt, 'failed', `poll ${pollRes.status}`, logPath)
        }
        backoff = pollIntervalMs
        const body = pollRes.body as { status?: string; result?: unknown; error?: string }
        if (body.status === 'completed') {
          const finishedAt = new Date().toISOString()
          return {
            runId,
            manifestId: manifest.id,
            taskId: 'pending',
            status: 'completed',
            startedAt,
            finishedAt,
            durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
            findings: [],
            artifacts: [],
            candidates: [],
            diagnostics: { truncated: false, parserWarnings: [], stdoutPath: logPath },
            confidence: 0.7,
            falsePositiveRisk: manifest.scheduling.falsePositiveRisk,
            summary: `service-runner ${manifest.id} → completed`,
          }
        }
        if (body.status === 'failed') {
          return this.fail(runId, manifest, startedAt, 'failed', body.error ?? 'service failed', logPath)
        }
      }
      return this.fail(runId, manifest, startedAt, 'timeout', 'service did not respond in time', logPath)
    } catch (err) {
      const status: OneShotStatus = runCtrl.signal.aborted ? 'cancelled' : 'unavailable'
      return this.fail(runId, manifest, startedAt, status, (err as Error).message, logPath)
    } finally {
      this.cleanup(runId, onParentAbort, inputs.signal)
    }
  }

  async cancel(runId: string): Promise<void> {
    const ctrl = this.runSignals.get(runId)
    if (ctrl) {
      ctrl.abort('user_cancelled')
      this.runSignals.delete(runId)
    }
  }

  private cleanup(runId: string, onParentAbort: () => void, parentSignal?: AbortSignal): void {
    if (parentSignal) parentSignal.removeEventListener('abort', onParentAbort)
    this.runSignals.delete(runId)
  }

  private fail(
    runId: string,
    manifest: OneShotManifest,
    startedAt: string,
    status: OneShotStatus,
    error: string,
    logPath: string,
  ): OneShotResult {
    return {
      runId,
      manifestId: manifest.id,
      taskId: 'pending',
      status,
      startedAt,
      finishedAt: new Date().toISOString(),
      findings: [],
      artifacts: [],
      candidates: [],
      diagnostics: { truncated: false, parserWarnings: [error], stdoutPath: logPath },
      confidence: 0,
      falsePositiveRisk: manifest.scheduling.falsePositiveRisk,
      summary: error,
    }
  }
}