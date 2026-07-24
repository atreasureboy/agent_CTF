import { ExternalSolverResult } from './solverTypes.js'

export interface NormalizedResult {
  runId: string
  solverId: string
  validObservations: Array<{ summary: string; confidence: number; sourcePath?: string }>
  validCandidates: Array<{ value: string; sourcePath?: string }>
  status: string
  sanitizedSummary: string
}

export class SolverResultNormalizer {
  public static normalize(raw: ExternalSolverResult): NormalizedResult {
    const validObservations = raw.observations
      .filter((o) => o.summary && o.summary.trim().length > 0)
      .map((o) => ({
        summary: o.summary.trim(),
        confidence: Math.min(Math.max(o.confidence || 0.5, 0), 1),
        sourcePath: o.sourcePath,
      }))

    const validCandidates = raw.flagCandidates
      .filter((c) => c.value && c.value.trim().length > 0)
      .map((c) => ({
        value: c.value.trim(),
        sourcePath: c.sourcePath,
      }))

    return {
      runId: raw.runId,
      solverId: raw.solverId,
      validObservations,
      validCandidates,
      status: raw.status,
      sanitizedSummary: raw.summary ? raw.summary.substring(0, 500) : 'Solver run completed',
    }
  }
}
