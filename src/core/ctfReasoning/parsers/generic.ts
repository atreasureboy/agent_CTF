/**
 * GenericParser — Phase 2.1 §十四.
 *
 * Universal fallback. Produces:
 *   - command_status Observation (low confidence)
 *   - bounded preview of stdout/stderr
 *   - tool_unavailable / tool_failure Evidence on error paths
 *
 * Never produces high-confidence Evidence or FlagCandidate.
 */

import type { ResultParser, ParserInput, MaterializedResult } from '../parserRegistry.js'

const MAX_PREVIEW_BYTES = 2048

export const genericParser: ResultParser = {
  id: 'generic',
  supports() {
    return true
  },
  async parse(input: ParserInput): Promise<MaterializedResult> {
    const observations: MaterializedResult['observations'] = []
    const evidence: MaterializedResult['evidence'] = []
    const warnings: string[] = []

    const exitCode = typeof input.exitCode === 'number' ? input.exitCode : 0
    const statusSummary = input.isError
      ? `tool errored (exit ${exitCode})`
      : `tool completed (exit ${exitCode})`

    observations.push({
      kind: 'command_status',
      source: input.source,
      summary: statusSummary,
      attributes: { exitCode, isError: input.isError },
      confidence: 0.4,
    })

    if (input.content) {
      const preview = input.content.length > MAX_PREVIEW_BYTES
        ? input.content.slice(0, MAX_PREVIEW_BYTES)
        : input.content
      if (input.content.length > MAX_PREVIEW_BYTES) {
        warnings.push(`generic: preview truncated from ${input.content.length} to ${MAX_PREVIEW_BYTES} bytes`)
      }
      observations.push({
        kind: 'printable_text',
        source: input.source,
        summary: preview.split('\n')[0]?.slice(0, 200) ?? '',
        attributes: { previewLength: preview.length },
        rawExcerpt: preview,
        confidence: 0.3,
      })
    }

    if (input.isError || exitCode !== 0) {
      evidence.push({
        kind: input.isError ? 'tool_failure' : 'tool_unavailable',
        claim: `${input.source.toolId ?? input.source.workflowId ?? 'tool'} exit=${exitCode}`,
        confidence: 0.5,
        producer: { type: 'parser', id: 'generic' },
        polarity: 'neutral',
      })
    }

    return {
      observations,
      evidence,
      suggestedActions: [],
      flagCandidateDrafts: [],
      warnings,
      rawArtifactIds: input.artifactIds,
    }
  },
}