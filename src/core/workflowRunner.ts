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
 */

import type {
  WorkflowRunner,
  RunContext,
} from './workflowEngine.js'
import type { WorkflowStep } from './workflowDefinition.js'
import type { ToolBroker } from './toolBroker.js'

export interface WorkflowRunnerOptions {
  taskId: string
  defaultAgentId: string
}

export class WorkflowBrokerRunner implements WorkflowRunner {
  constructor(
    private readonly broker: ToolBroker,
    private readonly opts: WorkflowRunnerOptions,
  ) {}

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
      cwd: process.cwd(),
      sessionDir: undefined,
      taskId: ctx.taskId || this.opts.taskId,
      agentId: this.opts.defaultAgentId,
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
    // Resolve the broker's findingStore via meta-tool execution would be
    // heavy-handed; here we directly call the store if accessible. Since the
    // broker doesn't expose the store, we use the runtime by issuing a
    // shell trick: write the finding JSON to findings.jsonl. ToolBroker
    // already has a findingStore reference, but only via internal opts.
    // Easiest: use the ToolBroker's meta-tool through a hand-crafted input.
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
        cwd: process.cwd(),
        sessionDir: undefined,
        taskId: ctx.taskId || this.opts.taskId,
        agentId: this.opts.defaultAgentId,
      },
    )
  }
}
