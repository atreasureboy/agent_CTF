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
    const maxCap = Math.min(input.modelProfile.limits.maxVisibleTools || 20, 50)

    const visible = this.policy.resolveVisibleTools({
      tools: input.allTools,
      identity: input.identity,
      profile: input.capabilityProfile,
      taskState: input.taskState,
      maxVisibleTools: maxCap,
    })

    return visible
  }

  public assertExecutable(input: ToolExecutionAssertInput): void {
    const context = {
      role: input.identity.modelRole,
      modelId: input.identity.modelId,
      solverId: input.identity.solverId,
      specialistId: input.identity.specialistId,
      isOrchestrator: input.identity.isOrchestrator,
      isWorkflow: input.identity.isWorkflow,
      isOneShot: input.identity.isOneShot,
    }

    if (!this.policy.isToolVisible(input.tool.name, context)) {
      throw new Error(
        `ToolExecutionDenied: Tool '${input.tool.name}' is hidden or denied for identity role='${input.identity.modelRole}' solver='${input.identity.solverId ?? 'none'}'. Execution blocked.`,
      )
    }
  }
}
