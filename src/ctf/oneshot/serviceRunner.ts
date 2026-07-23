/**
 * ServiceRunner — long-running local analysis services.
 *
 * Examples: AperiSolve, MobSF, FACT, EMBA. Pattern: submit a job, poll the
 * status endpoint, fetch the result. ServiceRunner does NOT start the service
 * itself — that's the operator's responsibility (containerised locally).
 *
 * Failure model:
 *   - network error / 5xx before submit  → `unavailable`;
 *   - submit accepted, no result in time → `timeout`;
 *   - operator cancel via AbortSignal   → `cancelled`;
 *   - service explicitly returns error  → `failed`.
 */

import { request } from 'http'
import { request as httpsRequest } from 'https'
import { URL } from 'url'
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
  /** Pre-built fetcher — tests inject a fake here. */
  fetcher?: typeof defaultFetcher
  /** Polling interval in milliseconds. */
  pollIntervalMs?: number
}

function defaultFetcher(
  url: string,
  method: 'GET' | 'POST',
  body: unknown,
  signal: AbortSignal,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const lib = u.protocol === 'https:' ? httpsRequest : request
    const req = lib(
      {
        method,
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        headers: { 'content-type': 'application/json' },
      },
      (res) => {
        let raw = ''
        res.on('data', (c) => (raw += c.toString()))
        res.on('end', () => {
          let parsed: unknown = raw
          try {
            parsed = raw ? JSON.parse(raw) : null
          } catch { /* keep raw */ }
          resolve({ status: res.statusCode ?? 0, body: parsed })
        })
      },
    )
    req.on('error', reject)
    if (signal.aborted) {
      req.destroy(new Error('aborted'))
      return
    }
    signal.addEventListener('abort', () => req.destroy(new Error('aborted')))
    if (body !== undefined) req.write(JSON.stringify(body))
    req.end()
  })
}

export class ServiceRunner implements OneShotRunner {
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

    try {
      const submitRes = await fetcher(submitUrl, 'POST', { argv: inputs.argv }, inputs.signal)
      if (submitRes.status >= 500) {
        return this.fail(runId, manifest, startedAt, 'unavailable', `submit ${submitRes.status}`, logPath)
      }
      const jobId = (submitRes.body as { id?: string })?.id
      if (!jobId) {
        return this.fail(runId, manifest, startedAt, 'failed', 'submit returned no id', logPath)
      }

      // Poll until completed or timeout.
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        if (inputs.signal.aborted) {
          return this.fail(runId, manifest, startedAt, 'cancelled', 'parent task aborted', logPath)
        }
        await new Promise((r) => setTimeout(r, pollIntervalMs))
        const pollRes = await fetcher(`${endpoint}/status/${jobId}`, 'GET', undefined, inputs.signal)
        if (pollRes.status >= 500) continue
        const body = pollRes.body as { status?: string; result?: unknown; error?: string }
        if (body.status === 'completed') {
          const finishedAt = new Date().toISOString()
          return {
            runId,
            manifestId: manifest.id,
            taskId: '',
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
      return this.fail(runId, manifest, startedAt, 'unavailable', (err as Error).message, logPath)
    }
  }

  async cancel(runId: string): Promise<void> {
    void runId
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
      taskId: '',
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
