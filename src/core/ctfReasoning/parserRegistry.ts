/**
 * ParserRegistry — Phase 2.1 §十二.
 *
 * Centralised registry for `ResultParser`s. Parsers are matched by
 * `ParserSelectionInput` (toolId / manifestId / workflowId / stepId).
 * When no parser matches, the registry falls back to `GenericParser`.
 *
 * The Registry is the canonical place; legacy `outputParser.ts` (used
 * by OneShot today) is exposed via a thin adapter so we keep one
 * parser taxonomy.
 */

import type { ObservationSource, ObservationDraft } from './observation.js'
import type { EvidenceDraft } from './evidence.js'
import type { SuggestedAction } from './suggestedAction.js'
import type { FlagCandidateDraft } from './flagCandidate.js'

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
    return this.parsers
      .filter((p) => p.supports(input))
      .sort((a, b) => a.id.localeCompare(b.id))
  }

  async parse(
    selection: ParserSelectionInput,
    input: ParserInput,
    durationMs?: number,
  ): Promise<MaterializedResult> {
    const matches = this.resolve(selection)
    if (matches.length === 0) {
      return genericParser.parse(input)
    }
    // Compose outputs from all matches. GenericParser is the
    // universal fallback for any failed parser; we run matches first.
    const aggregate: MaterializedResult = {
      observations: [],
      evidence: [],
      suggestedActions: [],
      flagCandidateDrafts: [],
      warnings: [],
      rawArtifactIds: input.artifactIds,
      metrics: { durationMs },
    }
    for (const p of matches) {
      try {
        const out = await p.parse(input)
        aggregate.observations.push(...out.observations)
        aggregate.evidence.push(...out.evidence)
        aggregate.suggestedActions.push(...out.suggestedActions)
        aggregate.flagCandidateDrafts.push(...out.flagCandidateDrafts)
        aggregate.warnings.push(...out.warnings)
        if (out.metrics) aggregate.metrics = { ...aggregate.metrics, ...out.metrics }
      } catch (err) {
        aggregate.warnings.push(`parser ${p.id} failed: ${(err as Error).message}`)
      }
    }
    // Always append a command_status observation from the GenericParser
    // so downstream steps can see whether the underlying tool succeeded.
    if (input.isError || (typeof input.exitCode === 'number' && input.exitCode !== 0)) {
      const g = await genericParser.parse(input)
      aggregate.observations.unshift(...g.observations)
      aggregate.warnings.unshift(...g.warnings)
    }
    return aggregate
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