/**
 * CTF Harness Factory — composes the entire runtime from a single config.
 *
 * `createHarness(config)` returns a fully wired bundle:
 *   - registry   : ToolRegistry with every legacy + meta + CTF tool
 *   - workflowRegistry : WorkflowRegistry
 *   - contestScope     : ContestScopeChecker
 *   - jobManager       : BackgroundJobManager (with a passthrough runner)
 *   - artifactStore / findingStore / handoffStore : per-task stores
 *   - broker     : ToolBroker (gate + Artifact + Audit)
 *   - workflowRunner : WorkflowEngine step runner that calls broker.execute
 *   - workflowEngine : WorkflowEngine
 *   - taskWorkspace  : TaskWorkspace (canonical sessions/<contest>/tasks/<task>/... layout)
 *   - profile    : the resolved CapabilityProfile
 *   - runTask / runWorkflow / dispatch : high-level entry points
 *
 * CLI / REPL / tests call createHarness instead of hand-constructing 12
 * objects.
 */

import { resolve } from 'path'

import { ExecutionEngine } from './engine.js'
import type { Renderer } from '../ui/renderer.js'
import type { EngineConfig, Tool } from './types.js'
import type OpenAI from 'openai'
import { EventLog } from './eventLog.js'
import { composeSystemPrompt } from './specialistAgent.js'

import { ToolRegistry } from './toolRegistry.js'
import { TOOL_METADATA } from './toolMetadata.js'
import { createTools } from '../tools/index.js'

import { parseCapabilityProfile } from './capabilityProfile.js'
import { ContestScopeChecker, type ContestScope } from './contestScope.js'
import { ToolBroker } from './toolBroker.js'
import { ToolFirstPolicy } from './toolFirstPolicy.js'
import { BackgroundJobManager } from './backgroundJobs.js'
import type { ArtifactStore } from './artifacts.js'
import type { FindingStore } from './findings.js'
import type { HandoffStore } from './handoff.js'
import {
  createDefaultContestConfig,
  loadContestConfig,
  mergeContestConfig,
} from './contestConfig.js'
import type { TaskExecutionContext } from './ctfRuntime/taskExecutionContext.js'
import type { ProfileStore } from './ctfRuntime/profileStore.js'

import { WorkflowRegistry } from './workflowRegistry.js'
import { WorkflowEngine, type RunContext, type WorkflowRunner } from './workflowEngine.js'
import { ensureWorkflowsRegistered } from '../workflows/index.js'
import {
  ensureProfilesRegistered,
  PROFILES,
  getBuiltinProfile,
} from '../capabilityProfiles/index.js'
import { WorkflowBrokerRunner } from './workflowRunner.js'

import { TaskWorkspace, makeContestId, makeTaskId } from '../modules/taskWorkspace.js'
import type { WorkflowDefinition, WorkflowRunResult } from './workflowDefinition.js'
import type { Finding } from './findings.js'
import type { HandoffRequest } from './handoff.js'
import type { CapabilityProfile as Profile } from './capabilityProfile.js'

export interface CreateHarnessInput {
  /** Working directory root (project). */
  cwd: string
  /** Either a profile id ("image-stego") or a CapabilityProfile object. */
  profile: string | Profile | Profile[]
  /**
   * Phase 1.7 — TaskExecutionContext must be supplied by the caller BEFORE
   * the Harness builds its internal closures. Passing it in guarantees that
   * WorkflowRunner, WorkflowEngine, ToolBroker, ExecutionEngine and the
   * Tool execution context all read the SAME object reference, not a
   * post-hoc patched copy.
   *
   * When omitted (legacy single-Harness non-CTF callers) the Harness
   * constructs a synthetic one — this path is allowed but the CTF Runtime
   * never uses it.
   */
  context?: TaskExecutionContext
  /**
   * Phase 1.7 — ProfileStore is the single dynamic Profile source. The
   * Harness, ToolBroker, WorkflowRunner and prompt builder all read from
   * it via `profileStore.getCurrent()`. When omitted (legacy non-CTF
   * callers) the Harness falls back to a synthetic store seeded with
   * `profile`.
   */
  profileStore?: ProfileStore
  /** Optional override for the contest scope. If omitted, defaults to a
   * conservative `allowedFilesRoot: cwd`. */
  contestScope?: ContestScope
  /** Override the active contest id (defaults to basename of cwd). */
  contestId?: string
  /** Override the task id (defaults to a freshly generated id). */
  taskId?: string
  /** Sub-directory under `sessions/` to use. Defaults to 'sessions'. */
  sessionsRoot?: string
  /** OpenAI SDK instance (test injection). Production callers omit. */
  client?: OpenAI
  /** Renderable for engine output. Optional in non-interactive contexts. */
  renderer?: Renderer
  /** Background-job concurrency caps. */
  jobLimits?: { maxPerAgent?: number; maxPerTask?: number; globalTimeoutMs?: number }
  /** Inline-byte threshold for Artifact conversion (default 10 KB). */
  inlineMaxBytes?: number
  /**
   * Audit rounds 6-10 — explicit ModelConfig overrides the env-driven
   * defaults. The previous code ignored this and hardcoded model='gpt-4o'
   * + apiKey from OPENAI_API_KEY; tests / production callers could
   * not pin a model.
   */
  modelConfig?: { model?: string; apiKey?: string; baseURL?: string }
  /** Pre-built tools (e.g. MCP tools). */
  extraTools?: Tool[]
  /**
   * Override the artifact store used by this harness. Used by the
   * SpecialistHarnessFactory to make a specialist share the parent's
   * artifact directory so the projector can observe its writes.
   */
  artifactStore?: ArtifactStore
  /** Override the finding store used by this harness. */
  findingStore?: FindingStore
  /** Phase 3.1 — Model Gateway, Visibility Policy, Trajectory Recorder */
  modelGateway?: import('./modelReliability/structuredModelGateway.js').ModelInvocationGateway
  toolVisibilityPolicy?: import('./toolVisibility/toolVisibilityPolicy.js').ToolVisibilityPolicy
  trajectoryRecorder?: import('./trajectory/trajectoryRecorder.js').TrajectoryRecorder
}

export interface HarnessBundle {
  profile: Profile
  context: TaskExecutionContext
  contestScope: ContestScopeChecker
  registry: ToolRegistry
  workflowRegistry: WorkflowRegistry
  jobManager: BackgroundJobManager
  artifactStore: ArtifactStore
  findingStore: FindingStore
  handoffStore: HandoffStore
  broker: ToolBroker
  workflowRunner: WorkflowBrokerRunner
  workflowEngine: WorkflowEngine
  taskWorkspace: TaskWorkspace
  toolFirstPolicy: ToolFirstPolicy
  /** Phase 1.7 — explicit renderer accessor (was previously closure-only). */
  renderer: Renderer | undefined
  eventLog: EventLog
  /** Run a workflow; returns the engine's WorkflowRunResult. */
  runWorkflow(
    workflow: WorkflowDefinition,
    inputs?: Record<string, unknown>,
    options?: { workflowRunId?: string },
  ): Promise<WorkflowRunResult>
  /** Run a single iteration (turn) under the harness. The caller supplies the
   * prompt and a fresh `history`. */
  runTurn(
    userMessage: string,
    history: import('./types.js').OpenAIMessage[],
    options?: {
      systemPromptAddon?: string
      inheritedFindings?: Array<{ id: string; summary: string; confidence: string }>
      inheritedArtifacts?: Array<{ id: string; type: string; summary: string }>
    },
  ): Promise<{
    result: import('./types.js').TurnResult
    newHistory: import('./types.js').OpenAIMessage[]
  }>
  /** Switch the active profile — re-routes the broker. */
  switchProfile(next: string | Profile): void
  /** Approve a pending handoff and dispatch to the suggested agent. */
  approveHandoff(handoffId: string): { handoff: HandoffRequest; approved: true }
  /** Cancel all running jobs for this task. */
  cancelAllJobs(reason: string): number
}

export function createHarness(input: CreateHarnessInput): HarnessBundle {
  ensureProfilesRegistered()
  const profile = resolveProfile(input.profile)

  // ── Resolve ContestScope ──────────────────────────────────────────
  // Priority: explicit input.contestScope > .ovogo/contest.json > safe default.
  // The auto-loaded file is merged with input.contestScope so callers can
  // override individual fields without replacing the whole object. The default
  // factory is the single source of truth for "what if no file is supplied".
  const fileResult = loadContestConfig({ cwd: input.cwd })
  const baseConfig = fileResult.loaded
    ? fileResult.config
    : createDefaultContestConfig({ cwd: input.cwd })
  const mergedConfig = input.contestScope
    ? mergeContestConfig(baseConfig, input.contestScope)
    : baseConfig
  const contestScope = new ContestScopeChecker(mergedConfig)

  const contestId = input.contestId ?? makeContestId(input.cwd.split('/').pop() ?? 'project')
  const taskId = input.taskId ?? makeTaskId('task')
  const sessionsRoot = input.sessionsRoot ?? resolve(input.cwd, 'sessions')

  const taskWorkspace = new TaskWorkspace({
    sessionsRoot,
    contestId,
    taskId,
  })

  // ── ProfileStore (single dynamic source). If the caller passed one in,
  //    use it as-is. Otherwise build a synthetic store backed by the local
  //    `profile` reference. Legacy non-CTF callers without a real
  //    ProfileStore still get correct behaviour: switchProfile updates both
  //    the broker and this synthetic store atomically.
  let localProfile: Profile = profile
  const profileStore: ProfileStore = input.profileStore ?? {
    getCurrent: () => localProfile,
    switchTo: (next) => {
      localProfile = next
    },
    subscribe: () => () => {},
  }

  // Store layer
  const artifactStore = input.artifactStore ?? taskWorkspace.artifactStore
  const findingStore = input.findingStore ?? taskWorkspace.findingStore
  const handoffStore = taskWorkspace.handoffStore

  // Tool layer
  // Audit round 1 — the previous code instantiated a single BashTool
  // here and never used it (Bash is part of the legacyTools created
  // below via createTools). Removed; the instance was dead code.
  const legacyTools: Tool[] = createTools(input.extraTools ?? [])
  const registry = ToolRegistry.fromLegacyTools(legacyTools, TOOL_METADATA)

  // Workflow layer
  const workflowRegistry = new WorkflowRegistry()
  ensureWorkflowsRegistered(workflowRegistry)

  // Background job manager — runner delegates to broker (BashTool runs inline via broker)
  const brokerRef: { current: ToolBroker | null } = { current: null }
  const jobManager = new BackgroundJobManager(
    {
      taskWorkspaceDir: taskWorkspace.paths.root,
      maxPerAgent: input.jobLimits?.maxPerAgent,
      maxPerTask: input.jobLimits?.maxPerTask,
      globalTimeoutMs: input.jobLimits?.globalTimeoutMs,
    },
    async (spec, signal) => {
      if (!brokerRef.current) return { error: 'no broker bound' }
      const r = await brokerRef.current.execute(spec.toolId, spec.input, {
        cwd: input.cwd,
        sessionDir: taskWorkspace.paths.workspaceDir,
        signal,
        taskId,
        agentId: spec.agentId,
      })
      if (r.result.isError)
        return { error: r.result.content, summary: r.result.content.slice(0, 500) }
      const summary =
        r.result.content.length > 1500 ? r.result.content.slice(0, 1500) + '…' : r.result.content
      return { summary, artifactId: r.artifactId }
    },
  )

  // Tool broker — wires contestScope + stores + jobManager to innerCtx.__ctf
  const toolFirstPolicy = new ToolFirstPolicy()

  const broker = new ToolBroker({
    registry,
    profile,
    profileStore,
    contestScope,
    jobManager,
    jobRunner: async (spec, signal) => {
      const r = await brokerRef.current!.execute(spec.toolId, spec.input, {
        cwd: input.cwd,
        sessionDir: taskWorkspace.paths.workspaceDir,
        signal,
        taskId,
        agentId: spec.agentId,
      })
      if (r.result.isError)
        return { error: r.result.content, summary: r.result.content.slice(0, 500) }
      const summary =
        r.result.content.length > 1500 ? r.result.content.slice(0, 1500) + '…' : r.result.content
      return { summary, artifactId: r.artifactId }
    },
    artifactStore,
    findingStore,
    handoffStore,
    toolFirstPolicy,
    toolVisibilityPolicy: input.toolVisibilityPolicy,
    eventLog: new EventLog(taskWorkspace.paths.root),
    inlineTimeoutMs: 30 * 60 * 1000,
    defaultInlineMaxBytes: input.inlineMaxBytes ?? 10240,
  })
  brokerRef.current = broker

  // Workflow runner bridges workflow steps to Broker. Phase 1.7 — the
  // TaskExecutionContext must come from the caller (input.context) so the
  // WorkflowRunner, WorkflowEngine, ToolBroker and ExecutionEngine all see
  // the SAME reference. When the caller omits it (legacy non-CTF), we
  // build a synthetic one — but the CTF Runtime always supplies one.
  const taskExecutionContext: TaskExecutionContext = input.context ?? {
    taskId,
    workspaceDir: taskWorkspace.paths.workspaceDir,
    sessionDir: taskWorkspace.paths.workspaceDir,
    artifactDir: taskWorkspace.paths.artifactsDir,
    inputDir: taskWorkspace.paths.inputDir,
    eventsFile: taskWorkspace.paths.eventsFile,
    profileId: profile.id,
    contestScope: mergedConfig,
    contestConfig: mergedConfig,
    metadata: { projectRoot: input.cwd },
  }
  const workflowRunner = new WorkflowBrokerRunner(broker, {
    taskId,
    defaultAgentId: profileStore.getCurrent().id,
    context: taskExecutionContext,
  })
  const workflowEngine = new WorkflowEngine(workflowRunner)

  // Engine for free-form agentic turns. We expose a method later.
  // Renderer may be undefined in non-CLI mode.
  const renderer = input.renderer

  // §十三.3 — track the most recently-issued agent run id so workflow
  // steps can attribute emitted findings/artifacts to the originating
  // run. Updated by runTurn() at start and clear of the broker
  // propagation path (specialists set their own id when spawned).
  let lastAgentRunId: string | undefined
  function currentAgentRunId(): string | undefined {
    return lastAgentRunId
  }
  function setCurrentAgentRunId(id: string | undefined): void {
    lastAgentRunId = id
  }

  // Convenience: run a workflow under the broker
  async function runWorkflow(
    workflow: WorkflowDefinition,
    runInputs: Record<string, unknown> = {},
    options: { workflowRunId?: string } = {},
  ): Promise<WorkflowRunResult> {
    // §十三.3 — use the orchestrator-issued workflow run id when provided
    // so the WorkflowRunRecord, the broker's emitted Findings/Artifacts,
    // and the projector's run-id filter all reference the SAME id.
    // Falls back to a freshly-generated id when no Orchestrator is
    // wired (legacy callers / unit tests).
    const workflowRunId = options.workflowRunId ?? `wf_${Math.random().toString(16).slice(2, 14)}`
    return workflowEngine.run(
      workflow,
      {
        taskId,
        agentId: profile.id,
        workflowId: workflow.id,
        inputs: runInputs,
        capturedOutputs: new Map(),
        // The originating agent run id (if any) is forwarded so tools
        // triggered from a specialist handoff can attribute emitted
        // findings/artifacts back to the parent run as well.
        workflowRunId,
        agentRunId: currentAgentRunId(),
      },
      {
        // Phase 1.7 §四 — pass the Task-level abort signal to WorkflowEngine
        // so cancel() can short-circuit the workflow's run loop.
        signal: taskExecutionContext.abortSignal,
      },
    )
  }

  // Approve a pending HandoffRequest. The Harness's approveHandoff is a
  // LEGACY shim that exists for backwards compatibility; the only
  // authoritative flow is `CTFTaskOrchestrator.approveHandoff`. The harness
  // marks the record as approved but does NOT spawn a specialist — callers
  // should prefer `orchestrator.approveHandoff` so the Handoff lifecycle is
  // driven through the StateStore.
  function approveHandoff(handoffId: string): { handoff: HandoffRequest; approved: true } {
    const req = handoffStore.list().find((h) => h.id === handoffId)
    if (!req) throw new Error(`HandoffRequest not found: ${handoffId}`)
    if (req.status !== 'pending') {
      throw new Error(
        `HandoffRequest ${handoffId} is not pending (status=${req.status}); refuse to re-approve.`,
      )
    }
    handoffStore.decide(handoffId, 'approved', 'harness approveHandoff shim')
    return { handoff: { ...req, status: 'approved' }, approved: true }
  }

  function switchProfile(next: string | Profile): void {
    const p = resolveProfile(next)
    // Use the broker's public setter — direct private-field writes are
    // forbidden. The Orchestrator coordinates atomic profile changes across
    // TaskState + Broker + tool exposure.
    broker.setProfile(p)
  }

  function cancelAllJobs(reason: string): number {
    return jobManager.cancelTask(taskId, reason)
  }

  // The "runTurn" entry point is only useful with a real renderer/engine; we
  // expose it lazily so createHarness stays cheap in non-interactive contexts.
  // `systemPromptAddon` lets callers (especially dispatchNext) inject inherited
  // context — Findings/Artifacts from a parent harness — so the child does not
  // re-analyse the original input.
  function runTurn(
    userMessage: string,
    history: import('./types.js').OpenAIMessage[],
    options: {
      systemPromptAddon?: string
      inheritedFindings?: Array<{ id: string; summary: string; confidence: string }>
      inheritedArtifacts?: Array<{ id: string; type: string; summary: string }>
      handoffId?: string
    } = {},
  ): Promise<{
    result: import('./types.js').TurnResult
    newHistory: import('./types.js').OpenAIMessage[]
  }> {
    if (!renderer) throw new Error('Harness.runTurn requires a renderer; pass one to createHarness')
    // §十三.3 — issue an agent run id at the start of each main turn so
    // subsequent workflow steps and tool calls can attribute their
    // outputs to the originating run via the broker/projector.
    const agentRunId = `run_${Math.random().toString(16).slice(2, 14)}`
    setCurrentAgentRunId(agentRunId)
    // §十五 — read the active Profile from the broker each turn so a
    // switchProfile() call between turns is reflected in the next prompt.
    // The closure-captured `profile` is only the initial fallback (used when
    // no ProfileStore has been wired, e.g. legacy callers).
    const currentProfile = broker.getProfile?.() ?? profile
    const baseSystemPrompt = composeSystemPrompt({
      cwd: input.cwd,
      taskWorkspaceDir: taskWorkspace.paths.workspaceDir,
      profile: currentProfile,
      // Audit round 1 — propagate inherited findings / artifacts so
      // specialist handoffs see the parent's prior context.
      inheritedFindings: options.inheritedFindings,
      inheritedArtifacts: options.inheritedArtifacts,
    })
    const systemPrompt = options.systemPromptAddon
      ? `${baseSystemPrompt}\n\n${options.systemPromptAddon}`
      : baseSystemPrompt
    const engineConfig: EngineConfig = {
      client: input.client,
      cwd: input.cwd,
      sessionDir: taskWorkspace.paths.workspaceDir,
      // Audit rounds 6-10 — ModelConfig from caller wins. Fall back to
      // env-derived defaults only if the caller did not supply.
      apiKey: input.modelConfig?.apiKey ?? process.env.OPENAI_API_KEY ?? '',
      baseURL: input.modelConfig?.baseURL ?? process.env.OPENAI_BASE_URL,
      model: input.modelConfig?.model ?? 'gpt-4o',
      maxIterations: 60,
      permissionMode: 'auto',
      broker,
      taskId,
      agentId: currentProfile.id,
      eventLog: undefined,
      // Audit rounds 6-10 — pass the active CapabilityProfile so the
      // engine can filter tool definitions by allowedTools/deniedTools
      // (otherwise the LLM sees every tool and is only rejected at
      // execution time, which causes repeated retry loops).
      profile: currentProfile,
      systemPrompt,
      // §十三.3 — pass the agent run id (issued above) into the engine
      // so tool calls emitted during this turn carry the right run
      // attribution, and the orchestrator's projector can filter by it.
      agentRunId,
      // §十三.3 — propagate the surrounding handoff id (if any) so tools
      // emitted from a Specialist carry the handoffId into the broker's
      // __ctf context and the projector can match against
      // projectDiff({...handoffId}) without inventing a synthetic match.
      handoffId:
        options.handoffId ?? (taskExecutionContext.metadata?.['fromHandoff'] as string | undefined),
      // Phase 1.7 §四.2 — forward the Task-level abort signal into the
      // engine so cancelling the Task aborts the in-flight LLM call.
      signal: taskExecutionContext.abortSignal,
      // Phase 2.0 §十一 — pass the TaskExecutionContext so the engine can
      // forward it into ToolContext. Tools read workspace/scope/taskId from
      // there and refuse model-supplied equivalents.
      taskContext: taskExecutionContext,
      modelGateway: input.modelGateway,
      toolVisibilityPolicy: input.toolVisibilityPolicy,
    }
    const engine = new ExecutionEngine(engineConfig, renderer)
    return engine.runTurn(userMessage, history)
  }

  return {
    profile,
    context: taskExecutionContext,
    contestScope,
    registry,
    workflowRegistry,
    jobManager,
    artifactStore,
    findingStore,
    handoffStore,
    broker,
    workflowRunner,
    workflowEngine,
    taskWorkspace,
    toolFirstPolicy,
    eventLog: new EventLog(taskWorkspace.paths.root),
    renderer: input.renderer,
    runWorkflow,
    runTurn,
    switchProfile,
    approveHandoff,
    cancelAllJobs,
  }
}

function resolveProfile(input: string | Profile | (string | Profile)[]): Profile {
  if (Array.isArray(input)) {
    // Multi-profile: merge first one wins for displayName/allowlists; later
    // ones contribute extra allowedTools via simple union. The first profile
    // also dictates the id used for tool-events.
    const primary = input[0]
    return resolveProfile(primary)
  }
  if (typeof input === 'string') {
    const found = getBuiltinProfile(input) ?? PROFILES[input]
    if (found) return found
    throw new Error(
      `No builtin profile named "${input}". Known: ${Object.keys(PROFILES).join(', ')}`,
    )
  }
  return parseCapabilityProfile(input)
}

/** Convenience: list available built-in profiles. */
export function listProfiles(): string[] {
  return Object.keys(PROFILES)
}
