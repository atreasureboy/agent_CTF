export type ToolVisibility =
  | 'orchestrator'
  | 'solver'
  | `solver:${string}`
  | `model:${string}`
  | `specialist:${string}`
  | 'workflow-only'
  | 'oneshot-only'
  | 'operator-only'

export interface ToolVisibilityRule {
  toolId: string
  visibleTo: ToolVisibility[]
}

export class ToolVisibilityPolicy {
  private rules = new Map<string, ToolVisibilityRule>()

  constructor(initialRules: ToolVisibilityRule[] = []) {
    for (const r of initialRules) {
      this.rules.set(r.toolId, r)
    }
  }

  public addRule(rule: ToolVisibilityRule): void {
    this.rules.set(rule.toolId, rule)
  }

  public isToolVisible(
    toolId: string,
    context: {
      role?: string
      modelId?: string
      solverId?: string
      specialistId?: string
      isOrchestrator?: boolean
      isWorkflow?: boolean
      isOneShot?: boolean
    },
  ): boolean {
    const rule = this.rules.get(toolId)
    if (!rule) {
      // Default policy: if no specific rule, visible to standard solvers & orchestrator
      if (context.isWorkflow || context.isOneShot) return false
      return true
    }

    for (const v of rule.visibleTo) {
      if (v === 'orchestrator' && context.isOrchestrator) return true
      if (v === 'solver' && !context.isOrchestrator) return true
      if (context.solverId && v === `solver:${context.solverId}`) return true
      if (context.modelId && v === `model:${context.modelId}`) return true
      if (context.specialistId && v === `specialist:${context.specialistId}`) return true
      if (v === 'workflow-only' && context.isWorkflow) return true
      if (v === 'oneshot-only' && context.isOneShot) return true
    }

    return false
  }

  public filterVisibleTools<T extends { name: string }>(
    tools: T[],
    context: {
      role?: string
      modelId?: string
      solverId?: string
      specialistId?: string
      isOrchestrator?: boolean
      maxVisibleTools?: number
    },
  ): T[] {
    const visible = tools.filter((t) =>
      this.isToolVisible(t.name, context),
    )

    // Orchestrator filter: limit to high-level orchestrator tools
    if (context.isOrchestrator) {
      const HIGH_LEVEL_ORCHESTRATOR_TOOLS = new Set([
        'inspect_task_state',
        'run_workflow',
        'run_one_shot',
        'request_handoff',
        'inspect_solver',
        'send_solver_guidance',
        'validate_candidate',
        'pause_challenge',
      ])

      const filtered = visible.filter((t) =>
        HIGH_LEVEL_ORCHESTRATOR_TOOLS.has(t.name),
      )
      if (filtered.length > 0) return filtered
    }

    // Limit maximum visible tools (e.g. for M3 Scout capped at 8-15)
    if (context.maxVisibleTools && visible.length > context.maxVisibleTools) {
      return visible.slice(0, context.maxVisibleTools)
    }

    return visible
  }
}
