import { describe, it, expect } from 'vitest'
import {
  parseManifest,
  safeParseManifest,
  oneShotManifestSchema,
} from '../../src/ctf/oneshot/index.js'

const validManifest = {
  id: 'demo',
  displayName: 'Demo tool',
  category: 'demo',
  description: 'for tests',
  source: { repository: 'https://example.com/repo' },
  maturity: 'stable',
  enabledByDefault: true,
  allowedProfiles: ['triage'],
  runner: { type: 'process', command: ['demo'] },
  resources: { timeoutSeconds: 10, maxOutputBytes: 1024 },
  network: { mode: 'none', requiresScopeApproval: false },
  output: { parser: 'passthrough' },
  scheduling: { costTier: 'fast', falsePositiveRisk: 'low' },
}

describe('manifest schema', () => {
  it('parses a valid manifest', () => {
    const r = parseManifest(validManifest)
    expect(r.id).toBe('demo')
  })

  it('rejects unknown fields (strict mode)', () => {
    const r = safeParseManifest({ ...validManifest, unknownField: 'x' })
    expect(r.ok).toBe(false)
  })

  it('rejects container manifest without image', () => {
    const bad = safeParseManifest({
      ...validManifest,
      runner: { type: 'container', command: ['x'] },
    })
    expect(bad.ok).toBe(false)
  })

  it('rejects heavy + experimental maturity', () => {
    const bad = safeParseManifest({
      ...validManifest,
      scheduling: { costTier: 'heavy', falsePositiveRisk: 'low' },
      maturity: 'experimental',
    })
    expect(bad.ok).toBe(false)
  })

  it('accepts service manifest with endpoint', () => {
    const r = safeParseManifest({
      ...validManifest,
      runner: { type: 'service', endpoint: 'http://localhost:9999' },
    })
    expect(r.ok).toBe(true)
  })

  it('rejects negative maxOutputBytes', () => {
    const bad = safeParseManifest({
      ...validManifest,
      resources: { timeoutSeconds: 10, maxOutputBytes: -1 },
    })
    expect(bad.ok).toBe(false)
  })

  it('exports the raw schema for advanced consumers', () => {
    expect(oneShotManifestSchema).toBeDefined()
  })
})
