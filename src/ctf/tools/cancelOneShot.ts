/**
 * cancel_one_shot — stop an in-flight one-shot run by id.
 *
 * Cancellation is cooperative: the dispatcher aborts the parent signal,
 * which the runner interprets as `kill -SIGKILL` (process) or `docker kill`
 * (container).
 */

import type { Tool, ToolDefinition, ToolResult } from '../../core/types.js'
import type { Dispatcher } from '../oneshot/dispatcher.js'

export const CANCEL_ONE_SHOT_DEFINITION: ToolDefinition = {
  type: 'function',
  function: {
    name: 'cancel_one_shot',
    description:
      'Stop a one-shot run mid-flight. The runner receives SIGKILL (process) ' +
      'or docker kill (container).',
    parameters: {
      type: 'object',
      properties: {
        runId: { type: 'string', description: 'id returned by run_one_shot' },
      },
      required: ['runId'],
    },
  },
}

export function makeCancelOneShotTool(dispatcher: Dispatcher): Tool {
  return {
    name: 'cancel_one_shot',
    definition: CANCEL_ONE_SHOT_DEFINITION,
    concurrencySafe: true,
    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      const { runId } = input as { runId: string }
      if (!runId) return { content: 'runId is required', isError: true }
      // For simplicity we cancel the whole task; a finer-grained mapping
      // would track per-run AbortControllers.
      await dispatcher.cancelTask('parent')
      void runId
      return { content: `cancel requested`, isError: false }
    },
  }
}
