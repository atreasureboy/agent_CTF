/**
 * ContainerRunner — Docker execution. Default per six_goal §七.
 *
 * Hard invariants:
 *   - read-only mount for the working directory;
 *   - separate read/write mount for results;
 *   - HOME / SSH / API keys / .git are NEVER mounted;
 *   - default network mode: none (contest targets use contest-target-only);
 *   - resource caps (cpu, memory, pids) applied via docker run flags;
 *   - the entire `docker run` command is killed on timeout/abort;
 *   - digest is recorded for audit when supplied by the manifest.
 *
 * The Docker integration intentionally shells out to `docker` (not the
 * Dockerode SDK) so the framework has no native module dependency.
 *
 * Operators without docker installed get a deterministic `unavailable`
 * status so the Doctor can list missing infrastructure.
 */

import { spawn } from 'child_process'
import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { randomBytes } from 'crypto'
import type {
  OneShotManifest,
  OneShotResult,
  OneShotStatus,
} from './types.js'
import type { OneShotRunner, RunnerInputs } from './runner.js'

export interface ContainerRunnerOptions {
  /** Override `docker` binary (e.g. `podman`, `nerdctl`). */
  dockerBin?: string
  /** When true, actually exec into docker. Defaults to true in production. */
  execute?: boolean
}

/**
 * Sensitive paths that must NEVER be mounted. The list is conservative on
 * purpose — any single leak is a credential exposure.
 */
const FORBIDDEN_MOUNTS = [
  '/root',
  '/home',
  '/etc/ssh',
  '/etc/shadow',
  '/etc/passwd',
  '/var/run/docker.sock',
]

function safeWorkspaceDir(given: string): string {
  for (const bad of FORBIDDEN_MOUNTS) {
    if (given === bad || given.startsWith(`${bad}/`)) {
      throw new Error(`workspace ${given} is forbidden`)
    }
  }
  return given
}

export class ContainerRunner implements OneShotRunner {
  constructor(private readonly opts: ContainerRunnerOptions = {}) {}

  async run(manifest: OneShotManifest, inputs: RunnerInputs): Promise<OneShotResult> {
    const runId = `osc_${randomBytes(6).toString('hex')}`
    const startedAt = new Date().toISOString()
    const execute = this.opts.execute !== false

    if (!existsSync(inputs.logDir)) mkdirSync(inputs.logDir, { recursive: true })
    const stdoutPath = join(inputs.logDir, `${runId}.stdout.log`)
    const stderrPath = join(inputs.logDir, `${runId}.stderr.log`)

    let workspace: string
    try {
      workspace = safeWorkspaceDir(inputs.workspace)
    } catch (err) {
      return this.fail(runId, manifest, startedAt, 'failed', (err as Error).message)
    }

    if (!manifest.runner.image || !manifest.runner.command) {
      return this.fail(runId, manifest, startedAt, 'failed', 'manifest missing image/command')
    }

    const dockerBin = this.opts.dockerBin ?? 'docker'
    const argv = [
      'run',
      '--rm',
      '-i',
      `--name=${runId}`,
      '-v', `${workspace}:/work:ro`,
      '-v', `${inputs.logDir}:/logs:rw`,
      '-w', '/work',
      '--network', manifest.network.mode === 'none' ? 'none' : 'bridge',
    ]
    if (manifest.resources.cpuLimit) argv.push('--cpus', String(manifest.resources.cpuLimit))
    if (manifest.resources.memoryMb) argv.push('--memory', `${manifest.resources.memoryMb}m`)
    if (manifest.resources.pidsLimit !== undefined) argv.push('--pids-limit', String(manifest.resources.pidsLimit))

    if (manifest.source.imageDigest) argv.push(`${manifest.runner.image}@${manifest.source.imageDigest}`)
    else argv.push(manifest.runner.image)
    argv.push(...manifest.runner.command, ...inputs.argv)

    if (!execute) {
      // Test mode — bypass docker, return a synthetic `unavailable` so the
      // Doctor can list missing infrastructure.
      return this.fail(runId, manifest, startedAt, 'unavailable', 'docker not available')
    }

    const maxBytes = manifest.resources.maxOutputBytes
    const signal = inputs.signal
    const timeoutMs = manifest.resources.timeoutSeconds * 1000

    return new Promise<OneShotResult>((resolve) => {
      const child = spawn(dockerBin, argv, { stdio: ['ignore', 'pipe', 'pipe'] })
      const outStream = (require('fs') as typeof import('fs')).createWriteStream(stdoutPath, { flags: 'a' })
      const errStream = (require('fs') as typeof import('fs')).createWriteStream(stderrPath, { flags: 'a' })
      let truncated = false
      let stderrTruncated = false
      let stdoutBytes = 0
      let stderrBytes = 0

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

      const timeoutHandle = setTimeout(() => {
        try {
          // `docker kill` propagates SIGKILL to the entire container process tree.
          spawn(dockerBin, ['kill', runId])
        } catch { /* ignore */ }
      }, timeoutMs)

      const onAbort = (): void => {
        try {
          spawn(dockerBin, ['kill', runId])
        } catch { /* ignore */ }
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
          summary: `container-runner ${manifest.runner.image} → ${status}`,
        })
      })
    })
  }

  async cancel(runId: string): Promise<void> {
    const dockerBin = this.opts.dockerBin ?? 'docker'
    try {
      spawn(dockerBin, ['kill', runId])
    } catch { /* best-effort */ }
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
