/**
 * createCTFTaskRuntime — single public entry that wires the full CTF Task
 * runtime. Every CTF CLI / REPL / test MUST go through this factory.
 *
 * Phase 3.1 — assembly order is:
 *
 *   1. Resolve Task AbortController.
 *   2. Build TaskExecutionContext.
 *   3. Resolve ProfileStore.
 *   4. TrajectoryRecorder (async queue).
 *   5. ModelCapabilityRegistry → ModelHealthStore → ModelCircuitBreaker → ModelRouter.
 *   6. Model Provider Adapter (OpenAICompatibleProvider) → ModelInvocationGateway.
 *   7. ToolVisibilityPolicy (fail-closed default).
 *   8. createHarness (injecting Gateway, Policy, TrajectoryRecorder).
 *   9. Build StateStore + Orchestrator.
 *  10. Wire Job lifecycle events & SolverPortfolio.
 */

import type OpenAI from 'openai'
import { readdirSync, existsSync, readFileSync } from 'fs'
import { resolve as resolvePath, join } from 'path'

import type { CapabilityProfile } from '../capabilityProfile.js'
import type { ContestScope } from '../contestScope.js'
import type { ContestConfig } from '../contestConfig.js'
import { createDefaultContestConfig } from '../contestConfig.js'
import { createHarness, type HarnessBundle } from '../harness.js'
import type { Renderer } from '../../ui/renderer.js'
import { TaskWorkspace } from '../../modules/taskWorkspace.js'

import type { TaskExecutionContext } from './taskExecutionContext.js'
import { CTFProfileStore, resolveProfileById } from './profileStore.js'
import { createLinkedAbortController, type LinkedAbortController } from './linkedAbortController.js'
import { CTFTaskOrchestrator } from './taskOrchestrator.js'
import type { AgentRuntimeDependencies, ModelConfig } from './agentRuntimeDependencies.js'
import { assertLlmDependencies } from './agentRuntimeDependencies.js'
import type { CTFTaskState } from './taskState.js'
import {
  BackgroundJobRunnerRegistryImpl,
  Dispatcher,
  type BackgroundJobRunnerRegistry,
} from '../../ctf/oneshot/dispatcher.js'
import type { RuntimeModelConfiguration } from '../modelReliability/modelRegistry.js'
import type { NativeSolverRuntimeDelegate } from '../solverPortfolio/nativeSolverAdapter.js'
import type { ExternalSolverAdapter } from '../solverPortfolio/solverAdapter.js'
import { ModelCapabilityRegistry } from '../modelReliability/modelRegistry.js'
import { ModelHealthStore } from '../modelReliability/modelHealth.js'
import { ModelCircuitBreaker } from '../modelReliability/modelCircuitBreaker.js'
import { ModelRouter } from '../modelReliability/modelRouter.js'
import { StructuredModelGateway } from '../modelReliability/structuredModelGateway.js'
import { SolverPortfolio } from '../solverPortfolio/solverPortfolio.js'
import { ToolVisibilityPolicy } from '../toolVisibility/toolVisibilityPolicy.js'
import { DefaultToolExposureResolver } from '../toolVisibility/toolExposureResolver.js'
import { TrajectoryRecorder } from '../trajectory/trajectoryRecorder.js'
import { ProductionTruthfulnessGuard } from '../runtimeGuard/productionTruthfulnessGuard.js'
import { OpenAICompatibleProvider } from '../modelReliability/providers/openAICompatibleProvider.js'
import type { ModelProvider } from '../modelReliability/providers/modelProvider.js'
import { ensureWorkflowsRegistered } from '../../workflows/index.js'
import { NativeSolverAdapter } from '../solverPortfolio/nativeSolverAdapter.js'
import {
  GenericProcessSolverAdapter,
  type GenericProcessSolverOptions,
} from '../solverPortfolio/genericProcessSolverAdapter.js'
import { SolverResultNormalizer } from '../solverPortfolio/solverResultNormalizer.js'
import { runnerFor } from '../../ctf/oneshot/runner.js'
import { OneShotRegistry } from '../../ctf/oneshot/registry.js'
import { OneShotCatalog } from '../../ctf/oneshot/catalog.js'
import { loadManifestsFromDir } from '../../ctf/oneshot/manifestLoader.js'
import {
  ChallengeConcurrencyPool,
  type QueuedChallenge,
  type TaskExecutorResult,
} from './challengeConcurrencyPool.js'
import { createChallengeClassifier } from '../../ctf/competition/challengeClassifier.js'
import { runFastPath } from '../../ctf/competition/fastPath.js'
import { AdaptiveConcurrencyController } from '../../ctf/competition/adaptiveConcurrency.js'
import { flagExtractionPipeline } from '../../ctf/competition/flagExtractionPipeline.js'
import { getRetryConfigForCategory } from '../../ctf/competition/retryStrategy.js'
import { CrossChallengeCache } from '../../ctf/competition/crossChallengeCache.js'

export type CTFTaskRuntimeMode = 'workflow-only' | 'llm'

export interface CreateCTFTaskRuntimeInput {
  cwd: string
  /** Profile id (e.g. "orchestrator" | "triage" | "image-stego" | "crypto" | "file-forensics"). */
  profileId: string
  /** Initial profile object — preferred over id when supplied. */
  profile?: CapabilityProfile

  contestConfig?: ContestConfig
  contestScope?: ContestScope
  contestId?: string
  taskId?: string
  sessionsRoot?: string

  /** OpenAI-compatible client. Required for LLM mode. */
  client?: OpenAI
  /** Renderer for streaming. Required for LLM mode. */
  renderer?: Renderer
  /** Model config. Required for LLM mode. */
  modelConfig?: ModelConfig

  workflowOnly?: boolean

  mode?: CTFTaskRuntimeMode

  challenge?: {
    description?: string
    category?: string
    flagPattern?: string
    inputArtifactIds?: string[]
  }
  environment?: Record<string, string>

  jobLimits?: { maxPerAgent?: number; maxPerTask?: number; globalTimeoutMs?: number }
  runtimeMode?: 'production' | 'test'
  runtimeModelConfig?: RuntimeModelConfiguration
  nativeRuntimeDelegate?: NativeSolverRuntimeDelegate
  /**
   * Phase 3.x — External process-based solver adapters to register alongside
   * the built-in NativeSolverAdapter. Each entry pairs a solver id with the
   * adapter's constructor options.
   */
  processSolvers?: ReadonlyArray<{
    id: string
    options?: Partial<GenericProcessSolverOptions>
  }>
  /** Competition mode — max concurrent tasks (default 4 via OVOGO_MAX_CONCURRENCY). */
  maxConcurrency?: number
}

export interface CTFTaskRuntime {
  orchestrator: CTFTaskOrchestrator
  dependencies: AgentRuntimeDependencies
  abort: LinkedAbortController
  mainHarness: HarnessBundle
  mode: CTFTaskRuntimeMode
  oneShotRunnerRegistry: BackgroundJobRunnerRegistry
  /** Competition oneshot dispatcher — used by fast-path executor. */
  dispatcher: Dispatcher
  oneShotCatalog: OneShotCatalog
  modelReliability: {
    registry: ModelCapabilityRegistry
    healthStore: ModelHealthStore
    circuitBreaker: ModelCircuitBreaker
    router: ModelRouter
    gateway: StructuredModelGateway
  }
  solverPortfolio: SolverPortfolio
  toolVisibilityPolicy: ToolVisibilityPolicy
  trajectoryRecorder: TrajectoryRecorder
  /** Competition multi-task concurrency pool. */
  concurrencyPool: ChallengeConcurrencyPool
  /**
   * Competition batch solve — solve all challenges in a directory concurrently.
   * Returns a summary of solved, failed, and queued tasks.
   */
  batchSolve: (
    manifestDir: string,
    options?: { maxConcurrency?: number; timeoutMs?: number },
  ) => Promise<{
    solved: Array<{ taskId: string; flag: string }>
    failed: Array<{ taskId: string; reason: string }>
    total: number
  }>
  getState(): Readonly<CTFTaskState>
  cancel(reason: string): Promise<void>
  dispose(): Promise<void>
}

/**
 * Build the full CTF Task runtime in Phase 3.1 canonical assembly order.
 *
 * Note: kept `async` for caller-source compatibility (every consumer does
 * `await createCTFTaskRuntime(...)`). Once the assembly order stabilised and
 * all dynamic imports were lifted to static ones, the function body is fully
 * synchronous — the trailing `await Promise.resolve()` is a deliberate
 * microtask yield so async callers see a real Promise resolution and
 * downstream `then` handlers fire in the right order.
 */
export async function createCTFTaskRuntime(
  input: CreateCTFTaskRuntimeInput,
): Promise<CTFTaskRuntime> {
  const cwd = input.cwd
  const contestConfig = input.contestConfig ?? createDefaultContestConfig({ cwd })
  const contestScope = input.contestScope ?? contestConfig

  const initialProfile = input.profile ?? resolveProfileById(input.profileId)
  const profileStore = new CTFProfileStore(initialProfile)

  // 1. Task-level AbortController
  const abort = createLinkedAbortController(undefined)

  // 2. Mode & Dependencies
  const mode: CTFTaskRuntimeMode = input.mode ?? 'workflow-only'
  const dependencies: AgentRuntimeDependencies = {
    client: input.client,
    renderer: input.renderer,
    modelConfig: input.modelConfig,
  }
  if (mode === 'llm') {
    assertLlmDependencies(dependencies)
  }

  // 3. TaskWorkspace & TaskExecutionContext
  const contestId = input.contestId ?? cwd.split('/').pop() ?? 'project'
  const taskId = input.taskId ?? `task_${Math.random().toString(36).slice(2, 10)}`
  const sessionsRoot = input.sessionsRoot ?? `${cwd}/sessions`

  const taskWorkspace = new TaskWorkspace({
    sessionsRoot,
    contestId,
    taskId,
  })

  const ctx: TaskExecutionContext = {
    taskId,
    workspaceDir: cwd,
    sessionDir: taskWorkspace.paths.workspaceDir,
    artifactDir: taskWorkspace.paths.artifactsDir,
    inputDir: taskWorkspace.paths.inputDir,
    eventsFile: taskWorkspace.paths.eventsFile,
    profileId: initialProfile.id,
    contestScope,
    contestConfig,
    environment: input.environment,
    abortSignal: abort.signal,
    metadata: {
      projectRoot: cwd,
      sessionsRoot: input.sessionsRoot,
    },
  }

  // 4. TrajectoryRecorder (static import — was dynamic; now lifted to top)
  const trajectoryRecorder = new TrajectoryRecorder(`${taskWorkspace.paths.root}/trajectory.jsonl`)

  // 5. Model Reliability Infrastructure & Guard
  const guard = new ProductionTruthfulnessGuard({ mode: input.runtimeMode ?? 'production' })

  const registry = new ModelCapabilityRegistry()
  const healthStore = new ModelHealthStore()
  const circuitBreaker = new ModelCircuitBreaker(healthStore)
  const router = new ModelRouter(registry, healthStore, circuitBreaker)

  // Provider map: keyed by provider id; value is the ModelProvider instance.
  // Typed as `ModelProvider` so callers see real methods (not `any`).
  const providersMap = new Map<string, ModelProvider>()

  if (input.runtimeModelConfig) {
    registry.registerConfiguration(input.runtimeModelConfig)
    if (input.runtimeModelConfig.providers) {
      for (const p of input.runtimeModelConfig.providers) {
        if (input.client) {
          providersMap.set(p.id, new OpenAICompatibleProvider(input.client, p.id))
        }
      }
    }
  } else if (input.client) {
    const provider = new OpenAICompatibleProvider(input.client)
    providersMap.set(provider.id, provider)

    const modelName = input.modelConfig?.model ?? 'gpt-4o'
    registry.registerProfile({
      id: modelName,
      providerId: provider.id,
      providerModelName: modelName,
      provider: provider.id,
      model: modelName,
      trustLevel: 'standard',
      reliabilityClass: 'standard',
      contextWindow: 128000,
      capabilities: {
        toolCalling: true,
        structuredOutput: true,
        vision: true,
        longContext: true,
        codeExecutionPlanning: true,
      },
      reliability: {
        structuredOutput: 0.98,
        toolArguments: 0.95,
        longHorizonPlanning: 0.92,
        summarization: 0.95,
        instructionFollowing: 0.96,
      },
      economics: {},
      allowedRoles: [
        'competition_coordinator',
        'task_planner',
        'solver_scout',
        'deep_solver',
        'context_compiler',
        'progress_summarizer',
        'specialist',
        'flag_discriminator',
        'reporter',
      ],
      limits: {
        maxVisibleTools: 50,
        maxIterations: 30,
        maxRepairAttempts: 2,
        maxConsecutiveFailures: 3,
      },
      fallbackModelIds: [],
    })
  }

  if (input.mode === 'llm' && (providersMap.size === 0 || registry.listProfiles().length === 0)) {
    throw new Error('Runtime creation failed: No configured model/provider available in registry')
  }

  // 6. Construct the gateway. The `getStateRevision` callback is used by the
  //    TrajectoryRecorder as a cache-busting key. The previous
  //    `orchestratorRef: any` late-binding pattern read a non-existent
  //    `stateRevision` field on CTFTaskState, returning `undefined ?? 1`
  //    on every call — i.e. it was always returning the gateway's own
  //    fallback `1`. We preserve that semantic explicitly: omitting the
  //    callback makes the gateway fall back to its constant. If we ever
  //    add a real state-revision counter (e.g. increment-on-reduce), wire
  //    it here without re-introducing `any`.
  const gateway = new StructuredModelGateway({
    router,
    healthStore,
    circuitBreaker,
    registry,
    providers: providersMap,
    trajectoryRecorder,
    truthfulnessGuard: guard,
  })

  const toolVisibilityPolicy = new ToolVisibilityPolicy([], 'profile_allowed')
  const toolExposureResolver = new DefaultToolExposureResolver(toolVisibilityPolicy)

  dependencies.modelGateway = gateway
  dependencies.toolVisibilityPolicy = toolVisibilityPolicy
  dependencies.toolExposureResolver = toolExposureResolver
  dependencies.trajectoryRecorder = trajectoryRecorder

  // 7. Create Harness (passing Reliability, Visibility, Exposure Resolver, Trajectory)
  const harness = createHarness({
    cwd,
    context: ctx,
    profileStore,
    profile: initialProfile,
    contestScope,
    contestId,
    taskId,
    sessionsRoot,
    client: input.client,
    renderer: input.renderer,
    jobLimits: input.jobLimits,
    // Forward modelConfig to the harness so identity.modelProfileId
    // (harness.ts line 528) reflects the real model name. The previous
    // call dropped this and the harness fell back to the hardcoded
    // 'gpt-4o' default, causing `Unknown model profile 'gpt-4o'` when
    // the user passed a non-OpenAI model like MiniMax-M3.
    modelConfig: input.modelConfig,
    modelGateway: gateway,
    toolVisibilityPolicy,
    toolExposureResolver,
    trajectoryRecorder,
  })

  // 8. Register Workflows
  ensureWorkflowsRegistered(harness.workflowRegistry)

  // 9. Build StateStore + Orchestrator
  const orchestrator = CTFTaskOrchestrator.assemble({
    harness,
    profileStore,
    abort,
    dependencies,
    challenge: input.challenge,
    environment: input.environment,
  })

  // 10. Wire Job & SolverPortfolio with complete dependencies
  const adapters: ExternalSolverAdapter[] = [new NativeSolverAdapter(input.nativeRuntimeDelegate)]

  // processSolvers is now a typed input field (no longer `(input as any)`).
  if (input.processSolvers) {
    for (const ps of input.processSolvers) {
      adapters.push(new GenericProcessSolverAdapter(ps.id, ps.options))
    }
  }

  const portfolio = new SolverPortfolio({
    stateStore: orchestrator.store,
    // ContextCompiler is supplied via `dependencies` (the public AgentRuntime
    // shape) — orchestrator does not own it. The previous `(orchestrator as any).contextCompiler
    // || (dependencies as any).contextCompiler` chain is reduced to a single
    // typed access. If we ever expose contextCompiler on the orchestrator we
    // add an explicit method here instead of an `as any` cast.
    contextCompiler: dependencies.contextCompiler,
    resultNormalizer: new SolverResultNormalizer(),
    trajectoryRecorder,
    truthfulnessGuard: guard,
    adapters,
  })

  const projector = orchestrator.projector
  const canonicalTaskDir = harness.taskWorkspace.paths.root
  harness.jobManager?.registerTaskWorkspace(taskId, canonicalTaskDir)
  const jobUnsub =
    harness.jobManager?.subscribe((ev) => {
      projector.projectJobEvent(ev, orchestrator)
    }) ?? null

  const runnerRegistry = new BackgroundJobRunnerRegistryImpl()

  const oneShotCatalog = new OneShotCatalog()
  const manifestsRoot = `${cwd}/oneshot/manifests`
  try {
    loadManifestsFromDir(manifestsRoot, oneShotCatalog)
  } catch {
    /* best-effort */
  }
  const oneShotRegistry = new OneShotRegistry(oneShotCatalog)

  harness.jobManager.setRunnerRegistry(runnerRegistry)

  runnerRegistry.register('oneshot:', async (spec, signal) => {
    const manifestId = String(spec.toolId).slice('oneshot:'.length)
    const manifest = oneShotRegistry.get(manifestId)
    if (!manifest) {
      return { error: `unknown manifest: ${manifestId}` }
    }
    const inputPayload = (spec.input ?? {}) as {
      argv?: string[]
      workspace?: string
      logDir?: string
      evidenceRoot?: string
    }
    const runner = runnerFor(manifest)
    const out = await runner.run(manifest, {
      argv: inputPayload.argv ?? [],
      workspace: inputPayload.workspace ?? cwd,
      logDir: inputPayload.logDir ?? inputPayload.evidenceRoot ?? cwd,
      signal,
    })
    const payload = Buffer.from(JSON.stringify(out), 'utf8').toString('base64')
    return {
      summary: out.summary,
      artifactId: undefined,
      error: undefined,
      __oneShotPayload: payload,
    }
  })

  // ── Competition: Dispatcher + Classifier for fast-path routing ────────
  const dispatcher = new Dispatcher({
    registry: oneShotRegistry,
    catalog: oneShotCatalog,
    jobManager: harness.jobManager,
    workspace: harness.taskWorkspace.paths.root,
    signal: abort.signal,
    orchestrator,
    taskContext: harness.context,
    runnerRegistry,
  })
  const classifier = createChallengeClassifier(oneShotCatalog)

  const baseDispose = orchestrator.dispose.bind(orchestrator)
  const wrappedDispose = async (): Promise<void> => {
    try {
      await baseDispose()
    } finally {
      if (jobUnsub) jobUnsub()
      healthStore.dispose()
      await trajectoryRecorder.dispose()
      // §Round-5 — Clear cross-challenge cache to free memory
      crossCache.clear()
    }
  }

  // ── Competition concurrency pool ──────────────────────────────────────
  const maxConcurrency =
    input.maxConcurrency ?? (parseInt(process.env.OVOGO_MAX_CONCURRENCY ?? '4', 10) || 4)

  // §Round-2 — Adaptive concurrency: auto-scale based on success rate
  const adaptiveController = new AdaptiveConcurrencyController({
    initialConcurrency: maxConcurrency,
    minConcurrency: 1,
    maxConcurrency: 16,
  })

  // §Round-2 — Classification-aware timeouts
  const TIER_TIMEOUTS: Record<string, number> = {
    fast: 30_000,
    medium: 120_000,
    heavy: 300_000,
  }

  // §Round-5 — Cross-challenge cache for learning across tasks
  const crossCache = new CrossChallengeCache()

  // §Round-4 — Category to profile mapping (inline, avoid solve.ts side-effects)
  const PROFILE_MAP: Record<string, string> = {
    encoding: 'crypto',
    crypto: 'crypto',
    forensics: 'image-stego',
    reverse: 'reverse',
    rev: 'reverse',
    pwn: 'pwn',
    web: 'web',
    pcap: 'traffic',
    traffic: 'traffic',
    misc: 'triage',
  }
  const getProfile = (cat: string) => PROFILE_MAP[cat] || 'triage'

  /** §Round-4 — Attempt LLM solve with flag extraction; returns flag or undefined. */
  async function attemptLlmSolve(
    taskRuntime: CTFTaskRuntime,
    challenge: QueuedChallenge,
  ): Promise<string | undefined> {
    const taskDesc = challenge.description ?? challenge.title
    const result = await taskRuntime.orchestrator.runMainAgent(taskDesc)
    if (result.status !== 'completed') return undefined
    const state = taskRuntime.orchestrator.store.getState()

    // Build pseudo-stdout from agent observations & run summaries so the
    // stdout regex pass (Pass 1) can find flags in agent output text.
    const agentTexts: string[] = []
    for (const obs of state.observations ?? []) {
      const text = (obs as unknown as Record<string, unknown>).text
      if (typeof text === 'string' && text.length > 0) agentTexts.push(text)
    }
    for (const run of state.agentRuns ?? []) {
      const summary = (run as unknown as Record<string, unknown>).resultSummary
      if (typeof summary === 'string' && summary.length > 0) agentTexts.push(summary)
    }
    const pseudoStdout = agentTexts.join('\n') || undefined

    const extraction = flagExtractionPipeline.extract(state, pseudoStdout)
    if (extraction.best && extraction.best.confidence >= 0.55) {
      return extraction.best.value
    }
    return undefined
  }

  const concurrencyPool = new ChallengeConcurrencyPool(maxConcurrency, {
    defaultTimeoutMs: 300_000, // 5min global default
    onCompleted: (handle) => {
      const success = handle.status === 'solved'
      const newConcurrency = adaptiveController.recordResult(success)
      concurrencyPool.adjustConcurrency(newConcurrency)
    },
    executor: async (challenge, _handle, signal): Promise<TaskExecutorResult> => {
      const startTime = Date.now()

      // §Round-5 — Cross-challenge cache: try known patterns first
      const cachedApproach = crossCache.suggest(challenge.category, challenge.description ?? '')
      if (cachedApproach && cachedApproach.confidence >= 0.7) {
        // Fast-path based on prior success
        const suggestedManifests = cachedApproach.manifests.filter(
          (id) => oneShotCatalog.get(id) !== undefined,
        )
        if (suggestedManifests.length > 0) {
          try {
            const fastResult = await runFastPath(suggestedManifests, dispatcher, signal, {
              maxManifests: 2,
              perManifestTimeoutMs: 20_000,
              minConfidence: 0.7,
            })
            if (fastResult.flag) {
              crossCache.recordSuccess(
                challenge.category,
                challenge.description ?? '',
                fastResult.solvedBy ?? 'cached_fast',
                'fast',
                Date.now() - startTime,
              )
              return { status: 'solved', flag: fastResult.flag }
            }
          } catch (err) {
            // eslint-disable-next-line no-console
            console.error(
              '[competition] cached fast-path error:',
              (err as Error)?.message ?? String(err),
            )
            /* fall through */
          }
        }
      }

      // ── Pre-flight classification ──────────────────────────────────
      const classification = classifier.classify(challenge)

      // Assign tier-based timeout to the challenge
      challenge.timeoutMs = challenge.timeoutMs ?? TIER_TIMEOUTS[classification.tier] ?? 300_000

      // Fast path: oneshot-only, zero LLM calls
      if (classification.tier === 'fast' && classification.recommendedManifests.length > 0) {
        try {
          const fastResult = await runFastPath(
            classification.recommendedManifests,
            dispatcher,
            signal,
            { maxManifests: 3, perManifestTimeoutMs: 30_000, minConfidence: 0.7 },
          )
          if (fastResult.flag) {
            crossCache.recordSuccess(
              challenge.category,
              challenge.description ?? '',
              fastResult.solvedBy ?? 'fast_path',
              'fast',
              Date.now() - startTime,
            )
            return { status: 'solved', flag: fastResult.flag }
          }
          // Fast path didn't find a flag — fall through to LLM
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error(
            '[competition] classification fast-path error:',
            (err as Error)?.message ?? String(err),
          )
          /* fall through */
        }
      }

      // §Round-4 — Retry loop with profile switching
      const retryConfig = getRetryConfigForCategory(challenge.category)
      const deadline = Date.now() + retryConfig.deadlineMs
      const initialProfile = getProfile(challenge.category)

      // Filter retry profiles to exclude the initial profile (avoids duplicate
      // attempts when getProfile() returns a profile that is also in the
      // category's retry chain).
      const alternateProfiles = retryConfig.retryProfiles.filter((p) => p !== initialProfile)

      for (let attempt = 0; attempt <= retryConfig.maxRetries; attempt++) {
        if (Date.now() > deadline || signal.aborted) break

        const profileId = attempt === 0 ? initialProfile : alternateProfiles[attempt - 1]
        if (!profileId) break

        const taskId = `task_${challenge.id}_${Date.now()}`
        let taskRuntime: Awaited<ReturnType<typeof createCTFTaskRuntime>> | undefined

        try {
          taskRuntime = await createCTFTaskRuntime({
            cwd: input.cwd,
            profileId,
            profile: input.profile,
            contestScope: input.contestScope,
            contestId: input.contestId,
            taskId,
            sessionsRoot: input.sessionsRoot,
            client: input.client,
            renderer: input.renderer,
            modelConfig: input.modelConfig,
            mode: input.mode,
            challenge: {
              description: challenge.description,
              category: challenge.category,
              flagPattern: challenge.flagPattern,
            },
            jobLimits: input.jobLimits,
            maxConcurrency: 1,
          })

          const flag = await attemptLlmSolve(taskRuntime, challenge)
          if (flag) {
            crossCache.recordSuccess(
              challenge.category,
              challenge.description ?? '',
              profileId,
              classification.tier,
              Date.now() - startTime,
            )
            return { status: 'solved', flag }
          }
          // No flag found — will retry with next profile
          if (attempt > 0) {
            crossCache.recordFailure(profileId)
          }
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error(
            `[competition] retry attempt ${attempt} (${profileId}) failed:`,
            (err as Error)?.message ?? String(err),
          )
          crossCache.recordFailure(profileId)
        } finally {
          if (taskRuntime) await taskRuntime.dispose()

          // §Round-4 — Apply delay between retry attempts
          const delay = retryConfig.retryDelayMs
          if (delay > 0 && attempt < retryConfig.maxRetries) {
            await new Promise((r) => setTimeout(r, delay))
          }
        }
      }

      // All attempts exhausted
      crossCache.recordFailure('all_profiles')
      return { status: 'failed', flag: undefined }
    },
  })

  /**
   * Competition batch solve — load all challenge manifests from a directory
   * and solve them concurrently using the concurrency pool.
   * Uses the pool's auto-fill executor + waitForAll() pattern.
   */
  async function batchSolve(
    manifestDir: string,
    _options?: { maxConcurrency?: number; timeoutMs?: number },
  ): Promise<{
    solved: Array<{ taskId: string; flag: string }>
    failed: Array<{ taskId: string; reason: string }>
    total: number
  }> {
    const dir = resolvePath(manifestDir)
    if (!existsSync(dir)) {
      throw new Error(`Manifest directory not found: ${dir}`)
    }

    const files = readdirSync(dir).filter((f) => f.endsWith('.json'))
    if (files.length === 0) {
      throw new Error(`No JSON manifest files found in: ${dir}`)
    }

    const challenges: QueuedChallenge[] = []
    for (const file of files) {
      try {
        const raw = JSON.parse(readFileSync(join(dir, file), 'utf-8')) as Record<string, unknown>
        /* eslint-disable @typescript-eslint/no-base-to-string */
        challenges.push({
          id: String(raw.id ?? file.replace('.json', '')),
          title: String(raw.title ?? raw.id ?? file),
          category: String(raw.category ?? 'misc'),
          description: String(raw.description ?? ''),
          flagPattern: raw.flagPattern ? String(raw.flagPattern) : undefined,
          priority: challenges.length === 0 ? 10 : 0,
        })
        /* eslint-enable @typescript-eslint/no-base-to-string */
      } catch {
        // skip invalid manifests
      }
    }

    if (challenges.length === 0) {
      throw new Error(`No valid challenge manifests found in: ${dir}`)
    }

    // Sort: easy/predictable categories first (misc, encoding) → harder later
    const easyCategories = ['misc', 'encoding', 'forensics']
    challenges.sort((a, b) => {
      const aEasy = easyCategories.includes(a.category) ? 0 : 1
      const bEasy = easyCategories.includes(b.category) ? 0 : 1
      return aEasy - bEasy
    })

    concurrencyPool.addChallenges(challenges)
    concurrencyPool.spawnNext()

    // Wait for all tasks to complete (pool auto-fills)
    await concurrencyPool.waitForAll()

    // Collect results
    const solved: Array<{ taskId: string; flag: string }> = []
    const failed: Array<{ taskId: string; reason: string }> = []

    for (const handle of concurrencyPool.getCompletedHandles()) {
      if (handle.status === 'solved') {
        solved.push({ taskId: handle.challenge.id, flag: handle.foundFlag ?? 'unknown' })
      } else {
        const reason =
          handle.status === 'failed'
            ? 'execution failed'
            : handle.status === 'timeout'
              ? 'timed out'
              : 'unknown'
        failed.push({
          taskId: handle.challenge.id,
          reason,
        })
      }
    }

    return {
      solved,
      failed,
      total: challenges.length,
    }
  }

  // Microtask yield so the resolved promise fires after the current tick —
  // see doc-comment on `createCTFTaskRuntime`. Real work above has no awaits.
  await Promise.resolve()

  return {
    orchestrator,
    dependencies,
    abort,
    mainHarness: harness,
    mode,
    oneShotRunnerRegistry: runnerRegistry,
    dispatcher,
    oneShotCatalog,
    modelReliability: {
      registry,
      healthStore,
      circuitBreaker,
      router,
      gateway,
    },
    solverPortfolio: portfolio,
    toolVisibilityPolicy,
    trajectoryRecorder,
    concurrencyPool,
    batchSolve,
    getState: () => orchestrator.getState(),
    async cancel(reason: string): Promise<void> {
      await orchestrator.cancel(reason)
    },
    dispose: wrappedDispose,
  }
}

export type { ModelConfig }
