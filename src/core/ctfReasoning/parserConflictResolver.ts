/**
 * ParserConflictResolver — Phase 2.3 §十五.
 *
 * Conflict groups evidence by (taskId + subject.artifactId/entityId +
 * claimFamily). Inside a group the highest-priority Claim wins; lower-
 * priority Claims are kept as Observations (audit) but the Evidence
 * layer marks them with conflict metadata.
 *
 * Priority (highest first):
 *   magic_signature > specialized_parser > file_command > generic
 *
 * Encoding conflict (§十七.2 / §十五):
 *   Multiple codecs succeed with different outputs → keep each as a
 *   separate decode branch observation; the conflict group is
 *   claimFamily=encoding_type.
 *
 * Partial success:
 *   When the tool exit code is non-zero but valid artifacts / evidence
 *   exist, surface as `partial` with a warning.
 *
 * Parser failure:
 *   Per-parser exceptions are captured as `parser_failure` warnings.
 */

import type { ObservationDraft } from './observation.js'
import type { EvidenceDraft, EvidenceClaimFamily } from './evidence.js'
import { deriveClaimFamilyFromKind } from './evidence.js'
import type { MaterializedResult } from './parserRegistry.js'

export type ParserPriority = 'magic_signature' | 'specialized_parser' | 'file_command' | 'generic'

export interface ParserConflictResolution {
  /** Observations that survive conflict resolution. */
  observations: ObservationDraft[]
  /** Evidence drafts — only the highest-priority claim wins per
   *  conflict group. Lower-priority drafts are kept as audit
   *  Observations (when present) but not as Evidence. */
  evidence: EvidenceDraft[]
  warnings: string[]
}

interface GroupKey {
  subjectKey: string
  family: EvidenceClaimFamily
}

function groupKeyOf(e: EvidenceDraft): GroupKey {
  const subjectKey = e.subject
    ? `${e.subject.artifactId ?? ''}|${e.subject.valueHash ?? ''}|${e.subject.entityId ?? ''}`
    : ''
  const family = e.claimFamily ?? deriveClaimFamilyFromKind(e.kind)
  return { subjectKey, family }
}

export function resolveParserConflicts(
  results: ReadonlyArray<{ parserId: string; result: MaterializedResult }>,
): ParserConflictResolution {
  const warnings: string[] = []
  const observations: ObservationDraft[] = []
  const evByGroup = new Map<string, { ev: EvidenceDraft; priority: ParserPriority }>()

  for (const { parserId, result } of results) {
    const priority = priorityForParser(parserId)
    for (const o of result.observations) {
      observations.push(o)
    }
    for (const e of result.evidence) {
      const key = `${groupKeyOf(e).subjectKey}|${groupKeyOf(e).family}`
      const existing = evByGroup.get(key)
      if (!existing) {
        evByGroup.set(key, { ev: e, priority })
        continue
      }
      if (rank(priority) > rank(existing.priority)) {
        evByGroup.set(key, { ev: e, priority })
      }
      // Lower-priority claim: kept as audit observation via the
      // observations array when present in the original result.
    }
  }

  return {
    observations,
    evidence: [...evByGroup.values()].map((x) => x.ev),
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

export function withPartialWarning(result: MaterializedResult, parserId: string): MaterializedResult {
  return {
    ...result,
    warnings: [...result.warnings, `parser ${parserId}: partial — tool exited with error but produced evidence`],
  }
}

export function parserFailureWarning(parserId: string, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return `parser_failure: ${parserId}: ${msg}`
}