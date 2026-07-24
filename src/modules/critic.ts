/**
 * CriticModule — self-correction loop.
 *
 * Every N iterations, runs a lightweight LLM call to review recent
 * conversation history for common failure modes. If issues are found,
 * returns a correction message to inject.
 *
 * Extracted from engine.ts (maybeRunCritic + critic invocation in loop).
 */

import type OpenAI from 'openai'
import type { AgentModule, ModuleBootResult, ModuleIterationContext, ModuleIterationResult } from '../core/module.js'
import {
  CRITIC_INTERVAL,
  CRITIC_MIN_ITERATIONS,
  CRITIC_CONTEXT_MESSAGES,
  CRITIC_MAX_TOKENS,
  DEFAULT_CRITIC_SYSTEM_PROMPT,
  formatMessagesForCritic,
  parseCriticOutput,
} from '../prompts/critic.js'

export class CriticModule implements AgentModule {
  readonly name = 'critic'

  constructor(
    private client: OpenAI,
    private model: string,
    private planMode: boolean,
  ) {}

  boot(): ModuleBootResult {
    return {}
  }

  async onIteration(ctx: ModuleIterationContext): Promise<ModuleIterationResult | void> {
    if (this.planMode) return
    if (ctx.iteration < CRITIC_MIN_ITERATIONS) return
    if (ctx.iteration % CRITIC_INTERVAL !== 0) return

    const recent = ctx.messages.slice(-CRITIC_CONTEXT_MESSAGES)
    if (recent.length < 4) return

    try {
      const { OpenAICompatibleProvider } = await import('../core/modelReliability/providers/openAICompatibleProvider.js')
      const provider = new OpenAICompatibleProvider(this.client)
      const res = await provider.executeStructured(
        {
          id: this.model,
          provider: 'openai-compatible',
          model: this.model,
          contextWindow: 128000,
          capabilities: { toolCalling: false, structuredOutput: true, vision: false, longContext: true, codeExecutionPlanning: false },
          reliability: { structuredOutput: 0.9, toolArguments: 0.9, longHorizonPlanning: 0.8, summarization: 0.9, instructionFollowing: 0.9 },
          economics: {},
          allowedRoles: ['specialist'],
          limits: { maxVisibleTools: 5, maxIterations: 1, maxRepairAttempts: 1, maxConsecutiveFailures: 2 },
          fallbackModelIds: [],
        },
        {
          taskId: 'critic',
          role: 'specialist',
          preferredModelId: this.model,
          systemPrompt: DEFAULT_CRITIC_SYSTEM_PROMPT,
          userPrompt: `以下是最近的操作历史，请检查是否存在失误：\n\n${formatMessagesForCritic(recent)}`,
          temperature: 0,
          signal: ctx.abortSignal,
        },
      )

      const output = res.rawText ?? ''
      const criticism = parseCriticOutput(output)

      if (criticism) {
        return {
          injectMessage: `[🔍 自动纠错检查]\n${criticism}\n\n请根据以上纠错提示立即调整行动。`,
        }
      }
    } catch (err) {
      // critic failures must never break the main loop, but should be traceable
      ctx.eventLog?.append('module_error', this.name, {
        stage: 'onIteration',
        iteration: ctx.iteration,
        error: (err as Error).message,
      })
    }
  }
}
