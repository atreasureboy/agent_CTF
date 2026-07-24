import type { CTFTaskState } from '../ctfRuntime/taskState.js'

export interface RepetitionGuardInput {
  solverRunId: string
  action: {
    type: string
    toolId?: string
    targetPath?: string
    params?: Record<string, any>
  }
  attemptFingerprint: string
  taskState: Readonly<CTFTaskState>
}

export type RepetitionDecision =
  | { allowed: true }
  | {
      allowed: false
      reason: string
      priorAttemptIds: string[]
      requiredDirectionChange: true
    }

export interface RepetitionGuard {
  inspect(input: RepetitionGuardInput): RepetitionDecision
}

export class DefaultRepetitionGuard implements RepetitionGuard {
  public inspect(input: RepetitionGuardInput): RepetitionDecision {
    const { action, attemptFingerprint, taskState } = input

    // Check exact fingerprint repetition
    const priorAttempts = taskState.attempts.filter(
      (a) => a.fingerprint === attemptFingerprint && a.status === 'failed',
    )

    if (priorAttempts.length >= 2) {
      return {
        allowed: false,
        reason: `RepetitionGuard blocked action: Attempt fingerprint '${attemptFingerprint}' has already failed ${priorAttempts.length} times.`,
        priorAttemptIds: priorAttempts.map((a) => a.id),
        requiredDirectionChange: true,
      }
    }

    // Check action family / target repetition
    if (action.toolId && action.targetPath) {
      const sameToolSameTargetFailures = taskState.attempts.filter((a) => {
        if (a.status !== 'failed') return false
        return (
          a.kind === action.toolId &&
          a.targetId === action.targetPath &&
          a.fingerprint === attemptFingerprint
        )
      })

      if (sameToolSameTargetFailures.length >= 3) {
        return {
          allowed: false,
          reason: `RepetitionGuard blocked action: Tool '${action.toolId}' on target '${action.targetPath}' failed ${sameToolSameTargetFailures.length} times.`,
          priorAttemptIds: sameToolSameTargetFailures.map((a) => a.id),
          requiredDirectionChange: true,
        }
      }
    }

    return { allowed: true }
  }
}
