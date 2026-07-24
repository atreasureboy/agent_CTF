/**
 * MCPExecutorAdapter — Phase borrow-plan Phase C.
 *
 * Wraps an `McpClient` as a `StrategyActionExecutor`. The exposed
 * action is a synthetic `call_tool` with `toolId="mcp:<server>:<tool>"`
 * that the existing planner can call through the normal tool path.
 *
 * Wire-up example:
 *
 *   const client = createMcpClient({ name: 'chrome', command: 'npx', args: [...] })
 *   await client.start()
 *   const tools = await client.listTools()
 *   const executor = createMcpExecutor(client)
 *   // StrategyPlanner picks a `call_tool` action with the right toolId.
 */

import type { ActionExecutionResult, ExecutionRefs } from '../ctfReasoning/actionExecutionResult.js'
import type { MaterializedResult } from '../ctfReasoning/parserRegistry.js'
import type {
  StrategyActionExecutor,
  StrategyActionExecutorContext,
} from '../ctfReasoning/strategyActionExecutor.js'
import type { McpClient, McpCallResult, McpToolDescriptor } from './mcpClient.js'
import { createObservation } from '../ctfReasoning/observation.js'

export function createMcpExecutor(client: McpClient): StrategyActionExecutor {
  return {
    async execute(ctx: StrategyActionExecutorContext): Promise<ActionExecutionResult> {
      const action = ctx.action
      if (action.type !== 'call_tool') {
        return {
          status: 'failed',
          error: { message: `mcp executor only handles call_tool, got ${action.type}` },
        }
      }
      const prefix = `mcp:${client.serverName}:`
      if (!action.toolId.startsWith(prefix)) {
        return {
          status: 'failed',
          error: {
            message: `tool ${action.toolId} not handled by MCP server ${client.serverName}`,
          },
        }
      }
      const toolName = action.toolId.slice(prefix.length)
      let result: McpCallResult
      try {
        result = await client.callTool(toolName, action.input, ctx.signal)
      } catch (err) {
        return {
          status: 'failed',
          error: { message: err instanceof Error ? err.message : String(err) },
        }
      }
      const text = result.content
        .filter((c: { type: string; text?: string }) => c.type === 'text' && c.text)
        .map((c: { text?: string }) => c.text ?? '')
        .join('\n')
      const observations = result.isError
        ? []
        : text
          ? [
              {
                ...createObservation(ctx.taskState.taskId, {
                  kind: 'generic',
                  source: { type: 'tool', toolId: action.toolId },
                  summary: text.slice(0, 200),
                  confidence: 0.7,
                }),
                attemptId: ctx.attempt.id,
              },
            ]
          : []
      const mat: MaterializedResult = {
        observations,
        evidence: [],
        suggestedActions: [],
        flagCandidateDrafts: [],
        warnings: result.isError ? [`mcp:isError: ${text}`] : [],
        rawArtifactIds: [],
      }
      return result.isError
        ? ({
            status: 'failed',
            error: { message: `mcp:${client.serverName}:${toolName} returned isError: ${text}` },
            partialResult: mat,
          } as ActionExecutionResult)
        : {
            status: 'executed',
            materializedResult: mat,
            executionRefs: { attemptId: ctx.attempt.id } as ExecutionRefs,
          }
    },
  }
}

/** Helper: list the toolId prefix a server uses. */
export function mcpToolId(serverName: string, toolName: string): string {
  return `mcp:${serverName}:${toolName}`
}

/** Convert MCP tool descriptors into plugin metadata for
 *  documentation / orchestration visibility. */
export function describeMcpTools(serverName: string, tools: McpToolDescriptor[]): string[] {
  return tools.map((t) => `mcp:${serverName}:${t.name}`)
}
