import { ExternalSolverAdapter } from './solverAdapter.js'
import { ExternalSolverResult, SolverChallengeInput } from './solverTypes.js'

export interface SolverPortfolioDependencies {
  stateStore?: any
  contextCompiler?: any
  resultNormalizer?: any
  trajectoryRecorder?: any
  adapters?: ExternalSolverAdapter[]
}

export class SolverPortfolio {
  private adapters = new Map<string, ExternalSolverAdapter>()

  constructor(deps?: SolverPortfolioDependencies) {
    if (deps?.adapters) {
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
      throw new Error(`Solver adapter '${solverId}' not registered in SolverPortfolio.`)
    }
    const handle = await adapter.start(input)
    return handle.wait()
  }
}
