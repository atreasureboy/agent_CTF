export interface StagnationSignals {
  cyclesWithoutNewEvidence: number
  millisecondsWithoutNewEvidence: number
  repeatedAttemptFingerprints: number
  repeatedActionFamilies: number
  consecutiveToolFailures: number
  contextCompactions: number
  hypothesisProgressDelta: number
  budgetExceeded?: boolean
}

export type StagnationDecision =
  | { action: 'continue' }
  | { action: 'nudge'; reason: string }
  | { action: 'switch_model'; targetModelId?: string; reason: string }
  | { action: 'spawn_branch'; reason: string }
  | { action: 'pause'; reason: string }

export class StagnationDetector {
  public static evaluate(signals: StagnationSignals): StagnationDecision {
    if (signals.budgetExceeded) {
      return {
        action: 'pause',
        reason: 'Reasoning budget or cost limit exceeded for this challenge run.',
      }
    }

    if (signals.repeatedAttemptFingerprints >= 5 || signals.repeatedActionFamilies >= 5) {
      return {
        action: 'spawn_branch',
        reason: `Attempt fingerprint repeated ${signals.repeatedAttemptFingerprints} times. Halting loop and spawning new branch hypothesis.`,
      }
    }

    if (signals.repeatedAttemptFingerprints >= 3 || signals.repeatedActionFamilies >= 3) {
      return {
        action: 'nudge',
        reason: `Attempt fingerprint repeated ${signals.repeatedAttemptFingerprints} times. Nudging solver with do_not_repeat guidance.`,
      }
    }

    if (signals.cyclesWithoutNewEvidence >= 4 || signals.consecutiveToolFailures >= 3) {
      return {
        action: 'switch_model',
        targetModelId: 'high-tier-model',
        reason: `Solver stagnated for ${signals.cyclesWithoutNewEvidence} cycles without new evidence. Escalating model.`,
      }
    }

    return { action: 'continue' }
  }
}
