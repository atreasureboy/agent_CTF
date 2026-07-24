import { CrossSolverEvidenceBus } from './crossSolverEvidenceBus.js'

import { GenericProcessSolverAdapter } from './genericProcessSolverAdapter.js'

import { NativeSolverAdapter } from './nativeSolverAdapter.js'
import { ExternalSolverAdapter } from './solverAdapter.js'
import { ExternalSolverResult, SolverChallengeInput } from './solverTypes.js'

export class SolverPortfolio {
  private adapters = new Map<string, ExternalSolverAdapter>()
  public readonly evidenceBus: CrossSolverEvidenceBus

  constructor() {
    this.evidenceBus = new CrossSolverEvidenceBus()
    this.registerDefaultAdapters()
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

  private registerDefaultAdapters(): void {
    this.registerAdapter(new NativeSolverAdapter())
    this.registerAdapter(
      new GenericProcessSolverAdapter('generic-process-solver', {
        executablePath: 'node',
        args: ['-e', 'console.log(JSON.stringify({type:"observation",summary:"Generic mock solver output",confidence:0.85}))'],
      }),
    )
  }
}
