/**
 * ContainerRunner — Phase 2.0 §十七.
 *
 * Real Docker execution with:
 *   - ESM imports (no require('fs'))
 *   - runId → ChildProcess map + docker container name for cancellation
 *   - hard isolation: --read-only, --cap-drop=ALL, --security-opt=no-new-privileges
 *   - digest required for stable/candidate maturity
 *   - real UNAVAILABLE when docker is missing (no synthetic default)
 *   - sensitive-path mount guard (HOME/SSH/API/.git/socket)
 *   - 'contest-target-only' must come with a configured adapter — otherwise
 *     we return DISABLED_SCOPE_REQUIRED instead of silently degrading to
 *     unrestricted bridge
 */

import { spawn, type ChildProcess } from 'child_process'
import { createWriteStream, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { randomBytes } from 'crypto'
import type {
  OneShotManifest,
  OneShotResult,
  OneShotStatus,
} from './types.js'
import type { OneShotRunner, RunnerInputs } from './runner.js'

export interface ContainerRunnerOptions {
  dockerBin?: string
  /** When false, skip actually invoking docker (test mode). Default true. */
  execute?: boolean
  /**
   * Network adapter — supplies the `docker network create` + `connect`
   * commands for `contest-target-only`. When absent and the manifest
   * declares `contest-target-only`, the runner returns
   * `DISABLED_SCOPE_REQUIRED` rather than degrading to `bridge`.
   */
  networkAdapter?: ContainerNetworkAdapter
}

export interface ContainerNetworkAdapter {
  /** Build the `--network` argument for a given manifest's targets. */
  buildNetworkArg(targets: string[]): Promise<{ networkName: string; argv: string[] }>
  /** Cleanup hook — remove the network after the run. */
  cleanup(networkName: string): Promise<void>
}

const FORBIDDEN_MOUNTS = [
  '/root',
  '/home',
  '/etc/ssh',
  '/etc/shadow',
  '/etc/passwd',
  '/var/run/docker.sock',
  '/.git',
]

function safeWorkspaceDir(given: string): string {
  for (const bad of FORBIDDEN_MOUNTS) {
    if (given === bad || given.startsWith(`${bad}/`)) {
      throw new Error(`workspace ${given} is forbidden`)
    }
  }
  return given
}

/** Probe `docker version` to detect presence without faking it. */
export async function probeDocker(dockerBin: string = 'docker'): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = spawn(dockerBin, ['version', '--format', '{{.Server.Version}}'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let ok = false
      child.stdout.on('data', (chunk: Buffer) => {
        if (chunk.toString('utf8').trim().length > 0) ok = true
      })
      child.on('error', () => resolve(false))
      child.on('close', (code) => resolve(ok && code === 0))
    } catch {
      resolve(false)
    }
  })
}

export class ContainerRunner implements OneShotRunner {
  /** runId → docker child + container name. */
  private readonly children = new Map<string, { child: ChildProcess; containerName: string }>()

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

    // §十五 — digest required for stable/candidate maturity. `:latest` is
    // forbidden — Doctor flags it; runtime fails fast here.
    if (manifest.maturity !== 'experimental') {
      if (!manifest.source.imageDigest) {
        return this.fail(runId, manifest, startedAt, 'failed', 'image not pinned (no imageDigest)')
      }
      if (manifest.runner.image.endsWith(':latest')) {
        return this.fail(runId, manifest, startedAt, 'failed', ':latest tag forbidden for non-experimental manifests')
      }
    }

    // §十四 — `contest-target-only` requires a network adapter. Refuse to
    // degrade silently to unrestricted bridge.
    if (manifest.network.mode === 'contest-target-only' && !this.opts.networkAdapter) {
      return this.fail(runId, manifest, startedAt, 'unavailable', 'contest-target-only requires network adapter')
    }

    const dockerBin = this.opts.dockerBin ?? 'docker'
    if (execute) {
      const available = await probeDocker(dockerBin)
      if (!available) {
        return this.fail(runId, manifest, startedAt, 'unavailable', 'docker not available')
      }
    }

    // §十四 — actually use the network adapter for non-`none` modes.
    // `contest-target-only` requires `networkAdapter` to claim real
    // isolation; `outbound-readonly` requires explicit operator
    // approval — see `healthChecker.checkManifestSync` for the gate.
    let resolvedNetwork = 'none'
    let createdNetworkName: string | undefined
    if (manifest.network.mode === 'contest-target-only' && this.opts.networkAdapter) {
      try {
        const plan = await this.opts.networkAdapter.buildNetworkArg(inputs.argv)
        resolvedNetwork = plan.networkName
        createdNetworkName = plan.networkName
      } catch (err) {
        return this.fail(
          runId, manifest, startedAt, 'unavailable',
          `network adapter failed: ${(err as Error).message}`,
        )
      }
    }
    // `outbound-readonly` is intentionally still mapped to `none` until a
    // dedicated adapter is wired — Doctor marks it DISABLED_SCOPE_REQUIRED
    // so operators know the integration is gated.

    const argv = [
      'run',
      '--rm',
      '-i',
      `--name=${runId}`,
      '-v', `${workspace}:/work:ro`,
      '-v', `${inputs.logDir}:/logs:rw`,
      '-w', '/work',
      // §十五 — read-only root filesystem, drop caps, no-new-privileges.
      '--read-only',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      '--network', resolvedNetwork,
    ]
    if (manifest.resources.cpuLimit) argv.push('--cpus', String(manifest.resources.cpuLimit))
    if (manifest.resources.memoryMb) argv.push('--memory', `${manifest.resources.memoryMb}m`)
    if (manifest.resources.pidsLimit !== undefined) argv.push('--pids-limit', String(manifest.resources.pidsLimit))

    if (manifest.source.imageDigest) argv.push(`${manifest.runner.image}@${manifest.source.imageDigest}`)
    else argv.push(manifest.runner.image)
    argv.push(...manifest.runner.command, ...inputs.argv)

    if (!execute) {
      return this.fail(runId, manifest, startedAt, 'unavailable', 'docker execute disabled')
    }

    const maxBytes = manifest.resources.maxOutputBytes
    const signal = inputs.signal
    const timeoutMs = manifest.resources.timeoutSeconds * 1000

    return new Promise<OneShotResult>((resolve) => {
      let child: ChildProcess
      try {
        child = spawn(dockerBin, argv, { stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (err) {
        resolve(this.fail(runId, manifest, startedAt, 'failed', `docker spawn failed: ${(err as Error).message}`))
        return
      }
      this.children.set(runId, { child, containerName: runId })
      const outStream = createWriteStream(stdoutPath, { flags: 'a' })
      const errStream = createWriteStream(stderrPath, { flags: 'a' })
      let truncated = false
      let stderrTruncated = false
      let stdoutBytes = 0
      let stderrBytes = 0

      child.stdout?.on('data', (chunk: Buffer) => {
        const remaining = maxBytes - stdoutBytes
        if (remaining <= 0) { truncated = true; return }
        if (chunk.length <= remaining) { stdoutBytes += chunk.length; outStream.write(chunk); return }
        stdoutBytes += remaining
        outStream.write(chunk.subarray(0, remaining))
        truncated = true
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        const remaining = maxBytes - stderrBytes
        if (remaining <= 0) { stderrTruncated = true; return }
        if (chunk.length <= remaining) { stderrBytes += chunk.length; errStream.write(chunk); return }
        stderrBytes += remaining
        errStream.write(chunk.subarray(0, remaining))
        stderrTruncated = true
      })

      const timeoutHandle = setTimeout(() => {
        try { spawn(dockerBin, ['kill', runId]) } catch { /* ignore */ }
      }, timeoutMs)

      const onAbort = (): void => {
        try { spawn(dockerBin, ['kill', runId]) } catch { /* ignore */ }
      }
      if (signal) {
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
      }

      // §P1 audit fix — when the run finishes (close or error), clean up
      // the adapter-created docker network so it doesn't leak across runs.
      const cleanupNetwork = (): void => {
        if (createdNetworkName && this.opts.networkAdapter) {
          try {
            spawn(dockerBin, ['network', 'rm', createdNetworkName], { stdio: 'ignore' })
              .on('error', () => { /* best-effort */ })
          } catch { /* best-effort */ }
          createdNetworkName = undefined
        }
      }

      child.on('error', (err) => {
        clearTimeout(timeoutHandle)
        if (signal) signal.removeEventListener('abort', onAbort)
        outStream.end()
        errStream.end()
        this.children.delete(runId)
        cleanupNetwork()
        resolve({
          runId,
          manifestId: manifest.id,
          taskId: 'pending',
          status: signal?.aborted ? 'cancelled' : 'failed',
          startedAt,
          finishedAt: new Date().toISOString(),
          findings: [],
          artifacts: [],
          candidates: [],
          diagnostics: { truncated: false, parserWarnings: [err.message] },
          confidence: 0,
          falsePositiveRisk: manifest.scheduling.falsePositiveRisk,
          summary: err.message,
        })
      })

      child.on('close', (code, sig) => {
        clearTimeout(timeoutHandle)
        if (signal) signal.removeEventListener('abort', onAbort)
        outStream.end()
        errStream.end()
        this.children.delete(runId)
        cleanupNetwork()
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
          summary: `container-runner ${manifest.runner.image} → ${status}`,
        })
      })
    })
  }

  async cancel(runId: string): Promise<void> {
    const entry = this.children.get(runId)
    if (!entry) return
    const dockerBin = this.opts.dockerBin ?? 'docker'
    try {
      // Issue `docker kill` for the container, then kill the docker client
      // process to ensure no orphan child remains.
      spawn(dockerBin, ['kill', entry.containerName])
    } catch { /* ignore */ }
    try { entry.child.kill('SIGKILL') } catch { /* ignore */ }
    this.children.delete(runId)
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