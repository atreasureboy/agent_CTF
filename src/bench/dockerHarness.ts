/**
 * DockerChallengeHarness — Phase borrow-plan Tier D2.
 *
 * Inspired by nyuctf_agents' `CTFEnvironment` (Docker per-challenge),
 * NYU CTF Bench, EnIGMA+ / Cyber-Zero, and swe-agent's `SWEEnv`.
 *
 * The harness:
 *   1. Parses a `BenchChallenge` with a `dockerComposePath`.
 *   2. Spawns `docker compose up -d` in a child process.
 *   3. Waits for the container to expose a TCP port (the
 *      `exposedPort` field of the challenge).
 *   4. Runs the challenge with the configured StrategyExecutor.
 *   5. Tears down the container.
 *
 * The actual challenge content is a docker-compose.yml supplied
 * by the benchmark fixture. The harness only manages the lifecycle
 * — the planning/execution happens via the same `processNewReasoningInputs`
 * path as the synthetic `BenchRunner`.
 *
 * This module is a thin orchestration wrapper. The Plan is:
 *   - Hooks are real Docker via `docker compose` CLI (we shell out).
 *   - No automatic image building in this scaffold — the bench
 *     fixture is responsible for `docker compose build`.
 *   - Network isolation: each challenge gets a unique compose
 *     project name (`bench-<runId>-<challengeId>`).
 */

import { spawn, exec } from 'child_process'
import { promisify } from 'util'
import { setTimeout as delay } from 'timers/promises'

const execAsync = promisify(exec)

export interface DockerBenchChallenge {
  id: string
  category: string
  /** Path to a docker-compose.yml describing the challenge. */
  dockerComposePath: string
  /** Host port the challenge exposes (e.g. 1337 for a pwn
   *  challenge). */
  exposedPort: number
  /** Expected flag. */
  expectedFlag: string
  /** Max seconds to wait for the container to be reachable. */
  startupTimeoutSec?: number
}

export interface DockerRunResult {
  challengeId: string
  containerReady: boolean
  elapsedMs: number
  /** Detected flag from the runtime, or null if not found. */
  detectedFlag: string | null
  /** Stdout / stderr captured (for the audit trail). */
  stdout: string
  stderr: string
}

/** Wait for a TCP port to be reachable. Resolves when connected,
 *  rejects when timeout exceeded. */
export async function waitForTcp(host: string, port: number, timeoutMs: number): Promise<void> {
  const net = await import('net')
  const started = Date.now()
  return new Promise<void>((resolve, reject) => {
    const tryOnce = (): void => {
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`waitForTcp: timeout ${host}:${port}`))
        return
      }
      const sock = new net.Socket()
      sock.setTimeout(2000)
      sock.once('connect', () => {
        sock.end()
        resolve()
      })
      sock.once('error', () => {
        sock.destroy()
        setTimeout(tryOnce, 1000)
      })
      sock.connect(port, host)
    }
    tryOnce()
  })
}

export interface DockerRunOptions {
  /** Compose project name suffix (each challenge gets a unique
   *  one). */
  projectSuffix: string
  /** Host to wait for (default 127.0.0.1). */
  host?: string
}

/** Spawn the challenge's docker-compose, wait for the port, and
 *  invoke the supplied runtime-check. Then tear down. */
export async function runDockerChallenge(
  challenge: DockerBenchChallenge,
  opts: DockerRunOptions,
  runtimeCheck: (
    host: string,
    port: number,
  ) => Promise<{ detectedFlag: string | null; stdout: string; stderr: string }>,
): Promise<DockerRunResult> {
  const projectName = `bench-${opts.projectSuffix}-${challenge.id}`.toLowerCase()
  const host = opts.host ?? '127.0.0.1'
  const timeoutMs = (challenge.startupTimeoutSec ?? 60) * 1000
  const startedAt = Date.now()
  let containerReady = false
  let detectedFlag: string | null = null
  let stdout = ''
  let stderr = ''
  const child = spawn(
    'docker',
    [
      'compose',
      '-p',
      projectName,
      '-f',
      challenge.dockerComposePath,
      'up',
      '-d',
      '--remove-orphans',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf-8')
  })
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf-8')
  })
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`docker compose up exited ${code}: ${stderr}`))
    })
  })
  try {
    await waitForTcp(host, challenge.exposedPort, timeoutMs)
    containerReady = true
    const check = await runtimeCheck(host, challenge.exposedPort)
    detectedFlag = check.detectedFlag
    stdout += check.stdout
    stderr += check.stderr
  } finally {
    // Tear down: docker compose down (best-effort).
    try {
      await execAsync(
        `docker compose -p ${projectName} -f ${challenge.dockerComposePath} down --remove-orphans`,
      )
    } catch {
      /* ignore */
    }
  }
  void delay(0) // keep import for future use
  return {
    challengeId: challenge.id,
    containerReady,
    elapsedMs: Date.now() - startedAt,
    detectedFlag,
    stdout,
    stderr,
  }
}
