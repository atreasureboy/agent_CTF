import { readFileSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { createHash } from 'crypto'
import { exec, spawn } from 'child_process'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

export async function runSolveCommand(
  challengePath: string,
  io: { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream },
): Promise<number> {
  const { stdout, stderr } = io

  if (!existsSync(challengePath)) {
    stderr.write(`Error: Challenge file not found: ${challengePath}\n`)
    return 1
  }

  const manifest = JSON.parse(readFileSync(challengePath, 'utf-8'))
  const challengeDir = dirname(resolve(challengePath))

  stdout.write(`\n=== SolveBench Challenge ===\n`)
  stdout.write(`ID: ${manifest.id}\n`)
  stdout.write(`Title: ${manifest.title}\n`)
  stdout.write(`Category: ${manifest.category}\n`)
  stdout.write(`Description: ${manifest.description}\n`)
  stdout.write(`Expected SHA256: ${manifest.expectedFlagSha256}\n`)
  stdout.write(`Timeout: ${manifest.timeoutMs}ms\n\n`)

  // Start server if needed
  let serverProcess: any = null
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
    const agentCmd = [
      'npx', 'tsx', cliPath,
      '--profile', getProfileForCategory(manifest.category),
      '--cwd', challengeDir,
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
    const result = await runWithTimeout(
      agentCmd,
      challengeDir,
      manifest.timeoutMs,
    )

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

    proc.stdout.on('data', (data) => {
      stdout += data.toString()
    })

    proc.stderr.on('data', (data) => {
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
