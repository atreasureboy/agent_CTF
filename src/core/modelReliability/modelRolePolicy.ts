import { ModelRole } from './modelCapability.js'

export interface BannedActionCheckResult {
  allowed: boolean
  reason?: string
}

export class ModelRolePolicy {
  /**
   * Enforces non-bypassable code checks for auxiliary/low-cost models like M3.
   */
  public static validateRolePermission(
    modelId: string,
    role: ModelRole,
    actionType: string,
  ): BannedActionCheckResult {
    const isAuxiliaryModel =
      modelId.includes('m3') ||
      modelId.includes('mini') ||
      modelId.includes('small') ||
      modelId.includes('scout')

    if (!isAuxiliaryModel) {
      return { allowed: true }
    }

    // Strict forbidden action types for auxiliary / M3 models
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
