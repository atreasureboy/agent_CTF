import type { ModelExecutionIdentity } from '../modelReliability/modelExecutionIdentity.js'
import type { ModelCapabilityProfile } from '../modelReliability/modelCapability.js'
import type { CapabilityProfile } from '../capabilityProfile.js'
import type { CTFTaskState } from '../ctfRuntime/taskState.js'
import { ToolVisibilityPolicy } from './toolVisibilityPolicy.js'

export interface ToolDescriptor {
  name: string
  description?: string
  parameters?: Record<string, any>
  category?: string
  availability?: string
  cost?: number
  metadata?: {
    visibilityClass?: 'orchestrator' | 'solver' | 'specialist' | 'all'
    roleMatch?: string[]
    hypothesisMatch?: string[]
    informationGain?: number
    [key: string]: any
  }
}

export interface ToolExposureResolverInput {
  identity: ModelExecutionIdentity
  modelProfile: ModelCapabilityProfile
  capabilityProfile?: CapabilityProfile
  taskState?: Readonly<CTFTaskState>
  allTools: ToolDescriptor[]
}

export interface ToolExecutionAssertInput {
  identity: ModelExecutionIdentity
  tool: ToolDescriptor
  taskState?: Readonly<CTFTaskState>
}

export interface ToolExposureResolver {
  resolveDefinitions(input: ToolExposureResolverInput): ToolDescriptor[]
  assertExecutable(input: ToolExecutionAssertInput): void
}

const ORCHESTRATOR_TOOL_NAMES = new Set([
  'run_workflow',
  'run_one_shot',
  'request_handoff',
  'inspect_task_state',
  'inspect_solver',
  'send_solver_guidance',
  'validate_candidate',
  'pause_solver',
  'resume_solver',
])

export class DefaultToolExposureResolver implements ToolExposureResolver {
  private policy: ToolVisibilityPolicy

  constructor(policy: ToolVisibilityPolicy = new ToolVisibilityPolicy()) {
    this.policy = policy
  }

  public resolveDefinitions(input: ToolExposureResolverInput): ToolDescriptor[] {
    const isOrchestrator = input.identity.isOrchestrator || input.identity.modelRole === 'competition_coordinator'

    let candidates = input.allTools

    if (isOrchestrator) {
      candidates = candidates.filter(
        (t) => t.metadata?.visibilityClass === 'orchestrator' || ORCHESTRATOR_TOOL_NAMES.has(t.name),
      )
      if (candidates.length === 0) {
        // Orchestrator Fail-closed: No orchestrator tools available -> Return empty definitions
        return []
      }
    } else {
      // Non-orchestrator filter via policy
      const context = {
        role: input.identity.modelRole,
        modelId: input.identity.modelId,
        solverId: input.identity.solverId,
        specialistId: input.identity.specialistId,
        isOrchestrator: false,
      }
      candidates = candidates.filter((t) => this.policy.isToolVisible(t.name, context))
    }

    // Sort candidates according to Section 17 rules:
    // 1. Role match
    // 2. Capability Profile
    // 3. Category / Task type match
    // 4. Information gain (desc)
    // 5. Cost (asc)
    // 6. Tool ID (alphabetical)
    const sorted = [...candidates].sort((a, b) => {
      const aRoleMatch = a.metadata?.roleMatch?.includes(input.identity.modelRole) ? 1 : 0
      const bRoleMatch = b.metadata?.roleMatch?.includes(input.identity.modelRole) ? 1 : 0
      if (aRoleMatch !== bRoleMatch) return bRoleMatch - aRoleMatch

      const aGain = a.metadata?.informationGain ?? 0
      const bGain = b.metadata?.informationGain ?? 0
      if (aGain !== bGain) return bGain - aGain

      const aCost = a.cost ?? 0
      const bCost = b.cost ?? 0
      if (aCost !== bCost) return aCost - bCost

      return a.name.localeCompare(b.name)
    })

    const limit = Math.min(
      input.modelProfile.limits?.maxVisibleTools ?? 20,
      50,
    )
    return sorted.slice(0, limit)
  }

  public assertExecutable(input: ToolExecutionAssertInput): void {
    const isOrchestrator = input.identity.isOrchestrator || input.identity.modelRole === 'competition_coordinator'

    if (isOrchestrator) {
      const allowed =
        input.tool.metadata?.visibilityClass === 'orchestrator' ||
        ORCHESTRATOR_TOOL_NAMES.has(input.tool.name)
      if (!allowed) {
        throw new Error(
          `ToolExecutionDenied: Orchestrator is not permitted to execute non-orchestrator tool '${input.tool.name}'.`,
        )
      }
      return
    }

    const context = {
      role: input.identity.modelRole,
      modelId: input.identity.modelId,
      solverId: input.identity.solverId,
      specialistId: input.identity.specialistId,
      isOrchestrator: false,
    }

    if (!this.policy.isToolVisible(input.tool.name, context)) {
      throw new Error(
        `ToolExecutionDenied: Tool '${input.tool.name}' is hidden or denied for identity role='${input.identity.modelRole}' solver='${input.identity.solverId ?? 'none'}'. Execution blocked.`,
      )
    }
  }
}
