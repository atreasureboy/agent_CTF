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
 *   6. Installs `process.on` SIGINT/SIGTERM → `runtime.cancel`,
 *      tracked with an in-flight shutdown promise so duplicate
 *      signals are idempotent.
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
import type {
  createCTFTaskRuntime,
  CTFTaskRuntime,
} from '../src/core/ctfRuntime/createCTFTaskRuntime.js'

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
    } catch {
      /* best-effort */
    }
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
  /** §13 R4 — multi-input --text (parsed from `--text KEY=VALUE`). */
  textInputs?: Record<string, string>
  task?: string
  help: boolean
  version: boolean
  cwd: string
  /** Competition mode — max concurrent tasks. */
  concurrency?: number
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
  --concurrency <N>         Max concurrent tasks in competition mode (default: OVOGO_MAX_CONCURRENCY or 4)
  -v, --version             Print version
  -h, --help                Show this help

COMMANDS
  batch <dir>               Solve all challenge manifests in a directory concurrently
  solve <challenge.json>    Solve a single challenge manifest
  oneshot list              List available one-shot manifests
  doctor [--oneshot]        Check environment health
  benchmark [runs]          Run benchmarking suite

EXAMPLES
  ovogogogo-ctf --profile image-stego --run-workflow image_quick_scan --input ctf-sample.png
  ovogogogo-ctf --profile crypto --run-workflow encoding_sweep --text "RkxBR3t..."
  ovogogogo-ctf --profile orchestrator "decide how to solve this puzzle"
  ovogogogo-ctf --concurrency 8 batch ./challenges/
  ovogogogo-ctf solve ./challenges/crypto1.json
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
  /** §13 R4 — multi-input --text. Each `--text KEY=VALUE` maps to
   *  `inputs[key.toLowerCase()] = VALUE`. Bare `--text VALUE` is the
   *  legacy form (defaults to KEY=TEXT_INPUT). */
  const textInputs: Record<string, string> = {}
  let help = false
  let version = false
  let cwd = process.env.OVOGO_CWD ?? process.cwd()
  let concurrency: number | undefined
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
      // Phase 1.7 audit — refuse a flag-like token as a value unless it
      // explicitly looks like a value (e.g. negative number, =-prefixed
      // assignment). Otherwise `ovogogogo-ctf --input --profile foo`
      // silently consumed `--profile` as the file path.
      if (next.startsWith('-') && !/^-\d/.test(next)) {
        throw new Error(`flag ${flag} requires a value (got "${next}")`)
      }
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
      // §13 R4 — `--text KEY=VALUE` registers an extra workflow input
      // (e.g. `--text KNOWN_PLAINTEXT=...`). Bare `--text VALUE` is
      // equivalent to `--text TEXT_INPUT=VALUE` (back-compat for callers
      // that only need the default TEXT_INPUT).
      const value = takeValue(arg)
      const eq = value.indexOf('=')
      if (eq > 0) {
        textInputs[value.slice(0, eq).toLowerCase()] = value.slice(eq + 1)
      } else {
        textInputs['text_input'] = value
      }
      text = value
      continue
    }
    if (arg === '--cwd' || arg.startsWith('--cwd=')) {
      cwd = takeValue(arg)
      continue
    }
    if (arg === '--concurrency' || arg.startsWith('--concurrency=')) {
      concurrency = parseInt(takeValue(arg), 10)
      if (!Number.isFinite(concurrency) || concurrency < 1) {
        throw new Error(`--concurrency must be a positive integer, got ${concurrency}`)
      }
      continue
    }
    if (arg.startsWith('-')) {
      // Phase 1.7 — surface unknown flags as a real error.
      throw new Error(`unknown flag: ${arg}`)
    }
    positional.push(arg)
  }
  const task = positional.length > 0 ? positional.join(' ') : undefined
  return {
    profile,
    contest,
    taskId,
    allowPublicNetwork,
    allowHosts,
    runWorkflow,
    input,
    text,
    textInputs: Object.keys(textInputs).length > 0 ? textInputs : undefined,
    task,
    help,
    version,
    cwd,
    concurrency,
  }
}

/** Dependency seams — every IO is injectable so tests can swap them out. */
export interface CtfCliDependencies {
  stdout: NodeJS.WritableStream
  stderr: NodeJS.WritableStream
  /** Build an OpenAI client (or return undefined to skip LLM mode). */
  createClient?: (apiKey: string, baseURL?: string) => OpenAI
  /** Build a Renderer; defaults to a noop renderer. */
  createRenderer?: () => Renderer
  /** Construct the runtime. Defaults to createCTFTaskRuntime. */
  createRuntime?: typeof createCTFTaskRuntime
  /**
   * Register signal handlers. Defaults to process.on + an in-flight
   * shutdown promise cache so 2nd SIGINT/SIGTERM is a no-op.
   */
  registerSignals?: (handler: (sig: string) => void) => () => void
  /** Resolve env vars / config. Defaults to process.env. */
  env?: NodeJS.ProcessEnv
}

/** Public entry — fully testable. */
export async function runCtfCli(
  argv: string[],
  deps: Partial<CtfCliDependencies> = {},
): Promise<number> {
  const stdout = deps.stdout ?? process.stdout
  const stderr = deps.stderr ?? process.stderr
  const env = deps.env ?? process.env

  // Fast-path help/version (no arg parsing required).
  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp(stdout)
    stdout.write(`
ONEShot COMMANDS (six_goal §十四)
  ovogogogo-ctf doctor [--oneshot]
  ovogogogo-ctf oneshot list
  ovogogogo-ctf oneshot check <manifestId>
  ovogogogo-ctf benchmark [runs]
`)
    return 0
  }
  if (argv.includes('--version') || argv.includes('-V') || argv.includes('-v')) {
    stdout.write(`${VERSION} (ovogogogo-ctf)\n`)
    return 0
  }

  // ── Doctor / OneShot command fast-paths (no Runtime needed).
  if (argv[2] === 'doctor' || argv.includes('--doctor')) {
    const { runDoctorCommand } = await import('../src/ctf/cli/doctor.js')
    return runDoctorCommand(argv.slice(argv.indexOf('doctor') >= 0 ? argv.indexOf('doctor') : 2), {
      stdout,
      stderr,
    })
  }
  if (argv[2] === 'oneshot') {
    const { runOneshotCommand } = await import('../src/ctf/cli/oneshot.js')
    return runOneshotCommand(argv.slice(3), { stdout, stderr })
  }
  if (argv[2] === 'benchmark') {
    const { runBenchmarkCommand } = await import('../src/ctf/cli/benchmarkCli.js')
    return runBenchmarkCommand(argv.slice(3), { stdout, stderr })
  }
  if (argv[2] === 'solve') {
    if (!argv[3]) {
      stderr.write(`${RED}error:${RESET} solve requires a challenge.json path\n`)
      return 1
    }
    const solveModule: {
      runSolveCommand: (
        path: string,
        options: { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream },
      ) => Promise<number>
    } = await import('../src/ctf/cli/solve.js')
    return solveModule.runSolveCommand(argv[3], { stdout, stderr })
  }
  if (argv[2] === 'batch') {
    if (!argv[3]) {
      stderr.write(`${RED}error:${RESET} batch requires a manifest directory\n`)
      return 1
    }
    return runBatchCommand(argv[3], argv.slice(4), { stdout, stderr, env })
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
  const { createCTFTaskRuntime } = await import('../src/core/ctfRuntime/createCTFTaskRuntime.js')
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
      // Phase 1.7 audit (P1) — install signal handlers AFTER `createRuntime`
      // completes. The boot sequence (workspace creation, registry setup,
      // profile selection) is bounded; a Ctrl+C during boot will trigger
      // Node's default action (exit), but the `try`/`finally` ensures
      // `dispose` runs and we still get a clean teardown of everything
      // we successfully allocated. The previous order (signal AFTER)
      // had the same property — the difference is that `unregisterSignals`
      // is now guaranteed to be wired when boot completes. Note: the
      // original P1 audit finding recommended installing BEFORE createRuntime;
      // doing so requires a separate pre-runtime abort hook. We accept the
      // boot-window risk as it is small (sub-second) and the partial
      // dispose is still safe.
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
        const known = reg
          .list()
          .map((w) => w.id)
          .join(', ')
        stderr.write(`${RED}Unknown workflow: ${args.runWorkflow}${RESET}\n  Known: ${known}\n`)
        return 1
      }
      const inputs: Record<string, unknown> = {}
      if (args.input) inputs['FILE_INPUT'] = args.input
      // Apply textInputs FIRST (last-wins if `text` overlaps), then the
      // legacy single `--text VALUE` form as a back-compat fallback.
      for (const [k, v] of Object.entries(args.textInputs ?? {})) inputs[k] = v
      if (args.text && !('text_input' in inputs)) {
        inputs['TEXT_INPUT'] = args.text
      }
      if (process.env.OVOGO_DEBUG_TOOL_BROKER) {
        // eslint-disable-next-line no-console
        console.error(
          `[cli.runWorkflow] args.text_len=${args.text ? args.text.length : 'unset'} inputs_keys=${Object.keys(inputs).join(',')}`,
        )
      }
      stdout.write(`running workflow: ${BOLD}${args.runWorkflow}${RESET}\n`)
      const result = await runtime.orchestrator.runWorkflow(args.runWorkflow, inputs)
      stdout.write(`\n${GREEN}workflow status:${RESET} ${result.status}\n`)
      stdout.write(
        `  steps: ${result.stepOutcomes.length}, artifacts: ${result.emittedArtifactCount}, findings: ${result.emittedFindingCount}\n`,
      )
      if (result.stepOutcomes.length > 0) {
        stdout.write(`  per-step outcomes:\n`)
        for (const s of result.stepOutcomes) {
          stdout.write(
            `    - [${s.status}] ${s.stepId}${s.error ? `: ${s.error.slice(0, 80)}` : ''}\n`,
          )
        }
      }
      // §13 R2 — print the actual finding summaries so the operator
      // can see what the workflow emitted without grepping the
      // sessions/<task>/findings.jsonl. We pull from the live state
      // store (which the projector populated during the run).
      //
      // Filter strategy: scope by workflowId AND recency so unrelated
      // findings from prior runs never leak in. Allow a 60s window
      // because the projector dispatches findings asynchronously
      // after `runWorkflow` resolves.
      const stateSnapshot = runtime.orchestrator.store.getState()
      const recentThreshold = Date.now() - 60_000
      const findingsAfter = stateSnapshot.findings.filter((f) => {
        const meta = f as { workflowId?: string; workflowRunId?: string }
        // Some projectors emit with `workflowId` set instead of
        // `workflowRunId`. The workflow-run itself is the lookup
        // identifier we have; we don't have its id without a state
        // search, so we just filter by recency + workflowId.
        if (meta.workflowId === args.runWorkflow) return true
        const created = typeof f.createdAt === 'string' ? Date.parse(f.createdAt) : f.createdAt
        return created > recentThreshold
      })
      if (findingsAfter.length > 0) {
        stdout.write(`  emitted findings:\n`)
        for (const f of findingsAfter) {
          stdout.write(
            `    - [${f.category}] ${f.title}` +
              // FindingConfidence is the typed union 'low' | 'medium' | 'high';
              // it can also surface as a string at runtime, so handle both.
              ` [confidence=${String(f.confidence)}]` +
              `\n      summary: ${f.summary.slice(0, 240)}\n`,
          )
        }
      }
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
      : new OpenAI({
          apiKey: apiKey ?? '',
          baseURL,
          timeout: parseInt(env['OVOGO_LLM_TIMEOUT_MS'] ?? '120000', 10) || 120_000,
          maxRetries: parseInt(env['OVOGO_LLM_MAX_RETRIES'] ?? '5', 10) || 5,
        })

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
      maxConcurrency: args.concurrency,
    })
    unregisterSignals = installSignalHandlers(deps, runtime)
    const r = await runtime.orchestrator.runMainAgent(args.task)
    stdout.write(`\n${GREEN}run status:${RESET} ${r.status}\n`)
    if (r.error) stderr.write(`${RED}run error:${RESET} ${r.error}\n`)
    if (r.summary) stdout.write(`  summary: ${r.summary}\n`)
    // Distinct exit codes so CI can distinguish outcomes. Mirrors the
    // workflow branch (success → 0; cancelled/failed → non-zero).
    if (r.status === 'completed') return 0
    if (r.status === 'cancelled') return 130
    return 1
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err)
    const stack = (err as Error)?.stack
    stderr.write(`${RED}fatal:${RESET} ${msg}\n`)
    if (stack) stderr.write(`${stack}\n`)
    return 1
  } finally {
    if (unregisterSignals) unregisterSignals()
    if (runtime) {
      await runtime.dispose()
    }
  }
}

// ── Batch command — competition multi-task solver ──────────────────────
async function runBatchCommand(
  manifestDir: string,
  extraArgs: string[],
  deps: { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream; env: NodeJS.ProcessEnv },
): Promise<number> {
  const { stdout, stderr, env } = deps
  const apiKey = env['OPENAI_API_KEY']
  const baseURL = env['OPENAI_BASE_URL']
  const model = env['OVOGO_MODEL'] ?? 'gpt-4o'

  if (!apiKey) {
    stderr.write(`${RED}error:${RESET} batch mode requires OPENAI_API_KEY\n`)
    return 3
  }

  const { ensureProfilesRegistered } = await import('../src/capabilityProfiles/index.js')
  const { resolveContestConfig } = await import('../src/core/contestConfig.js')
  const { createCTFTaskRuntime } = await import('../src/core/ctfRuntime/createCTFTaskRuntime.js')
  ensureProfilesRegistered()

  const { scope: mergedScope } = resolveContestConfig({
    cwd: resolve(process.cwd()),
    cliOverride: {},
  })

  // Parse extra args for --concurrency
  let concurrency: number | undefined
  for (let i = 0; i < extraArgs.length; i++) {
    if (extraArgs[i] === '--concurrency' && extraArgs[i + 1]) {
      concurrency = parseInt(extraArgs[++i], 10)
    } else if (extraArgs[i].startsWith('--concurrency=')) {
      concurrency = parseInt(extraArgs[i].split('=')[1], 10)
    }
  }

  const client = new OpenAI({
    apiKey,
    baseURL,
    timeout: parseInt(env['OVOGO_LLM_TIMEOUT_MS'] ?? '120000', 10) || 120_000,
    maxRetries: parseInt(env['OVOGO_LLM_MAX_RETRIES'] ?? '5', 10) || 5,
  })
  const { Renderer } = await import('../src/ui/renderer.js')

  const runtime = await createCTFTaskRuntime({
    cwd: resolve(process.cwd()),
    profileId: 'orchestrator',
    contestScope: mergedScope,
    client,
    renderer: new Renderer(),
    modelConfig: { model, apiKey, baseURL },
    mode: 'llm',
    maxConcurrency: concurrency,
  })

  let unregisterSignals: (() => void) | undefined
  try {
    unregisterSignals = installSignalHandlers({}, runtime)
    stdout.write(`${CYAN}${BOLD}ovogogogo-ctf batch solver${RESET}\n`)
    stdout.write(`manifest dir: ${resolve(manifestDir)}\n`)
    stdout.write(`concurrency:  ${concurrency ?? env['OVOGO_MAX_CONCURRENCY'] ?? '4'}\n`)
    stdout.write(`model:        ${model}\n\n`)

    const result = await runtime.batchSolve(manifestDir)

    stdout.write(`${BOLD}── Results ──${RESET}\n`)
    stdout.write(`${GREEN}  Solved: ${result.solved.length}${RESET}\n`)
    for (const s of result.solved) {
      stdout.write(`    ✅ ${GREEN}${s.taskId}${RESET} → ${BOLD}${s.flag}${RESET}\n`)
    }
    stdout.write(`${RED}  Failed: ${result.failed.length}${RESET}\n`)
    for (const f of result.failed) {
      stdout.write(`    ❌ ${RED}${f.taskId}${RESET} — ${f.reason}\n`)
    }
    stdout.write(`\n  Total:  ${result.total}\n`)
    stdout.write(
      `  Rate:   ${((result.solved.length / Math.max(result.total, 1)) * 100).toFixed(0)}%\n`,
    )

    return result.solved.length > 0 ? 0 : 1
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err)
    stderr.write(`${RED}fatal:${RESET} ${msg}\n`)
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
  const register =
    deps.registerSignals ??
    ((cb: (sig: string) => void) => {
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
