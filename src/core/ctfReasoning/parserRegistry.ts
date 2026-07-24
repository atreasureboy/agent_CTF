/**
 * ParserRegistry — Phase 2.2 §十七.
 *
 * Centralised registry for `ResultParser`s. Parsers are matched by
 * `ParserSelectionInput` (toolId / manifestId / workflowId / stepId).
 * When no parser matches, the registry falls back to `GenericParser`.
 *
 * Pipeline (§十七):
 *   1. Resolve parsers matching the selection
 *   2. Run each parser (failures → `parser_failure` warnings, do not
 *      stop other parsers)
 *   3. GenericParser always runs as fallback
 *   4. ResultMerger dedupes Observations, merges Evidence, dedupes
 *      SuggestedActions, merges FlagCandidates
 *   5. ParserConflictResolver enforces the priority order
 *      (magic > specialized > file > generic) and surfaces partial
 *      successes
 */

import type { ObservationSource, ObservationDraft } from './observation.js'
import type { EvidenceDraft } from './evidence.js'
import type { SuggestedAction } from './suggestedAction.js'
import type { FlagCandidateDraft } from './flagCandidate.js'
import { createResultMerger } from './resultMerger.js'
import {
  resolveParserConflicts,
  parserFailureWarning,
  withPartialWarning,
} from './parserConflictResolver.js'

export interface ParserSelectionInput {
  toolId?: string
  manifestId?: string
  workflowId?: string
  stepId?: string
  mimeType?: string
}

export interface ParserInput {
  taskId: string
  source: ObservationSource
  content?: string
  stdoutPath?: string
  stderrPath?: string
  artifactIds: string[]
  exitCode?: number
  isError: boolean
  parserOptions?: Record<string, unknown>
}

export interface MaterializedResult {
  observations: ObservationDraft[]
  evidence: EvidenceDraft[]
  suggestedActions: SuggestedAction[]
  flagCandidateDrafts: FlagCandidateDraft[]
  warnings: string[]
  rawArtifactIds: string[]
  metrics?: {
    durationMs?: number
    outputBytes?: number
    truncated?: boolean
  }
}

export interface ResultParser {
  id: string
  supports(input: ParserSelectionInput): boolean
  parse(input: ParserInput): Promise<MaterializedResult>
}

export class ParserRegistry {
  private readonly parsers: ResultParser[] = []

  register(parser: ResultParser): void {
    if (this.parsers.some((p) => p.id === parser.id)) {
      throw new Error(`ParserRegistry: duplicate parser id ${parser.id}`)
    }
    this.parsers.push(parser)
  }

  resolve(input: ParserSelectionInput): ResultParser[] {
    return this.parsers.filter((p) => p.supports(input)).sort((a, b) => a.id.localeCompare(b.id))
  }

  async parse(
    selection: ParserSelectionInput,
    input: ParserInput,
    durationMs?: number,
  ): Promise<MaterializedResult> {
    const matches = this.resolve(selection)
    const perParser: Array<{ parserId: string; result: MaterializedResult }> = []
    const allWarnings: string[] = []

    for (const p of matches) {
      try {
        let out = await p.parse(input)
        if (input.isError || (typeof input.exitCode === 'number' && input.exitCode !== 0)) {
          out = withPartialWarning(out, p.id)
        }
        perParser.push({ parserId: p.id, result: out })
      } catch (err) {
        allWarnings.push(parserFailureWarning(p.id, err))
      }
    }

    // Always run the GenericParser last as a fallback. Its outputs are
    // included but lower priority — conflict resolution still applies.
    try {
      const g = await genericParser.parse(input)
      perParser.push({ parserId: 'generic', result: g })
    } catch (err) {
      allWarnings.push(parserFailureWarning('generic', err))
    }

    // Conflict resolution — observations kept verbatim; evidence
    // filtered by parser priority.
    const conflict = resolveParserConflicts(perParser)

    // ResultMerger — dedupe observations, merge evidence, dedupe
    // suggested actions, merge flag candidates. We start from the
    // conflict-resolved Observations and Evidence so the merger only
    // has to handle intra-kind duplicates.
    const merged = createResultMerger().merge([
      {
        observations: conflict.observations,
        evidence: conflict.evidence,
        suggestedActions: perParser.flatMap((p) => p.result.suggestedActions),
        flagCandidateDrafts: perParser.flatMap((p) => p.result.flagCandidateDrafts),
        warnings: [],
        rawArtifactIds: input.artifactIds,
      },
    ])

    return {
      observations: merged.observations,
      evidence: merged.evidence,
      suggestedActions: merged.suggestedActions,
      flagCandidateDrafts: merged.flagCandidateDrafts,
      warnings: dedupe([...allWarnings, ...merged.warnings, ...conflict.warnings]),
      rawArtifactIds: input.artifactIds,
      metrics: { durationMs },
    }
  }
}

import { genericParser } from './parsers/generic.js'
import { fileParser } from './parsers/file.js'
import { hexHeaderParser } from './parsers/hexHeader.js'
import { stringsParser } from './parsers/strings.js'
import { binwalkParser } from './parsers/binwalk.js'
import { zstegParser } from './parsers/zsteg.js'
import { checksecParser } from './parsers/checksec.js'
import { encodingParser } from './parsers/encoding.js'
import { exifToolParser } from './parsers/exifTool.js'

function dedupe<T>(arr: T[]): T[] {
  return [...new Set(arr)]
}

let _defaultRegistry: ParserRegistry | null = null
export function getDefaultParserRegistry(): ParserRegistry {
  if (_defaultRegistry) return _defaultRegistry
  const r = new ParserRegistry()
  r.register(fileParser)
  r.register(hexHeaderParser)
  r.register(stringsParser)
  r.register(binwalkParser)
  r.register(zstegParser)
  r.register(checksecParser)
  r.register(encodingParser)
  r.register(exifToolParser)
  _defaultRegistry = r
  return r
}

export async function materializeViaRegistry(
  selection: ParserSelectionInput,
  input: ParserInput,
  durationMs?: number,
): Promise<MaterializedResult> {
  return getDefaultParserRegistry().parse(selection, input, durationMs)
}
