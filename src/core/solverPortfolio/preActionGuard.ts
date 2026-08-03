import type { CTFTaskState } from '../ctfRuntime/taskState.js'

export interface SuggestedAction {
  toolId: string
  target?: string
  inputArtifactIds?: string[]
  params?: Record<string, any>
  intention?: string
  encodingBranch?: string
  stegoChannel?: string
  cveId?: string
  exploitPrimitive?: string
  webRoute?: string
}

export type RepetitionDecision =
  | { allowed: true }
  | {
      allowed: false
      reason: string
      priorAttemptIds: string[]
      requiredDirectionChange: true
    }

export interface SolverPreActionGuard {
  inspect(input: {
    taskId: string
    solverRunId: string
    action: SuggestedAction
    fingerprint: string
    taskState: Readonly<CTFTaskState>
  }): RepetitionDecision
}

export class DefaultSolverPreActionGuard implements SolverPreActionGuard {
  public inspect(input: {
    taskId: string
    solverRunId: string
    action: SuggestedAction
    fingerprint: string
    taskState: Readonly<CTFTaskState>
  }): RepetitionDecision {
    const attempts = input.taskState?.attempts || []
    const priorMatch = attempts.filter((att) => {
      if (att.fingerprint && att.fingerprint === input.fingerprint) return true
      if (att.targetId && input.action.target && att.targetId === input.action.target) {
        return true
      }
      return false
    })

    if (priorMatch.length > 0) {
      return {
        allowed: false,
        reason: `Repetition guard blocked action: Technical route repetition for fingerprint '${input.fingerprint}' (tool: ${input.action.toolId}, target: ${input.action.target}) already attempted ${priorMatch.length} time(s).`,
        priorAttemptIds: priorMatch.map((a) => a.id),
        requiredDirectionChange: true,
      }
    }

    return { allowed: true }
  }
}
