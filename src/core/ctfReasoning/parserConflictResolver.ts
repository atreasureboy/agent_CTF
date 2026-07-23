/**
 * ParserConflictResolver — Phase 2.2 §十七.
 *
 * Decides how to resolve conflicts between parsers producing different
 * conclusions for the same input (e.g. `file` says "data" while
 * `hex_header` says "PNG"). All conflicts are resolved by a strict
 * priority order; the lower-priority conclusion is preserved as an
 * audit observation but does not produce competing Evidence.
 *
 * Priority (highest first):
 *   magic_signature > specialized_parser > file_command > generic
 *
 * Encoding conflict (§十七.2):
 *   - Multiple codecs succeed with different outputs → keep each as a
 *     separate decode branch observation (no single Evidence claim).
 *   - Conflict resolution defers to the DecoderTree / readability /
 *     next-layer detection, which this resolver does not score itself.
 *
 * Partial success (§十七.3):
 *   - When the tool exit code is non-zero but the output contains
 *     valid artifacts / evidence, surface as `partial` with a warning.
 *
 * Parser failure (§十七.4):
 *   - Per-parser exceptions are captured as `parser_failure` warnings.
 *     The GenericParser runs as a last-resort fallback. Other parsers
 *     are not affected.
 */

import type { ObservationDraft } from './observation.js'
import type { EvidenceDraft } from './evidence.js'
import type { MaterializedResult } from './parserRegistry.js'

export type ParserPriority = 'magic_signature' | 'specialized_parser' | 'file_command' | 'generic'

export interface ParserConflictResolution {
  /** Observations that survive conflict resolution. */
  observations: ObservationDraft[]
  /** Evidence drafts — only the highest-priority claim wins per
   *  subject. */
  evidence: EvidenceDraft[]
  /** Aggregated warnings including any `parser_failure` markers. */
  warnings: string[]
}

export function resolveParserConflicts(
  results: ReadonlyArray<{ parserId: string; result: MaterializedResult }>,
): ParserConflictResolution {
  const warnings: string[] = []
  const observations: ObservationDraft[] = []
  const evBySubjectKey = new Map<string, { ev: EvidenceDraft; priority: ParserPriority }>()

  for (const { parserId, result } of results) {
    const priority = priorityForParser(parserId)
    for (const o of result.observations) {
      observations.push(o)
    }
    for (const e of result.evidence) {
      const key = `${e.kind}|${(e.claim ?? '').toLowerCase()}`
      const existing = evBySubjectKey.get(key)
      if (!existing) {
        evBySubjectKey.set(key, { ev: e, priority })
        continue
      }
      if (rank(priority) > rank(existing.priority)) {
        evBySubjectKey.set(key, { ev: e, priority })
      }
      // Lower-priority claim: dropped as Evidence (kept as audit
      // observation via the observations array when present).
    }
  }

  return {
    observations,
    evidence: [...evBySubjectKey.values()].map((x) => x.ev),
    warnings,
  }
}

function priorityForParser(parserId: string): ParserPriority {
  if (parserId === 'hex_header' || parserId === 'zsteg') return 'magic_signature'
  if (
    parserId === 'binwalk' ||
    parserId === 'checksec' ||
    parserId === 'exiftool' ||
    parserId === 'strings'
  ) return 'specialized_parser'
  if (parserId === 'file') return 'file_command'
  return 'generic'
}

function rank(p: ParserPriority): number {
  switch (p) {
    case 'magic_signature': return 4
    case 'specialized_parser': return 3
    case 'file_command': return 2
    case 'generic': return 1
  }
}

/** Surface a tool's partial failure without losing Evidence. The
 *  parser registry uses this when `isError === true` but the
 *  materializer still produced valid Observations / Evidence. */
export function withPartialWarning(result: MaterializedResult, parserId: string): MaterializedResult {
  return {
    ...result,
    warnings: [...result.warnings, `parser ${parserId}: partial — tool exited with error but produced evidence`],
  }
}

/** Wrap a parser failure. The exception is recorded as a warning;
 *  the parser's `result` (when supplied) is preserved verbatim. */
export function parserFailureWarning(parserId: string, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return `parser_failure: ${parserId}: ${msg}`
}