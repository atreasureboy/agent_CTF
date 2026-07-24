import type { CompiledContext } from './compiledContext.js'

import type { TaskStateProjectionInput } from './contextProjection.js';
import { ContextProjection } from './contextProjection.js'
import type { ModelRole } from '../modelReliability/modelCapability.js'

export class SolverBriefCompiler {
  public static compileM3Brief(
    input: TaskStateProjectionInput,
    targetModelId: string,
    targetRole: ModelRole = 'solver_scout',
  ): CompiledContext {
    const ctx = ContextProjection.project(input, 'solver_brief', targetModelId, targetRole)

    const xmlLines: string[] = [
      '<task>',
      `  <objective>${ctx.objective}</objective>`,
      `  <scope>${ctx.scopeSummary}</scope>`,
      '  <confirmed_facts>',
    ]

    for (const ev of ctx.confirmedEvidence) {
      xmlLines.push(`    <fact id="${ev.id}">${ev.title}: ${ev.factSummary}</fact>`)
    }
    xmlLines.push('  </confirmed_facts>', '  <active_hypotheses>')

    for (const h of ctx.activeHypotheses) {
      xmlLines.push(`    <hypothesis id="${h.id}">${h.title}</hypothesis>`)
    }
    xmlLines.push('  </active_hypotheses>', '  <do_not_repeat>')

    for (const fp of ctx.forbiddenRepeats) {
      xmlLines.push(`    <fingerprint>${fp}</fingerprint>`)
    }
    xmlLines.push('  </do_not_repeat>', '  <allowed_tools>')

    for (const t of ctx.allowedToolIds) {
      xmlLines.push(`    <tool>${t}</tool>`)
    }
    xmlLines.push(
      '  </allowed_tools>',
      '  <next_action>Perform EXACTLY ONE clear, single step tool invocation or observation.</next_action>',
      '  <output_contract>Must return valid single action JSON matching requested output schema.</output_contract>',
      '</task>',
    )

    ctx.renderedText = xmlLines.join('\n')
    return ctx
  }
}
