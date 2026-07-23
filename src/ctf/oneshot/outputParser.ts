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
  // §二十 — passthrough keeps a bounded preview; we no longer emit every
  // line as a Finding (that would flood the FindingStore with noise).
  const content = readFileSync(files.stdoutPath, 'utf8')
  const lines = content.split('\n').filter(Boolean)
  const MAX_LINES = 50
  const preview = lines.slice(0, MAX_LINES)
  if (lines.length > MAX_LINES) {
    warnings.push(`passthrough truncated: ${lines.length - MAX_LINES} additional line(s) not surfaced`)
  }
  findings.push({
    category: 'raw',
    title: `passthrough preview (${preview.length}/${lines.length} lines)`,
    summary: preview.join('\n'),
    confidence: 'low',
  })
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

/* ─── §二十 — Deterministic parsers for the standard tooling ─────────── */

/** `file` — emits a magic-type finding. */
builtInParsers['file'] = (_m, files, runId) => {
  const findings: NormalizedFinding[] = []
  const warnings: string[] = []
  if (!files.stdoutPath || !existsSync(files.stdoutPath)) {
    return { findings: [], artifacts: [], candidates: [], warnings: ['file: no stdout file'] }
  }
  const content = readFileSync(files.stdoutPath, 'utf8').trim()
  if (!content) {
    return { findings: [], artifacts: [], candidates: [], warnings: ['file: empty output'] }
  }
  findings.push({
    category: 'magic',
    title: `file: ${content.split('\n')[0]?.slice(0, 120) ?? 'unknown'}`,
    summary: content,
    confidence: 'high',
    evidence: [runId],
  })
  return { findings, artifacts: [], candidates: [], warnings }
}

/** `strings` — keep first N printable strings above length threshold. */
builtInParsers['strings'] = (_m, files, runId) => {
  const findings: NormalizedFinding[] = []
  const candidates: CandidateValue[] = []
  const warnings: string[] = []
  if (!files.stdoutPath || !existsSync(files.stdoutPath)) {
    return { findings: [], artifacts: [], candidates: [], warnings: ['strings: no stdout file'] }
  }
  const content = readFileSync(files.stdoutPath, 'utf8')
  const lines = content.split('\n').filter((l) => l.length >= 4)
  const MAX = 200
  const keep = lines.slice(0, MAX)
  if (lines.length > MAX) {
    warnings.push(`strings: truncated ${lines.length - MAX} lines`)
  }
  // Flag candidates — common flag formats.
  for (const line of keep) {
    const m = line.match(/flag\{[^}]+\}|CTF\{[^}]+\}|FLAG\{[^}]+\}/)
    if (m) {
      candidates.push({
        value: m[0],
        sourceRuns: [runId],
        sourceArtifacts: [],
        confidence: 0.7,
        needsVerification: true,
      })
    }
  }
  findings.push({
    category: 'strings',
    title: `strings: ${keep.length} printable string(s)`,
    summary: keep.join('\n'),
    confidence: 'medium',
    evidence: [runId],
  })
  return { findings, artifacts: [], candidates, warnings }
}

/** `binwalk` — each detected signature becomes a finding. */
builtInParsers['binwalk'] = (_m, files, runId) => {
  const findings: NormalizedFinding[] = []
  const artifacts: NormalizedArtifact[] = []
  const warnings: string[] = []
  if (!files.stdoutPath || !existsSync(files.stdoutPath)) {
    return { findings: [], artifacts: [], candidates: [], warnings: ['binwalk: no stdout file'] }
  }
  const content = readFileSync(files.stdoutPath, 'utf8')
  const re = /^(\d+)\s+(0x[0-9a-fA-F]+)\s+(.+)$/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(content)) !== null) {
    findings.push({
      category: 'embedded',
      title: `binwalk offset ${m[2]}: ${m[3]?.slice(0, 80)}`,
      summary: m[3] ?? '',
      confidence: 'high',
      evidence: [runId],
    })
  }
  // Header line — descriptive summary.
  const head = content.split('\n')[0]?.trim() ?? ''
  if (head) {
    findings.push({
      category: 'binwalk-summary',
      title: head.slice(0, 120),
      summary: head,
      confidence: 'low',
    })
  }
  if (findings.length === 0) {
    warnings.push('binwalk: no signatures parsed')
  }
  void artifacts
  return { findings, artifacts, candidates: [], warnings }
}

/** `zsteg` — each detected channel becomes a finding. */
builtInParsers['zsteg'] = (_m, files, runId) => {
  const findings: NormalizedFinding[] = []
  const candidates: CandidateValue[] = []
  const warnings: string[] = []
  if (!files.stdoutPath || !existsSync(files.stdoutPath)) {
    return { findings: [], artifacts: [], candidates: [], warnings: ['zsteg: no stdout file'] }
  }
  const content = readFileSync(files.stdoutPath, 'utf8')
  // zsteg rows look like:  b1,r,lsb,xy       .. text: "..."
  const re = /^\s*([\w.,]+)\s+(\.\.|file|text|zip|RGBA)\s*:\s*"([^"]*)"/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(content)) !== null) {
    const value = m[3] ?? ''
    findings.push({
      category: 'zsteg',
      title: `zsteg ${m[1]?.slice(0, 40)}: ${m[2]}`,
      summary: value.slice(0, 200),
      confidence: 'medium',
      evidence: [runId],
    })
    const fm = value.match(/flag\{[^}]+\}|CTF\{[^}]+\}|FLAG\{[^}]+\}/)
    if (fm) {
      candidates.push({
        value: fm[0],
        sourceRuns: [runId],
        sourceArtifacts: [],
        confidence: 0.7,
        needsVerification: true,
      })
    }
  }
  if (findings.length === 0) {
    warnings.push('zsteg: no channels parsed')
  }
  return { findings, artifacts: [], candidates, warnings }
}

/** `checksec` — emits a structured finding for each binary's protections. */
builtInParsers['checksec'] = (_m, files, runId) => {
  const findings: NormalizedFinding[] = []
  const warnings: string[] = []
  if (!files.stdoutPath || !existsSync(files.stdoutPath)) {
    return { findings: [], artifacts: [], candidates: [], warnings: ['checksec: no stdout file'] }
  }
  const content = readFileSync(files.stdoutPath, 'utf8')
  const lines = content.split('\n').filter(Boolean)
  const MAX = 100
  const keep = lines.slice(0, MAX)
  if (lines.length > MAX) warnings.push(`checksec: truncated ${lines.length - MAX} line(s)`)
  findings.push({
    category: 'checksec',
    title: `checksec: ${keep.length} protection row(s)`,
    summary: keep.join('\n'),
    confidence: 'high',
    evidence: [runId],
  })
  return { findings, artifacts: [], candidates: [], warnings }
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
      const flag = (obj['flag'] ?? obj['candidate'])
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
