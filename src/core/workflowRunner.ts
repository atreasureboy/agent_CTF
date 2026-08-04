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

import type { WorkflowRunner, RunContext } from './workflowEngine.js'
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
   * Resolve `input` placeholders that the typedDagExecutor accepts but the
   * legacy WorkflowRunner previously ignored. Two shapes are supported:
   *
   *   1. Typed-DAG `{ ref: '$TEXT_INPUT' }` — unwrap to the matching entry
   *      in `inputs`. Unknown refs are passed through unchanged so a missing
   *      input surfaces as an actual tool error.
   *   2. Legacy `$TEXT_INPUT` text — string-substituted inside string
   *      leaf values (matches shell-step substitution in the previous block).
   *
   * Lookup is case-insensitive because CLI callers register inputs as
   * `inputs['TEXT_INPUT']` while workflow steps use `$text_input`. We
   * match both.
   */
  private resolveToolInputRefs(
    input: Record<string, unknown>,
    inputs: Record<string, unknown>,
  ): Record<string, unknown> {
    if (process.env.OVOGO_DEBUG_TOOL_BROKER) {
      // eslint-disable-next-line no-console
      console.error(
        `[resolveToolInputRefs] input_keys=${Object.keys(input).join(',')} inputs_keys=${Object.keys(inputs).join(',')}`,
      )
    }
    const lookup = (key: string): unknown => {
      if (key in inputs) return inputs[key]
      const lower = key.toLowerCase()
      for (const [k, v] of Object.entries(inputs)) {
        if (k.toLowerCase() === lower) return v
      }
      return undefined
    }
    const resolve = (v: unknown): unknown => {
      if (v === null || v === undefined) return v
      if (Array.isArray(v)) return v.map((x) => resolve(x))
      if (typeof v === 'object') {
        const obj = v as Record<string, unknown>
        // Typed-DAG ref pattern.
        if (typeof obj['ref'] === 'string') {
          const refStr = obj['ref']
          const m = /^\$([A-Z_]+)$/i.exec(refStr)
          if (m) {
            const v2 = lookup(m[1])
            if (process.env.OVOGO_DEBUG_TOOL_BROKER) {
              // eslint-disable-next-line no-console
              console.error(
                `[resolveToolInputRefs] ref=${refStr} lookup(${m[1]})=found=${v2 !== undefined}`,
              )
            }
            if (v2 !== undefined) return v2
          }
          return v
        }
        const out: Record<string, unknown> = {}
        for (const [k, val] of Object.entries(obj)) out[k] = resolve(val)
        return out
      }
      if (typeof v === 'string') {
        return v.replaceAll(/\$([A-Z_]+)/gi, (_, name: string) => {
          const v2 = lookup(name)
          return typeof v2 === 'string' ? v2 : ''
        })
      }
      return v
    }
    return resolve(input) as Record<string, unknown>
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
      // §13 R1 fix — substitute placeholders $FILE_INPUT / $TEXT_INPUT
      // (and `{ref: '$X'}` typed-DAG style refs) BEFORE handing off to the
      // broker. The legacy workflow runner previously only substituted on
      // shell steps, leaving tool steps with literal `{ref: '$TEXT_INPUT'}`
      // objects that got coerced to "[object Object]" — which made
      // encode_sweep's decode_tree receive a stringified object instead of
      // the encoded text. Mirrors the typedDagExecutor's input ref
      // resolution so the legacy and typed paths line up.
      input = this.resolveToolInputRefs(input, ctx.inputs ?? {})
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
