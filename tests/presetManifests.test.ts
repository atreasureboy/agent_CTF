import { describe, it, expect } from 'vitest'
import { OneShotCatalog, PRESET_ONESHOT_MANIFESTS } from '../src/ctf/oneshot/index.js'

describe('Preset Oneshot Instant Heuristics Manifests', () => {
  it('contains valid preset manifests for Crypto, Forensics, Reverse, and Web', () => {
    expect(PRESET_ONESHOT_MANIFESTS.length).toBeGreaterThanOrEqual(5)

    const catalog = new OneShotCatalog()
    for (const manifest of PRESET_ONESHOT_MANIFESTS) {
      catalog.upsert(manifest)
    }

    expect(catalog.list().length).toBe(PRESET_ONESHOT_MANIFESTS.length)
    expect(catalog.listByCategory('crypto').length).toBeGreaterThanOrEqual(2)
    expect(catalog.listByCategory('forensics').length).toBeGreaterThanOrEqual(1)
    expect(catalog.listByCategory('reverse').length).toBeGreaterThanOrEqual(1)
    expect(catalog.listByCategory('web').length).toBeGreaterThanOrEqual(1)
  })
})
