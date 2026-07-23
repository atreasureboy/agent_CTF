/**
 * OutputParser — adapter parsers that convert raw tool output into the
 * normalized Finding / Artifact / Candidate model.
 *
 * The framework ships a couple of built-in parsers (regex flag-extractor,
 * JSON-line parser, generic grep-on-pattern) plus a registry the user can
 * extend with manifest-`output.parser`-keyed custom parsers.
 */

import type {
  CandidateValue,
  NormalizedArtifact,
  NormalizedFinding,
  OneShotManifest,
} from './types.js'
import { readFileSync, existsSync } from 'fs'

export interface ParsedOutput {
  findings: NormalizedFinding[]
  artifacts: NormalizedArtifact[]
  candidates: CandidateValue[]
  warnings: string[]
}

/* ─── Built-in parsers ────────────────────────────────────────────────────── */

export const builtInParsers: Record<string, OutputParser> = {}

export type OutputParser = (
  manifest: OneShotManifest,
  result: { stdoutPath?: string; stderrPath?: string },
  runId: string,
) => ParsedOutput

/** Raw lines — emit each line prefixed with `Found:` so the LLM can grep. */
builtInParsers['passthrough'] = (_m, files) => {
  const warnings: string[] = []
  const findings: NormalizedFinding[] = []
  if (!files.stdoutPath || !existsSync(files.stdoutPath)) {
    return { findings, artifacts: [], candidates: [], warnings: ['no stdout file'] }
  }
  const content = readFileSync(files.stdoutPath, 'utf8')
  for (const line of content.split('\n').filter(Boolean)) {
    findings.push({
      category: 'raw',
      title: line.slice(0, 80),
      summary: line,
      confidence: 'low',
    })
  }
  return { findings, artifacts: [], candidates: [], warnings }
}

/** Generic flag-extractor on regex from manifest.output.flagPatterns. */
builtInParsers['flag-regex'] = (manifest, files, runId) => {
  const findings: NormalizedFinding[] = []
  const candidates: CandidateValue[] = []
  const warnings: string[] = []
  const patterns = manifest.output.flagPatterns ?? []
  if (!patterns.length) {
    warnings.push('flag-regex parser: no flagPatterns configured')
  }
  if (!files.stdoutPath || !existsSync(files.stdoutPath)) {
    return { findings, artifacts: [], candidates: [], warnings }
  }
  const content = readFileSync(files.stdoutPath, 'utf8')
  for (const pat of patterns) {
    try {
      const re = new RegExp(pat, 'gm')
      let m: RegExpExecArray | null
      while ((m = re.exec(content)) !== null) {
        const value = m[1] ?? m[0]
        candidates.push({
          value,
          sourceRuns: [runId],
          sourceArtifacts: [],
          confidence: 0.6,
          needsVerification: true,
        })
        findings.push({
          category: 'flag',
          title: `flag candidate: ${value.slice(0, 60)}`,
          summary: `Match against /${pat}/`,
          confidence: 'medium',
          evidence: [value.slice(0, 1000)],
        })
      }
    } catch (err) {
      warnings.push(`bad pattern ${pat}: ${(err as Error).message}`)
    }
  }
  return { findings, artifacts: [], candidates, warnings }
}

/** JSON-line parser: each line is a JSON object, mapped to a Finding. */
builtInParsers['jsonl'] = (_m, files, runId) => {
  const findings: NormalizedFinding[] = []
  const candidates: CandidateValue[] = []
  const warnings: string[] = []
  if (!files.stdoutPath || !existsSync(files.stdoutPath)) {
    return { findings, artifacts: [], candidates: [], warnings: ['jsonl: no stdout file'] }
  }
  const content = readFileSync(files.stdoutPath, 'utf8')
  for (const [i, line] of content.split('\n').filter(Boolean).entries()) {
    try {
      const obj = JSON.parse(line) as Record<string, unknown>
      const flag = (obj['flag'] ?? obj['candidate']) as unknown
      if (typeof flag === 'string') {
        candidates.push({
          value: flag,
          sourceRuns: [runId],
          sourceArtifacts: [],
          confidence: 0.7,
          needsVerification: true,
        })
      }
      findings.push({
        category: String(obj['category'] ?? 'tool-output'),
        title: String(obj['title'] ?? `record ${i}`),
        summary: typeof obj['summary'] === 'string' ? obj['summary'] : '',
        confidence:
          obj['confidence'] === 'low' || obj['confidence'] === 'high'
            ? obj['confidence']
            : 'medium',
      })
    } catch (err) {
      warnings.push(`jsonl line ${i}: ${(err as Error).message}`)
    }
  }
  return { findings, artifacts: [], candidates, warnings }
}

/* ─── Parser lookup ───────────────────────────────────────────────────────── */

const custom = new Map<string, OutputParser>()

export function registerParser(name: string, parser: OutputParser): void {
  custom.set(name, parser)
}

export function clearCustomParsers(): void {
  custom.clear()
}

export function parserFor(name: string): OutputParser | undefined {
  return custom.get(name) ?? builtInParsers[name]
}

export function runParser(
  manifest: OneShotManifest,
  files: { stdoutPath?: string; stderrPath?: string },
  runId: string,
): ParsedOutput {
  const p = parserFor(manifest.output.parser)
  if (!p) {
    return {
      findings: [],
      artifacts: [],
      candidates: [],
      warnings: [`unknown parser: ${manifest.output.parser}`],
    }
  }
  return p(manifest, files, runId)
}
