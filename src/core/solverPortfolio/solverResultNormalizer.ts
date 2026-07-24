import type { ExternalSolverResult } from './solverTypes.js'
import type { FlagCandidate } from '../ctfRuntime/taskState.js'

export interface NormalizedResult {
  runId: string
  solverId: string
  validObservations: Array<{ summary: string; confidence: number; sourcePath?: string }>
  validCandidates: FlagCandidate[]
  status: string
  sanitizedSummary: string
  rawOutputArtifactPath?: string
}

export class SolverResultNormalizer {
  public static normalize(raw: ExternalSolverResult, taskId?: string): NormalizedResult {
    const validObservations = (raw.observations || [])
      .filter((o) => o.summary && o.summary.trim().length > 0)
      .slice(0, 50)
      .map((o) => ({
        summary: o.summary.trim().slice(0, 1000),
        confidence: Math.min(Math.max(o.confidence || 0.5, 0.1), 0.85),
        sourcePath: o.sourcePath && !o.sourcePath.includes('..') ? o.sourcePath : undefined,
      }))

    const validCandidates: FlagCandidate[] = (raw.flagCandidates || [])
      .filter((c) => c.value && c.value.trim().length > 0)
      .slice(0, 10)
      .map((c, i) => {
        const val = c.value.trim()
        return {
          id: `cand_${raw.runId}_${i}`,
          taskId: taskId || 'session',
          value: val,
          normalizedValue: val,
          sourceObservationIds: [],
          sourceEvidenceIds: [],
          sourceArtifactIds: [],
          sourceRunIds: [raw.runId],
          sourceAttemptIds: [],
          confidence: 0.5,
          validation: {
            patternMatched: val.includes('{') && val.includes('}'),
            provenanceComplete: false,
            locallyVerified: false,
            platformVerified: false,
            errors: [],
          },
          status: 'detected' as const,
          source: 'agent_output' as const,
          matchedPattern: val.includes('{') && val.includes('}'),
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }
      })

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
