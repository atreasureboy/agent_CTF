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
import type { TaskExecutionContext } from './ctfRuntime/taskExecutionContext.js'

import { ToolRegistry } from './toolRegistry.js'
import { TOOL_METADATA } from './toolMetadata.js'
import { createTools } from '../tools/index.js'
import { BashTool } from '../tools/bash.js'

import { parseCapabilityProfile } from './capabilityProfile.js'
import { ContestScopeChecker, type ContestScope } from './contestScope.js'
import { ToolBroker } from './toolBroker.js'
import { ToolFirstPolicy } from './toolFirstPolicy.js'
import { BackgroundJobManager } from './backgroundJobs.js'
import { ArtifactStore } from './artifacts.js'
import { FindingStore } from './findings.js'
import { HandoffStore } from './handoff.js'
import { createDefaultContestConfig, loadContestConfig, mergeContestConfig } from './contestConfig.js'

import { WorkflowRegistry } from './workflowRegistry.js'
import { WorkflowEngine, type RunContext, type WorkflowRunner } from './workflowEngine.js'
import { ensureWorkflowsRegistered } from '../workflows/index.js'
import { ensureProfilesRegistered, PROFILES, getBuiltinProfile } from '../capabilityProfiles/index.js'
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
  /** Pre-built tools (e.g. MCP tools). */
  extraTools?: Tool[]
  /**
   * Override the artifact store used by this harness. Used by the
   * SpecialistHarnessFactory to make a specialist share the parent's
   * artifact directory so the projector can observe its writes.
   */
  artifactStore?: ArtifactStore
  /**
   * Override the finding store used by this harness.
   */
  findingStore?: FindingStore
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
  eventLog: EventLog
  /** Run a workflow; returns the engine's WorkflowRunResult. */
  runWorkflow(workflow: WorkflowDefinition, inputs?: Record<string, unknown>): Promise<WorkflowRunResult>
  /** Run a single iteration (turn) under the harness. The caller supplies the
   * prompt and a fresh `history`. */
  runTurn(userMessage: string, history: import('./types.js').OpenAIMessage[], options?: { systemPromptAddon?: string }): Promise<{ result: import('./types.js').TurnResult; newHistory: import('./types.js').OpenAIMessage[] }>
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
    ? mergeContestConfig(
        baseConfig,
        input.contestScope as Partial<Parameters<typeof mergeContestConfig>[1]>,
      )
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

  // Store layer
  const artifactStore = input.artifactStore ?? taskWorkspace.artifactStore
  const findingStore = input.findingStore ?? taskWorkspace.findingStore
  const handoffStore = taskWorkspace.handoffStore

  // Tool layer
  const bashOnly = new BashTool()  // we keep BashTool single-instance so policy can short-circuit consistently
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
      if (r.result.isError) return { error: r.result.content, summary: r.result.content.slice(0, 500) }
      const summary = r.result.content.length > 1500 ? r.result.content.slice(0, 1500) + '…' : r.result.content
      return { summary, artifactId: r.artifactId }
    },
  )

  // Tool broker — wires contestScope + stores + jobManager to innerCtx.__ctf
  const toolFirstPolicy = new ToolFirstPolicy()

  const broker = new ToolBroker({
    registry,
    profile,
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
      if (r.result.isError) return { error: r.result.content, summary: r.result.content.slice(0, 500) }
      const summary = r.result.content.length > 1500 ? r.result.content.slice(0, 1500) + '…' : r.result.content
      return { summary, artifactId: r.artifactId }
    },
    artifactStore,
    findingStore,
    handoffStore,
    toolFirstPolicy,
    eventLog: new EventLog(taskWorkspace.paths.root),
    inlineTimeoutMs: 30 * 60 * 1000,
    defaultInlineMaxBytes: input.inlineMaxBytes ?? 10240,
  })
  brokerRef.current = broker

  // Workflow runner bridges workflow steps to Broker — receives an explicit
  // TaskExecutionContext so steps never read process.cwd().
  const taskExecutionContext: TaskExecutionContext = {
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
    defaultAgentId: profile.id,
    context: taskExecutionContext,
  })
  const workflowEngine = new WorkflowEngine(workflowRunner)

  // Engine for free-form agentic turns. We expose a method later.
  // Renderer may be undefined in non-CLI mode.
  const renderer = input.renderer

  // Convenience: run a workflow under the broker
  async function runWorkflow(workflow: WorkflowDefinition, runInputs: Record<string, unknown> = {}): Promise<WorkflowRunResult> {
    return workflowEngine.run(workflow, {
      taskId,
      agentId: profile.id,
      workflowId: workflow.id,
      inputs: runInputs,
      capturedOutputs: new Map(),
    })
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
      throw new Error(`HandoffRequest ${handoffId} is not pending (status=${req.status}); refuse to re-approve.`)
    }
    handoffStore.decide(handoffId, 'approved', 'harness approveHandoff shim')
    return { handoff: { ...req, status: 'approved' }, approved: true }
  }

  function switchProfile(next: string | Profile): void {
    const p = resolveProfile(next)
    // Use the broker's public setter — direct private-field writes are
    // forbidden. The Orchestrator coordinates atomic profile changes across
    // TaskState + Broker + tool exposure.
    broker.setProfile(p as Profile)
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
    options: { systemPromptAddon?: string } = {},
  ): Promise<{ result: import('./types.js').TurnResult; newHistory: import('./types.js').OpenAIMessage[] }> {
    if (!renderer) throw new Error('Harness.runTurn requires a renderer; pass one to createHarness')
    // §十五 — read the active Profile from the broker each turn so a
    // switchProfile() call between turns is reflected in the next prompt.
    // The closure-captured `profile` is only the initial fallback (used when
    // no ProfileStore has been wired, e.g. legacy callers).
    const currentProfile = broker.getProfile?.() ?? profile
    const baseSystemPrompt = composeSystemPrompt({
      cwd: input.cwd,
      taskWorkspaceDir: taskWorkspace.paths.workspaceDir,
      profile: currentProfile,
    })
    const systemPrompt = options.systemPromptAddon
      ? `${baseSystemPrompt}\n\n${options.systemPromptAddon}`
      : baseSystemPrompt
    const engineConfig: EngineConfig = {
      client: input.client,
      cwd: input.cwd,
      sessionDir: taskWorkspace.paths.workspaceDir,
      apiKey: process.env.OPENAI_API_KEY ?? 'test-key',
      baseURL: process.env.OPENAI_BASE_URL,
      model: 'gpt-4o',
      maxIterations: 60,
      permissionMode: 'auto',
      broker,
      taskId,
      agentId: currentProfile.id,
      eventLog: undefined,
      systemPrompt,
    }
    const engine = new ExecutionEngine(engineConfig, renderer)
    return engine.runTurn(userMessage, history)
  }

  // Silence unused (BashTool ref used by reference above)
  void bashOnly

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
    throw new Error(`No builtin profile named "${input}". Known: ${Object.keys(PROFILES).join(', ')}`)
  }
  return parseCapabilityProfile(input as unknown as Profile) as Profile
}

/** Convenience: list available built-in profiles. */
export function listProfiles(): string[] {
  return Object.keys(PROFILES)
}
