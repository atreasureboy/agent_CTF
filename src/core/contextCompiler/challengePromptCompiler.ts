import { CompiledContext } from './compiledContext.js'
import { CompilerValidator } from './compilerValidator.js'
import { ContextProjection, TaskStateProjectionInput } from './contextProjection.js'
import { ModelRole } from '../modelReliability/modelCapability.js'

export class ChallengePromptCompiler {
  public static compile(
    input: TaskStateProjectionInput,
    targetModelId: string,
    targetRole: ModelRole = 'solver_scout',
    enableModelRender = false,
  ): CompiledContext {
    const ctx = ContextProjection.project(input, 'challenge_prompt', targetModelId, targetRole)

    if (!enableModelRender) {
      ctx.renderedText = CompilerValidator.fallbackToDeterministicTemplate(ctx)
    } else {
      ctx.renderedText = `[CHALLENGE PROMPT]\nObjective: ${ctx.objective}\nScope: ${ctx.scopeSummary}`
      const val = CompilerValidator.validate(ctx)
      if (!val.valid) {
        ctx.renderedText = CompilerValidator.fallbackToDeterministicTemplate(ctx)
      }
    }

    return ctx
  }
}
