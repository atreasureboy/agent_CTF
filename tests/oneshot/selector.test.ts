import { describe, it, expect, beforeEach } from 'vitest'
import {
  OneShotCatalog,
  OneShotRegistry,
  selectManifests,
} from '../../src/ctf/oneshot/index.js'

function raw(over: Record<string, unknown>): unknown {
  return {
    id: 'demo',
    displayName: 'Demo',
    category: 'demo',
    description: 'd',
    source: { repository: 'https://example.com/r' },
    maturity: 'stable',
    enabledByDefault: true,
    allowedProfiles: ['triage'],
    runner: { type: 'process', command: ['demo'] },
    resources: { timeoutSeconds: 10, maxOutputBytes: 1024 },
    network: { mode: 'none', requiresScopeApproval: false },
    output: { parser: 'passthrough' },
    scheduling: { costTier: 'fast', falsePositiveRisk: 'low' },
    ...over,
  }
}

describe('selector', () => {
  let registry: OneShotRegistry
  let catalog: OneShotCatalog

  beforeEach(() => {
    catalog = new OneShotCatalog()
    registry = new OneShotRegistry(catalog)
  })

  it('returns no manifests when none registered', () => {
    const result = selectManifests({ taskId: 't', profileId: 'triage', taskText: '' }, catalog)
    expect(result).toHaveLength(0)
  })

  it('includes a manifest whose allowedProfiles match', () => {
    registry.registerSafe(raw({}))
    const out = selectManifests({ taskId: 't', profileId: 'triage', taskText: '' }, catalog)
    expect(out).toHaveLength(1)
    expect(out[0].lane).toBe('fast')
  })

  it('excludes a manifest whose profile is not in allowedProfiles', () => {
    registry.registerSafe(raw({}))
    const out = selectManifests({ taskId: 't', profileId: 'web', taskText: '' }, catalog)
    expect(out).toHaveLength(0)
  })

  it('respects excludedProfiles', () => {
    registry.registerSafe(raw({ excludedProfiles: ['triage'] }))
    const out = selectManifests({ taskId: 't', profileId: 'triage', taskText: '' }, catalog)
    expect(out).toHaveLength(0)
  })

  it('matches by task tag (image)', () => {
    registry.registerSafe(raw({ inputMatchers: { taskTags: ['image'] } }))
    const out = selectManifests(
      { taskId: 't', profileId: 'triage', taskText: 'analyze this PNG screenshot' },
      catalog,
    )
    expect(out).toHaveLength(1)
  })

  it('ignores disabled-by-default manifests unless includeExperimental', () => {
    registry.registerSafe(raw({ enabledByDefault: false }))
    expect(selectManifests({ taskId: 't', profileId: 'triage', taskText: '' }, catalog)).toHaveLength(0)
    expect(
      selectManifests(
        { taskId: 't', profileId: 'triage', taskText: '', includeExperimental: true },
        catalog,
      ).length,
    ).toBe(1)
  })
})
