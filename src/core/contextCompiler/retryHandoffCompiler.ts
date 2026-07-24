import type { CompiledContext } from './compiledContext.js'
import type { TaskStateProjectionInput } from './contextProjection.js';
import { ContextProjection } from './contextProjection.js'
import type { ModelRole } from '../modelReliability/modelCapability.js'

export interface RetryHandoffExtraInput {
  reproducibleCommands: string[]
  environmentDependencies: string[]
  resumeEntryPoint: string
}

export class RetryHandoffCompiler {
  public static compileRetryHandoff(
    input: TaskStateProjectionInput,
    extra: RetryHandoffExtraInput,
    targetModelId: string,
    targetRole: ModelRole = 'deep_solver',
  ): CompiledContext {
    const ctx = ContextProjection.project(input, 'retry_handoff', targetModelId, targetRole)

    const lines: string[] = [
      `=== RETRY / RESUME HANDOFF BRIEF [Task:${ctx.taskId} Rev:${ctx.stateRevision}] ===`,
      `Objective: ${ctx.objective}`,
      `Scope: ${ctx.scopeSummary}`,
      `Resume Entry Point: ${extra.resumeEntryPoint}`,
      '',
      '=== REPRODUCIBLE COMMANDS ===',
    ]

    for (const cmd of extra.reproducibleCommands) {
      lines.push(`$ ${cmd}`)
    }

    lines.push('', '=== ENVIRONMENT DEPENDENCIES ===')
    for (const dep of extra.environmentDependencies) {
      lines.push(`- ${dep}`)
    }

    lines.push('', '=== IMPORTANT ARTIFACTS & SHA256 ===')
    for (const art of ctx.importantArtifacts) {
      lines.push(`- Path: ${art.path} | SHA: ${art.sha256 || 'N/A'} | ${art.description}`)
    }

    lines.push('', '=== FAILED ATTEMPTS TO AVOID ===')
    for (const att of ctx.failedAttempts) {
      lines.push(`- [A:${att.id}] ${att.fingerprint} -> ${att.outcome}`)
    }

    lines.push('', '=== FIRST ACTION ON RESUME ===')
    if (ctx.recommendedActions.length > 0) {
      const first = ctx.recommendedActions[0]
      lines.push(`- Action: ${first.actionName} on ${first.target}`)
    } else {
      lines.push('- Inspect current blocker and re-evaluate active hypotheses.')
    }

    ctx.renderedText = lines.join('\n')
    return ctx
  }
}
