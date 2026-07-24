/**
 * ActionTool — OpenAI-format tool definition for `SuggestedAction`.
 *
 * Every model adapter that needs a structured output uses the same
 * tool schema. The LLM is told to emit exactly one tool call with
 * arguments that match `StructuredAction` (from `actionSchema.ts`).
 */

import type { ToolDefinition } from './llmToolUse.js'

export function buildActionTool(toolDefs: ReadonlyArray<ToolDefinition>): {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: unknown
  }
} {
  return {
    type: 'function',
    function: {
      name: 'ctf_action',
      description:
        'Emit exactly one CTF action. Use one of the supported types. ' +
        'Required: type, reason, priority (0..100), costTier (cheap|normal|expensive). ' +
        'Type-specific required fields are validated client-side.',
      parameters: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ['run_workflow', 'run_oneshot', 'call_tool', 'request_handoff', 'verify_flag', 'stop'],
          },
          // run_workflow
          workflowId: { type: 'string' },
          inputs: { type: 'object' },
          // run_oneshot
          manifestId: { type: 'string' },
          inputArtifactIds: { type: 'array', items: { type: 'string' } },
          options: { type: 'object' },
          // call_tool
          toolId: { type: 'string' },
          input: { type: 'object' },
          // request_handoff
          capability: { type: 'string' },
          objective: { type: 'string' },
          artifactIds: { type: 'array', items: { type: 'string' } },
          // verify_flag
          candidateId: { type: 'string' },
          // universal
          reason: { type: 'string', minLength: 1 },
          priority: { type: 'number', minimum: 0, maximum: 100 },
          costTier: { type: 'string', enum: ['cheap', 'normal', 'expensive'] },
          hypothesisIds: { type: 'array', items: { type: 'string' } },
        },
        required: ['type', 'reason', 'priority', 'costTier'],
        additionalProperties: true,
      },
    },
  }
}

export function buildActionPrompt(toolDefs: ReadonlyArray<ToolDefinition>): string {
  return `You are a CTF agent. Pick exactly one next action and emit it via the ctf_action tool call.
Available tools: ${toolDefs.map((t) => `${t.name} — ${t.description}`).join(' | ')}
- run_workflow: spawn a workflow (need workflowId, inputs)
- run_oneshot: trigger a one-shot (need manifestId, inputArtifactIds)
- call_tool: call a tool directly (need toolId, input)
- request_handoff: ask a specialist (need capability, objective, artifactIds)
- verify_flag: try a flag (need candidateId)
- stop: end the run
- reason: short justification
- priority: 0..100 (higher = more urgent)
- costTier: 'cheap' | 'normal' | 'expensive'
Return ONLY the tool call. Do not include prose.`
}
