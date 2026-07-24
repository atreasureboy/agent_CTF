import type { CompiledContext } from './compiledContext.js'
import type { CTFTaskState } from '../ctfRuntime/taskState.js'
import type { ModelExecutionIdentity } from '../modelReliability/modelExecutionIdentity.js'
import type { ArtifactStore } from '../artifacts.js'

export interface CompilerValidationResult {
  valid: boolean
  errors: string[]
}

export interface CompilerValidationDependencies {
  state: Readonly<CTFTaskState>
  artifactStore?: ArtifactStore
  expectedIdentity: ModelExecutionIdentity
  expectedSnapshotHash?: string
}

export class CompilerValidator {
  public static validate(
    ctx: CompiledContext,
    dependencies?: CompilerValidationDependencies,
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

    if (dependencies) {
      const { state, expectedIdentity, expectedSnapshotHash } = dependencies

      if (ctx.taskId !== expectedIdentity.taskId || ctx.taskId !== state.taskId) {
        errors.push(`Task ID mismatch: context '${ctx.taskId}', expected '${state.taskId}'.`)
      }

      if (expectedSnapshotHash && ctx.stateSnapshotHash !== expectedSnapshotHash) {
        errors.push(`Snapshot hash mismatch: context '${ctx.stateSnapshotHash}', expected '${expectedSnapshotHash}'.`)
      }

      for (const ev of ctx.confirmedEvidence) {
        const found = state.evidence.find((e) => e.id === ev.id)
        if (!found) {
          errors.push(`Evidence '${ev.id}' does not exist in authoritative TaskState.`)
        }
      }

      for (const hyp of ctx.activeHypotheses) {
        const found = state.hypotheses.find((h) => h.id === hyp.id)
        if (!found) {
          errors.push(`Hypothesis '${hyp.id}' does not exist in authoritative TaskState.`)
        } else if (found.status !== hyp.status) {
          errors.push(`Hypothesis '${hyp.id}' status mismatch: '${hyp.status}' vs state '${found.status}'.`)
        }
      }

      for (const att of ctx.failedAttempts) {
        const found = state.attempts.find((a) => a.id === att.id)
        if (!found) {
          errors.push(`Attempt '${att.id}' does not exist in authoritative TaskState.`)
        }
      }

      for (const art of ctx.importantArtifacts) {
        if (!state.artifactIds.includes(art.id)) {
          errors.push(`Artifact '${art.id}' is not associated with task '${state.taskId}'.`)
        }
      }
    }

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
      lines.push(`- [E:${ev.id}] (${(ev.confidence * 100).toFixed(0)}%) ${ev.title}: ${ev.factSummary}`)
    }

    lines.push('', '=== ACTIVE HYPOTHESES ===')
    for (const h of ctx.activeHypotheses) {
      lines.push(`- [H:${h.id}] (${h.status}) ${h.statement}`)
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
