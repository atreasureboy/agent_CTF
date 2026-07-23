import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { normalizeResult, runParser, parseManifest, type OneShotManifest } from '../../src/ctf/oneshot/index.js'

function passthroughManifest(): OneShotManifest {
  return parseManifest({
    id: 'demo',
    displayName: 'D',
    category: 'd',
    description: 'd',
    source: { repository: 'https://example.com/r' },
    maturity: 'stable',
    enabledByDefault: true,
    allowedProfiles: ['triage'],
    runner: { type: 'process', command: ['true'] },
    resources: { timeoutSeconds: 30, maxOutputBytes: 1024 },
    network: { mode: 'none', requiresScopeApproval: false },
    output: { parser: 'passthrough' },
    scheduling: { costTier: 'fast', falsePositiveRisk: 'low' },
  })
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'oneshot-norm-'))
}

describe('normalizer', () => {
  it('passes through raw lines as low-confidence findings', () => {
    const dir = tmp()
    try {
      const stdout = join(dir, 'o.log')
      writeFileSync(stdout, 'alpha\nbeta\ngamma\n')
      const m = passthroughManifest()
      const parsed = runParser(m, { stdoutPath: stdout }, 'osp_test')
      expect(parsed.findings.length).toBe(3)
      expect(parsed.findings[0].title).toBe('alpha')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('extracts flags via regex and dedupes by value', () => {
    const dir = tmp()
    try {
      const stdout = join(dir, 'o.log')
      const m = parseManifest({
        id: 'demo',
        displayName: 'D',
        category: 'd',
        description: 'd',
        source: { repository: 'https://example.com/r' },
        maturity: 'stable',
        enabledByDefault: true,
        allowedProfiles: ['triage'],
        runner: { type: 'process', command: ['true'] },
        resources: { timeoutSeconds: 30, maxOutputBytes: 1024 },
        network: { mode: 'none', requiresScopeApproval: false },
        output: { parser: 'flag-regex', flagPatterns: ['flag\\{[^}]+\\}'] },
        scheduling: { costTier: 'fast', falsePositiveRisk: 'low' },
      })
      writeFileSync(stdout, 'flag{first} flag{first} flag{second}\n')
      const normalized = normalizeResult({
        runId: 'osp_x',
        manifestId: m.id,
        taskId: 't',
        status: 'completed',
        startedAt: '',
        finishedAt: '',
        findings: [],
        artifacts: [],
        candidates: [],
        diagnostics: { truncated: false, parserWarnings: [], stdoutPath: stdout },
        confidence: 0.5,
        falsePositiveRisk: 'medium',
        summary: '',
      }, undefined, m)
      // Two unique flag candidates.
      const values = normalized.candidates.map((c) => c.value).sort()
      expect(values).toEqual(['flag{first}', 'flag{second}'])
      // Same flag captured twice → still appears only once.
      const first = normalized.candidates.find((c) => c.value === 'flag{first}')
      expect(first?.sourceRuns.length).toBeGreaterThanOrEqual(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('caps findings and candidates per result', () => {
    const dir = tmp()
    try {
      const stdout = join(dir, 'o.log')
      const m = parseManifest({
        id: 'demo',
        displayName: 'D',
        category: 'd',
        description: 'd',
        source: { repository: 'https://example.com/r' },
        maturity: 'stable',
        enabledByDefault: true,
        allowedProfiles: ['triage'],
        runner: { type: 'process', command: ['true'] },
        resources: { timeoutSeconds: 30, maxOutputBytes: 1024 },
        network: { mode: 'none', requiresScopeApproval: false },
        output: { parser: 'flag-regex', flagPatterns: ['flag\\{[^}]+\\}'] },
        scheduling: { costTier: 'fast', falsePositiveRisk: 'low' },
      })
      const lines: string[] = []
      for (let i = 0; i < 100; i++) lines.push(`flag{n${i}}`)
      writeFileSync(stdout, lines.join('\n') + '\n')
      const normalized = normalizeResult({
        runId: 'osp_x',
        manifestId: m.id,
        taskId: 't',
        status: 'completed',
        startedAt: '',
        finishedAt: '',
        findings: [],
        artifacts: [],
        candidates: [],
        diagnostics: { truncated: false, parserWarnings: [], stdoutPath: stdout },
        confidence: 0.5,
        falsePositiveRisk: 'medium',
        summary: '',
      }, { maxFindings: 5, maxCandidates: 3 }, m)
      expect(normalized.findings.length).toBeLessThanOrEqual(5)
      expect(normalized.candidates.length).toBeLessThanOrEqual(3)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns warning when parser is unknown', () => {
    const dir = tmp()
    try {
      const stdout = join(dir, 'o.log')
      writeFileSync(stdout, 'flag{ok}\n')
      const m = parseManifest({
        id: 'demo',
        displayName: 'D',
        category: 'd',
        description: 'd',
        source: { repository: 'https://example.com/r' },
        maturity: 'stable',
        enabledByDefault: true,
        allowedProfiles: ['triage'],
        runner: { type: 'process', command: ['true'] },
        resources: { timeoutSeconds: 30, maxOutputBytes: 1024 },
        network: { mode: 'none', requiresScopeApproval: false },
        output: { parser: 'no-such-parser' },
        scheduling: { costTier: 'fast', falsePositiveRisk: 'low' },
      })
      const parsed = runParser(m, { stdoutPath: stdout }, 'osp_test')
      expect(parsed.warnings.length).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
