/**
 * inspect_one_shot_result — Phase 2.0 §十.
 *
 * Reads from the OneShotResultStore (persistent, restart-safe). Returns
 * a structured summary with no raw stdout/stderr.
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
      additionalProperties: false,
    },
  },
}

export interface MakeInspectOneShotToolOptions {
  /** Optional path resolver — when present, the tool surfaces the
   *  on-disk evidence root + result path. */
  resolvePaths?: (runId: string) => { evidenceRoot: string; resultPath: string }
}

export function makeInspectOneShotTool(
  dispatcher: Dispatcher,
  options: MakeInspectOneShotToolOptions = {},
): Tool {
  const resolvePaths = options.resolvePaths
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
      const durationMs = (() => {
        if (!result.startedAt || !result.finishedAt) return 0
        return Date.parse(result.finishedAt) - Date.parse(result.startedAt)
      })()
      const paths = resolvePaths
        ? resolvePaths(runId)
        : { evidenceRoot: '<unknown>', resultPath: '<unknown>' }
      return {
        content:
          `manifest=${result.manifestId} status=${result.status}\n` +
          `summary: ${result.summary}\n` +
          `findings=${result.findings.length} artifacts=${result.artifacts.length} candidates=${result.candidates.length}\n` +
          `started=${result.startedAt} finished=${result.finishedAt} durationMs=${durationMs}\n` +
          `evidenceRoot=${paths.evidenceRoot}\n` +
          `resultPath=${paths.resultPath}\n` +
          `parser warnings: ${result.diagnostics.parserWarnings.length}`,
        isError: false,
      }
    },
  }
}
