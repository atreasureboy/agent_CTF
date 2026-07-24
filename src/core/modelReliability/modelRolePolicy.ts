import type { ModelCapabilityProfile, ModelRole, ModelTrustLevel } from './modelCapability.js'

export interface BannedActionCheckResult {
  allowed: boolean
  reason?: string
}

export interface ModelRoleResolverInput {
  capabilityProfileId: string
  agentKind:
    'orchestrator' | 'main-agent' | 'specialist' | 'solver' | 'summarizer' | 'flag-discriminator'

  workflowId?: string
  specialistId?: string
}

export interface ModelRoleResolver {
  resolve(input: ModelRoleResolverInput): ModelRole
}

export class DefaultModelRoleResolver implements ModelRoleResolver {
  public resolve(input: ModelRoleResolverInput): ModelRole {
    switch (input.agentKind) {
      case 'orchestrator':
        return 'task_planner'
      case 'main-agent':
        return 'deep_solver'
      case 'solver':
        return 'solver_scout'
      case 'summarizer':
        return 'progress_summarizer'
      case 'specialist':
        return 'specialist'
      case 'flag-discriminator':
        return 'flag_discriminator'
      default:
        return 'deep_solver'
    }
  }
}

export class ModelRolePolicy {
  /**
   * Enforces non-bypassable code checks based on trust level or profile capability.
   */
  public static validateRolePermission(
    modelOrTrust: string | ModelCapabilityProfile | ModelTrustLevel,
    role: ModelRole,
    actionType: string,
  ): BannedActionCheckResult {
    let trustLevel: ModelTrustLevel = 'standard'
    let modelId = 'model'

    if (typeof modelOrTrust === 'string') {
      modelId = modelOrTrust
      if (
        modelOrTrust === 'auxiliary' ||
        modelOrTrust === 'standard' ||
        modelOrTrust === 'privileged'
      ) {
        trustLevel = modelOrTrust
      } else if (
        modelOrTrust.toLowerCase().includes('m3') ||
        modelOrTrust.toLowerCase().includes('mini') ||
        modelOrTrust.toLowerCase().includes('small') ||
        modelOrTrust.toLowerCase().includes('scout')
      ) {
        trustLevel = 'auxiliary'
      } else {
        trustLevel = 'standard'
      }
    } else if (modelOrTrust && typeof modelOrTrust === 'object') {
      modelId = modelOrTrust.id
      trustLevel = modelOrTrust.trustLevel || modelOrTrust.reliabilityClass || 'standard'
    }

    const isAuxiliaryModel = trustLevel === 'auxiliary'

    if (!isAuxiliaryModel) {
      return { allowed: true }
    }

    // Strict forbidden action types for auxiliary models
    const BANNED_ACTION_TYPES = [
      'expand_scope',
      'modify_security_policy',
      'approve_expensive',
      'announce_solved',
      'validate_final_flag',
      'submit_flag',
      'terminate_solver',
      'modify_competition_priority',
      'override_evidence',
      'delete_attempt',
      'direct_write_state',
    ]

    if (BANNED_ACTION_TYPES.includes(actionType.toLowerCase())) {
      return {
        allowed: false,
        reason: `Auxiliary model '${modelId}' with role '${role}' is prohibited from executing action '${actionType}'.`,
      }
    }

    // Role-specific check
    if (role === 'solver_scout' || role === 'progress_summarizer') {
      if (actionType === 'deep_exploit' || actionType === 'execute_pwn') {
        return {
          allowed: false,
          reason: `Role '${role}' is restricted to passive scouting/summary. Escalation required for deep exploit.`,
        }
      }
    }

    return { allowed: true }
  }

  public static isRoleAllowedForModel(
    modelAllowedRoles: ModelRole[],
    targetRole: ModelRole,
  ): boolean {
    return modelAllowedRoles.includes(targetRole)
  }
}
