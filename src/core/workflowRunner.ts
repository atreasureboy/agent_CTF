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
    const r = await this.broker.execute(toolId, input, {
      cwd: this.opts.context.workspaceDir,
      sessionDir: this.opts.context.sessionDir,
      taskId: ctx.taskId || this.opts.taskId,
      agentId: this.opts.defaultAgentId,
      apiConfig: undefined,
      signal: this.opts.context.abortSignal,
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
        agentId: this.opts.defaultAgentId,
        apiConfig: undefined,
        signal: this.opts.context.abortSignal,
      },
    )
  }
}
