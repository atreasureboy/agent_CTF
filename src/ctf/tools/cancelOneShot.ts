/**
 * cancel_one_shot — Phase 2.0 §十.
 *
 * Per-run cancellation via Dispatcher.cancelRun(runId, reason). Returns
 * a structured status rather than fire-and-forget.
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
        reason: { type: 'string', description: 'audit reason for cancellation' },
      },
      required: ['runId'],
      additionalProperties: false,
    },
  },
}

export function makeCancelOneShotTool(dispatcher: Dispatcher): Tool {
  return {
    name: 'cancel_one_shot',
    definition: CANCEL_ONE_SHOT_DEFINITION,
    concurrencySafe: true,
    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      const { runId, reason } = input as { runId: string; reason?: string }
      if (!runId) return { content: 'runId is required', isError: true }
      const r = await dispatcher.cancelRun(runId, reason ?? 'user_cancelled')
      if (r.ok) {
        return { content: `cancelled: ${runId}`, isError: false }
      }
      switch (r.reason) {
        case 'unknown_run':
          return { content: `unknown_run: ${runId}`, isError: true }
        case 'already_terminal':
          return { content: `already_terminal: ${runId}`, isError: false }
        case 'cancel_failed':
          return { content: `cancel_failed: ${runId}`, isError: true }
      }
    },
  }
}