/**
 * list_one_shots — show available one-shot manifests to the LLM.
 *
 * Output is a stable, compact catalog (id, displayName, category, lane,
 * scheduling tier, enabledByDefault, maturity). Doctors can use this to
 * surface what's registered; agents can use this to choose eligible tools.
 */

import type { Tool, ToolDefinition, ToolResult } from '../../core/types.js'
import type { OneShotRegistry } from '../oneshot/registry.js'

export const LIST_ONE_SHOTS_DEFINITION: ToolDefinition = {
  type: 'function',
  function: {
    name: 'list_one_shots',
    description: 'List registered one-shot manifests. Optionally filter by category or profile id.',
    parameters: {
      type: 'object',
      properties: {
        category: { type: 'string', description: 'optional filter' },
        profileId: {
          type: 'string',
          description: 'optional filter — only show manifests allowed for this profile',
        },
        enabledOnly: { type: 'boolean', description: 'hide disabled manifests' },
      },
    },
  },
}

export function makeListOneShotsTool(registry: OneShotRegistry): Tool {
  return {
    name: 'list_one_shots',
    definition: LIST_ONE_SHOTS_DEFINITION,
    concurrencySafe: true,
    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      const { category, profileId, enabledOnly } = input as {
        category?: string
        profileId?: string
        enabledOnly?: boolean
      }
      let list = registry.list()
      if (category) list = list.filter((m) => m.category === category)
      if (profileId) list = list.filter((m) => m.allowedProfiles.includes(profileId))
      if (enabledOnly) list = list.filter((m) => m.enabledByDefault)

      const lines = list.map(
        (m) =>
          `${m.id.padEnd(20)} | ${m.displayName.padEnd(28)} | ${m.category.padEnd(10)} | ` +
          `${m.scheduling.costTier.padEnd(6)} | ${m.maturity.padEnd(11)} | ` +
          `${m.enabledByDefault ? 'enabled ' : 'disabled'}`,
      )
      return {
        content: lines.length > 0 ? lines.join('\n') : 'No matching manifests registered.',
        isError: false,
      }
    },
  }
}
