export interface ProductionTruthfulnessGuard {
  assertRealModelInvocation(input: { providerId: string; modelId: string; runtimeMode?: string }): void
  assertRealSolverExecution(input: { solverId: string; hasDelegate: boolean; runtimeMode?: string }): void
  assertGroundedKnowledge(input: { evidenceIds?: string[]; observationIds?: string[]; artifactIds?: string[] }): void
  assertValidCompletion(input: { status: string; hasEvents: boolean; runtimeMode?: string }): void
}

export class DefaultProductionTruthfulnessGuard implements ProductionTruthfulnessGuard {
  public assertRealModelInvocation(input: {
    providerId: string
    modelId: string
    runtimeMode?: string
  }): void {
    if (input.runtimeMode !== 'test') {
      if (input.providerId.includes('mock') || input.providerId.includes('fake')) {
        throw new Error(
          `ProductionTruthfulnessViolation: Mock Provider '${input.providerId}' is forbidden in production mode.`,
        )
      }
    }
  }

  public assertRealSolverExecution(input: {
    solverId: string
    hasDelegate: boolean
    runtimeMode?: string
  }): void {
    if (!input.hasDelegate && input.runtimeMode !== 'test') {
      throw new Error(
        `ProductionTruthfulnessViolation: Solver '${input.solverId}' has no execution delegate in production.`,
      )
    }
  }

  public assertGroundedKnowledge(input: {
    evidenceIds?: string[]
    observationIds?: string[]
    artifactIds?: string[]
  }): void {
    const hasGroundedId =
      (input.evidenceIds && input.evidenceIds.length > 0) ||
      (input.observationIds && input.observationIds.length > 0) ||
      (input.artifactIds && input.artifactIds.length > 0)

    if (!hasGroundedId) {
      throw new Error(
        'ProductionTruthfulnessViolation: Cross-solver knowledge broadcast requires at least one formal state ID.',
      )
    }
  }

  public assertValidCompletion(input: {
    status: string
    hasEvents: boolean
    runtimeMode?: string
  }): void {
    if (input.status === 'completed' && !input.hasEvents && input.runtimeMode !== 'test') {
      throw new Error(
        'ProductionTruthfulnessViolation: Solver run declared completed without emitting start/progress events.',
      )
    }
  }
}
