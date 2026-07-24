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
import { Dispatcher, BackgroundJobRunnerRegistryImpl } from '../../ctf/oneshot/dispatcher.js'

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

  mode?: CTFTaskRuntimeMode

  challenge?: {
    description?: string
    category?: string
    flagPattern?: string
    inputArtifactIds?: string[]
  }
  environment?: Record<string, string>

  jobLimits?: { maxPerAgent?: number; maxPerTask?: number; globalTimeoutMs?: number }
}

export interface CTFTaskRuntime {
  orchestrator: CTFTaskOrchestrator
  dependencies: AgentRuntimeDependencies
  abort: LinkedAbortController
  mainHarness: HarnessBundle
  mode: CTFTaskRuntimeMode
  oneShotRunnerRegistry: import('../../ctf/oneshot/dispatcher.js').BackgroundJobRunnerRegistry
  modelReliability: {
    registry: import('../modelReliability/modelRegistry.js').ModelCapabilityRegistry
    healthStore: import('../modelReliability/modelHealth.js').ModelHealthStore
    circuitBreaker: import('../modelReliability/modelCircuitBreaker.js').ModelCircuitBreaker
    router: import('../modelReliability/modelRouter.js').ModelRouter
    gateway: import('../modelReliability/structuredModelGateway.js').StructuredModelGateway
  }
  solverPortfolio: import('../solverPortfolio/solverPortfolio.js').SolverPortfolio
  toolVisibilityPolicy: import('../toolVisibility/toolVisibilityPolicy.js').ToolVisibilityPolicy
  trajectoryRecorder: import('../trajectory/trajectoryRecorder.js').TrajectoryRecorder
  getState(): Readonly<CTFTaskState>
  cancel(reason: string): Promise<void>
  dispose(): Promise<void>
}

/**
 * Build the full CTF Task runtime in Phase 3.1 canonical assembly order.
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

  // 4. TrajectoryRecorder
  const { TrajectoryRecorder } = await import('../trajectory/trajectoryRecorder.js')
  const trajectoryRecorder = new TrajectoryRecorder(`${taskWorkspace.paths.root}/trajectory.jsonl`)

  // 5. Model Reliability Infrastructure
  const { ModelCapabilityRegistry } = await import('../modelReliability/modelRegistry.js')
  const { ModelHealthStore } = await import('../modelReliability/modelHealth.js')
  const { ModelCircuitBreaker } = await import('../modelReliability/modelCircuitBreaker.js')
  const { ModelRouter } = await import('../modelReliability/modelRouter.js')
  const { StructuredModelGateway } = await import('../modelReliability/structuredModelGateway.js')
  const { ToolVisibilityPolicy } = await import('../toolVisibility/toolVisibilityPolicy.js')

  const registry = new ModelCapabilityRegistry()
  const healthStore = new ModelHealthStore()
  const circuitBreaker = new ModelCircuitBreaker(healthStore)
  const router = new ModelRouter(registry, healthStore, circuitBreaker)
  const gateway = new StructuredModelGateway(
    router,
    healthStore,
    circuitBreaker,
    registry,
    trajectoryRecorder,
  )

  if (input.client) {
    const { OpenAICompatibleProvider } =
      await import('../modelReliability/providers/openAICompatibleProvider.js')
    const provider = new OpenAICompatibleProvider(input.client)
    gateway.registerProvider(provider)
  }

  const toolVisibilityPolicy = new ToolVisibilityPolicy([], 'profile_allowed')

  // 6. Create Harness (passing Reliability, Visibility, Trajectory)
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
    modelGateway: gateway,
    toolVisibilityPolicy,
    trajectoryRecorder,
  })

  // 7. Register Workflows
  const { ensureWorkflowsRegistered } = await import('../../workflows/index.js')
  ensureWorkflowsRegistered(harness.workflowRegistry)

  // 8. Build StateStore + Orchestrator
  const orchestrator = CTFTaskOrchestrator.assemble({
    harness,
    profileStore,
    abort,
    dependencies,
    challenge: input.challenge,
    environment: input.environment,
  })

  // 9. Wire Job & SolverPortfolio
  const { SolverPortfolio } = await import('../solverPortfolio/solverPortfolio.js')
  const portfolio = new SolverPortfolio()

  const projector = orchestrator.projector
  const canonicalTaskDir = harness.taskWorkspace.paths.root
  harness.jobManager?.registerTaskWorkspace(taskId, canonicalTaskDir)
  const jobUnsub =
    harness.jobManager?.subscribe((ev) => {
      projector.projectJobEvent(ev, orchestrator)
    }) ?? null

  const runnerRegistry = new BackgroundJobRunnerRegistryImpl()
  const { runnerFor } = await import('../../ctf/oneshot/runner.js')
  const { OneShotRegistry } = await import('../../ctf/oneshot/registry.js')
  const { OneShotCatalog } = await import('../../ctf/oneshot/catalog.js')
  const { loadManifestsFromDir } = await import('../../ctf/oneshot/manifestLoader.js')

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

  const baseDispose = orchestrator.dispose.bind(orchestrator)
  const wrappedDispose = async (): Promise<void> => {
    try {
      await baseDispose()
    } finally {
      if (jobUnsub) jobUnsub()
      healthStore.dispose()
      await trajectoryRecorder.dispose()
      if ((portfolio as any).evidenceBus) (portfolio as any).evidenceBus.dispose()
    }
  }

  return {
    orchestrator,
    dependencies,
    abort,
    mainHarness: harness,
    mode,
    oneShotRunnerRegistry: runnerRegistry,
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
    getState: () => orchestrator.getState(),
    async cancel(reason: string): Promise<void> {
      await orchestrator.cancel(reason)
    },
    dispose: wrappedDispose,
  }
}

export type { ModelConfig }
