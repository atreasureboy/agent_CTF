/**
 * ResultNormalizer — converts a runner's OneShotResult into the final
 * normalized envelope the Agent sees.
 *
 * Responsibilities:
 *   - apply `output.parser` to the runner output files;
 *   - dedupe Finding records by semantic key (category + title + summary);
 *   - dedupe Candidate flags by value (collecting sourceRuns);
 *   - attach a short summary string (`summary`) suitable for LLM context;
 *   - cap returned findings/candidates to a reasonable size.
 *
 * The Normalizer never returns raw tool output — that path is forbidden by
 * the §六 contract.
 */

import type { CandidateValue, NormalizedFinding, OneShotResult } from './types.js'
import { runParser } from './outputParser.js'
import { runParser as _runParser } from './outputParser.js'
void _runParser

export interface NormalizerLimits {
  /** Cap returned findings. Default 20. */
  maxFindings: number
  /** Cap returned candidates. Default 8. */
  maxCandidates: number
}

const DEFAULT_LIMITS: NormalizerLimits = { maxFindings: 20, maxCandidates: 8 }

function findingKey(f: NormalizedFinding): string {
  return `${f.category}|${f.title}|${f.summary}`.slice(0, 200)
}

function candidateKey(c: CandidateValue): string {
  return c.value
}

export function normalizeResult(
  result: OneShotResult,
  limits: NormalizerLimits = DEFAULT_LIMITS,
  manifest?: { output: { parser: string; flagPatterns?: string[] } },
): OneShotResult {
  const parserManifest = manifest ?? {
    output: { parser: 'passthrough' },
  }
  const parsed = runParser(
    parserManifest as Parameters<typeof runParser>[0],
    { stdoutPath: result.diagnostics.stdoutPath, stderrPath: result.diagnostics.stderrPath },
    result.runId,
  )

  // Dedupe findings.
  const seenFinding = new Set<string>()
  const findings: NormalizedFinding[] = []
  for (const f of [...result.findings, ...parsed.findings]) {
    const k = findingKey(f)
    if (seenFinding.has(k)) continue
    seenFinding.add(k)
    findings.push(f)
  }

  // Dedupe candidates by value; merge sourceRuns.
  const candMap = new Map<string, CandidateValue>()
  for (const c of [...result.candidates, ...parsed.candidates]) {
    const k = candidateKey(c)
    const existing = candMap.get(k)
    if (existing) {
      existing.sourceRuns = [...new Set([...existing.sourceRuns, ...c.sourceRuns])]
      existing.sourceArtifacts = [...new Set([...existing.sourceArtifacts, ...c.sourceArtifacts])]
      existing.confidence = Math.max(existing.confidence, c.confidence)
      existing.needsVerification = existing.needsVerification && c.needsVerification
    } else {
      candMap.set(k, { ...c })
    }
  }
  const candidates = [...candMap.values()]

  const summary = buildSummary(
    result,
    findings.slice(0, limits.maxFindings),
    candidates.slice(0, limits.maxCandidates),
  )

  return {
    ...result,
    findings: findings.slice(0, limits.maxFindings),
    candidates: candidates.slice(0, limits.maxCandidates),
    diagnostics: {
      ...result.diagnostics,
      parserWarnings: [...result.diagnostics.parserWarnings, ...parsed.warnings],
    },
    summary,
  }
}

function buildSummary(
  result: OneShotResult,
  findings: NormalizedFinding[],
  candidates: CandidateValue[],
): string {
  const parts: string[] = []
  parts.push(`OneShot ${result.manifestId} ${result.status}`)
  if (result.durationMs !== undefined) parts.push(`(${result.durationMs}ms)`)
  if (candidates.length > 0) {
    parts.push(
      `\nCandidates: ${candidates.map((c) => `${c.value.slice(0, 30)}(${c.confidence})`).join(', ')}`,
    )
  }
  if (findings.length > 0) {
    parts.push(
      `\nFindings (${findings.length}): ${findings
        .slice(0, 5)
        .map((f) => f.title.slice(0, 50))
        .join('; ')}`,
    )
  }
  if (result.diagnostics.truncated) {
    parts.push('\n[output truncated — full log on disk]')
  }
  return parts.join('')
}
