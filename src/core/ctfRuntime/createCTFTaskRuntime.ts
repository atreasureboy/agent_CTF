/**
 * createCTFTaskRuntime — single public entry that wires the full CTF Task
 * runtime. Every CTF CLI / REPL / test MUST go through this factory.
 *
 * Per forth_goal.md §四 — it:
 *   1. Is the only public entry point for creating a CTF Task.
 *   2. Builds the full TaskExecutionContext.
 *   3. Creates the Task-level AbortController.
 *   4. Creates the main Harness.
 *   5. Creates the StateStore.
 *   6. Creates the Orchestrator.
 *   7. Subscribes to Job lifecycle events.
 *   8. Registers Workflows.
 *   9. Does NOT run any task itself.
 *
 * The CLI must call this — never `createHarness(...)` directly.
 */

import type OpenAI from 'openai'

import type { CapabilityProfile } from '../capabilityProfile.js'
import type { ContestScope } from '../contestScope.js'
import type { ContestConfig } from '../contestConfig.js'
import { createDefaultContestConfig } from '../contestConfig.js'
import { createHarness, type HarnessBundle } from '../harness.js'
import type { Renderer } from '../../ui/renderer.js'

import type { TaskExecutionContext } from './taskExecutionContext.js'
import { CTFProfileStore } from './profileStore.js'
import { createLinkedAbortController, type LinkedAbortController } from './linkedAbortController.js'
import { CTFTaskOrchestrator } from './taskOrchestrator.js'
import type { AgentRuntimeDependencies, ModelConfig } from './agentRuntimeDependencies.js'
import { getBuiltinProfile, PROFILES } from '../../capabilityProfiles/index.js'
import type { CTFTaskState } from './taskState.js'

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
  /** Model config. Defaults: model="gpt-4o", apiKey from env, baseURL from env. */
  modelConfig?: ModelConfig

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

  // ── Task-level AbortController.
  const abort = createLinkedAbortController(undefined)

  // ── Dependencies — shared by main + every specialist.
  const modelConfig: ModelConfig = input.modelConfig ?? {
    model: process.env['OVOGO_MODEL'] ?? 'gpt-4o',
    apiKey: process.env['OPENAI_API_KEY'] ?? 'test-key',
    baseURL: process.env['OPENAI_BASE_URL'],
  }
  const dependencies: AgentRuntimeDependencies = {
    client: input.client,
    renderer: input.renderer,
    modelConfig,
  }

  // ── Main Harness — broker wired through the ProfileStore.
  const harness = createHarness({
    cwd,
    profile: profileStore.getCurrent(),
    contestScope,
    contestId: input.contestId,
    taskId: input.taskId,
    sessionsRoot: input.sessionsRoot,
    client: input.client,
    renderer: input.renderer,
    jobLimits: input.jobLimits,
  })
  harness.broker.setProfile(profileStore.getCurrent())

  // ── TaskExecutionContext — built once, abort signal already set.
  const ctx: TaskExecutionContext = {
    ...harness.context,
    abortSignal: abort.signal,
    profileId: profileStore.getCurrent().id,
    metadata: {
      ...(harness.context.metadata ?? {}),
      projectRoot: cwd,
      sessionsRoot: input.sessionsRoot,
    },
  }
  ;(harness as unknown as { context: TaskExecutionContext }).context = ctx

  // ── Workflows — register before exposing orchestrator.
  const { ensureWorkflowsRegistered } = await import('../../workflows/index.js')
  ensureWorkflowsRegistered(harness.workflowRegistry)

  // ── Build StateStore + Orchestrator (single private ctor path).
  const orchestrator = CTFTaskOrchestrator.assemble({
    harness,
    profileStore,
    abort,
    dependencies,
    challenge: input.challenge,
    environment: input.environment,
  })

  // ── Wire Job lifecycle events into the TaskState projector.
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