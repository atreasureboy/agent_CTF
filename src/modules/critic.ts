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
import type { ModelInvocationGateway } from '../core/modelReliability/structuredModelGateway.js'
import { z } from 'zod'
import type {
  AgentModule,
  ModuleBootResult,
  ModuleIterationContext,
  ModuleIterationResult,
} from '../core/module.js'
import {
  CRITIC_INTERVAL,
  CRITIC_MIN_ITERATIONS,
  CRITIC_CONTEXT_MESSAGES,
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
    private gateway?: ModelInvocationGateway,
  ) {}

  boot(): ModuleBootResult {
    return {}
  }

  async onIteration(ctx: ModuleIterationContext): Promise<ModuleIterationResult | void> {
    await Promise.resolve()
    if (this.planMode) return
    if (ctx.iteration < CRITIC_MIN_ITERATIONS) return
    if (ctx.iteration % CRITIC_INTERVAL !== 0) return

    const recent = ctx.messages.slice(-CRITIC_CONTEXT_MESSAGES)
    if (recent.length < 4) return

    try {
      if (!this.gateway) return

      const schema = z
        .object({ analysis: z.string().optional(), criticism: z.string().optional() })
        .passthrough()
      const res = await this.gateway.executeStructured({
        role: 'specialist',
        preferredModelId: this.model,
        systemPrompt: DEFAULT_CRITIC_SYSTEM_PROMPT,
        userPrompt: `以下是最近的操作历史，请检查是否存在失误：\n\n${formatMessagesForCritic(recent)}`,
        outputSchema: schema,
        taskId: 'critic',
        signal: ctx.abortSignal,
      })

      const output = JSON.stringify(res.value)
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
