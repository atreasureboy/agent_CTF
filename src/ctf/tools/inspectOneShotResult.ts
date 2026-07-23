/**
 * inspect_one_shot_result — read structured findings / candidates from a
 * previously-finished run.
 *
 * The dispatcher keeps a small per-process registry of run ids so this tool
 * works without a separate persistent store. For longer sessions the Agent
 * is expected to consume results via the run's evidence directory.
 */

import type { Tool, ToolDefinition, ToolResult } from '../../core/types.js'
import type { Dispatcher } from '../oneshot/dispatcher.js'

export const INSPECT_ONE_SHOT_RESULT_DEFINITION: ToolDefinition = {
  type: 'function',
  function: {
    name: 'inspect_one_shot_result',
    description:
      'Read the structured output (summary, findings, candidates, artifact ' +
      'paths) of a one-shot run. Returns a short JSON envelope — never raw ' +
      'tool stdout/stderr.',
    parameters: {
      type: 'object',
      properties: {
        runId: { type: 'string', description: 'id returned by run_one_shot' },
      },
      required: ['runId'],
    },
  },
}

export function makeInspectOneShotTool(dispatcher: Dispatcher): Tool {
  return {
    name: 'inspect_one_shot_result',
    definition: INSPECT_ONE_SHOT_RESULT_DEFINITION,
    concurrencySafe: true,
    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      const { runId } = input as { runId: string }
      if (!runId) return { content: 'runId is required', isError: true }
      const result = await dispatcher.getResult(runId)
      if (!result) {
        return { content: `unknown or evicted runId: ${runId}`, isError: true }
      }
      return {
        content:
          `${result.summary}\n` +
          `Findings: ${result.findings.length}; Candidates: ${result.candidates.length}.`,
        isError: false,
      }
    },
  }
}
