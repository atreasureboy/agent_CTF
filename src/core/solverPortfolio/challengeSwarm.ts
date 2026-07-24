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
  private evidenceBus?: CrossSolverEvidenceBus

  constructor(evidenceBus?: CrossSolverEvidenceBus, policy: Partial<ChallengeSwarmPolicy> = {}) {
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
    const activePromises = new Map<
      string,
      Promise<{ handle: SolverRunHandle; result: ExternalSolverResult }>
    >()
    let totalStarted = 0
    let winnerResult: ExternalSolverResult | undefined

    if (input.signal) {
      input.signal.addEventListener(
        'abort',
        () => {
          void this.cancelAllActive('Task abort signal fired')
        },
        { once: true },
      )
    }

    const launchSolver = async (sId: string) => {
      const adapter = this.adapters.get(sId)
      if (!adapter) return null
      const handle = await adapter.start(input)
      this.activeHandles.set(handle.runId, handle)
      totalStarted++

      // Start consuming live events if available
      if (handle.events) {
        ;(async () => {
          try {
            for await (const event of handle.events!()) {
              if (event.type === 'tool_call_completed' && event.evidenceIds?.length) {
                this.evidenceBus?.publish({
                  id: `msg_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
                  taskId: input.taskId,
                  sourceSolverRunId: handle.runId,
                  evidenceIds: event.evidenceIds,
                  observationIds: event.observationIds || [],
                  artifactIds: event.artifactIds || [],
                  summary: `Live event from ${handle.solverId}`,
                  priority: 'normal',
                  createdAt: Date.now(),
                })
              }
            }
          } catch {
            // ignore stream consumption errors
          }
        })()
      }

      const resPromise = handle.wait().then((result) => {
        this.activeHandles.delete(handle.runId)
        return { handle, result }
      })
      activePromises.set(handle.runId, resPromise)
      return handle.runId
    }

    while (
      pendingSolverIds.length > 0 &&
      activePromises.size < this.policy.maxConcurrentSolvers &&
      totalStarted < this.policy.maxTotalSolvers
    ) {
      const nextId = pendingSolverIds.shift()!
      await launchSolver(nextId)
    }

    while (activePromises.size > 0) {
      const finished = await Promise.race(Array.from(activePromises.values()))
      activePromises.delete(finished.handle.runId)
      allResults.push(finished.result)

      // Publish Grounded evidence with formal IDs
      for (const obs of finished.result.observations) {
        const formalObsId = `obs_${finished.handle.runId}_${Date.now()}`
        this.evidenceBus?.publish({
          id: `msg_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
          taskId: input.taskId,
          sourceSolverRunId: finished.handle.runId,
          evidenceIds: [],
          observationIds: [formalObsId],
          artifactIds: [],
          summary: obs.summary,
          priority: 'normal',
          createdAt: Date.now(),
        })
      }

      // Check flag candidates using FlagDiscriminator
      if (finished.result.flagCandidates && finished.result.flagCandidates.length > 0) {
        for (const cand of finished.result.flagCandidates) {
          const disc = FlagDiscriminator.discriminate({
            taskId: input.taskId,
            candidateValue: cand.value,
          })
          if (
            disc.canCancelOtherSolvers ||
            disc.status === 'locally_validated' ||
            disc.status === 'platform_accepted'
          ) {
            winnerResult = finished.result
            if (this.policy.cancelLosersOnValidatedCandidate) {
              await this.cancelAllActive('Validated flag candidate found by winner solver.')
            }
            return { winnerResult, allResults }
          }
        }
      }

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

      while (
        pendingSolverIds.length > 0 &&
        activePromises.size < this.policy.maxConcurrentSolvers &&
        totalStarted < this.policy.maxTotalSolvers
      ) {
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
