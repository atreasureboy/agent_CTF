import { CompiledContext } from './compiledContext.js'
import { ContextProjection, TaskStateProjectionInput } from './contextProjection.js'
import { ModelRole } from '../modelReliability/modelCapability.js'

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

    lines.push('', '=== ALLOWED TOOLS FOR SPECIALIST ===', ctx.allowedToolIds.join(', '))

    ctx.renderedText = lines.join('\n')
    return ctx
  }
}
