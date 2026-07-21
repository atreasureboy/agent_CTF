#!/usr/bin/env node
/**
 * ovogogogo-ctf — CTF-harness entry point for the unified Agent Harness.
 *
 * Build on top of the existing ovogogogo engine by injecting a CTF-aware
 * ToolBroker. CLI flags:
 *
 *   --profile <id>            Built-in Profile id (orchestrator | triage |
 *                             image-stego | crypto | file-forensics) —
 *                             default: orchestrator
 *   --contest <id>            Contest id (defaults to basename of cwd)
 *   --task-id <id>            Task id (defaults to a randomly generated id)
 *   --allow-public-network    Disable scope.allowPublicNetwork=false default
 *   --allow-host <host>       Add host to ContestScope.allowedHosts (repeatable)
 *   --run-workflow <id>       Run a workflow by id then exit (no LLM call)
 *   --input <path>            FILE_INPUT passed into the workflow
 *   --text <str>              TEXT_INPUT passed into the workflow
 *
 * Examples:
 *   ovogogogo-ctf --profile image-stego --run-workflow image_quick_scan --input a.png
 *   ovogogogo-ctf --profile crypto --run-workflow rsa_common_attacks --text "n=12345 e=65537"
 *   ovogogogo-ctf --profile orchestrator "decide how to solve this puzzle"
 */

import { resolve, join, dirname } from 'path'
import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { fileURLToPath } from 'url'

// ── .env auto-loader (mirrors the main CLI's)
{
  const __scriptDir = dirname(fileURLToPath(import.meta.url))
  const __projectRoot = resolve(__scriptDir, '..', '..')
  for (const dir of [process.cwd(), __projectRoot]) {
    const envPath = join(dir, '.env')
    if (!existsSync(envPath)) continue
    try {
      for (const line of readFileSync(envPath, 'utf8').split('\n')) {
        const t = line.trim()
        if (!t || t.startsWith('#')) continue
        const eq = t.indexOf('=')
        if (eq <= 0) continue
        const key = t.slice(0, eq).trim()
        const val = t.slice(eq + 1).trim()
        if (!process.env[key]) process.env[key] = val
      }
    } catch { /* best-effort */ }
    break
  }
}

// ── ANSI helpers
const RESET = '\x1b[0m'
const DIM = '\x1b[2m'
const BOLD = '\x1b[1m'
const CYAN = '\x1b[36m'
const YELLOW = '\x1b[33m'
const RED = '\x1b[31m'
const GREEN = '\x1b[32m'

interface CtfArgs {
  profile: string
  contest?: string
  taskId?: string
  allowPublicNetwork: boolean
  allowHosts: string[]
  runWorkflow?: string
  input?: string
  text?: string
  task?: string
  help: boolean
  version: boolean
  cwd: string
}

const VERSION = '0.1.0'

function printHelp(): void {
  process.stdout.write(`USAGE
  ovogogogo-ctf [options] [task]

OPTIONS
  --profile <id>            Built-in Profile: orchestrator | triage | image-stego | crypto | file-forensics
                             (default: orchestrator)
  --contest <id>            Contest id (default: directory basename)
  --task-id <id>            Task id (default: auto-generated)
  --allow-public-network    Disable ContestScope public-network block (default: deny)
  --allow-host <host>       Whitelist a host (repeatable)
  --run-workflow <id>       Run a workflow by id and exit
  --input <path>            FILE_INPUT for the workflow
  --text <str>              TEXT_INPUT for the workflow
  --cwd <path>              Project root (default: cwd)
  -v, --version             Print version
  -h, --help                Show this help

EXAMPLES
  ovogogogo-ctf --profile image-stego --run-workflow image_quick_scan --input ctf-sample.png
  ovogogogo-ctf --profile crypto --run-workflow encoding_sweep --text "RkxBR3t..."
  ovogogogo-ctf --profile orchestrator "decide how to solve this puzzle"
`)
}

function parseArgs(argv: string[]): CtfArgs {
  const args = argv.slice(2)
  let profile = 'orchestrator'
  let contest: string | undefined
  let taskId: string | undefined
  let allowPublicNetwork = false
  const allowHosts: string[] = []
  let runWorkflow: string | undefined
  let input: string | undefined
  let text: string | undefined
  let help = false
  let version = false
  let cwd = process.env.OVOGO_CWD ?? process.cwd()
  const positional: string[] = []

  const takesValue = (i: number) => {
    if (i + 1 >= args.length) throw new Error(`flag ${args[i]} requires a value`)
    return args[++i]
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    switch (arg) {
      case '-h': case '--help': help = true; break
      case '-v': case '-V': case '--version': version = true; break
      case '--profile': profile = takesValue(i); break
      case '--contest': contest = takesValue(i); break
      case '--task-id': taskId = takesValue(i); break
      case '--allow-public-network': allowPublicNetwork = true; break
      case '--allow-host': allowHosts.push(takesValue(i)); break
      case '--run-workflow': runWorkflow = takesValue(i); break
      case '--input': input = takesValue(i); break
      case '--text': text = takesValue(i); break
      case '--cwd': cwd = takesValue(i); break
      default:
        if (arg.startsWith('-')) {
          process.stderr.write(`${YELLOW}warning: unknown flag ${arg} (ignored)${RESET}\n`)
        } else {
          positional.push(arg)
        }
    }
  }
  const task = positional.length > 0 ? positional.join(' ') : undefined
  return { profile, contest, taskId, allowPublicNetwork, allowHosts, runWorkflow, input, text, task, help, version, cwd }
}

// ── main ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv)
  const cwd = resolve(args.cwd)

  if (args.help) {
    printHelp()
    process.exit(0)
  }

  if (args.version) {
    process.stdout.write(`${VERSION} (ovogogogo-ctf)\n`)
    process.exit(0)
  }

  process.stdout.write(`${CYAN}${BOLD}ovogogogo-ctf ${VERSION}${RESET}\n`)
  process.stdout.write(`cwd: ${cwd}\n`)
  process.stdout.write(`profile: ${BOLD}${args.profile}${RESET}\n`)

  // Lazy import to keep startup fast.
  const { createHarness } = await import('../src/core/harness.js')
  const { ensureProfilesRegistered } = await import('../src/capabilityProfiles/index.js')
  const { ensureWorkflowsRegistered, __resetWorkflowRegistrationForTests } = await import('../src/workflows/index.js')
  ensureProfilesRegistered()
  __resetWorkflowRegistrationForTests()

  // ContestScope — load .ovogo/contest.json first, merge with CLI overrides.
  const { resolveContestConfig } = await import('../src/core/contestConfig.js')
  const { ContestScopeChecker } = await import('../src/core/contestScope.js')
  const { scope: mergedScope, sourcePath: contestCfgPath } = resolveContestConfig({
    cwd,
    cliOverride: {
      allowedHosts: args.allowHosts.length > 0 ? args.allowHosts : undefined,
      allowPublicNetwork: args.allowPublicNetwork ? true : undefined,
    },
  })
  const scope = new ContestScopeChecker(mergedScope)
  if (contestCfgPath) {
    process.stdout.write(`contest config: ${CYAN}${contestCfgPath}${RESET}\n`)
  }

  const harness = createHarness({
    cwd,
    profile: args.profile,
    contestId: args.contest,
    taskId: args.taskId,
    contestScope: mergedScope,
    inlineMaxBytes: 1024,
    jobLimits: { maxPerAgent: 0, maxPerTask: 0 }, // CLI mode forces inline
  })
  // Re-bind the broker's scope to the constructed checker.
  ;(harness.broker as unknown as { opts: { contestScope?: unknown } }).opts.contestScope = scope

  // Register the same workflows so runWorkflow can find them.
  ensureWorkflowsRegistered(harness.workflowRegistry)

  process.stdout.write(`task workspace: ${harness.taskWorkspace.paths.workspaceDir}\n`)
  process.stdout.write(`events:        ${harness.taskWorkspace.paths.eventsFile}\n`)

  // ── Workflow-only mode ────────────────────────────────────────────────
  if (args.runWorkflow) {
    const wf = harness.workflowRegistry.get(args.runWorkflow)
    if (!wf) {
      const known = harness.workflowRegistry.list().map((w) => w.id).join(', ')
      process.stderr.write(`${RED}Unknown workflow: ${args.runWorkflow}${RESET}\n  Known: ${known}\n`)
      process.exit(1)
    }
    const inputs: Record<string, unknown> = {}
    if (args.input) inputs.FILE_INPUT = args.input
    if (args.text) inputs.TEXT_INPUT = args.text
    process.stdout.write(`running workflow: ${BOLD}${args.runWorkflow}${RESET}\n`)
    const result = await harness.runWorkflow(wf, inputs)
    process.stdout.write(`\n${GREEN}workflow status:${RESET} ${result.status}\n`)
    process.stdout.write(`  steps: ${result.stepOutcomes.length}, artifacts: ${result.emittedArtifactCount}, findings: ${result.emittedFindingCount}\n`)
    if (result.stepOutcomes.length > 0) {
      process.stdout.write(`  per-step outcomes:\n`)
      for (const s of result.stepOutcomes) {
        process.stdout.write(`    - [${s.status}] ${s.stepId}${s.error ? `: ${s.error.slice(0, 80)}` : ''}\n`)
      }
    }
    process.exit(result.status === 'cancelled' ? 1 : 0)
  }

  // ── No task → bail ──────────────────────────────────────────────────
  if (!args.task) {
    process.stderr.write(`${YELLOW}No task or --run-workflow supplied. Use --help.${RESET}\n`)
    process.exit(2)
  }

  process.stdout.write(`${DIM}LLM-backed turn is reserved for clients with a real API key.${RESET}\n`)
  process.stdout.write(`${DIM}For headless verification of the harness, run with --run-workflow.${RESET}\n`)
}

main().catch((err: unknown) => {
  process.stderr.write(`${RED}fatal:${RESET} ${(err as Error).message}\n`)
  process.exit(1)
})
