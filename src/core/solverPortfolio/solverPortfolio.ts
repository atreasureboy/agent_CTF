import type { ExternalSolverAdapter } from './solverAdapter.js'
import type { ExternalSolverResult, SolverChallengeInput } from './solverTypes.js'
import type { ProductionTruthfulnessGuard } from '../runtimeGuard/productionTruthfulnessGuard.js'
import type { CTFTaskStateStore } from '../ctfRuntime/taskStateStore.js'

export interface SolverPortfolioDependencies {
  stateStore: CTFTaskStateStore
  /**
   * ContextCompiler implementation specific to the caller's adapter contract.
   * Typed as `unknown` here — adapters cast or validate per their own type.
   * Was previously `any` which propagated untyped access through creation sites.
   */
  contextCompiler?: unknown
  resultNormalizer?: unknown
  trajectoryRecorder?: unknown
  truthfulnessGuard?: ProductionTruthfulnessGuard
  adapters?: ExternalSolverAdapter[]
}

export class SolverPortfolio {
  private adapters = new Map<string, ExternalSolverAdapter>()

  constructor(private readonly deps: SolverPortfolioDependencies) {
    if (!deps || !deps.stateStore) {
      throw new Error('SolverPortfolio missing required dependencies (stateStore, etc.)')
    }
    if (deps.adapters) {
      for (const adapter of deps.adapters) {
        this.registerAdapter(adapter)
      }
    }
  }

  public registerAdapter(adapter: ExternalSolverAdapter): void {
    this.adapters.set(adapter.id, adapter)
  }

  public getAdapter(id: string): ExternalSolverAdapter | undefined {
    return this.adapters.get(id)
  }

  public listAdapters(): ExternalSolverAdapter[] {
    return Array.from(this.adapters.values())
  }

  public async executeSolver(
    solverId: string,
    input: SolverChallengeInput,
  ): Promise<ExternalSolverResult> {
    const adapter = this.adapters.get(solverId)
    if (!adapter) {
      // §11 F11 — surface the missing-adapter error into the state store so
      // audit trails show why no `solverRuns` entry was created. The previous
      // implementation threw out of executeSolver without dispatching any
      // SOLVER_RUN_* events, so state.solverRuns stayed empty and operators
      // had to dig through stderr logs. We dispatch the full QUEUED+STARTED
      // + FAILED triplet so the audit trail is the same shape as a real run.
      const now = Date.now()
      const runId = `solver_synth_${now.toString(36)}_${Math.random().toString(36).slice(2, 6)}`
      const reason = `solver adapter '${solverId}' not registered`
      try {
        this.deps.stateStore.apply({
          type: 'SOLVER_RUN_QUEUED',
          run: {
            id: runId,
            taskId: '',
            solverId,
            solverType: 'native',
            status: 'queued',
            queuedAt: now,
          },
        })
        this.deps.stateStore.apply({
          type: 'SOLVER_RUN_STARTED',
          runId,
          startedAt: now,
        })
        this.deps.stateStore.apply({
          type: 'SOLVER_RUN_FAILED',
          runId,
          completedAt: now,
          error: reason,
        })
      } catch {
        /* best-effort; don't double-throw */
      }
      throw new Error(reason + ' in SolverPortfolio.')
    }
    try {
      const handle = await adapter.start(input)
      return await handle.wait()
    } catch (err) {
      // Wrap the failure into the state store as well. We don't know what
      // shape the adapter used to identify the run; supply a synthetic id
      // and let the reducer tolerate an unknown id (or the projector
      // matchRunPath filter — both store paths are idempotent).
      try {
        this.deps.stateStore.apply({
          type: 'SOLVER_RUN_FAILED',
          runId: `solver_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
          completedAt: Date.now(),
          error: err instanceof Error ? err.message : String(err),
        })
      } catch {
        /* best-effort */
      }
      throw err
    }
  }
}
