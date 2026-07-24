import type { CompiledContext } from './compiledContext.js'
import type { TaskStateProjectionInput } from './contextProjection.js';
import { ContextProjection } from './contextProjection.js'
import type { ModelRole } from '../modelReliability/modelCapability.js'

export class ProgressCompiler {
  public static compileProgress(
    input: TaskStateProjectionInput,
    targetModelId: string,
    targetRole: ModelRole = 'progress_summarizer',
  ): CompiledContext {
    const ctx = ContextProjection.project(input, 'progress_handoff', targetModelId, targetRole)

    const lines: string[] = [
      `=== PROGRESS BRIEF [Task:${ctx.taskId} StateRev:${ctx.stateRevision}] ===`,
      `Objective: ${ctx.objective}`,
      `Scope: ${ctx.scopeSummary}`,
      `Current Blocker: ${ctx.currentBlocker || 'None reported'}`,
      '',
      `Confirmed Evidence Count: ${ctx.confirmedEvidence.length}`,
      `Active Hypotheses Count: ${ctx.activeHypotheses.length}`,
      `Failed Attempts Excluded: ${ctx.forbiddenRepeats.length}`,
      '',
      '=== RECENT KEY EVIDENCE ===',
    ]

    for (const ev of ctx.confirmedEvidence.slice(-5)) {
      lines.push(`- [${ev.id}] ${ev.title}: ${ev.factSummary}`)
    }

    lines.push('', '=== NEXT RECOMMENDED STEPS ===')
    for (const act of ctx.recommendedActions.slice(0, 3)) {
      lines.push(`- Execute ${act.actionName} on ${act.target}: ${act.rationale}`)
    }

    ctx.renderedText = lines.join('\n')
    return ctx
  }
}
