/**
 * Competition runner — solves CTF challenges with tiered timeouts and
 * easy-first strategy. Designed for maximum score in minimum time.
 *
 * Strategy:
 *   1. Score every challenge by difficulty heuristic.
 *   2. Sort easy-first (low score → high score).
 *   3. Assign tiered timeouts based on difficulty:
 *      - fast:   90s  (trivial encoding / simple text challenges)
 *      - medium: 240s (crypto, basic rev, misc)
 *      - heavy:  420s (RSA, assembly, forensics, pwn)
 *   4. Run sequentially (can parallelize later).
 *   5. Auto-save results.json after each solve.
 *
 * Usage:
 *   npx tsx src/ctf/cli/competition.ts <challenges-dir> [output-dir]
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs'
import { resolve, dirname } from 'path'
import { spawn } from 'child_process'
import type { ChildProcess } from 'child_process'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const PROJECT_ROOT = resolve(__dirname, '../../..')

// ── Types ──────────────────────────────────────────────────────────

interface ChallengeManifest {
  id?: string
  title?: string
  category?: string
  description?: string
  expectedFlagSha256?: string
  attachmentPaths?: string[]
}

interface Challenge {
  dir: string
  manifestPath: string
  id: string
  title: string
  category: string
  description: string
  expectedFlagSha256: string
  attachmentPaths: string[]
  /** Computed difficulty score (lower = easier). */
  difficultyScore: number
  /** Assigned tier: fast | medium | heavy. */
  tier: 'fast' | 'medium' | 'heavy'
}

interface SolveResult {
  id: string
  category: string
  tier: string
  difficultyScore: number
  flag: string | null
  status: 'solved' | 'failed' | 'timeout' | 'wrong_flag' | 'no_flag' | 'error'
  durationMs: number
  error?: string
  solvedAt?: string
}

interface CompetitionState {
  startedAt: string
  totalChallenges: number
  solved: number
  results: SolveResult[]
}

// ── Difficulty scoring ─────────────────────────────────────────────

const HARD_KEYWORDS = [
  'rsa',
  'aes',
  'decrypt',
  'crack',
  'exploit',
  'overflow',
  'shellcode',
  'pwn',
  'buffer',
  'rop',
  'canary',
  'pie',
  'aslr',
  'asm',
  'assembly',
]

function scoreChallenge(ch: {
  description: string
  category: string
  attachmentPaths: string[]
  dir: string
}): number {
  let score = 0

  // Description length (longer = more complex instructions)
  score += Math.min(ch.description.length / 40, 8)

  // Hard keywords
  for (const kw of HARD_KEYWORDS) {
    if (ch.description.toLowerCase().includes(kw)) score += 3
  }

  // Stego/image challenges
  if (/stego|hidden|lsb|binwalk/i.test(ch.description)) score += 2

  // File-type difficulty
  for (const f of ch.attachmentPaths) {
    const ext = f.split('.').pop()?.toLowerCase()
    if (ext === 'py' || ext === 'java' || ext === 'txt') score += 1
    if (ext === 'png' || ext === 'jpg' || ext === 'bmp' || ext === 'gif') score += 2
    if (ext === 'elf' || ext === 'exe' || ext === 'bin' || ext === 'S' || ext === 'asm') score += 3
    // File size
    try {
      const buf = readFileSync(resolve(ch.dir, f))
      score += Math.min(buf.length / 5000, 5)
    } catch {
      /* file may not exist */
    }
  }

  // Category base difficulty
  const catMult: Record<string, number> = {
    crypto: 1.0,
    rev: 0.8,
    misc: 0.7,
    forensics: 1.2,
    pwn: 1.5,
    web: 0.6,
  }
  score *= catMult[ch.category] ?? 1.0

  return score
}

function tierForScore(score: number): 'fast' | 'medium' | 'heavy' {
  if (score < 3) return 'fast'
  if (score < 7) return 'medium'
  return 'heavy'
}

function tierTimeout(tier: 'fast' | 'medium' | 'heavy'): number {
  return { fast: 90_000, medium: 240_000, heavy: 420_000 }[tier]
}

// ── Challenge discovery ────────────────────────────────────────────

export function discoverChallenges(rootDir: string): Challenge[] {
  const challenges: Challenge[] = []

  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const manifestPath = resolve(rootDir, entry.name, 'challenge.json')
    if (!existsSync(manifestPath)) continue

    try {
      const raw: ChallengeManifest = JSON.parse(
        readFileSync(manifestPath, 'utf-8'),
      ) as ChallengeManifest
      const ch: Challenge = {
        dir: resolve(rootDir, entry.name),
        manifestPath,
        id: raw.id ?? entry.name,
        title: raw.title ?? raw.id ?? entry.name,
        category: raw.category ?? 'misc',
        description: raw.description ?? '',
        expectedFlagSha256: raw.expectedFlagSha256 ?? '',
        attachmentPaths: raw.attachmentPaths ?? [],
        difficultyScore: 0,
        tier: 'fast',
      }
      ch.difficultyScore = scoreChallenge(ch)
      ch.tier = tierForScore(ch.difficultyScore)
      challenges.push(ch)
    } catch {
      // Skip broken manifests
    }
  }

  // Sort: easy first (low score first), then alphabetical
  challenges.sort((a, b) => a.difficultyScore - b.difficultyScore || a.id.localeCompare(b.id))

  return challenges
}

// ── Single challenge solver ────────────────────────────────────────

interface SolveOutcome {
  flag: string | null
  status: SolveResult['status']
  stdout: string
  stderr: string
}

function solveOne(ch: Challenge, timeoutMs: number): Promise<SolveOutcome> {
  return new Promise((resolve) => {
    const proc: ChildProcess = spawn('npx', ['tsx', 'src/ctf/cli/solve.ts', ch.manifestPath], {
      cwd: PROJECT_ROOT,
      env: {
        ...(process.env as Record<string, string | undefined>),
        OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? '',
        OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? '',
        OVOGO_MODEL: process.env.OVOGO_MODEL ?? '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''

    proc.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString()
    })
    proc.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString()
    })

    const timer = setTimeout(() => {
      proc.kill('SIGKILL')
      resolve({ flag: null, status: 'timeout', stdout, stderr })
    }, timeoutMs)

    proc.on('close', (code) => {
      clearTimeout(timer)

      if (code === null) {
        resolve({ flag: null, status: 'timeout', stdout, stderr })
        return
      }

      // Extract flag from output
      const flagMatch = stdout.match(/Extracted flag:\s*(.+)/)
      const flag = flagMatch ? flagMatch[1].trim() : null

      if (code === 0 && stdout.includes('✓ SOLVED')) {
        resolve({ flag, status: 'solved', stdout, stderr })
      } else if (code !== 0 && flag && stdout.includes('✗ Wrong flag')) {
        resolve({ flag, status: 'wrong_flag', stdout, stderr })
      } else if (stdout.includes('✗ No flag found')) {
        resolve({ flag: null, status: 'no_flag', stdout, stderr })
      } else {
        resolve({ flag: null, status: 'failed', stdout, stderr })
      }
    })

    proc.on('error', (err) => {
      clearTimeout(timer)
      resolve({ flag: null, status: 'error', stdout, stderr: err.message })
    })
  })
}

// ── Competition runner ─────────────────────────────────────────────

export async function runCompetition(
  challengesDir: string,
  outputDir: string,
): Promise<CompetitionState> {
  const challenges = discoverChallenges(challengesDir)
  if (challenges.length === 0) {
    throw new Error('No challenges found.')
  }

  mkdirSync(outputDir, { recursive: true })
  const statePath = resolve(outputDir, 'results.json')

  const fastCount = challenges.filter((c) => c.tier === 'fast').length
  const medCount = challenges.filter((c) => c.tier === 'medium').length
  const heavyCount = challenges.filter((c) => c.tier === 'heavy').length

  process.stdout.write(`\n${'='.repeat(70)}\n`)
  process.stdout.write(`🏆 CTF Competition Runner\n`)
  process.stdout.write(`${'='.repeat(70)}\n`)
  process.stdout.write(
    `Challenges: ${challenges.length} (⚡${fastCount} ⏳${medCount} 🐢${heavyCount})\n`,
  )
  process.stdout.write(`Strategy: easy-first, tiered timeouts (90s/240s/420s)\n`)
  process.stdout.write(`${'-'.repeat(70)}\n\n`)

  const state: CompetitionState = {
    startedAt: new Date().toISOString(),
    totalChallenges: challenges.length,
    solved: 0,
    results: [],
  }

  let index = 0

  for (const ch of challenges) {
    index++
    const timeoutMs = tierTimeout(ch.tier)

    // Score display
    const emoji = { fast: '⚡', medium: '⏳', heavy: '🐢' }[ch.tier]
    process.stdout.write(
      `[${index}/${challenges.length}] ${emoji} [${ch.tier}:${timeoutMs / 1000}s] ` +
        `[${ch.category}] ${ch.id} (s=${ch.difficultyScore.toFixed(1)}) `,
    )

    const startedAt = Date.now()
    const result = await solveOne(ch, timeoutMs)
    const durationMs = Date.now() - startedAt

    const solveResult: SolveResult = {
      id: ch.id,
      category: ch.category,
      tier: ch.tier,
      difficultyScore: ch.difficultyScore,
      flag: result.flag,
      status: result.status,
      durationMs,
      solvedAt: result.status === 'solved' ? new Date().toISOString() : undefined,
      error: result.status === 'error' ? result.stderr : undefined,
    }

    state.results.push(solveResult)

    if (result.status === 'solved') {
      state.solved++
      process.stdout.write(`✅ (${(durationMs / 1000).toFixed(1)}s) → ${result.flag}\n`)
    } else if (result.status === 'timeout') {
      process.stdout.write(`⏱️ TIMEOUT\n`)
    } else if (result.status === 'wrong_flag') {
      process.stdout.write(`❌ WRONG\n`)
    } else if (result.status === 'no_flag') {
      process.stdout.write(`❌ NO_FLAG\n`)
    } else {
      process.stdout.write(`❌ FAILED\n`)
    }

    // Auto-save after each solve for crash recovery
    writeFileSync(statePath, JSON.stringify(state, null, 2))
  }

  return state
}

function printSummary(state: CompetitionState): void {
  const totalDuration = Date.now() - new Date(state.startedAt).getTime()
  const solved = state.results.filter((r) => r.status === 'solved')

  const byTier: Record<string, { total: number; solved: number }> = {}
  const byCategory: Record<string, { total: number; solved: number }> = {}

  for (const r of state.results) {
    byTier[r.tier] ??= { total: 0, solved: 0 }
    byTier[r.tier].total++
    if (r.status === 'solved') byTier[r.tier].solved++

    byCategory[r.category] ??= { total: 0, solved: 0 }
    byCategory[r.category].total++
    if (r.status === 'solved') byCategory[r.category].solved++
  }

  process.stdout.write(`\n${'='.repeat(70)}\n`)
  process.stdout.write(`📊 FINAL RESULTS\n`)
  process.stdout.write(`${'='.repeat(70)}\n`)
  process.stdout.write(
    `Solved: ${solved.length}/${state.totalChallenges} ` +
      `(${Math.round((100 * solved.length) / state.totalChallenges)}%)\n`,
  )
  process.stdout.write(`Total time: ${(totalDuration / 60000).toFixed(1)} min\n\n`)

  process.stdout.write(`By tier:\n`)
  for (const [tier, stats] of Object.entries(byTier)) {
    const pct = stats.total > 0 ? Math.round((100 * stats.solved) / stats.total) : 0
    process.stdout.write(`  ${tier}: ${stats.solved}/${stats.total} (${pct}%)\n`)
  }

  process.stdout.write(`\nBy category:\n`)
  for (const [cat, stats] of Object.entries(byCategory)) {
    const pct = stats.total > 0 ? Math.round((100 * stats.solved) / stats.total) : 0
    process.stdout.write(`  ${cat}: ${stats.solved}/${stats.total} (${pct}%)\n`)
  }

  process.stdout.write(`\nSolved flags:\n`)
  for (const r of solved) {
    process.stdout.write(`  ✅ [${r.tier}] ${r.id} → ${r.flag}\n`)
  }

  // Failed breakdown
  process.stdout.write(`\nFailed:\n`)
  for (const r of state.results) {
    if (r.status !== 'solved') {
      process.stdout.write(`  ❌ [${r.tier}] ${r.id} — ${r.status}\n`)
    }
  }
}

// ── CLI entry point ────────────────────────────────────────────────

const args = process.argv.slice(2)
const challengesDir = args[0] ?? resolve(process.cwd(), 'challenges')
const outputDir = args[1] ?? resolve(process.cwd(), 'competition-results')

if (!existsSync(challengesDir)) {
  process.stderr.write(`Error: challenges directory not found: ${challengesDir}\n`)
  process.exit(1)
}

runCompetition(challengesDir, outputDir)
  .then((state) => {
    printSummary(state)
    const fails = state.results.filter((r) => r.status !== 'solved').length
    process.exit(fails > 0 ? 1 : 0)
  })
  .catch((err: Error) => {
    process.stderr.write(`Fatal: ${err.message}\n`)
    process.exit(2)
  })
