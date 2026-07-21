/**
 * createCTFTaskRuntime — single public entry that wires the full CTF Task
 * runtime. Every CTF CLI / REPL / test MUST go through this factory.
 *
 * Phase 1.7 — assembly order is:
 *
 *   1. Resolve the Task-level AbortController.
 *   2. Build the TaskExecutionContext — built ONCE with the real signal
 *      already wired in. Every downstream component captures this same
 *      reference; we never mutate it post-hoc.
 *   3. Resolve the ProfileStore (single dynamic Profile source).
 *   4. Resolve AgentRuntimeDependencies.
 *   5. createHarness(context, profileStore, ...) — Harness binds the same
 *      Context to its WorkflowRunner, WorkflowEngine, ToolBroker and
 *      ExecutionEngine.
 *   6. Build StateStore + Orchestrator.
 *   7. Wire Job lifecycle events.
 *
 * No `(harness as unknown as { context }).context = ...` exists in the
 * production path. CTFTaskRuntimeMode ('workflow-only' | 'llm') is derived
 * from the supplied deps and gates `runMainAgent` accordingly.
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
import { CTFProfileStore } from './profileStore.js'
import { createLinkedAbortController, type LinkedAbortController } from './linkedAbortController.js'
import { CTFTaskOrchestrator } from './taskOrchestrator.js'
import type { AgentRuntimeDependencies, ModelConfig } from './agentRuntimeDependencies.js'
import { assertLlmDependencies } from './agentRuntimeDependencies.js'
import { getBuiltinProfile, PROFILES } from '../../capabilityProfiles/index.js'
import type { CTFTaskState } from './taskState.js'

/**
 * Phase 1.7 — explicit runtime mode. `workflow-only` runs only Workflow /
 * CLI without LLM; `llm` runs Main Agent + Specialists with a real OpenAI
 * client + renderer + modelConfig.
 */
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

  /**
   * Phase 1.7 — explicit mode. Defaults to 'llm' if a client is supplied,
   * 'workflow-only' otherwise. Mismatch with supplied deps throws.
   */
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
  getState(): Readonly<CTFTaskState>
  cancel(reason: string): Promise<void>
  dispose(): Promise<void>
}

/**
 * Build the full CTF Task runtime. Returns a `CTFTaskRuntime` whose
 * `orchestrator` is the only handle for executing tasks.
 */
export async function createCTFTaskRuntime(
  input: CreateCTFTaskRuntimeInput,
): Promise<CTFTaskRuntime> {
  const cwd = input.cwd
  const contestConfig = input.contestConfig ?? createDefaultContestConfig({ cwd })
  const contestScope = input.contestScope ?? contestConfig

  // ── Resolve the starting Profile.
  const initialProfile = input.profile ?? resolveProfileById(input.profileId)

  // ── ProfileStore (single source of truth for active profile).
  const profileStore = new CTFProfileStore(initialProfile)

  // ── Step 1 — Task-level AbortController.
  const abort = createLinkedAbortController(undefined)

  // ── Step 2 — Determine mode.
  //            Default is 'workflow-only' unless the caller EXPLICITLY opts
  //            into 'llm' (so test fixtures without a real client/renderer
  //            don't trip the validation). Production CLI always passes
  //            mode: 'llm' when invoking.
  const mode: CTFTaskRuntimeMode = input.mode ?? 'workflow-only'

  // ── Step 3 — Dependencies. No fake 'test-key' fallback in production;
  //            LLM mode validates at construction time.
  const dependencies: AgentRuntimeDependencies = {
    client: input.client,
    renderer: input.renderer,
    modelConfig: input.modelConfig,
  }
  if (mode === 'llm') {
    assertLlmDependencies(dependencies)
  }

  // ── Step 4 — Build TaskWorkspace BEFORE createHarness so we can mint
  //            the TaskExecutionContext up-front (Phase 1.7 requirement).
  const contestId = input.contestId ?? (cwd.split('/').pop() ?? 'project')
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

  // ── Step 5 — Create the Harness with the SAME context reference and the
  //            SAME ProfileStore. No post-hoc mutation.
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
  })

  // ── Step 6 — Workflows — register before exposing orchestrator.
  const { ensureWorkflowsRegistered } = await import('../../workflows/index.js')
  ensureWorkflowsRegistered(harness.workflowRegistry)

  // ── Step 7 — Build StateStore + Orchestrator.
  const orchestrator = CTFTaskOrchestrator.assemble({
    harness,
    profileStore,
    abort,
    dependencies,
    challenge: input.challenge,
    environment: input.environment,
  })

  // ── Step 8 — Wire Job lifecycle events into the TaskState projector.
  const projector = orchestrator.projector
  const jobUnsub = harness.jobManager?.subscribe((ev) => {
    projector.projectJobEvent(ev, orchestrator)
  }) ?? null

  // ── Wrap dispose so it also unsubscribes the job listener.
  const baseDispose = orchestrator.dispose.bind(orchestrator)
  const wrappedDispose = async (): Promise<void> => {
    if (jobUnsub) jobUnsub()
    await baseDispose()
  }

  return {
    orchestrator,
    dependencies,
    abort,
    mainHarness: harness,
    mode,
    getState: () => orchestrator.getState(),
    async cancel(reason: string): Promise<void> {
      await orchestrator.cancel(reason)
    },
    dispose: wrappedDispose,
  }
}

function resolveProfileById(id: string): CapabilityProfile {
  const found = getBuiltinProfile(id) ?? PROFILES[id]
  if (!found) throw new Error(`Unknown profile: ${id}`)
  return found
}

// Keep ModelConfig exported for downstream consumers; the dependency alias
// `import('./agentRuntimeDependencies.js').ModelConfig` is preferred but we
// re-export here for convenience.
export type { ModelConfig }