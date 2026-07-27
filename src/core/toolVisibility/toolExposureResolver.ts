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
    domains?: string[]
    executionMode?: string
    costClass?: string
    outputMode?: string
    riskLevel?: string
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

export class DefaultToolExposureResolver implements ToolExposureResolver {
  private policy: ToolVisibilityPolicy

  constructor(policy: ToolVisibilityPolicy = new ToolVisibilityPolicy()) {
    this.policy = policy
  }

  public resolveDefinitions(input: ToolExposureResolverInput): ToolDescriptor[] {
    const isOrchestrator = input.identity.isOrchestrator || input.identity.modelRole === 'competition_coordinator'

    let candidates = input.allTools

    if (isOrchestrator) {
      // Sole source of truth: Tool Metadata visibilityClass === 'orchestrator' or 'all'
      candidates = candidates.filter(
        (t) => t.metadata?.visibilityClass === 'orchestrator' || t.metadata?.visibilityClass === 'all',
      )
      if (candidates.length === 0) {
        // Fail-closed for Orchestrator when no orchestrator tools match
        return []
      }
    } else {
      // Non-orchestrator filter via policy and visibilityClass (exclude orchestrator-only tools)
      candidates = candidates.filter((t) => t.metadata?.visibilityClass !== 'orchestrator')
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
    // 2. Information gain (desc)
    // 3. Cost (asc)
    // 4. Tool ID (alphabetical)
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
        input.tool.metadata?.visibilityClass === 'all'
      if (!allowed) {
        throw new Error(
          `ToolExecutionDenied: Orchestrator is not permitted to execute non-orchestrator tool '${input.tool.name}'.`,
        )
      }
      return
    }

    if (input.tool.metadata?.visibilityClass === 'orchestrator') {
      throw new Error(
        `ToolExecutionDenied: Non-orchestrator identity role='${input.identity.modelRole}' is not permitted to execute orchestrator tool '${input.tool.name}'.`,
      )
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
