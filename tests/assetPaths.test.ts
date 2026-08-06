/**
 * assetPaths — cwd-independent resolution of shipped package assets
 * (knowledge base, oneshot manifests/scripts).
 */

import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { assetCandidates, locateAsset, locateAssetFromModule } from '../src/core/assetPaths.js'

describe('assetCandidates', () => {
  it('returns anchor + four parent levels in priority order', () => {
    const out = assetCandidates('/a/b/c', 'x/y')
    expect(out).toHaveLength(5)
    expect(out[0]).toBe('/a/b/c/x/y')
    expect(out[1]).toBe('/a/b/x/y')
    expect(out[2]).toBe('/a/x/y')
    expect(out[3]).toBe('/x/y')
    expect(out[4]).toBe('/x/y')
  })
})

describe('locateAsset', () => {
  let root: string

  const setup = (depth: number): { anchor: string; cleanup: () => void } => {
    root = mkdtempSync(join(tmpdir(), 'assetPaths-'))
    writeFileSync(join(root, 'package.json'), '{}')
    mkdirSync(join(root, 'oneshot', 'manifests'), { recursive: true })
    let anchor = root
    for (let i = 0; i < depth; i++) {
      anchor = join(anchor, `lvl${i}`)
      mkdirSync(anchor, { recursive: true })
    }
    const modFile = join(anchor, 'mod.ts')
    writeFileSync(modFile, '')
    return { anchor, cleanup: () => rmSync(root, { recursive: true, force: true }) }
  }

  it('finds the asset at the anchor itself (depth 0)', () => {
    const r = mkdtempSync(join(tmpdir(), 'assetPaths-'))
    try {
      mkdirSync(join(r, 'oneshot', 'manifests'), { recursive: true })
      const hit = locateAsset(r, join('oneshot', 'manifests'))
      expect(hit).toBe(join(r, 'oneshot', 'manifests'))
    } finally {
      rmSync(r, { recursive: true, force: true })
    }
  })

  it('finds the asset from nested module depths 1-4', () => {
    for (let depth = 1; depth <= 4; depth++) {
      const { anchor, cleanup } = setup(depth)
      try {
        const hit = locateAsset(anchor, join('oneshot', 'manifests'))
        expect(hit).toBe(join(root, 'oneshot', 'manifests'))
      } finally {
        cleanup()
      }
    }
  })

  it("returns '' when the asset does not exist anywhere", () => {
    const { anchor, cleanup } = setup(2)
    try {
      expect(locateAsset(anchor, 'no/such/asset')).toBe('')
    } finally {
      cleanup()
    }
  })
})

describe('shipped assets (repo layout)', () => {
  it('resolves the real oneshot catalog and knowledge base from this test module', () => {
    const manifests = locateAssetFromModule(import.meta.url, join('oneshot', 'manifests'))
    const knowledge = locateAssetFromModule(import.meta.url, join('src', 'knowledge'))
    expect(manifests.endsWith(join('oneshot', 'manifests'))).toBe(true)
    expect(knowledge.endsWith(join('src', 'knowledge'))).toBe(true)
  })
})
