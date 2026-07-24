import type { CTFTaskState } from '../ctfRuntime/taskState.js'
import type { StagnationSignals } from './stagnationDetector.js'

export class StagnationSignalCollector {
  public static collect(input: {
    state: Readonly<CTFTaskState>
    solverRunId?: string
    startTime?: number
  }): StagnationSignals {
    const { state, solverRunId, startTime } = input
    const now = Date.now()
    const runStart = startTime ?? (solverRunId ? state.solverRuns.find((r) => r.id === solverRunId)?.startedAt : undefined) ?? now

    let latestEvidenceAt = runStart
    for (const ev of state.evidence) {
      if (ev.createdAt > latestEvidenceAt) {
        latestEvidenceAt = ev.createdAt
      }
    }

    const millisecondsWithoutNewEvidence = Math.max(0, now - latestEvidenceAt)

    const attemptsSinceStart = state.attempts.filter((a) => a.createdAt >= runStart)
    const cyclesWithoutNewEvidence = attemptsSinceStart.filter((a) => (a.startedAt ?? a.createdAt) > latestEvidenceAt).length

    const fingerprintCounts = new Map<string, number>()
    let maxRepeatedFingerprints = 0
    let consecutiveFailures = 0

    for (const a of attemptsSinceStart) {
      if (a.fingerprint) {
        const cnt = (fingerprintCounts.get(a.fingerprint) ?? 0) + 1
        fingerprintCounts.set(a.fingerprint, cnt)
        if (cnt > maxRepeatedFingerprints) maxRepeatedFingerprints = cnt
      }

      if (a.status === 'failed') {
        consecutiveFailures++
      } else if (a.status === 'succeeded') {
        consecutiveFailures = 0
      }
    }

    const budgetExceeded =
      state.reasoningBudget && state.reasoningBudgetLimits
        ? state.reasoningBudget.estimatedCostUnitsUsed >= state.reasoningBudgetLimits.maxEstimatedCostUnits
        : false

    return {
      cyclesWithoutNewEvidence,
      millisecondsWithoutNewEvidence,
      repeatedAttemptFingerprints: maxRepeatedFingerprints,
      repeatedActionFamilies: maxRepeatedFingerprints,
      consecutiveToolFailures: consecutiveFailures,
      contextCompactions: 0,
      hypothesisProgressDelta: state.hypotheses.filter((h) => h.updatedAt >= runStart).length,
      budgetExceeded,
    }
  }
}
