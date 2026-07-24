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
import type { AgentModule, ModuleBootResult, ModuleRunContext } from '../core/module.js'
import type { SemanticMemory } from '../core/semanticMemory.js'
import type { EpisodicMemory } from '../core/episodicMemory.js'

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

export class ReflectionModule implements AgentModule {
  readonly name = 'reflection'
  readonly dependencies = ['memory']

  constructor(
    private client: OpenAI,
    private model: string,
    private semantic: SemanticMemory,
  ) {}

  boot(): ModuleBootResult {
    return {}
  }

  async onComplete(ctx: ModuleRunContext): Promise<void> {
    // Skip if the run was too short to yield useful insights
    const toolCallCount = ctx.messages.filter((m) => m.role === 'tool').length
    if (toolCallCount < 3) return

    // Skip if the run ended in error
    if (ctx.turnResult.reason === 'error') return

    try {
      const conversationSummary = this.serializeForReflection(ctx.messages)

      const { OpenAICompatibleProvider } =
        await import('../core/modelReliability/providers/openAICompatibleProvider.js')
      const provider = new OpenAICompatibleProvider(this.client)
      const res = await provider.executeStructured(
        {
          id: this.model,
          providerId: 'openai-compatible',
          providerModelName: this.model,
          provider: 'openai-compatible',
          model: this.model,
          trustLevel: 'standard',
          reliabilityClass: 'standard',
          contextWindow: 128000,
          capabilities: {
            toolCalling: false,
            structuredOutput: true,
            vision: false,
            longContext: true,
            codeExecutionPlanning: false,
          },
          reliability: {
            structuredOutput: 0.9,
            toolArguments: 0.9,
            longHorizonPlanning: 0.8,
            summarization: 0.9,
            instructionFollowing: 0.9,
          },
          economics: {},
          allowedRoles: ['reporter'],
          limits: {
            maxVisibleTools: 5,
            maxIterations: 1,
            maxRepairAttempts: 1,
            maxConsecutiveFailures: 2,
          },
          fallbackModelIds: [],
        },
        {
          taskId: 'reflection',
          role: 'reporter',
          preferredModelId: this.model,
          systemPrompt: REFLECTION_SYSTEM_PROMPT,
          userPrompt: `Analyze this agent run (outcome: ${ctx.turnResult.reason}):\n\n${conversationSummary}`,
          temperature: 0,
        },
      )

      const output = res.rawText ?? ''
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

      if (parsed.length > 0) {
        ctx.eventLog?.append('memory_write', 'reflection', {
          entries: parsed.length,
          module: 'reflection',
        })
      }
    } catch (err) {
      // reflection failures must never break anything, but should be traceable
      ctx.eventLog?.append('module_error', this.name, {
        stage: 'onComplete',
        error: (err as Error).message,
      })
    }
  }

  private serializeForReflection(
    messages: { role: string; content: string | null; tool_calls?: unknown[] }[],
  ): string {
    const parts: string[] = []
    for (const msg of messages.slice(-30)) {
      if (msg.role === 'user' && typeof msg.content === 'string') {
        parts.push(`[USER]: ${msg.content.slice(0, 200)}`)
      } else if (msg.role === 'assistant') {
        if (msg.content) parts.push(`[ASSISTANT]: ${msg.content.slice(0, 200)}`)
        if (msg.tool_calls?.length) {
          const names = (msg.tool_calls as Array<{ function: { name: string } }>)
            .map((tc) => tc.function.name)
            .join(', ')
          parts.push(`[TOOLS USED]: ${names}`)
        }
      } else if (msg.role === 'tool' && typeof msg.content === 'string') {
        parts.push(`[RESULT]: ${msg.content.slice(0, 100)}`)
      }
    }
    return parts.join('\n')
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

// ── Session-level consolidation (AgentOS §8 Memory 整合) ──────────────────────

/**
 * Consolidate a session's episodic events into semantic memory.
 * Called at REPL exit to close the learning loop.
 *
 * Unlike per-turn reflection (which analyzes a single run), this summarizes
 * the entire session's activity and extracts durable knowledge.
 */
export async function consolidateSession(
  client: OpenAI,
  model: string,
  episodic: EpisodicMemory,
  semantic: SemanticMemory,
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
    const { OpenAICompatibleProvider } =
      await import('../core/modelReliability/providers/openAICompatibleProvider.js')
    const provider = new OpenAICompatibleProvider(client)
    const res = await provider.executeStructured(
      {
        id: model,
        providerId: 'openai-compatible',
        providerModelName: model,
        provider: 'openai-compatible',
        model,
        trustLevel: 'standard',
        reliabilityClass: 'standard',
        contextWindow: 128000,
        capabilities: {
          toolCalling: false,
          structuredOutput: true,
          vision: false,
          longContext: true,
          codeExecutionPlanning: false,
        },
        reliability: {
          structuredOutput: 0.9,
          toolArguments: 0.9,
          longHorizonPlanning: 0.8,
          summarization: 0.9,
          instructionFollowing: 0.9,
        },
        economics: {},
        allowedRoles: ['reporter'],
        limits: {
          maxVisibleTools: 5,
          maxIterations: 1,
          maxRepairAttempts: 1,
          maxConsecutiveFailures: 2,
        },
        fallbackModelIds: [],
      },
      {
        taskId: 'consolidate',
        role: 'reporter',
        preferredModelId: model,
        systemPrompt: REFLECTION_SYSTEM_PROMPT,
        userPrompt: `Summarize this entire coding session and extract durable knowledge:\n\n${sessionSummary}`,
        temperature: 0,
      },
    )

    const output = res.rawText ?? ''
    const parsed = parseReflection(output)

    for (const entry of parsed) {
      semantic.write({
        content: `[session] ${entry.content}`,
        tags: entry.tags,
        source: 'consolidation',
        confidence: entry.confidence,
        timestamp: new Date().toISOString(),
      })
    }

    return { episodes: episodes.length, knowledgeExtracted: parsed.length }
  } catch {
    return { episodes: episodes.length, knowledgeExtracted: 0 }
  }
}
