/**
 * WorkflowBrokerRunner — bridges WorkflowEngine steps to the ToolBroker.
 *
 * Each `runStep` invocation:
 *   - `tool` step → broker.execute(toolId, input, ctx)
 *   - `shell` step → invokes BashTool through broker with the wrapped
 *                   command as input. The CTF command policy still applies.
 *   - `emit_finding` step → handled by WorkflowEngine via emitFinding().
 *
 * The runner keeps a capturedOutputs map and a Map<stepId, artifactIds> so
 * the workflow's `if` conditions and downstream steps can reason about prior
 * outputs.
 *
 * Important: this runner is constructed with an explicit
 * `TaskExecutionContext`. Workflow steps therefore run inside the task
 * workspace — never in `process.cwd()` and never with `sessionDir: undefined`.
 */

import type {
  WorkflowRunner,
  RunContext,
} from './workflowEngine.js'
import type { WorkflowStep } from './workflowDefinition.js'
import type { ToolBroker } from './toolBroker.js'
import type { TaskExecutionContext } from './ctfRuntime/taskExecutionContext.js'

export interface WorkflowRunnerOptions {
  taskId: string
  defaultAgentId: string
  /** Authoritative execution context — replaces any process.cwd / undefined
   *  defaults. The runner MUST receive this from the Orchestrator. */
  context: TaskExecutionContext
}

export class WorkflowBrokerRunner implements WorkflowRunner {
  constructor(
    private readonly broker: ToolBroker,
    private readonly opts: WorkflowRunnerOptions,
  ) {
    if (!opts.context) {
      throw new Error('WorkflowBrokerRunner requires a TaskExecutionContext')
    }
  }

  /** Read-only access to the context for diagnostics + the engine. */
  getContext(): TaskExecutionContext {
    return this.opts.context
  }

  /**
   * Resolve the current agent id. Per §十一 the runner must NOT keep a stale
   * cached defaultAgentId — it always asks the broker. The `opts.defaultAgentId`
   * is preserved as a fallback for first-call bootstrap before any profile
   * change has been recorded.
   */
  private currentAgentId(): string {
    return this.broker.getProfile().id ?? this.opts.defaultAgentId
  }

  async runStep(
    step: Extract<WorkflowStep, { kind: 'tool' | 'shell' }>,
    ctx: RunContext,
  ): Promise<{ content: string; isError: boolean; artifactIds: string[] }> {
    let toolId: string
    let input: Record<string, unknown>
    if (step.kind === 'tool') {
      toolId = step.toolId
      input = step.input ?? {}
    } else {
      toolId = 'Bash'
      // Translate placeholders $FILE_INPUT, $TEXT_INPUT into the matched env.
      let command = step.command
      for (const [k, v] of Object.entries(ctx.inputs ?? {})) {
        if (typeof v === 'string') {
          command = command.replaceAll(`$${k.toUpperCase()}`, v)
        }
      }
      input = { command, description: `${step.id} (workflow step)` }
    }
    // §十 — refuse any input that tries to escape the workspace via `..`.
    // We surface this as a structured error so the engine sees `isError: true`.
    const escapeErr = detectPathEscape(input, this.opts.context)
    if (escapeErr) {
      return {
        content: `Workflow step "${step.id}" refused: ${escapeErr}`,
        isError: true,
        artifactIds: [],
      }
    }
    const r = await this.broker.execute(toolId, input, {
      cwd: this.opts.context.workspaceDir,
      sessionDir: this.opts.context.sessionDir,
      taskId: ctx.taskId || this.opts.taskId,
      agentId: this.currentAgentId(),
      apiConfig: undefined,
      signal: this.opts.context.abortSignal,
      // §十三.3 — forward the run ids so emitted Findings / Artifacts
      // can be filtered by run, and the projector's matchesRun check
      // actually classifies them under the producing run.
      agentRunId: ctx.agentRunId,
      workflowRunId: ctx.workflowRunId,
    })
    return {
      content: r.result.content,
      isError: r.result.isError,
      artifactIds: r.artifactId ? [r.artifactId] : [],
    }
  }

  async emitFinding(
    step: Extract<WorkflowStep, { kind: 'emit_finding' }>,
    ctx: RunContext,
  ): Promise<void> {
    await this.broker.execute(
      'emit_finding',
      {
        category: step.category,
        title: step.title,
        summary: step.summary,
        confidence: step.confidence ?? 'medium',
        artifactIds: step.artifactIds ?? [],
        suggestedNextActions: step.suggestedNextActions,
        suggestedAgent: step.suggestedAgent,
      },
      {
        cwd: this.opts.context.workspaceDir,
        sessionDir: this.opts.context.sessionDir,
        taskId: ctx.taskId || this.opts.taskId,
        agentId: this.currentAgentId(),
        apiConfig: undefined,
        signal: this.opts.context.abortSignal,
        // §十三.3 — same run-id propagation as runStep so finding
        // emissions are attributed to the producing workflow/agent run.
        agentRunId: ctx.agentRunId,
        workflowRunId: ctx.workflowRunId,
      },
    )
  }
}

/**
 * Scan a tool-step input for path arguments that try to escape the task
 * workspace. Returns null when safe; a human-readable reason otherwise.
 *
 * The check is shallow: it inspects string values for `..` segments. Tools
 * with their own path semantics (e.g. Bash commandPolicy) should still
 * apply their own checks — this is a fast-path guard for declarative
 * workflow inputs.
 */
function detectPathEscape(
  input: Record<string, unknown>,
  context: { workspaceDir: string; artifactDir: string },
): string | null {
  const safeRoots = [context.workspaceDir, context.artifactDir]
  function checkString(s: string): string | null {
    if (s.includes('..' + '/') || s.includes('..' + '\\') || s.endsWith('..')) {
      // Allow `..` only when it stays inside one of the safe roots.
      // For declarative workflow inputs we are conservative: any `..`
      // segment is rejected.
      return `path segment ".." is not permitted in workflow inputs (rejected: ${JSON.stringify(s).slice(0, 80)})`
    }
    return null
  }
  function walk(value: unknown): string | null {
    if (typeof value === 'string') return checkString(value)
    if (Array.isArray(value)) {
      for (const v of value) {
        const r = walk(v)
        if (r) return r
      }
      return null
    }
    if (value && typeof value === 'object') {
      for (const v of Object.values(value as Record<string, unknown>)) {
        const r = walk(v)
        if (r) return r
      }
    }
    return null
  }
  const r = walk(input)
  if (r) return r
  void safeRoots // reserved for future "is path within X" check on resolved paths
  return null
}
