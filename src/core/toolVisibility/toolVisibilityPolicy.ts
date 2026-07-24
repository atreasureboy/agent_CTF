import type { ModelExecutionIdentity } from '../modelReliability/modelExecutionIdentity.js'
import type { CapabilityProfile } from '../capabilityProfile.js'
import type { CTFTaskState } from '../ctfRuntime/taskState.js'

export type ToolVisibility =
  | 'orchestrator'
  | 'solver'
  | `solver:${string}`
  | `model:${string}`
  | `specialist:${string}`
  | 'workflow-only'
  | 'oneshot-only'
  | 'operator-only'

export type VisibilityDefault = 'deny' | 'profile_allowed' | 'legacy_allow'

export interface ToolVisibilityRule {
  toolId: string
  visibleTo: ToolVisibility[]
}

export interface ResolveVisibleToolsInput<T extends { name: string }> {
  tools: T[]
  identity: ModelExecutionIdentity
  profile?: CapabilityProfile
  taskState?: Readonly<CTFTaskState>
  maxVisibleTools?: number
}

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

export class ToolVisibilityPolicy {
  private rules = new Map<string, ToolVisibilityRule>()
  private defaultPolicy: VisibilityDefault

  constructor(initialRules: ToolVisibilityRule[] = [], defaultPolicy: VisibilityDefault = 'profile_allowed') {
    this.defaultPolicy = defaultPolicy
    for (const r of initialRules) {
      this.rules.set(r.toolId, r)
    }
  }

  public addRule(rule: ToolVisibilityRule): void {
    this.rules.set(rule.toolId, rule)
  }

  public setDefaultPolicy(policy: VisibilityDefault): void {
    this.defaultPolicy = policy
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
    if (context.isOrchestrator && HIGH_LEVEL_ORCHESTRATOR_TOOLS.has(toolId)) {
      return true
    }

    const rule = this.rules.get(toolId)

    if (!rule) {
      if (this.defaultPolicy === 'deny') {
        return false
      }
      if (this.defaultPolicy === 'profile_allowed') {
        if (context.isWorkflow || context.isOneShot) return false
        return true
      }
      if (this.defaultPolicy === 'legacy_allow') {
        return true
      }
      return false
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

  public resolveVisibleTools<T extends { name: string }>(
    input: ResolveVisibleToolsInput<T>,
  ): T[] {
    const context = {
      role: input.identity.modelRole,
      modelId: input.identity.modelId,
      solverId: input.identity.solverId,
      specialistId: input.identity.specialistId,
      isOrchestrator: input.identity.isOrchestrator,
      isWorkflow: input.identity.isWorkflow,
      isOneShot: input.identity.isOneShot,
    }

    let candidateTools = input.tools.filter((t) =>
      this.isToolVisible(t.name, context),
    )

    if (input.profile) {
      const p = input.profile
      candidateTools = candidateTools.filter((t) => {
        if (p.deniedTools?.includes(t.name)) return false
        if (p.allowedTools && p.allowedTools.length > 0 && !p.allowedTools.includes(t.name)) return false
        return true
      })
    }

    if (input.identity.isOrchestrator) {
      // Fail-closed for Orchestrator: return ONLY high level tools.
      // If none match, return [] (do NOT fail-open to all tools).
      return candidateTools.filter((t) => HIGH_LEVEL_ORCHESTRATOR_TOOLS.has(t.name))
    }

    // Smart ranking & prioritization if maxVisibleTools is specified
    const cap = input.maxVisibleTools
    if (cap && candidateTools.length > cap) {
      const activeHypothesis = input.taskState?.hypotheses.find((h) => h.status === 'testing' || h.status === 'proposed')
      const category = input.taskState?.challenge.category

      candidateTools.sort((a, b) => {
        let scoreA = 0
        let scoreB = 0

        if (category && a.name.toLowerCase().includes(category.toLowerCase())) scoreA += 10
        if (category && b.name.toLowerCase().includes(category.toLowerCase())) scoreB += 10

        if (activeHypothesis && activeHypothesis.statement.toLowerCase().includes(a.name.toLowerCase())) scoreA += 5
        if (activeHypothesis && activeHypothesis.statement.toLowerCase().includes(b.name.toLowerCase())) scoreB += 5

        if (scoreA !== scoreB) return scoreB - scoreA
        return a.name.localeCompare(b.name)
      })

      return candidateTools.slice(0, cap)
    }

    return candidateTools
  }

  public filterVisibleTools<T extends { name: string }>(
    tools: T[],
    context: {
      role?: string
      modelId?: string
      solverId?: string
      specialistId?: string
      isOrchestrator?: boolean
      isWorkflow?: boolean
      isOneShot?: boolean
      maxVisibleTools?: number
    },
  ): T[] {
    const identity: ModelExecutionIdentity = {
      taskId: 'session',
      modelRole: (context.role as any) || 'task_planner',
      capabilityProfileId: 'default',
      modelId: context.modelId,
      solverId: context.solverId,
      specialistId: context.specialistId,
      isOrchestrator: !!context.isOrchestrator,
      isWorkflow: !!context.isWorkflow,
      isOneShot: !!context.isOneShot,
    }

    return this.resolveVisibleTools({
      tools,
      identity,
      maxVisibleTools: context.maxVisibleTools,
    })
  }
}
