import { SolverEvidenceMessage } from './crossSolverEvidenceBus.js'

export class GuidanceCompiler {
  public static compileGuidance(messages: SolverEvidenceMessage[], targetModelId: string): string {
    if (messages.length === 0) return ''

    const isM3 = targetModelId.includes('m3') || targetModelId.includes('mini')

    if (isM3) {
      // Extremely concise M3 guidance prompt
      const lines = ['新确认事实 (NEW FACTS):']
      for (const m of messages) {
        lines.push(`- ${m.summary} (Ref: ${m.evidenceIds.join(',')})`)
      }
      lines.push('下一步要求: 吸收新事实，只执行一个最符合新事实的明确动作。')
      return lines.join('\n')
    }

    // Richer guidance for high-tier model
    const lines = ['[CROSS-SOLVER GUIDANCE UPDATE]']
    for (const m of messages) {
      lines.push(
        `• Priority [${m.priority.toUpperCase()}] from Run ${m.sourceSolverRunId}: ${m.summary} (Evidence IDs: ${m.evidenceIds.join(', ')})`,
      )
    }
    return lines.join('\n')
  }
}
