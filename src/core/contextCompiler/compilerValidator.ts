import { CompiledContext } from './compiledContext.js'

export interface CompilerValidationResult {
  valid: boolean
  errors: string[]
}

export class CompilerValidator {
  public static validate(
    ctx: CompiledContext,
    maxTokenBudget = 32768,
  ): CompilerValidationResult {
    const errors: string[] = []

    if (!ctx.objective || ctx.objective.trim().length === 0) {
      errors.push('Objective must not be empty.')
    }

    if (!ctx.scopeSummary || ctx.scopeSummary.trim().length === 0) {
      errors.push('Scope summary must be explicitly defined.')
    }

    if (ctx.estimatedTokens > maxTokenBudget) {
      errors.push(`Estimated tokens (${ctx.estimatedTokens}) exceed max budget (${maxTokenBudget}).`)
    }

    if (!ctx.completionContract || ctx.completionContract.length === 0) {
      errors.push('Completion contract must be specified.')
    }

    // Check rendered text for illegal hallucinations or stripped scopes
    if (ctx.renderedText) {
      if (!ctx.renderedText.includes(ctx.scopeSummary) && ctx.scopeSummary !== 'default') {
        errors.push('Rendered context stripped required ContestScope definition.')
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    }
  }

  public static fallbackToDeterministicTemplate(ctx: CompiledContext): string {
    const lines: string[] = [
      `=== TASK OBJECTIVE [Task:${ctx.taskId} Rev:${ctx.stateRevision}] ===`,
      ctx.objective,
      `SCOPE: ${ctx.scopeSummary}`,
      '',
      '=== CONFIRMED FACTS & EVIDENCE ===',
    ]

    for (const ev of ctx.confirmedEvidence) {
      lines.push(`- [E:${ev.id}] (${ev.confidence * 100}%) ${ev.title}: ${ev.factSummary}`)
    }

    lines.push('', '=== ACTIVE HYPOTHESES ===')
    for (const h of ctx.activeHypotheses) {
      lines.push(`- [H:${h.id}] ${h.title}`)
    }

    lines.push('', '=== DO NOT REPEAT (FAILED ATTEMPTS) ===')
    for (const a of ctx.failedAttempts) {
      lines.push(`- [A:${a.id}] Fingerprint: ${a.fingerprint} (Outcome: ${a.outcome})`)
    }

    lines.push('', '=== ALLOWED TOOLS ===', ctx.allowedToolIds.join(', '))
    lines.push('', '=== COMPLETION CONTRACT ===', ctx.completionContract.join('\n'))

    return lines.join('\n')
  }
}
