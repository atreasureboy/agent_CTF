/**
 * ProcessRunner — local process execution.
 *
 * Used for tightly audited binaries (file, strings, exiftool, etc.) where
 * containerization overhead is undesirable. Crucially:
 *
 *   - never blocks beyond manifest.resources.timeoutSeconds;
 *   - emits stdout/stderr to files in `logDir` (not in memory);
 *   - honors `signal` for parent-task cancel;
 *   - records exit code, signal, and a truncation flag.
 *
 * ProcessRunner is intentionally minimal — heavy work like nmap is
 * routed through ContainerRunner per the goal's default-container rule.
 */

import { spawn } from 'child_process'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomBytes } from 'crypto'
import type {
  OneShotManifest,
  OneShotResult,
  OneShotStatus,
} from './types.js'
import type { OneShotRunner, RunnerInputs } from './runner.js'

export class ProcessRunner implements OneShotRunner {
  /** Always-defined progress hooks for the dispatcher; concrete here. */
  async run(manifest: OneShotManifest, inputs: RunnerInputs): Promise<OneShotResult> {
    const runId = `osp_${randomBytes(6).toString('hex')}`
    const startedAt = new Date().toISOString()
    if (!existsSync(inputs.logDir)) mkdirSync(inputs.logDir, { recursive: true })

    const stdoutPath = join(inputs.logDir, `${runId}.stdout.log`)
    const stderrPath = join(inputs.logDir, `${runId}.stderr.log`)
    // Touch both files so tests can read them even on early failure.
    writeFileSync(stdoutPath, '')
    writeFileSync(stderrPath, '')

    const cmd = manifest.runner.command ?? []
    if (cmd.length === 0) {
      return this.fail(runId, manifest, startedAt, 'failed', 'manifest.runner.command is empty')
    }

    const fullArgv = [...cmd, ...inputs.argv]
    const [head, ...rest] = fullArgv
    const signal = inputs.signal
    const maxBytes = manifest.resources.maxOutputBytes

    return new Promise<OneShotResult>((resolve) => {
      const child = spawn(head!, rest, {
        cwd: inputs.workspace,
        env: { ...process.env, ...(inputs.env ?? {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdoutBytes = 0
      let stderrBytes = 0
      let truncated = false
      let stderrTruncated = false

      const outStream = (require('fs') as typeof import('fs')).createWriteStream(stdoutPath, { flags: 'a' })
      const errStream = (require('fs') as typeof import('fs')).createWriteStream(stderrPath, { flags: 'a' })

      child.stdout.on('data', (chunk: Buffer) => {
        if (stdoutBytes + chunk.length > maxBytes) {
          truncated = true
          return
        }
        stdoutBytes += chunk.length
        outStream.write(chunk)
      })
      child.stderr.on('data', (chunk: Buffer) => {
        if (stderrBytes + chunk.length > maxBytes) {
          stderrTruncated = true
          return
        }
        stderrBytes += chunk.length
        errStream.write(chunk)
      })

      // Timeout — kill the process group after the manifest's cap.
      const timeoutMs = manifest.resources.timeoutSeconds * 1000
      const timeoutHandle = setTimeout(() => {
        try { child.kill('SIGKILL') } catch { /* ignore */ }
      }, timeoutMs)

      // Abort — propagate parent cancel.
      const onAbort = (): void => {
        try { child.kill('SIGKILL') } catch { /* ignore */ }
      }
      if (signal) {
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
      }

      child.on('close', (code, sig) => {
        clearTimeout(timeoutHandle)
        if (signal) signal.removeEventListener('abort', onAbort)
        outStream.end()
        errStream.end()
        const finishedAt = new Date().toISOString()
        const durationMs = Date.parse(finishedAt) - Date.parse(startedAt)
        const sig_ = sig as NodeJS.Signals | null

        let status: OneShotStatus = 'completed'
        if (sig_ === 'SIGKILL' && signal?.aborted) status = 'cancelled'
        else if (sig_ === 'SIGKILL') status = 'timeout'
        else if (code !== 0) status = 'failed'

        resolve({
          runId,
          manifestId: manifest.id,
          taskId: '',
          status,
          startedAt,
          finishedAt,
          durationMs,
          findings: [],
          artifacts: [],
          candidates: [],
          diagnostics: {
            exitCode: code ?? undefined,
            signal: sig ?? undefined,
            stdoutPath,
            stderrPath,
            truncated: truncated || stderrTruncated,
            parserWarnings: [],
          },
          confidence: 0.5,
          falsePositiveRisk: manifest.scheduling.falsePositiveRisk,
          summary: `process-runner ${head} → ${status}`,
        })
      })
    })
  }

  async cancel(runId: string): Promise<void> {
    // ProcessRunner has no central table — the dispatcher kills the child
    // via the AbortSignal it owns. We accept the runId for API symmetry.
    void runId
  }

  private fail(
    runId: string,
    manifest: OneShotManifest,
    startedAt: string,
    status: OneShotStatus,
    error: string,
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
      diagnostics: { truncated: false, parserWarnings: [error] },
      confidence: 0,
      falsePositiveRisk: manifest.scheduling.falsePositiveRisk,
      summary: error,
    }
  }
}
