import type { ModelCapabilityProfile } from '../modelReliability/modelCapability.js'
import type { SolverRunRecord, ExternalSolverResult } from '../solverPortfolio/solverTypes.js'
import type { SolverKnowledgeMessage } from '../solverPortfolio/crossSolverKnowledgeView.js'

export type RuntimeMode = 'production' | 'test'

export interface ProductionTruthfulnessGuardOptions {
  mode?: RuntimeMode
}

export class ProductionTruthfulnessGuardError extends Error {
  constructor(message: string) {
    super(`[ProductionTruthfulnessGuard] ${message}`)
    this.name = 'ProductionTruthfulnessGuardError'
  }
}

export class DefaultProductionTruthfulnessGuard {
  private mode: RuntimeMode

  constructor(options?: ProductionTruthfulnessGuardOptions) {
    // Enforcement: Must be explicitly passed or default to 'production'. NODE_ENV guessing is prohibited.
    this.mode = options?.mode ?? 'production'
  }

  public getMode(): RuntimeMode {
    return this.mode
  }

  public isProduction(): boolean {
    return this.mode === 'production'
  }

  public assertRealModelInvocation(input: {
    providerId: string
    modelProfile: ModelCapabilityProfile
    streamCompleted: boolean
    hasTokenOutput: boolean
  }): void {
    if (!this.isProduction()) return

    if (input.providerId.includes('mock') || input.providerId.includes('fake')) {
      throw new ProductionTruthfulnessGuardError(
        `Mock/Fake provider '${input.providerId}' is prohibited in production mode.`,
      )
    }

    if (
      input.modelProfile.id === 'high-tier-model' ||
      input.modelProfile.id === 'm3-low-cost-tier' ||
      input.modelProfile.id === 'm3-mini'
    ) {
      throw new ProductionTruthfulnessGuardError(
        `Placeholder model profile '${input.modelProfile.id}' is prohibited in production mode.`,
      )
    }

    if (input.modelProfile.providerId && input.modelProfile.providerId !== input.providerId) {
      throw new ProductionTruthfulnessGuardError(
        `Model profile '${input.modelProfile.id}' requires provider '${input.modelProfile.providerId}', but got '${input.providerId}'.`,
      )
    }

    if (!input.streamCompleted) {
      throw new ProductionTruthfulnessGuardError(
        `Model turn stream did not reach EOF. Stream success cannot be recorded.`,
      )
    }
  }

  public assertRealSolverExecution(input: {
    solverId: string
    hasDelegate: boolean
    runRecord?: SolverRunRecord
    result?: ExternalSolverResult
  }): void {
    if (!this.isProduction()) return

    if (!input.hasDelegate && input.solverId.toLowerCase().includes('native')) {
      throw new ProductionTruthfulnessGuardError(
        `Native solver '${input.solverId}' executed without a configured delegate.`,
      )
    }

    if (input.result?.status === 'completed') {
      if (!input.runRecord || input.runRecord.status !== 'running') {
        if (!input.runRecord?.startedAt) {
          throw new ProductionTruthfulnessGuardError(
            `Solver '${input.solverId}' reported completed status without a valid started run record.`,
          )
        }
      }

      if (
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        (input.result as any).isSynthetic ||
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        (input.result as any).mock ||
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        (input.result as any).simulated
      ) {
        throw new ProductionTruthfulnessGuardError(
          `Synthetic solver result is prohibited in production mode.`,
        )
      }
    }
  }

  public assertGroundedKnowledge(msg: SolverKnowledgeMessage): void {
    if (!this.isProduction()) return

    const hasGroundedId =
      (msg.evidenceIds && msg.evidenceIds.length > 0) ||
      (msg.observationIds && msg.observationIds.length > 0) ||
      (msg.artifactIds && msg.artifactIds.length > 0) ||
      (msg.candidateIds && msg.candidateIds.length > 0)

    if (!hasGroundedId) {
      throw new ProductionTruthfulnessGuardError(
        `Cross-solver knowledge message '${msg.id}' lacks grounded state IDs.`,
      )
    }
  }

  public assertValidFlagStatus(status: string): void {
    if (!this.isProduction()) return

    if (status === 'simulated_accepted') {
      throw new ProductionTruthfulnessGuardError(
        `Flag status 'simulated_accepted' cannot be treated as accepted in production mode.`,
      )
    }
  }

  public assertValidArtifactPath(path: string, artifactId: string): void {
    if (!this.isProduction()) return

    if (path === artifactId || path === `/artifacts/${artifactId}`) {
      throw new ProductionTruthfulnessGuardError(
        `Artifact ID '${artifactId}' or synthetic path '${path}' cannot be used as an authorized file path.`,
      )
    }
  }

  public assertValidMaterializedResult(result: { success: boolean; evidenceAdded?: any[] }): void {
    if (!this.isProduction()) return

    if (result.success && (!result.evidenceAdded || result.evidenceAdded.length === 0)) {
      // Empty materialized result claiming success
      throw new ProductionTruthfulnessGuardError(
        `Materialized result claimed success without adding any evidence or observations.`,
      )
    }
  }
}

export { DefaultProductionTruthfulnessGuard as ProductionTruthfulnessGuard }
