import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  listFixtures,
  listFixtureSpecs,
  runBenchmark,
  summarizeBenchmark,
  formatBenchmarkSummary,
  synthesizeBenchmarkRow,
  type BenchmarkFixture,
  type BenchmarkFixtureSpec,
} from '../../src/ctf/cli/benchmark.js'

describe('benchmark harness', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'bench-'))
    writeFileSync(join(root, 'base64_input.txt'), 'ZmxhZ3tiYXNlNjRfdGVzdH0=')
    writeFileSync(join(root, 'xor_input.bin'), 'flag{xor_test}')
    writeFileSync(join(root, 'tiny.elf'), '\x7fELF\x02\x01\x01')
    writeFileSync(join(root, 'rsa_params.txt'), 'n = 143\ne = 11\n')
    writeFileSync(join(root, 'tiny.pcap'), '\xd4\xc3\xb2\xa1')
    writeFileSync(join(root, 'macro.doc'), '\xd0\xcf\x11\xe0')
    writeFileSync(join(root, 'nested.zip'), 'PK\x03\x04')
  })

  it('listFixtures enumerates every file in root', () => {
    const fixtures = listFixtures(root)
    expect(fixtures.length).toBe(7)
  })

  it('detectCategory tags correctly', () => {
    const cat = (f: string): string =>
      listFixtures(root).find((x) => x.path.endsWith(f))?.category ?? 'missing'
    expect(cat('base64_input.txt')).toBe('crypto/encoded')
    expect(cat('xor_input.bin')).toBe('crypto/xor')
    expect(cat('rsa_params.txt')).toBe('crypto/rsa')
    expect(cat('tiny.elf')).toBe('binary/elf')
    expect(cat('tiny.pcap')).toBe('network/pcap')
    expect(cat('macro.doc')).toBe('office/oletools')
    expect(cat('nested.zip')).toBe('archive/zip')
  })

  it('synthesizeBenchmarkRow differentiates modes', () => {
    const f: BenchmarkFixture = {
      path: '/x',
      category: 'unknown',
      size: 1024,
    }
    const a = synthesizeBenchmarkRow(f, 'A')
    const c = synthesizeBenchmarkRow(f, 'C')
    expect(c.timeToFirstToolMs).toBeLessThan(a.timeToFirstToolMs)
    expect(a.manualScriptCount).toBeGreaterThan(0)
    expect(c.manualScriptCount).toBe(0)
  })

  it('runBenchmark produces three rows per fixture', () => {
    const summary = runBenchmark({ fixturesRoot: root })
    expect(summary.rows.length).toBe(7 * 3)
    for (const r of summary.rows) {
      expect(['A', 'B', 'C']).toContain(r.mode)
    }
  })

  it('summarizeBenchmark aggregates per mode', () => {
    const summary = summarizeBenchmark([
      synthesizeBenchmarkRow({ path: '/x', category: 'c', size: 256 }, 'A'),
      synthesizeBenchmarkRow({ path: '/x', category: 'c', size: 256 }, 'A'),
      synthesizeBenchmarkRow({ path: '/x', category: 'c', size: 256 }, 'C'),
    ])
    expect(summary.byMode.A.avgTimeToFirstToolMs).toBeGreaterThan(0)
    expect(summary.byMode.C.avgTimeToFirstToolMs).toBeGreaterThan(0)
    expect(summary.byMode.B.avgTimeToFirstToolMs).toBe(0)
  })

  it('formatBenchmarkSummary produces readable text', () => {
    const summary = runBenchmark({ fixturesRoot: root })
    const text = formatBenchmarkSummary(summary)
    expect(text).toContain('A: pure agent')
    expect(text).toContain('B: specialist')
    expect(text).toContain('C: specialist')
    expect(text).toContain('selection precision')
    expect(text).toContain('candidate recall')
    expect(text).toContain('median duration')
  })

  it('listFixtureSpecs reads JSON specs and applies expected fields', () => {
    const specsRoot = mkdtempSync(join(tmpdir(), 'bench-specs-'))
    try {
      const spec: BenchmarkFixtureSpec = {
        path: '/x',
        category: 'crypto/encoded',
        size: 32,
        expectedSelectedManifestIds: ['cipher-identifier'],
        expectedFindingCategories: ['strings'],
        expectedCandidateValues: ['flag{x}'],
        expectedArtifactKinds: [],
        maxFalsePositiveFindings: 0,
        maxDurationMs: 8000,
      }
      writeFileSync(join(specsRoot, 'spec.json'), JSON.stringify(spec))
      const specs = listFixtureSpecs(specsRoot)
      expect(specs.length).toBe(1)
      expect(specs[0].expectedSelectedManifestIds).toEqual(['cipher-identifier'])
      const row = synthesizeBenchmarkRow(specs[0], 'C')
      expect(row.selectedManifestIds).toEqual(['cipher-identifier'])
      expect(row.candidateValues).toEqual(['flag{x}'])
    } finally {
      rmSync(specsRoot, { recursive: true, force: true })
    }
  })

  it('summarizeBenchmark emits quality metrics', () => {
    const summary = runBenchmark({ fixturesRoot: root })
    expect(summary.quality).toBeDefined()
    expect(summary.quality.medianDurationMs).toBeGreaterThan(0)
    expect(summary.quality.candidateRecall).toBeGreaterThanOrEqual(0)
    expect(summary.quality.candidateRecall).toBeLessThanOrEqual(1)
  })
})
