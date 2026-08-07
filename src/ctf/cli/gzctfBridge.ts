/**
 * GZCTF Bridge — connect to a live GZCTF/CTFd instance, fetch challenges,
 * convert them to challenge.json, run the agent, and submit flags.
 *
 * Usage:
 *   ovogogogo-ctf gzctf-solve --url https://gzctf.example.com --token sk-...
 *       [--category crypto] [--challenge-id 42] [--timeout 300]
 *
 * Without --challenge-id, all unsolved challenges are solved sequentially.
 */

import { writeFileSync, mkdirSync, existsSync } from 'fs'
import { join, resolve as resolvePath, dirname } from 'path'
import { execSync } from 'child_process'
import { fileURLToPath } from 'url'
import {
  CTFPlatformAdapter,
  type CtfPlatformConfig,
  type RemoteChallenge,
  type RemoteChallengeDetail,
} from '../../core/ctfPlatform/ctfPlatformAdapter.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

export interface GzctfBridgeOptions {
  url: string
  token: string
  platform?: 'gzctf' | 'ctfd'
  category?: string
  challengeId?: string
  timeout?: number
  workDir?: string
  model?: string
  stdout: NodeJS.WritableStream
  stderr: NodeJS.WritableStream
}

interface SolveResult {
  id: number | string
  title: string
  solved: boolean
  flag: string | null
  timeMs: number
  submitVerdict: string | null
  error?: string
}

export async function runGzctfBridge(opts: GzctfBridgeOptions): Promise<SolveResult[]> {
  const { stdout, stderr } = opts
  const workDir = resolvePath(opts.workDir ?? join(process.cwd(), 'gzctf_work'))
  mkdirSync(workDir, { recursive: true })

  const config: CtfPlatformConfig = {
    baseUrl: opts.url.replace(/\/$/, ''),
    apiToken: opts.token,
    platform: opts.platform,
  }

  const adapter = new CTFPlatformAdapter(config)

  stdout.write(`\nDetecting platform at ${config.baseUrl}...\n`)
  const detected = await adapter.detectPlatform()
  stdout.write(`Platform: ${detected.toUpperCase()}\n\n`)

  const game = await adapter.getGameInfo()
  if (game) {
    stdout.write(`Competition: ${game.title}\n`)
    stdout.write(`Teams: ${game.teams}\n`)
    stdout.write(`Timeline: ${game.start} — ${game.end}\n\n`)
  }

  stdout.write('Fetching challenge list...\n')
  const allChallenges = await adapter.listChallenges()
  stdout.write(`Found ${allChallenges.length} challenges.\n`)

  let targets = allChallenges
  if (opts.category) {
    targets = targets.filter((c) => c.category.toLowerCase() === opts.category!.toLowerCase())
    stdout.write(`Filtered by category "${opts.category}": ${targets.length} challenges.\n`)
  }
  if (opts.challengeId) {
    targets = targets.filter((c) => String(c.id) === String(opts.challengeId))
    stdout.write(`Filtered by id "${opts.challengeId}": ${targets.length} challenges.\n`)
  }

  const unsolved = targets.filter((c) => !c.solved)
  stdout.write(`Unsolved: ${unsolved.length} / ${targets.length}\n\n`)
  if (unsolved.length === 0) {
    stdout.write('All targeted challenges already solved. Nothing to do.\n')
    return []
  }

  const results: SolveResult[] = []
  const timeout = opts.timeout ?? 300

  for (let i = 0; i < unsolved.length; i++) {
    const ch = unsolved[i]
    stdout.write(`\n[${i + 1}/${unsolved.length}] ${ch.title} (${ch.category}, id=${ch.id})...\n`)

    try {
      const detail = await adapter.getChallengeDetail(ch.id)
      const challengeDir = join(workDir, String(ch.id))
      mkdirSync(challengeDir, { recursive: true })

      const challengeJson = buildChallengeJson(ch, detail)

      const manifestPath = join(challengeDir, 'challenge.json')
      writeFileSync(manifestPath, JSON.stringify(challengeJson, null, 2))
      stdout.write(`  wrote challenge.json → ${manifestPath}\n`)

      if (detail?.files.length) {
        for (const f of detail.files) {
          const dl = await adapter.downloadAttachment(ch.id, f.id)
          if (dl) {
            const dest = join(challengeDir, f.name)
            writeFileSync(dest, dl.data)
            stdout.write(`  downloaded attachment: ${f.name} (${dl.data.length} bytes)\n`)
          } else {
            stdout.write(`  attachment ${f.name}: download failed\n`)
          }
        }
      }

      const env = { ...process.env }
      env.OPENAI_API_KEY = opts.token
      if (opts.model) env.OVOGO_MODEL = opts.model
      const repoRootCandidates = [
        resolvePath(__dirname, '..', '..', '..'),
        resolvePath(__dirname, '..', '..', '..', '..'),
      ]
      const repoRoot =
        repoRootCandidates.find((p) => existsSync(join(p, 'package.json'))) ?? repoRootCandidates[0]
      env.OVOGO_CTF_CLI = join(repoRoot, 'bin', 'ovogogogo-ctf.ts')

      const startTime = Date.now()
      // Resolve solve.ts path across source + compiled layouts (dist/src/ctf/cli → 4 up = root)
      const solvePathCandidates = [
        resolvePath(__dirname, '..', '..', '..', 'src', 'ctf', 'cli', 'solve.ts'),
        resolvePath(__dirname, '..', '..', '..', '..', 'src', 'ctf', 'cli', 'solve.ts'),
      ]
      const solvePath = solvePathCandidates.find((p) => existsSync(p)) ?? solvePathCandidates[0]
      let flag: string | null = null

      try {
        const output = execSync(`npx tsx "${solvePath}" "${manifestPath}"`, {
          cwd: process.cwd(),
          env,
          timeout: timeout * 1000,
          stdio: 'pipe',
        })
        const outStr = output.toString()
        stdout.write(outStr.slice(0, 1000) + (outStr.length > 1000 ? '\n...\n' : '\n'))

        const flagMatch = outStr.match(/Extracted flag:\s*(\S+)/)
        flag = flagMatch ? flagMatch[1] : null

        if (flag) {
          stdout.write(`  flag found: ${flag}\n`)

          stdout.write(`  submitting to platform...\n`)
          const submitResult = await adapter.submitFlag(ch.id, flag)
          results.push({
            id: ch.id,
            title: ch.title,
            solved: true,
            flag,
            timeMs: Date.now() - startTime,
            submitVerdict: submitResult.verdict,
          })
          stdout.write(`  submission verdict: ${submitResult.verdict} — ${submitResult.message}\n`)
        } else {
          results.push({
            id: ch.id,
            title: ch.title,
            solved: false,
            flag: null,
            timeMs: Date.now() - startTime,
            submitVerdict: null,
            error: 'no flag extracted',
          })
          stdout.write(`  no flag extracted from agent output\n`)
        }
      } catch (execErr: unknown) {
        const elapsed = Date.now() - startTime
        const msg = execErr instanceof Error ? execErr.message : String(execErr)
        results.push({
          id: ch.id,
          title: ch.title,
          solved: false,
          flag: null,
          timeMs: elapsed,
          submitVerdict: null,
          error: msg,
        })
        stdout.write(`  agent failed: ${msg.slice(0, 200)}\n`)
      }
    } catch (err: unknown) {
      results.push({
        id: ch.id,
        title: ch.title,
        solved: false,
        flag: null,
        timeMs: 0,
        submitVerdict: null,
        error: err instanceof Error ? err.message : String(err),
      })
      stderr.write(`  bridge error: ${err instanceof Error ? err.message : String(err)}\n`)
    }
  }

  stdout.write(`\n${'═'.repeat(60)}\n`)
  const solved = results.filter((r) => r.solved)
  stdout.write(`Solved: ${solved.length}/${results.length}\n`)
  for (const r of results) {
    const mark = r.solved ? '✅' : '❌'
    stdout.write(
      `  ${mark} ${r.title} — ${r.flag ?? r.error ?? 'unknown'} — ${r.timeMs}ms` +
        (r.submitVerdict ? ` [${r.submitVerdict}]` : '') +
        '\n',
    )
  }

  return results
}

function buildChallengeJson(
  ch: RemoteChallenge,
  detail: RemoteChallengeDetail | null,
): Record<string, unknown> {
  const descParts = [ch.description]
  if (detail?.connectionInfo) {
    descParts.push(`\nConnection: ${detail.connectionInfo}`)
  }
  if (ch.hints.length) {
    descParts.push('\nHints:')
    for (const h of ch.hints) {
      descParts.push(`  - ${h.content}`)
    }
  }

  const attachments = detail?.files.map((f) => f.name) ?? []

  const challenge: Record<string, unknown> = {
    id: `gzctf_${ch.id}`,
    title: ch.title,
    category: mapCategory(ch.category),
    description: descParts.join('\n'),
    flagPattern: 'flag{...}',
    expectedFlagSha256: '',
    attachmentPaths: attachments.length ? attachments : undefined,
    timeoutMs: 300000,
    allowedTools: [
      'Bash',
      'Read',
      'Write',
      'Grep',
      'Glob',
      'WebFetch',
      'python3',
      'curl',
      'nmap',
      'binwalk',
      'strings',
      'file',
    ],
  }

  const connInfo = detail?.connectionInfo?.trim()
  if (connInfo?.startsWith('http')) {
    challenge.targetUrl = connInfo
  } else if (connInfo && /\d+\.\d+\.\d+\.\d+:\d+/.test(connInfo)) {
    const [host, portStr] = connInfo.split(':')
    challenge.host = host
    challenge.port = parseInt(portStr, 10)
  }

  return challenge
}

function mapCategory(raw: string): string {
  const lower = raw.toLowerCase()
  if (lower.includes('crypto')) return 'crypto'
  if (lower.includes('reverse') || lower.includes('rev')) return 'reverse'
  if (lower.includes('pwn') || lower.includes('binary')) return 'pwn'
  if (lower.includes('web')) return 'web'
  if (lower.includes('forensic') || lower.includes('stego')) return 'forensics'
  if (lower.includes('misc')) return 'misc'
  if (lower.includes('pcap') || lower.includes('traffic')) return 'pcap'
  if (lower.includes('encod') || lower.includes('base')) return 'encoding'
  return 'misc'
}
