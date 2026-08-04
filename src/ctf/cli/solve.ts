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
    // §13 R4 — dispatch on category. Most CTF categories map directly to
    // a workflow-only run that calls the right tool. Chat-mode is the
    // fallback for categories without a dedicated workflow.
    const cliPath = resolve(__dirname, '../../../bin/ovogogogo-ctf.ts')
    const dispatch = planSolveDispatch(manifest, challengeDir)
    stdout.write(`Dispatch: ${dispatch.mode} ${dispatch.reason}\n`)
    let result: { stdout: string; stderr: string }
    if (dispatch.mode === 'workflow') {
      // Workflow-only path: spawn the CLI with --run-workflow. The CLI
      // resolves the args we pass through CLI argv, the workflow runs,
      // and the broker auto-emits flag findings.
      const workflowInputs: string[] = dispatch.workflowInputs ?? []
      const cliArgs: string[] = [
        'npx',
        'tsx',
        cliPath,
        '--profile',
        dispatch.profileId,
        '--cwd',
        challengeDir,
        '--run-workflow',
        dispatch.workflowId ?? '',
        ...workflowInputs,
      ]
      stdout.write(`Running agent: ${cliArgs.join(' ')}\n\n`)
      result = await runWithTimeout(cliArgs, challengeDir, manifest.timeoutMs)
    } else {
      // Chat-mode path: profile + description. Used as the universal
      // fallback when the challenge category doesn't have a workflow.
      const cleanDesc = manifest.description.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim()
      const cliArgs = [
        'npx',
        'tsx',
        cliPath,
        '--profile',
        dispatch.profileId,
        '--cwd',
        challengeDir,
        cleanDesc,
      ]
      if (manifest.attachmentPaths) {
        for (const attachment of manifest.attachmentPaths) {
          const attachmentPath = resolve(challengeDir, attachment)
          if (existsSync(attachmentPath)) {
            cliArgs.push('--input', attachmentPath)
          }
        }
      }
      stdout.write(`Running agent: ${cliArgs.join(' ')}\n\n`)
      result = await runWithTimeout(cliArgs, challengeDir, manifest.timeoutMs)
    }

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
    encoding: 'crypto',
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

/**
 * SolveBench dispatch plan.
 *
 * §13 R4 — instead of always spawning the agent with a profile+prompt
 * and hoping LLM reasoning finds the flag, we route known categories
 * through dedicated workflows that call specific tools. The
 * workflow-only path is fully deterministic and finishes in a few seconds.
 */
interface SolveDispatchPlan {
  mode: 'workflow' | 'chat'
  reason: string
  profileId: string
  workflowId?: string
  workflowInputs?: string[]
}

function readAttachment(manifest: SolveBenchManifest, challengeDir: string, name: string): string | null {
  if (!manifest.attachmentPaths?.includes(name)) return null
  const p = resolve(challengeDir, name)
  if (!existsSync(p)) return null
  return readFileSync(p, 'utf-8').trim()
}

/**
 * Try to extract a known-plaintext string + matching known ciphertext
 * from a challenge description. Many SolveBench challenges embed the
 * "Known plaintext: \"...\"" pair in the description rather than in
 * dedicated files.
 */
function extractKnownPlaintextFromDescription(desc: string): {
  plain: string
  cipherHex: string
} | null {
  const plainMatch = desc.match(/Known\s*plaintext\s*[:=]\s*"?([^\n"]+?)"?\s*(?:\(|$|\n|Known)/i)
  const encMatch = desc.match(/Known\s*(?:encrypted|cipher(?:text)?)\s*\(?hex\)?\s*[:=]\s*([0-9a-fA-F]+)/i)
  const plain = plainMatch?.[1]?.trim()
  const enc = encMatch?.[1]?.toLowerCase()
  if (!plain || !enc) return null
  return { plain, cipherHex: enc }
}

function planSolveDispatch(
  manifest: SolveBenchManifest,
  challengeDir: string,
): SolveDispatchPlan {
  // Crypto challenges can map to specific attack workflows if the
  // manifest contains the right inputs. We detect by id (lower-cased).
  const id = manifest.id.toLowerCase()
  const profileId = getProfileForCategory(manifest.category)

  // XOR known-plaintext attacks: requires cipher + known_plaintext +
  // known_ciphertext in the challenge description OR as files.
  if (id.includes('xor') || /known.plain.*attack|known.*plain/i.test(manifest.description)) {
    const cipher = readAttachment(manifest, challengeDir, 'encrypted.hex')
      ?? readAttachment(manifest, challengeDir, 'ciphertext.hex')
    const fromDesc = extractKnownPlaintextFromDescription(manifest.description)
    const knownPlain = readAttachment(manifest, challengeDir, 'known.txt')
      ?? fromDesc?.plain
    const knownEnc = readAttachment(manifest, challengeDir, 'known_encrypted.hex')
      ?? fromDesc?.cipherHex
    if (cipher && knownPlain && knownEnc) {
      return {
        mode: 'workflow',
        reason: 'crypto xor_known detected — dispatch to xor_known_attack workflow',
        profileId,
        workflowId: 'xor_known_attack',
        // The workflow expects $TEXT_INPUT / $KNOWN_PLAINTEXT /
        // $KNOWN_CIPHERTEXT_HEX. CLI passes them via --text key=value.
        workflowInputs: [
          '--text',
          `TEXT_INPUT=${cipher}`,
          '--text',
          `KNOWN_PLAINTEXT=${knownPlain}`,
          '--text',
          `KNOWN_CIPHERTEXT_HEX=${knownEnc}`,
        ],
      }
    }
  }

  // AES ECB / CBC attacks: known key + ciphertext.
  if (id.includes('aes') || /aes|cipher.*key|decrypt.*key/i.test(manifest.description)) {
    const cipher = readAttachment(manifest, challengeDir, 'ciphertext.hex')
    const key = readAttachment(manifest, challengeDir, 'key.hex')
    if (cipher && key) {
      return {
        mode: 'workflow',
        reason: 'crypto aes attack detected — dispatch to aes_ecb_attack workflow',
        profileId,
        workflowId: 'aes_ecb_attack',
        workflowInputs: [
          '--text',
          `TEXT_INPUT=${cipher}`,
          '--text',
          `KEY_HEX=${key}`,
        ],
      }
    }
  }

  // encoding → encoding_sweep (reads attachments). The dispatch can't
  // know which attachment is the encoded text without parsing, so we
  // pass all attachments as inputs. The CLI's --input is for FILE_INPUT;
  // encoding_sweep accepts both TEXT_INPUT (inline) and FILE_INPUT
  // (path). Use description as the inline text fallback (encoding
  // challenges often embed the cipher in the description).
  if (manifest.category === 'encoding' || id.startsWith('multi_encoding') || id.startsWith('encoding')) {
    const inlineText = readAttachment(manifest, challengeDir, 'encoded.txt')
      ?? readAttachment(manifest, challengeDir, 'ciphertext.txt')
      ?? readAttachment(manifest, challengeDir, 'message.txt')
    if (inlineText) {
      return {
        mode: 'workflow',
        reason: 'encoding category — dispatch to encoding_sweep workflow',
        profileId,
        workflowId: 'encoding_sweep',
        workflowInputs: ['--text', inlineText],
      }
    }
  }

  // Universal fallback — chat-mode profile+prompt.
  return {
    mode: 'chat',
    reason: `no workflow dispatch for category=${manifest.category} id=${manifest.id}, falling back to chat-mode`,
    profileId,
  }
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
