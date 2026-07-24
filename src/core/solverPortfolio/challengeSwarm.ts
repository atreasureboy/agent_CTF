import { CrossSolverEvidenceBus } from './crossSolverEvidenceBus.js'
import { FlagDiscriminator } from './flagDiscriminator.js'
import { ExternalSolverAdapter, SolverRunHandle } from './solverAdapter.js'
import { ExternalSolverResult, SolverChallengeInput, SolverRunRecord } from './solverTypes.js'
import { StagnationDetector } from './stagnationDetector.js'

export interface ChallengeSwarmPolicy {
  maxConcurrentSolvers: number
  maxTotalSolvers: number
  initialSolverIds: string[]
  escalationSolverIds: string[]
  cancelLosersOnValidatedCandidate: boolean
  requireFlagValidation: boolean
  stagnationEscalation: boolean
}

export const DEFAULT_SWARM_POLICY: ChallengeSwarmPolicy = {
  maxConcurrentSolvers: 3,
  maxTotalSolvers: 6,
  initialSolverIds: ['native-ctf-solver'],
  escalationSolverIds: ['generic-process-solver'],
  cancelLosersOnValidatedCandidate: true,
  requireFlagValidation: true,
  stagnationEscalation: true,
}

export class ChallengeSwarm {
  private policy: ChallengeSwarmPolicy
  private adapters = new Map<string, ExternalSolverAdapter>()
  private activeHandles = new Map<string, SolverRunHandle>()
  private evidenceBus: CrossSolverEvidenceBus

  constructor(
    evidenceBus: CrossSolverEvidenceBus,
    policy: Partial<ChallengeSwarmPolicy> = {},
  ) {
    this.evidenceBus = evidenceBus
    this.policy = { ...DEFAULT_SWARM_POLICY, ...policy }
  }

  public registerAdapter(adapter: ExternalSolverAdapter): void {
    this.adapters.set(adapter.id, adapter)
  }

  public async runSwarm(
    input: SolverChallengeInput,
  ): Promise<{ winnerResult?: ExternalSolverResult; allResults: ExternalSolverResult[] }> {
    const results: ExternalSolverResult[] = []

    // Phase 1: Start initial scout / native solver
    for (const sId of this.policy.initialSolverIds) {
      const adapter = this.adapters.get(sId)
      if (!adapter) continue

      const handle = await adapter.start(input)
      this.activeHandles.set(handle.runId, handle)

      const res = await handle.wait()
      results.push(res)

      // Publish any new evidence/observations to bus
      for (const obs of res.observations) {
        this.evidenceBus.publish({
          id: `msg_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
          taskId: input.taskId,
          sourceSolverRunId: handle.runId,
          evidenceIds: [],
          observationIds: [],
          artifactIds: [],
          summary: obs.summary,
          priority: 'normal',
          createdAt: Date.now(),
        })
      }

      // Check candidate validation
      if (res.flagCandidates.length > 0) {
        for (const cand of res.flagCandidates) {
          const disc = FlagDiscriminator.discriminate({ candidateValue: cand.value })
          if (disc.valid) {
            if (this.policy.cancelLosersOnValidatedCandidate) {
              await this.cancelAllActive('Validated flag candidate found by winner solver.')
            }
            return { winnerResult: res, allResults: results }
          }
        }
      }

      // Check for stagnation escalation
      if (this.policy.stagnationEscalation && res.status === 'completed' && res.observations.length === 0) {
        const stagDecision = StagnationDetector.evaluate({
          cyclesWithoutNewEvidence: 4,
          millisecondsWithoutNewEvidence: 10000,
          repeatedAttemptFingerprints: 0,
          repeatedActionFamilies: 0,
          consecutiveToolFailures: 0,
          contextCompactions: 0,
          hypothesisProgressDelta: 0,
        })

        if (stagDecision.action === 'switch_model' || stagDecision.action === 'spawn_branch') {
          // Escalate to next stage solver in policy
          for (const escId of this.policy.escalationSolverIds) {
            const escAdapter = this.adapters.get(escId)
            if (!escAdapter) continue
            const escHandle = await escAdapter.start(input)
            const escRes = await escHandle.wait()
            results.push(escRes)
          }
        }
      }
    }

    return { allResults: results }
  }

  public async cancelAllActive(reason: string): Promise<void> {
    for (const [runId, handle] of this.activeHandles.entries()) {
      await handle.cancel(reason)
    }
    this.activeHandles.clear()
  }
}
