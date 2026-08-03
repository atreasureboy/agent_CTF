import type { CompiledContext } from './compiledContext.js'
import type { TaskStateProjectionInput } from './contextProjection.js'
import { ContextProjection } from './contextProjection.js'
import type { ModelRole } from '../modelReliability/modelCapability.js'

export class SpecialistContextCompiler {
  public static compileSpecialistContext(
    input: TaskStateProjectionInput,
    specialistDomain: string,
    targetModelId: string,
    targetRole: ModelRole = 'specialist',
  ): CompiledContext {
    // Filter input to specialist relevant subset
    const filteredArtifacts = input.artifacts.filter(
      (a) => a.description.includes(specialistDomain) || a.path.includes(specialistDomain),
    )

    const filteredInput: TaskStateProjectionInput = {
      ...input,
      artifacts: filteredArtifacts.length > 0 ? filteredArtifacts : input.artifacts.slice(0, 3),
    }

    const ctx = ContextProjection.project(
      filteredInput,
      'specialist_context',
      targetModelId,
      targetRole,
    )

    const lines: string[] = [
      `=== SPECIALIST BRIEF: ${specialistDomain.toUpperCase()} ===`,
      `Objective: ${ctx.objective}`,
      `Scope: ${ctx.scopeSummary}`,
      '',
      '=== DOMAIN EVIDENCE & ARTIFACTS ===',
    ]

    for (const art of ctx.importantArtifacts) {
      lines.push(`- Artifact: ${art.path} (${art.description})`)
    }
    for (const ev of ctx.confirmedEvidence) {
      lines.push(`- Evidence [E:${ev.id}]: ${ev.title} - ${ev.factSummary}`)
    }

    const attempts = input.attempts || []
    if (attempts.length > 0) {
      const failed = attempts.filter((a) => a.outcome === 'failed' || a.outcome === 'error')
      if (failed.length > 0) {
        lines.push('', '=== BLOCKED / FAILED ATTEMPTS (DO NOT REPEAT) ===')
        for (const f of failed.slice(-5)) {
          lines.push(
            `- Attempt [${f.id}] Action: ${f.actionSummary} (Outcome: ${f.outcome}, Fingerprint: ${f.fingerprint ?? 'none'})`,
          )
        }
      }
    }

    lines.push('', '=== DOMAIN STRATEGY GUIDANCE ===')
    lines.push(
      `- Focus strictly on ${specialistDomain} analysis. Avoid executing commands outside profile boundaries.`,
    )
    lines.push('- Utilize confirmed evidence before generating new hypotheses.')
    lines.push('', '=== ALLOWED TOOLS FOR SPECIALIST ===', ctx.allowedToolIds.join(', '))

    ctx.renderedText = lines.join('\n')
    return ctx
  }
}
