#!/usr/bin/env node
/**
 * ovogogogo-ctf — CTF-harness entry point.
 *
 * Architecture (forth_goal.md §四 + §五):
 *   CLI (runCtfCli) → createCTFTaskRuntime → CTFTaskOrchestrator →
 *     Main Agent / Workflow / Specialist
 *
 * The CLI is intentionally thin. It only:
 *   1. Parses flags.
 *   2. Resolves ContestConfig + ContestScope.
 *   3. Builds an OpenAI client + Renderer when an API key is supplied.
 *   4. Calls `createCTFTaskRuntime(...)` to wire the entire runtime.
 *   5. Routes workflow + chat modes through the orchestrator.
 *   6. Installs `process.once` SIGINT/SIGTERM → `runtime.cancel`.
 *   7. Always disposes in `finally` (no `process.exit` skip).
 *
 * It does NOT create a Harness directly. It does NOT touch ToolBroker.opts.
 * It does NOT use the legacy fallback path in `dispatchNext`.
 */

import { resolve, join, dirname } from 'path'
import { existsSync, readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import OpenAI from 'openai'
import type { Renderer } from '../src/ui/renderer.js'
import type { createCTFTaskRuntime, CTFTaskRuntime } from '../src/core/ctfRuntime/createCTFTaskRuntime.js'

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

function printHelp(out: NodeJS.WritableStream = process.stdout): void {
  out.write(`USAGE
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
  let afterDoubleDash = false

  /**
   * Phase 1.7 — index-based parser. Walks argv with `i++` so it consumes
   * the value of a flag at `i+1` reliably, supports `--flag=value` form,
   * terminates flag parsing at `--`, refuses missing values, refuses
   * unknown flags, and treats repeated flags as "last wins" for scalars /
   * append for list flags.
   */
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === undefined) continue
    if (afterDoubleDash) {
      positional.push(arg)
      continue
    }
    if (arg === '--') {
      afterDoubleDash = true
      continue
    }
    if (arg === '-h' || arg === '--help') {
      help = true
      continue
    }
    if (arg === '-v' || arg === '-V' || arg === '--version') {
      version = true
      continue
    }
    if (arg === '--allow-public-network') {
      allowPublicNetwork = true
      continue
    }
    // Flags that take a value, possibly as `--flag=value`.
    const takeValue = (flag: string): string => {
      const eqIdx = flag.indexOf('=')
      if (eqIdx >= 0) return flag.slice(eqIdx + 1)
      const next = args[i + 1]
      if (next === undefined) throw new Error(`flag ${flag} requires a value`)
      i += 1
      return next
    }
    if (arg === '--profile' || arg.startsWith('--profile=')) {
      profile = takeValue(arg)
      continue
    }
    if (arg === '--contest' || arg.startsWith('--contest=')) {
      contest = takeValue(arg)
      continue
    }
    if (arg === '--task-id' || arg.startsWith('--task-id=')) {
      taskId = takeValue(arg)
      continue
    }
    if (arg === '--allow-host' || arg.startsWith('--allow-host=')) {
      allowHosts.push(takeValue(arg))
      continue
    }
    if (arg === '--run-workflow' || arg.startsWith('--run-workflow=')) {
      runWorkflow = takeValue(arg)
      continue
    }
    if (arg === '--input' || arg.startsWith('--input=')) {
      input = takeValue(arg)
      continue
    }
    if (arg === '--text' || arg.startsWith('--text=')) {
      text = takeValue(arg)
      continue
    }
    if (arg === '--cwd' || arg.startsWith('--cwd=')) {
      cwd = takeValue(arg)
      continue
    }
    if (arg.startsWith('-')) {
      // Phase 1.7 — surface unknown flags as a real error.
      throw new Error(`unknown flag: ${arg}`)
    }
    positional.push(arg)
  }
  const task = positional.length > 0 ? positional.join(' ') : undefined
  return { profile, contest, taskId, allowPublicNetwork, allowHosts, runWorkflow, input, text, task, help, version, cwd }
}

/** Dependency seams — every IO is injectable so tests can swap them out. */
export interface CtfCliDependencies {
  stdout: NodeJS.WritableStream
  stderr: NodeJS.WritableStream
  /** Build an OpenAI client (or return undefined to skip LLM mode). */
  createClient?: (apiKey: string, baseURL?: string) => OpenAI
  /** Build a Renderer; defaults to a noop renderer. */
  createRenderer?: () => Renderer
  /** Construct the runtime. Defaults to `createCTFTaskRuntime`. */
  createRuntime?: typeof createCTFTaskRuntime
  /** Register signal handlers. Defaults to process.once(SIGINT/SIGTERM). */
  registerSignals?: (handler: (sig: string) => void) => () => void
  /** Resolve env vars / config. Defaults to process.env. */
  env?: NodeJS.ProcessEnv
  /** Wall clock — used to compute task timestamps. */
  now?: () => number
}

/** Public entry — fully testable. */
export async function runCtfCli(
  argv: string[],
  deps: Partial<CtfCliDependencies> = {},
): Promise<number> {
  const stdout = deps.stdout ?? process.stdout
  const stderr = deps.stderr ?? process.stderr
  const env = deps.env ?? process.env
  const now = deps.now ?? Date.now

  // Fast-path help/version (no arg parsing required).
  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp(stdout)
    return 0
  }
  if (argv.includes('--version') || argv.includes('-V') || argv.includes('-v')) {
    stdout.write(`${VERSION} (ovogogogo-ctf)\n`)
    return 0
  }

  // §十四 — parseArgs inside the try block so missing-value / unknown-flag
  // errors become a clean exit 1 instead of an unhandled throw.
  let args: CtfArgs
  try {
    args = parseArgs(argv)
  } catch (err) {
    stderr.write(`${RED}error:${RESET} ${(err as Error).message}\n`)
    return 1
  }

  stdout.write(`${CYAN}${BOLD}ovogogogo-ctf ${VERSION}${RESET}\n`)
  stdout.write(`cwd: ${args.cwd}\n`)
  stdout.write(`profile: ${BOLD}${args.profile}${RESET}\n`)

  // Lazy imports — keep CLI startup snappy.
  const { ensureProfilesRegistered } = await import('../src/capabilityProfiles/index.js')
  const { resolveContestConfig } = await import('../src/core/contestConfig.js')
  const { createCTFTaskRuntime } = await import(
    '../src/core/ctfRuntime/createCTFTaskRuntime.js'
  )
  ensureProfilesRegistered()

  const { scope: mergedScope, sourcePath: contestCfgPath } = resolveContestConfig({
    cwd: resolve(args.cwd),
    cliOverride: {
      allowedHosts: args.allowHosts.length > 0 ? args.allowHosts : undefined,
      allowPublicNetwork: args.allowPublicNetwork ? true : undefined,
    },
  })
  if (contestCfgPath) {
    stdout.write(`contest config: ${CYAN}${contestCfgPath}${RESET}\n`)
  }

  // ── Build client + renderer for LLM mode (chat). Workflow-only can skip.
  const apiKey = env['OPENAI_API_KEY']
  const baseURL = env['OPENAI_BASE_URL']
  const model = env['OVOGO_MODEL'] ?? 'gpt-4o'

  let runtime: Awaited<ReturnType<typeof createCTFTaskRuntime>> | undefined
  let unregisterSignals: (() => void) | undefined

  const createRuntime = deps.createRuntime ?? createCTFTaskRuntime

  // §十四 — parseArgs moved inside the try block so a missing-value
  // error becomes a clean exit 1 instead of an unhandled throw.
  // (already done above; remove the duplicate below)

  try {
    // ── Workflow-only mode — no client / renderer required.
    if (args.runWorkflow) {
      runtime = await createRuntime({
        cwd: resolve(args.cwd),
        profileId: args.profile,
        contestScope: mergedScope,
        contestId: args.contest,
        taskId: args.taskId,
        jobLimits: { maxPerAgent: 0, maxPerTask: 0 },
      })
      unregisterSignals = installSignalHandlers(deps, runtime)
      const reg = runtime.mainHarness.workflowRegistry
      const wf = reg.get(args.runWorkflow)
      if (!wf) {
        const known = reg.list().map((w) => w.id).join(', ')
        stderr.write(`${RED}Unknown workflow: ${args.runWorkflow}${RESET}\n  Known: ${known}\n`)
        return 1
      }
      const inputs: Record<string, unknown> = {}
      if (args.input) inputs['FILE_INPUT'] = args.input
      if (args.text) inputs['TEXT_INPUT'] = args.text
      stdout.write(`running workflow: ${BOLD}${args.runWorkflow}${RESET}\n`)
      const result = await runtime.orchestrator.runWorkflow(args.runWorkflow, inputs)
      stdout.write(`\n${GREEN}workflow status:${RESET} ${result.status}\n`)
      stdout.write(`  steps: ${result.stepOutcomes.length}, artifacts: ${result.emittedArtifactCount}, findings: ${result.emittedFindingCount}\n`)
      if (result.stepOutcomes.length > 0) {
        stdout.write(`  per-step outcomes:\n`)
        for (const s of result.stepOutcomes) {
          stdout.write(`    - [${s.status}] ${s.stepId}${s.error ? `: ${s.error.slice(0, 80)}` : ''}\n`)
        }
      }
      void now
      // Audit rounds 6-10 — only `success` is a clean exit. `cancelled`,
      // `failed`, and `partial` all return non-zero so CI / orchestrators
      // can detect incomplete work.
      if (result.status === 'success') return 0
      if (result.status === 'cancelled') return 1
      // `partial` and `failed` indicate work that did not complete
      // cleanly; treat as non-zero exit.
      return 1
    }

    // ── Chat mode — requires a real LLM client.
    if (!args.task) {
      stderr.write(`${YELLOW}No task or --run-workflow supplied. Use --help.${RESET}\n`)
      return 2
    }
    if (!apiKey && !deps.createClient) {
      stderr.write(
        `${RED}error: LLM mode requires an OPENAI_API_KEY environment variable.${RESET}\n` +
          `${YELLOW}For headless verification, run with --run-workflow instead.${RESET}\n`,
      )
      return 3
    }
    const client = deps.createClient
      ? deps.createClient(apiKey ?? '', baseURL)
      : new OpenAI({ apiKey: apiKey ?? '', baseURL, timeout: 120_000, maxRetries: 5 })

    const renderer = deps.createRenderer
      ? deps.createRenderer()
      : new (await import('../src/ui/renderer.js')).Renderer()

    runtime = await createRuntime({
      cwd: resolve(args.cwd),
      profileId: args.profile,
      contestScope: mergedScope,
      contestId: args.contest,
      taskId: args.taskId,
      client,
      renderer,
      modelConfig: { model, apiKey: apiKey ?? '', baseURL },
      mode: 'llm',
    })
    unregisterSignals = installSignalHandlers(deps, runtime)
    const r = await runtime.orchestrator.runMainAgent(args.task)
    stdout.write(`\n${GREEN}run status:${RESET} ${r.status}\n`)
    if (r.summary) stdout.write(`  summary: ${r.summary}\n`)
    return r.status === 'completed' ? 0 : 1
  } catch (err) {
    stderr.write(`${RED}fatal:${RESET} ${(err as Error).message}\n`)
    return 1
  } finally {
    if (unregisterSignals) unregisterSignals()
    if (runtime) {
      await runtime.dispose()
    }
  }
}

function installSignalHandlers(
  deps: Partial<CtfCliDependencies>,
  runtime: CTFTaskRuntime,
): () => void {
  /**
   * Phase 1.7 — track the exact handler references so dispose can call
   * `process.off(handler)` instead of `process.removeAllListeners(sig)`,
   * which would clobber unrelated listeners installed by other modules.
   *
   * Also caches the in-flight shutdown promise so a second SIGINT does not
   * trigger a second `runtime.cancel` / `runtime.dispose`.
   */
  let shutdownPromise: Promise<void> | undefined
  function shutdown(sig: NodeJS.Signals): Promise<void> {
    if (!shutdownPromise) {
      shutdownPromise = runtime.cancel(`cli_${sig.toLowerCase()}`)
    }
    return shutdownPromise
  }
  // Phase 1.7 audit round 1 — the default registerSig handler now
  // wires the SUPPLIED callback (not its own closure), so custom
  // registerSignals callbacks work as expected and the dedup state
  // is shared.
  const register = deps.registerSignals ?? ((cb: (sig: string) => void) => {
    const handler = (sig: NodeJS.Signals): void => cb(sig)
    process.on('SIGINT', handler)
    process.on('SIGTERM', handler)
    return () => {
      process.off('SIGINT', handler)
      process.off('SIGTERM', handler)
    }
  })
  const unregister = register((sig) => {
    void shutdown(sig as NodeJS.Signals)
  })
  return unregister
}

// ── Module entry — only invoked when the script is run directly.
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
  runCtfCli(process.argv)
    .then((code) => {
      process.exitCode = code
    })
    .catch((err: unknown) => {
      process.stderr.write(`${RED}fatal:${RESET} ${(err as Error).message}\n`)
      process.exitCode = 1
    })
}