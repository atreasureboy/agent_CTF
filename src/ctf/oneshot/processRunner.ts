/**
 * ProcessRunner — Phase 2.0 §十六.
 *
 * Real process execution with:
 *   - proper ESM imports (no require('fs'))
 *   - runId → child map for per-run cancellation
 *   - POSIX process group + SIGKILL of the whole group
 *   - stdout/stderr stream drain awaited before resolve
 *   - oversized chunk truncation that doesn't drop the allowed bytes
 *   - timeout/cancelled/failed distinguished
 *   - spawn error events resolve the promise (no hangs)
 *   - timer + abort listener cleanup
 */

import { spawn, type ChildProcess } from 'child_process'
import { createWriteStream, existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomBytes } from 'crypto'
import type {
  OneShotManifest,
  OneShotResult,
  OneShotStatus,
} from './types.js'
import type { OneShotRunner, RunnerInputs } from './runner.js'

/**
 * §round-2 audit fix — build a strict allow-list env. The previous
 * `...process.env` propagation exposed OPENAI_API_KEY, GitHub tokens,
 * etc. to every spawned subprocess. A manifest template like
 * `["bash","-c","echo $OPENAI_API_KEY"]` exfiltrated secrets via the
 * captured log file.
 *
 * Allow-listed vars are passed through; everything matching common
 * secret patterns (API_KEY/TOKEN/SECRET/PRIVATE/PASSWORD/CREDENTIALS) is
 * stripped. Manifest-supplied `inputs.env` may opt-in additional vars
 * via `inputs.env.<name>`, but only those names survive.
 */
function buildSafeEnv(inputsEnv?: Record<string, string>): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  // Always-pass-through safe vars.
  const ALLOW = new Set([
    'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL',
    'LC_CTYPE', 'LC_MESSAGES', 'LC_COLLATE', 'TMPDIR', 'TMP', 'TEMP',
    'TZ', 'PWD', 'OLDPWD', 'TERM', 'COLORTERM', 'NODE_PATH',
    'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
    'XDG_CACHE_HOME', 'XDG_STATE_HOME',
  ])
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue
    if (ALLOW.has(k)) out[k] = v
  }
  // Allow only opt-in env vars supplied via `inputs.env`. Pattern-match
  // each name against secret heuristics and reject any match.
  if (inputsEnv) {
    const SECRET_RE = /api[_-]?key|token|secret|private|password|credential|passwd/i
    for (const [k, v] of Object.entries(inputsEnv)) {
      if (SECRET_RE.test(k)) continue
      out[k] = v
    }
  }
  return out
}

export class ProcessRunner implements OneShotRunner {
  /** runId → child for per-run cancellation. */
  private readonly children = new Map<string, ChildProcess>()

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
      let child: ChildProcess
      try {
        child = spawn(head, rest, {
          cwd: inputs.workspace,
          // §round-2 audit fix — use a strict allow-list env. The previous
          // `...process.env` propagation exposed OPENAI_API_KEY, GitHub
          // tokens, etc. to every spawned subprocess. Manifest templates
          // like `["bash","-c","echo $OPENAI_API_KEY"]` exfiltrated them.
          env: buildSafeEnv(inputs.env),
          stdio: ['ignore', 'pipe', 'pipe'],
          // Spawn detached so we can kill the whole process group on
          // cancel/timeout. Setsid-equivalent on POSIX.
          detached: process.platform !== 'win32',
        })
      } catch (err) {
        resolve(this.fail(runId, manifest, startedAt, 'failed', `spawn failed: ${(err as Error).message}`))
        return
      }

      this.children.set(runId, child)

      let stdoutBytes = 0
      let stderrBytes = 0
      let truncated = false
      let stderrTruncated = false

      const outStream = createWriteStream(stdoutPath, { flags: 'a' })
      const errStream = createWriteStream(stderrPath, { flags: 'a' })

      // Chunk truncation that preserves the allowed prefix rather than
      // dropping the entire overflowing chunk.
      child.stdout?.on('data', (chunk: Buffer) => {
        const remaining = maxBytes - stdoutBytes
        if (remaining <= 0) {
          truncated = true
          return
        }
        if (chunk.length <= remaining) {
          stdoutBytes += chunk.length
          outStream.write(chunk)
          return
        }
        // Truncate to remaining bytes (slice is cheap on Buffers).
        stdoutBytes += remaining
        outStream.write(chunk.subarray(0, remaining))
        truncated = true
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        const remaining = maxBytes - stderrBytes
        if (remaining <= 0) {
          stderrTruncated = true
          return
        }
        if (chunk.length <= remaining) {
          stderrBytes += chunk.length
          errStream.write(chunk)
          return
        }
        stderrBytes += remaining
        errStream.write(chunk.subarray(0, remaining))
        stderrTruncated = true
      })

      // Timeout — kill the process group after the manifest's cap.
      const timeoutMs = manifest.resources.timeoutSeconds * 1000
      const timeoutHandle = setTimeout(() => {
        try { this.killGroup(child, 'SIGKILL') } catch { /* ignore */ }
      }, timeoutMs)

      // Abort — propagate parent cancel.
      const onAbort = (): void => {
        try { this.killGroup(child, 'SIGKILL') } catch { /* ignore */ }
      }
      if (signal) {
        // §P1 audit fix — register the listener FIRST, then re-check
        // `signal.aborted`. The previous order (check-then-add) had a
        // race window where an abort that fired between the check and
        // the addEventListener was missed.
        signal.addEventListener('abort', onAbort, { once: true })
        if (signal.aborted) onAbort()
      }

      // Error events must resolve the promise — no hangs.
      child.on('error', async (err) => {
        clearTimeout(timeoutHandle)
        if (signal) signal.removeEventListener('abort', onAbort)
        // §round-2 audit fix — await stream drain so log bytes aren't
        // lost when the child exits unexpectedly.
        await Promise.all([
          new Promise<void>((r) => outStream.end(() => r())),
          new Promise<void>((r) => errStream.end(() => r())),
        ])
        this.children.delete(runId)
        const finishedAt = new Date().toISOString()
        const status: OneShotStatus = signal?.aborted ? 'cancelled' : 'failed'
        resolve({
          runId,
          manifestId: manifest.id,
          taskId: 'pending',
          status,
          startedAt,
          finishedAt,
          durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
          findings: [],
          artifacts: [],
          candidates: [],
          diagnostics: { truncated: false, parserWarnings: [err.message] },
          confidence: 0,
          falsePositiveRisk: manifest.scheduling.falsePositiveRisk,
          summary: err.message,
        })
      })

      child.on('close', async (code, sig) => {
        clearTimeout(timeoutHandle)
        if (signal) signal.removeEventListener('abort', onAbort)
        // §round-2 audit fix — await stream drain so log bytes aren't
        // lost when the child exits.
        await Promise.all([
          new Promise<void>((r) => outStream.end(() => r())),
          new Promise<void>((r) => errStream.end(() => r())),
        ])
        this.children.delete(runId)
        const finishedAt = new Date().toISOString()
        const durationMs = Date.parse(finishedAt) - Date.parse(startedAt)
        const sig_ = sig

        let status: OneShotStatus = 'completed'
        if (sig_ === 'SIGKILL' && signal?.aborted) status = 'cancelled'
        else if (sig_ === 'SIGKILL') status = 'timeout'
        else if (code !== 0) status = 'failed'

        resolve({
          runId,
          manifestId: manifest.id,
          taskId: 'pending',
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
    const child = this.children.get(runId)
    if (!child) return
    this.killGroup(child, 'SIGKILL')
  }

  private killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
    if (process.platform === 'win32' || !child.pid) {
      try { child.kill(signal) } catch { /* ignore */ }
      return
    }
    // Negative pid → process group kill. Falls back to direct kill if
    // process group is unavailable.
    try {
      process.kill(-child.pid, signal)
    } catch {
      try { child.kill(signal) } catch { /* ignore */ }
    }
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
      taskId: 'pending',
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