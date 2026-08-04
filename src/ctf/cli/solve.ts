import { readFileSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { createHash } from 'crypto'
import { exec, spawn } from 'child_process'
import type { ChildProcess } from 'child_process'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

/**
 * Minimal typed shape of a SolveBench challenge.json file. The schema mirrors
 * `ChallengeManifestSchema` in `src/core/challengeManifest.ts` but is kept
 * inline because the SolveBench CLI doesn't import the CTF runtime types
 * (it's a thin shim that spawns the agent as a subprocess).
 */
interface SolveBenchManifest {
  id: string
  title: string
  category: string
  description: string
  expectedFlagSha256: string
  timeoutMs: number
  startupCommand?: string
  shutdownCommand?: string
  attachmentPaths?: string[]
}

function parseManifest(json: unknown): SolveBenchManifest {
  if (typeof json !== 'object' || json === null) {
    throw new Error('challenge.json must be a JSON object')
  }
  const o = json as Record<string, unknown>
  const required = (k: string): unknown => {
    if (!(k in o)) throw new Error(`challenge.json missing required field '${k}'`)
    return o[k]
  }
  const str = (k: string): string => {
    const v = required(k)
    if (typeof v !== 'string') throw new Error(`challenge.json field '${k}' must be a string`)
    return v
  }
  const num = (k: string): number => {
    const v = required(k)
    if (typeof v !== 'number') throw new Error(`challenge.json field '${k}' must be a number`)
    return v
  }
  const optStr = (k: string): string | undefined => {
    const v = o[k]
    if (v === undefined) return undefined
    if (typeof v !== 'string') throw new Error(`challenge.json field '${k}' must be a string`)
    return v
  }
  const optStrArr = (k: string): string[] | undefined => {
    const v = o[k]
    if (v === undefined) return undefined
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
      throw new Error(`challenge.json field '${k}' must be a string[]`)
    }
    return v as string[]
  }
  return {
    id: str('id'),
    title: str('title'),
    category: str('category'),
    description: str('description'),
    expectedFlagSha256: str('expectedFlagSha256'),
    timeoutMs: num('timeoutMs'),
    startupCommand: optStr('startupCommand'),
    shutdownCommand: optStr('shutdownCommand'),
    attachmentPaths: optStrArr('attachmentPaths'),
  }
}

export async function runSolveCommand(
  challengePath: string,
  io: { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream },
): Promise<number> {
  const { stdout, stderr } = io

  if (!existsSync(challengePath)) {
    stderr.write(`Error: Challenge file not found: ${challengePath}\n`)
    return 1
  }

  const manifest = parseManifest(JSON.parse(readFileSync(challengePath, 'utf-8')))
  const challengeDir = dirname(resolve(challengePath))

  stdout.write(`\n=== SolveBench Challenge ===\n`)
  stdout.write(`ID: ${manifest.id}\n`)
  stdout.write(`Title: ${manifest.title}\n`)
  stdout.write(`Category: ${manifest.category}\n`)
  stdout.write(`Description: ${manifest.description}\n`)
  stdout.write(`Expected SHA256: ${manifest.expectedFlagSha256}\n`)
  stdout.write(`Timeout: ${manifest.timeoutMs}ms\n\n`)

  // Start server if needed
  let serverProcess: ChildProcess | null = null
  if (manifest.startupCommand) {
    stdout.write(`Starting server: ${manifest.startupCommand}\n`)
    const [cmd, ...args] = manifest.startupCommand.split(' ')
    serverProcess = spawn(cmd, args, {
      cwd: challengeDir,
      stdio: 'ignore',
      detached: true,
    })
    await sleep(1000)
  }

  try {
    // Build agent command - use absolute path to CLI
    const cliPath = resolve(__dirname, '../../../bin/ovogogogo-ctf.ts')
    // Clean description - remove newlines and extra spaces for CLI arg
    const cleanDesc = manifest.description.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim()
    const agentCmd: string[] = [
      'npx',
      'tsx',
      cliPath,
      '--profile',
      getProfileForCategory(manifest.category),
      '--cwd',
      challengeDir,
      cleanDesc,
    ]

    if (manifest.attachmentPaths) {
      for (const attachment of manifest.attachmentPaths) {
        const attachmentPath = resolve(challengeDir, attachment)
        if (existsSync(attachmentPath)) {
          agentCmd.push('--input', attachmentPath)
        }
      }
    }

    stdout.write(`Running agent: ${agentCmd.join(' ')}\n\n`)

    // Run agent with timeout
    const result = await runWithTimeout(agentCmd, challengeDir, manifest.timeoutMs)

    stdout.write(`\n=== Agent Output ===\n`)
    stdout.write(result.stdout)
    if (result.stderr) {
      stderr.write(result.stderr)
    }

    // Extract flag from output
    const flagMatch = result.stdout.match(/flag\{[^}]+\}|flag\([^)]+\)/)
    if (!flagMatch) {
      stdout.write(`\n✗ No flag found in output\n`)
      return 1
    }

    const flag = flagMatch[0]
    const flagHash = createHash('sha256').update(flag).digest('hex')

    stdout.write(`\n=== Verification ===\n`)
    stdout.write(`Extracted flag: ${flag}\n`)
    stdout.write(`Flag SHA256: ${flagHash}\n`)
    stdout.write(`Expected:      ${manifest.expectedFlagSha256}\n`)

    if (flagHash === manifest.expectedFlagSha256) {
      stdout.write(`\n✓ SOLVED\n`)
      return 0
    } else {
      stdout.write(`\n✗ Wrong flag\n`)
      return 1
    }
  } finally {
    // Shutdown server
    if (serverProcess) {
      stdout.write(`\nShutting down server...\n`)
      if (manifest.shutdownCommand) {
        await execPromise(manifest.shutdownCommand, challengeDir)
      }
      serverProcess.kill()
    }
  }
}

function getProfileForCategory(category: string): string {
  const profileMap: Record<string, string> = {
    encoding: 'triage',
    crypto: 'crypto',
    forensics: 'image-stego',
    reverse: 'reverse',
    pwn: 'pwn',
    web: 'web',
    pcap: 'pcap',
    misc: 'triage',
  }
  return profileMap[category] || 'triage'
}

async function runWithTimeout(
  cmd: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const [command, ...args] = cmd
    const proc = spawn(command, args, { cwd, stdio: 'pipe' })

    let stdout = ''
    let stderr = ''

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString()
    })

    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    const timeout = setTimeout(() => {
      proc.kill('SIGTERM')
      resolve({ stdout, stderr, exitCode: -1 })
    }, timeoutMs)

    proc.on('close', (code) => {
      clearTimeout(timeout)
      resolve({ stdout, stderr, exitCode: code || 0 })
    })
  })
}

function execPromise(cmd: string, cwd: string): Promise<string> {
  return new Promise((resolve) => {
    exec(cmd, { cwd }, (error, stdout) => {
      resolve(stdout || '')
    })
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ── Module entry — only invoked when the script is run directly.
// Audit §13 R3 — the previous version of solve.ts only exported
// `runSolveCommand`, which silently exited 0 with no output when invoked
// via `npx tsx src/ctf/cli/solve.ts <path>` — masking the fact that the
// SolveBench binary was never actually exercised. This guard mirrors the
// `bin/ovogogogo-ctf.ts` invokedDirectly pattern so a direct invocation
// now resolves a challenge end-to-end.
const invokedDirectly = (() => {
  try {
    const arg = process.argv[1]
    if (!arg) return false
    return resolve(arg) === resolve(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()

if (invokedDirectly) {
  const challengePath = process.argv[2]
  if (!challengePath) {
    process.stderr.write(
      'usage: solve <challenge.json>  [-- one-shot flags accepted]\n',
    )
    process.exitCode = 1
  } else {
    runSolveCommand(challengePath, {
      stdout: process.stdout,
      stderr: process.stderr,
    })
      .then((code) => {
        process.exitCode = code
      })
      .catch((err: unknown) => {
        process.stderr.write(`fatal: ${(err as Error)?.message ?? String(err)}\n`)
        process.exitCode = 1
      })
  }
}
