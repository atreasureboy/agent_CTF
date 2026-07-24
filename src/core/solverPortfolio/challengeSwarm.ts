import type { CrossSolverEvidenceBus } from './crossSolverEvidenceBus.js'
import { FlagDiscriminator } from './flagDiscriminator.js'
import type { ExternalSolverAdapter, SolverRunHandle } from './solverAdapter.js'
import type { ExternalSolverResult, SolverChallengeInput } from './solverTypes.js'
import { StagnationDetector } from './stagnationDetector.js'
import { StagnationSignalCollector } from './stagnationCollector.js'
import type { CTFTaskState } from '../ctfRuntime/taskState.js'

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
    taskState?: Readonly<CTFTaskState>,
  ): Promise<{ winnerResult?: ExternalSolverResult; allResults: ExternalSolverResult[] }> {
    const allResults: ExternalSolverResult[] = []
    const pendingSolverIds = [...this.policy.initialSolverIds]
    const activePromises = new Map<string, Promise<{ handle: SolverRunHandle; result: ExternalSolverResult }>>()
    let totalStarted = 0
    let winnerResult: ExternalSolverResult | undefined

    if (input.signal) {
      input.signal.addEventListener('abort', () => {
        void this.cancelAllActive('Task abort signal fired')
      }, { once: true })
    }

    const launchSolver = async (sId: string) => {
      const adapter = this.adapters.get(sId)
      if (!adapter) return null
      const handle = await adapter.start(input)
      this.activeHandles.set(handle.runId, handle)
      totalStarted++
      const resPromise = handle.wait().then((result) => {
        this.activeHandles.delete(handle.runId)
        return { handle, result }
      })
      activePromises.set(handle.runId, resPromise)
      return handle.runId
    }

    // Launch initial batch up to maxConcurrentSolvers in parallel
    while (pendingSolverIds.length > 0 && activePromises.size < this.policy.maxConcurrentSolvers && totalStarted < this.policy.maxTotalSolvers) {
      const nextId = pendingSolverIds.shift()!
      await launchSolver(nextId)
    }

    while (activePromises.size > 0) {
      const finished = await Promise.race(Array.from(activePromises.values()))
      activePromises.delete(finished.handle.runId)
      allResults.push(finished.result)

      // Publish evidence/observations to evidence bus
      for (const obs of finished.result.observations) {
        this.evidenceBus.publish({
          id: `msg_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
          taskId: input.taskId,
          sourceSolverRunId: finished.handle.runId,
          evidenceIds: [],
          observationIds: [],
          artifactIds: [],
          summary: obs.summary,
          priority: 'normal',
          createdAt: Date.now(),
        })
      }

      // Check flag candidates
      if (finished.result.flagCandidates && finished.result.flagCandidates.length > 0) {
        for (const cand of finished.result.flagCandidates) {
          const disc = FlagDiscriminator.discriminate({ candidateValue: cand.value })
          // ONLY locally_validated or platform_accepted cancels other solvers
          if (disc.status === 'locally_validated' || disc.status === 'platform_accepted') {
            winnerResult = finished.result
            if (this.policy.cancelLosersOnValidatedCandidate) {
              await this.cancelAllActive('Validated flag candidate found by winner solver.')
            }
            return { winnerResult, allResults }
          }
        }
      }

      // Check for stagnation escalation
      if (
        this.policy.stagnationEscalation &&
        taskState &&
        totalStarted < this.policy.maxTotalSolvers
      ) {
        const signals = StagnationSignalCollector.collect({
          state: taskState,
          solverRunId: finished.handle.runId,
        })
        const decision = StagnationDetector.evaluate(signals)

        if (decision.action === 'switch_model' || decision.action === 'spawn_branch') {
          for (const escId of this.policy.escalationSolverIds) {
            if (totalStarted < this.policy.maxTotalSolvers && !activePromises.has(escId)) {
              await launchSolver(escId)
            }
          }
        }
      }

      // Backfill pending solvers if concurrency permits
      while (pendingSolverIds.length > 0 && activePromises.size < this.policy.maxConcurrentSolvers && totalStarted < this.policy.maxTotalSolvers) {
        const nextId = pendingSolverIds.shift()!
        await launchSolver(nextId)
      }
    }

    return { winnerResult, allResults }
  }

  public async cancelAllActive(reason: string): Promise<void> {
    const handles = Array.from(this.activeHandles.values())
    this.activeHandles.clear()
    for (const handle of handles) {
      try {
        await handle.cancel(reason)
      } catch {
        /* best-effort */
      }
    }
  }
}
