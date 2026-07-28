/**
 * ReflectionModule — post-run knowledge extraction.
 *
 * After a Run completes, analyzes the conversation to extract:
 * - Success patterns → Semantic Memory (what worked)
 * - Failure patterns → Semantic Memory (what to avoid)
 *
 * Depends on: memory module (writes to SemanticMemory).
 * This is new functionality — not extracted from existing code.
 */

import type OpenAI from 'openai'
import { z } from 'zod'
import type { AgentModule, ModuleBootResult, ModuleRunContext } from '../core/module.js'
import type { SemanticMemory } from '../core/semanticMemory.js'
import type { EpisodicMemory } from '../core/episodicMemory.js'
import type { ModelInvocationGateway } from '../core/modelReliability/structuredModelGateway.js'

const REFLECTION_SYSTEM_PROMPT = `You are a reflection engine. Analyze the completed agent run and extract reusable knowledge.

Output JSON with this structure:
{
  "knowledge": [
    {
      "content": "concise knowledge statement",
      "tags": ["relevant", "tags"],
      "confidence": 0.8,
      "source": "agent_inferred"
    }
  ]
}

Rules:
- Extract only genuinely reusable insights (not run-specific details)
- Max 3 knowledge entries per run
- Confidence 0.5-0.9 (be honest about uncertainty)
- If nothing worth remembering, return {"knowledge": []}
- Respond with JSON only, no prose`

const SUMMARY_SYSTEM_PROMPT = `You are a summarization engine. Analyze the coding session and extract durable knowledge.`

export class ReflectionModule implements AgentModule {
  readonly name = 'reflection'
  readonly dependencies = ['memory']

  constructor(
    private client: OpenAI,
    private model: string,
    private semantic: SemanticMemory,
    private episodic?: EpisodicMemory,
    private gateway?: ModelInvocationGateway,
  ) {}

  boot(): ModuleBootResult {
    return {}
  }

  async onComplete(ctx: ModuleRunContext): Promise<void> {
    const toolCallCount = ctx.messages.filter((m: any) => m.role === 'tool').length
    if (toolCallCount < 3) return
    if (ctx.turnResult.reason === 'error') return

    try {
      if (!this.gateway) return

      const conversationSummary = this.serializeForReflection(ctx.messages as Parameters<typeof this.serializeForReflection>[0])
      const schema = z.object({ knowledge: z.array(z.unknown()).optional() }).passthrough()

      const res = await this.gateway.executeStructured({
        role: 'reporter',
        preferredModelId: this.model,
        systemPrompt: REFLECTION_SYSTEM_PROMPT,
        userPrompt: `Analyze this agent run (outcome: ${ctx.turnResult.reason}):\n\n${conversationSummary}`,
        outputSchema: schema,
        taskId: 'reflection',
      })

      const output = JSON.stringify(res.value)
      const parsed = parseReflection(output)

      for (const entry of parsed) {
        this.semantic.write({
          content: entry.content,
          tags: entry.tags,
          source: 'agent_inferred',
          confidence: entry.confidence,
          timestamp: new Date().toISOString(),
        })
      }
    } catch {
      // reflection is non-blocking
    }
  }

  private serializeForReflection(messages: any[]): string {
    return messages
      .filter((m) => m.role !== 'system')
      .map((m) => {
        if (m.role === 'user') return `User: ${m.content}`
        if (m.role === 'assistant') {
          const calls = m.tool_calls
            ? ` [tools: ${m.tool_calls.map((t: any) => t.function.name).join(', ')}]`
            : ''
          return `Assistant: ${(m.content ?? '').slice(0, 200)}${calls}`
        }
        if (m.role === 'tool') {
          return `Tool Output: ${(m.content ?? '').slice(0, 150)}`
        }
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
}

/** Parse LLM reflection output into knowledge entries (standalone, not private) */
function parseReflection(output: string): Array<{
  content: string
  tags: string[]
  confidence: number
}> {
  try {
    const parsed = JSON.parse(output) as {
      knowledge?: Array<{
        content: string
        tags?: string[]
        confidence?: number
      }>
    }
    return (parsed.knowledge ?? [])
      .filter((e) => e.content && e.content.length > 10)
      .map((e) => ({
        content: e.content.slice(0, 500),
        tags: e.tags ?? [],
        confidence: typeof e.confidence === 'number' ? e.confidence : 0.5,
      }))
  } catch {
    return []
  }
}

export async function runConsolidation(
  client: OpenAI,
  model: string,
  episodic: EpisodicMemory,
  semantic: SemanticMemory,
  gateway?: ModelInvocationGateway,
): Promise<{ episodes: number; knowledgeExtracted: number }> {
  const episodes = episodic.recent(100)
  if (episodes.length < 5) {
    return { episodes: episodes.length, knowledgeExtracted: 0 }
  }

  const sessionSummary = episodes
    .map((e, i) => {
      const icon = e.outcome === 'success' ? '✓' : '✗'
      return `${i + 1}. ${icon} ${e.toolName}: ${e.inputSummary.slice(0, 60)} → ${e.resultSummary.slice(0, 80)}`
    })
    .join('\n')

  try {
    if (!gateway) return { episodes: episodes.length, knowledgeExtracted: 0 }

    const schema = z.object({ knowledge: z.array(z.any()).optional() }).passthrough()
    const res = await gateway.executeStructured({
      role: 'reporter',
      preferredModelId: model,
      systemPrompt: SUMMARY_SYSTEM_PROMPT,
      userPrompt: `Consolidate rules from session:\n\n${sessionSummary}`,
      outputSchema: schema,
      taskId: 'consolidation',
    })

    const output = JSON.stringify(res.value)
    const parsed = parseReflection(output)
    let extracted = 0

    for (const entry of parsed) {
      semantic.write({
        content: entry.content,
        tags: entry.tags,
        source: 'agent_inferred',
        confidence: entry.confidence,
        timestamp: new Date().toISOString(),
      })
      extracted++
    }

    return { episodes: episodes.length, knowledgeExtracted: extracted }
  } catch {
    return { episodes: episodes.length, knowledgeExtracted: 0 }
  }
}

export { runConsolidation as consolidateSession }
