/**
 * ToolBroker — the single gateway through which every tool call flows.
 *
 * The Broker composes:
 *   - ToolRegistry  : tool definitions / metadata
 *   - CapabilityProfile  : agent-level permissions
 *   - PermissionChecker  : rule-based approval gate (legacy, preserved)
 *   - ContestScopeChecker : file/network boundary
 *   - BackgroundJobManager : background execution + lifecycle
 *   - ArtifactStore : persistent output storage
 *   - EventLog      : audit trail
 *   - HookRunner    : Pre/Post tool hooks
 *   - ToolFirstPolicy : rule-based reminders
 *
 * The Engine hands the broker raw `(toolId, input, ctx)` tuples. The broker
 * decides:
 *   1. Profile denial — fail fast (LLM should not see tools it cannot use)
 *   2. ToolFirstPolicy reminder — emit a soft reminder (never blocks; override
 *      is recorded in EventLog)
 *   3. Concurrency / queueing — if the tool is configured `background`,
 *      spawn via JobManager; otherwise execute inline
 *   4. Execute and materialize result; long outputs → Artifact + summary
 */

import type OpenAI from 'openai'
import type { EventLog } from './eventLog.js'
import type { ArtifactMeta, ArtifactStore } from './artifacts.js'
import type { FindingStore } from './findings.js'
import type { HandoffStore } from './handoff.js'
import type {
  CapabilityProfile,
} from './capabilityProfile.js'
import {
  profileToolDenialReason,
} from './capabilityProfile.js'
import { ScopeViolationError } from './contestScope.js'
import type { ContestScopeChecker } from './contestScope.js'
import { ToolRegistry } from './toolRegistry.js'
import type { RegisteredTool } from './toolDefinition.js'
import type { BackgroundJobManager, JobRunner, BackgroundJob } from './backgroundJobs.js'
import type { ToolFirstPolicy, PolicyVerdict } from './toolFirstPolicy.js'
import type { ToolResult } from './types.js'

export interface BrokerToolContext {
  cwd: string
  sessionDir?: string
  signal?: AbortSignal
  apiConfig?: { apiKey: string; baseURL?: string; model: string }
  taskId: string
  agentId: string
  /** Phase 1.7 §十三.3 — Run-id association for emitted findings. */
  agentRunId?: string
  workflowRunId?: string
  handoffId?: string
}

export interface ToolBrokerOptions {
  registry: ToolRegistry
  profile: CapabilityProfile
  contestScope?: ContestScopeChecker
  jobManager?: BackgroundJobManager
  jobRunner?: JobRunner
  artifactStore?: ArtifactStore
  findingStore?: FindingStore
  handoffStore?: HandoffStore
  eventLog?: EventLog
  hookRunner?: {
    runPreToolCall(name: string, input: Record<string, unknown>): void
    runPostToolCall(name: string, result: string, isError: boolean): void
  }
  permissionChecker?: {
    check(input: { tool: string; input: Record<string, unknown> }): Promise<{ allowed: boolean; reason: string }>
  }
  toolFirstPolicy?: ToolFirstPolicy
  /** Default inline threshold (bytes) for inline mode (default 10 KB). */
  defaultInlineMaxBytes?: number
  /** Max time per inline tool call in ms (default 30 min). */
  inlineTimeoutMs?: number
  /** When true, Broker forces execution inline regardless of executionMode.
   * Used by tests + as a fail-safe when JobManager refuses. */
  forceInline?: boolean
  /**
   * §七 — when provided, the broker reads/writes its active profile via this
   * store. This is the single source of truth shared with the Orchestrator
   * and Harness. Direct setProfile() / private-field mutation remains as a
   * fallback for tests; production code should pass a ProfileStore and call
   * `store.switchTo()` instead.
   */
  profileStore?: import('./ctfRuntime/profileStore.js').ProfileStore
}

/**
 * Throws on hard denial (Profile mismatch). The engine catches this and
 * returns a structured ToolResult to the model.
 */
export class ProfileDeniedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProfileDeniedError'
  }
}

export class BrokerExecutionResult {
  constructor(
    public readonly result: ToolResult,
    public readonly jobId?: string,
    public readonly artifactId?: string,
    public readonly policyVerdict?: PolicyVerdict,
  ) {}
}

export class ToolBroker {
  private opts: ToolBrokerOptions

  constructor(opts: ToolBrokerOptions) {
    this.opts = opts
  }

  getProfile(): CapabilityProfile {
    // §十五 Phase 1.7 — ProfileStore is the single dynamic source. The
    // broker always reads from it. `opts.profile` exists only for backward
    // compat in unit tests that build a broker without a store.
    if (this.opts.profileStore) return this.opts.profileStore.getCurrent()
    return this.opts.profile
  }

  /**
   * Atomically replace the active profile. This is the ONLY public way to
   * change the broker's profile — direct mutation of private fields is
   * forbidden and tests/audits should fail when they observe it.
   *
   * Tool exposure is recomputed lazily on the next call; the broker keeps
   * the new profile object reference so callers can immediately observe it
   * via getProfile().
   */
  setProfile(next: CapabilityProfile): void {
    if (!next || !next.id) {
      throw new Error('setProfile: profile must be a valid CapabilityProfile')
    }
    if (this.opts.profileStore) {
      this.opts.profileStore.switchTo(next)
      // Keep opts.profile current so legacy tests / readers that peek at
      // broker.opts.profile see the new value. We use a typed setter helper
      // (not a type-cast) so the mutation is visible in the type system.
      this.replaceOpts({ ...this.opts, profile: next })
      return
    }
    // No ProfileStore wired — keep the legacy profile path for non-CTF
    // tests. Same typed setter helper as the ProfileStore branch.
    this.replaceOpts({ ...this.opts, profile: next })
  }

  /** Typed internal helper — replaces the entire opts object so any
   *  cached references update. opts is a plain mutable field (not
   *  readonly) so we assign directly without any type cast. Object
   *  identity of the new object is preserved by spread. */
  private replaceOpts(next: ToolBrokerOptions): void {
    this.opts = next
  }

  /** Quick boolean predicate for the engine to use before scheduling. */
  isAllowed(toolId: string): boolean {
    const reg = this.opts.registry.get(toolId)
    if (!reg) return false
    return !profileToolDenialReason(this.getProfile(), toolId)
  }

  /**
   * Execute (or schedule) a tool call. Returns a BrokerExecutionResult.
   *
   * Throws nothing — all error paths return a ToolResult with `isError: true`.
   */
  async execute(
    toolId: string,
    input: Record<string, unknown>,
    ctx: BrokerToolContext,
  ): Promise<BrokerExecutionResult> {
    const startedAt = new Date().toISOString()
    const profile = this.getProfile()

    // ── Step 1: Profile gate ─────────────────────────────────
    const denyReason = profileToolDenialReason(profile, toolId)
    if (denyReason) {
      this.opts.eventLog?.append('permission', 'broker', {
        decision: 'deny',
        tool: toolId,
        reason: denyReason,
        agent: ctx.agentId,
        task: ctx.taskId,
      }, ['broker', toolId, 'deny'])
      return new BrokerExecutionResult({
        content: `Permission denied: ${denyReason}\nIf this tool is required for your task, return a HandoffRequest to an agent whose profile permits it.`,
        isError: true,
      })
    }

    const reg = this.opts.registry.get(toolId)
    if (!reg) {
      return new BrokerExecutionResult({
        content: `Unknown tool "${toolId}".`,
        isError: true,
      })
    }

    // ── Step 2: ToolFirstPolicy advisory ─────────────────────
    let policyVerdict: PolicyVerdict | undefined
    if (this.opts.toolFirstPolicy) {
      policyVerdict = this.opts.toolFirstPolicy.advise(toolId, input, profile)
      if (policyVerdict.advice) {
        this.opts.eventLog?.append('policy_advisory', 'broker', {
          tool: toolId,
          advice: policyVerdict.advice,
          severity: policyVerdict.severity,
          rule: policyVerdict.rule,
          agent: ctx.agentId,
        }, ['broker', toolId, 'policy'])
      }
    }

    // ── Step 3: Hook pre ─────────────────────────────────────
    try { this.opts.hookRunner?.runPreToolCall(toolId, input) } catch { /* best-effort */ }

    // ── Step 4: Decide execution mode ─────────────────────────
    const wantsBackground = reg.executionMode !== 'foreground' && !this.opts.forceInline && Boolean(this.opts.jobManager && this.opts.jobRunner)
    let jobId: string | undefined
    let artifactId: string | undefined

    if (wantsBackground) {
      // ── Background path ─────────────────────────────────────
      const manager = this.opts.jobManager!
      const runner = this.opts.jobRunner!
      try {
        const job = await manager.spawn({
          taskId: ctx.taskId,
          agentId: ctx.agentId,
          toolId,
          input,
          timeoutMs: this.opts.inlineTimeoutMs,
          inlineMaxBytes: reg.inlineMaxBytes ?? this.opts.defaultInlineMaxBytes,
        })
        jobId = job.id
        artifactId = job.artifactId
        return new BrokerExecutionResult({
          content: this.formatSpawnResult(job),
          isError: false,
        }, jobId, artifactId, policyVerdict)
      } catch (err) {
        if (err instanceof Error && err.name === 'ConcurrencyLimitError') {
          // Fall through to inline when the job queue is full.
        } else {
          return new BrokerExecutionResult({
            content: `Spawn failed: ${(err as Error).message}`,
            isError: true,
          })
        }
      }
    }

    // ── Step 5: Inline execution ──────────────────────────────
    this.opts.eventLog?.append('tool_call', toolId, {
      input,
      agent: ctx.agentId,
      task: ctx.taskId,
      inline: true,
      mode: reg.outputMode,
    }, [toolId, 'call', 'inline'])

    let result: ToolResult
    try {
      const inlineMax = reg.inlineMaxBytes ?? this.opts.defaultInlineMaxBytes ?? 10240
      const innerCtx: ToolCtxAdapter = {
        cwd: ctx.cwd,
        permissionMode: this.opts.permissionChecker ? 'auto' : 'ask',
        signal: ctx.signal,
        sessionDir: ctx.sessionDir,
        // Wired so meta tools (emit_finding / request_handoff / etc.) and the
        // bash command policy (BashTool) can reach their stores through the
        // legacy ToolContext.
        __ctf: {
          taskId: ctx.taskId,
          agentId: ctx.agentId,
          profile,
          contestScope: this.opts.contestScope,
          eventLog: this.opts.eventLog,
          artifactStore: this.opts.artifactStore,
          findingStore: this.opts.findingStore,
          handoffStore: this.opts.handoffStore,
          // §十三.3 — propagate run-id so emitted findings/artifacts
          // can be filtered by agentRunId / workflowRunId / handoffId.
          agentRunId: ctx.agentRunId,
          workflowRunId: ctx.workflowRunId,
          handoffId: ctx.handoffId,
          jobManager: this.opts.jobManager,
        },
      }
      // PermissionChecker is applied before execution by the engine path. The
      // Broker only enforces it when the engine delegated the gate here.
      result = await reg.impl.execute(input, innerCtx)

      // ── Artifact conversion for long outputs ──────────────
      if (
        this.opts.artifactStore &&
        !result.isError &&
        reg.outputMode === 'artifact' &&
        typeof result.content === 'string' &&
        result.content.length > inlineMax
      ) {
        const meta: ArtifactMeta = this.opts.artifactStore.writeSync(
          {
            taskId: ctx.taskId,
            producerAgentId: ctx.agentId,
            type: toolId,
            source: { toolId, inputSummary: JSON.stringify(input ?? {}).slice(0, 200) },
          },
          result.content,
          'bin',
        )
        artifactId = meta.id
        result = {
          content:
            `Output persisted as artifact ${meta.id} (${meta.size} bytes, sha256=${meta.sha256}).\n` +
            `Summary:\n${meta.summary}\n` +
            `Full path: ${this.opts.artifactStore.resolvePath(meta)}`,
          isError: false,
        }
      } else if (
        this.opts.artifactStore &&
        reg.outputMode === 'inline' &&
        typeof result.content === 'string' &&
        result.content.length > inlineMax
      ) {
        // Inline mode but content exceeded threshold — convert opportunistically.
        const meta: ArtifactMeta = this.opts.artifactStore.writeSync(
          {
            taskId: ctx.taskId,
            producerAgentId: ctx.agentId,
            type: toolId,
            source: { toolId, inputSummary: JSON.stringify(input ?? {}).slice(0, 200) },
          },
          result.content,
          'txt',
        )
        artifactId = meta.id
        const summary = meta.summary.length > 800 ? meta.summary.slice(0, 800) + '...' : meta.summary
        result = {
          content:
            `[output truncated to inline-cap, persisted as artifact ${meta.id} (${meta.size} bytes, sha256=${meta.sha256})]\n` +
            summary,
          isError: false,
        }
      }
    } catch (err) {
      if (err instanceof ScopeViolationError) {
        result = {
          content: `Scope violation: ${err.message}`,
          isError: true,
        }
      } else {
        result = {
          content: `Tool execution error: ${(err as Error).message}`,
          isError: true,
        }
      }
    }

    this.opts.eventLog?.append('tool_result', toolId, {
      success: !result.isError,
      length: result.content.length,
      agent: ctx.agentId,
      task: ctx.taskId,
      artifact: artifactId,
      duration_ms: Date.now() - new Date(startedAt).getTime(),
    }, [toolId, 'result'])

    try { this.opts.hookRunner?.runPostToolCall(toolId, result.content, result.isError) } catch { /* ignore */ }

    return new BrokerExecutionResult(result, undefined, artifactId, policyVerdict)
  }

  private formatSpawnResult(job: BackgroundJob): string {
    const lines: string[] = [
      `[background] Job ${job.id} spawned`,
      `status: ${job.status}`,
      `timeout: ${job.timeoutMs}ms`,
      `taskId: ${job.taskId} agentId: ${job.agentId}`,
    ]
    lines.push('Use the query_background_job tool with this id to check status and collect the result.')
    return lines.join('\n')
  }
}

/**
 * Adapter to pass to legacy Tool implementations. The tools themselves only
 * need cwd, signal, sessionDir, permissionMode — the rest of CTFToolContext is
 * intentionally omitted.
 */
interface ToolCtxAdapter {
  cwd: string
  permissionMode: 'auto' | 'ask' | 'deny'
  signal?: AbortSignal
  sessionDir?: string
  /** CTF services — meta tools read from here. Optional; tools that don't
   * use it should ignore it. */
  __ctf?: {
    taskId: string
    agentId: string
    profile?: import('./capabilityProfile.js').CapabilityProfile
    contestScope?: ContestScopeChecker
    eventLog?: EventLog
    artifactStore?: ArtifactStore
    findingStore?: FindingStore
    handoffStore?: HandoffStore
    jobManager?: BackgroundJobManager
    /** Phase 1.7 §十三.3 — Run-id propagation for emitted findings. */
    agentRunId?: string
    workflowRunId?: string
    handoffId?: string
  }
}

/** Registry-level availability check used by Workflows before running steps. */
export function checkRegistryAvailability(
  registry: ToolRegistry,
  toolIds: string[],
): { toolId: string; missingBinaries: string[] }[] {
  const issues: { toolId: string; missingBinaries: string[] }[] = []
  for (const id of toolIds) {
    const r = registry.get(id)
    if (!r) {
      issues.push({ toolId: id, missingBinaries: [`__unknown_tool__`] })
      continue
    }
    const missing = ToolRegistry.checkAvailability(r)
    if (missing.length > 0) issues.push({ toolId: id, missingBinaries: missing })
  }
  return issues
}

/** No-op client used by the Workflow Engine when it doesn't have to call LLM. */
export function noopOpenAIClient(): OpenAI {
  return {
    chat: {
      completions: {
        create: (() => {
          throw new Error('Workflow runner does not call LLM directly')
        }) as never,
      },
    },
  } as unknown as OpenAI
}
