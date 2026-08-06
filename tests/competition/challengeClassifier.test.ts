/**
 * Round 1 — ChallengeClassifier tests.
 */

import { describe, it, expect } from 'vitest'
import { ChallengeClassifier } from '../../src/ctf/competition/challengeClassifier.js'
import { OneShotCatalog } from '../../src/ctf/oneshot/catalog.js'
import type { OneShotManifest } from '../../src/ctf/oneshot/types.js'

function makeManifest(id: string, overrides: Partial<OneShotManifest> = {}): OneShotManifest {
  return {
    id,
    displayName: id,
    category: 'demo',
    description: 'd',
    source: { repository: 'https://example.com/r' },
    maturity: 'stable' as const,
    enabledByDefault: true,
    allowedProfiles: ['triage'],
    runner: { type: 'process' as const, command: ['demo'] },
    resources: { timeoutSeconds: 10, maxOutputBytes: 1024 },
    network: { mode: 'none' as const, requiresScopeApproval: false },
    output: { parser: 'passthrough' as const },
    scheduling: { costTier: 'fast' as const, falsePositiveRisk: 'low' as const },
    ...overrides,
  }
}

function makeCatalog(ids: string[]): OneShotCatalog {
  const catalog = new OneShotCatalog()
  for (const id of ids) {
    catalog.upsert(makeManifest(id))
  }
  return catalog
}

describe('ChallengeClassifier', () => {
  it('classifies base64 encoding challenge as fast', () => {
    const catalog = makeCatalog(['ciphey', 'cipher-identifier', 'file', 'strings'])
    const classifier = new ChallengeClassifier(catalog)

    const result = classifier.classify({
      id: 'c1',
      title: 'Base64 encoding challenge',
      category: 'encoding',
      description: 'This challenge involves base64 encoded strings. Decode them.',
    })

    expect(result.tier).toBe('fast')
    expect(result.recommendedManifests).toContain('ciphey')
    expect(result.confidence).toBeGreaterThanOrEqual(0.8)
  })

  it('classifies RSA crypto as heavy (rsa is heavy keyword)', () => {
    const catalog = makeCatalog(['ciphey', 'cipher-identifier', 'rsactftool', 'file', 'strings'])
    const classifier = new ChallengeClassifier(catalog)

    const result = classifier.classify({
      id: 'c2',
      title: 'RSA Warmup',
      category: 'crypto',
      description: 'We found an RSA public key. Can you factor n and decrypt the ciphertext?',
    })

    expect(result.tier).toBe('heavy')
  })

  it('classifies pwn as heavy', () => {
    const catalog = makeCatalog(['file', 'strings', 'pwntools-checksec'])
    const classifier = new ChallengeClassifier(catalog)

    const result = classifier.classify({
      id: 'c3',
      title: 'Buffer Overflow',
      category: 'pwn',
      description: 'Exploit the buffer overflow to get a shell.',
    })

    expect(result.tier).toBe('heavy')
  })

  it('downgrades heavy to medium when fast keywords present', () => {
    const catalog = makeCatalog(['file', 'strings', 'capa'])
    const classifier = new ChallengeClassifier(catalog)

    const result = classifier.classify({
      id: 'c4',
      title: 'Simple Java RE',
      category: 'reverse',
      description: 'Decompile the Java jar file to find the flag.',
    })

    expect(result.tier).toBe('medium')
  })

  it('detects fast keywords in misc category', () => {
    const catalog = makeCatalog(['file', 'strings'])
    const classifier = new ChallengeClassifier(catalog)

    const result = classifier.classify({
      id: 'c5',
      title: 'Strings',
      category: 'misc',
      description: 'Use the strings command to find the flag.',
    })

    expect(result.tier).toBe('fast')
    expect(result.recommendedManifests).toContain('strings')
  })

  it('always recommends file and strings as fallback manifests', () => {
    const catalog = makeCatalog(['file', 'strings'])
    const classifier = new ChallengeClassifier(catalog)

    const result = classifier.classify({
      id: 'c6',
      title: 'Unknown challenge',
      category: 'unknown_category',
      description: 'Something strange.',
    })

    expect(result.recommendedManifests).toContain('file')
    expect(result.recommendedManifests).toContain('strings')
  })

  it('filters manifests to only registered ones', () => {
    const catalog = makeCatalog(['strings']) // only 'strings' registered
    const classifier = new ChallengeClassifier(catalog)

    const result = classifier.classify({
      id: 'c7',
      title: 'Base64 encoding',
      category: 'encoding',
      description: 'base64 encoded flag',
    })

    // 'ciphey' and 'cipher-identifier' are defaults for encoding but not registered
    expect(result.recommendedManifests).not.toContain('ciphey')
    expect(result.recommendedManifests).toContain('strings')
  })

  it('sets high confidence for fast tier with multiple keyword matches', () => {
    const catalog = makeCatalog(['file', 'strings'])
    const classifier = new ChallengeClassifier(catalog)

    const result = classifier.classify({
      id: 'c8',
      title: 'Find the Flag',
      category: 'misc',
      description: 'Use strings and grep to find the flag in the text.',
    })

    expect(result.tier).toBe('fast')
    expect(result.confidence).toBeGreaterThanOrEqual(0.9)
    expect(result.features.descriptionKeywords).toContain('strings')
  })

  it('estimates complexity within 1-10 range', () => {
    const catalog = makeCatalog(['file', 'strings'])
    const classifier = new ChallengeClassifier(catalog)

    const easy = classifier.classify({
      id: 'easy',
      title: 'Easy',
      category: 'encoding',
      description: 'base64 decode this',
    })
    expect(easy.features.estimatedComplexity).toBeGreaterThanOrEqual(1)
    expect(easy.features.estimatedComplexity).toBeLessThanOrEqual(3)

    const hard = classifier.classify({
      id: 'hard',
      title: 'Hard',
      category: 'reverse',
      description: 'obfuscated packed vm custom binary',
    })
    expect(hard.features.estimatedComplexity).toBeGreaterThanOrEqual(7)
    expect(hard.features.estimatedComplexity).toBeLessThanOrEqual(10)
  })

  it('recognizes attachment hints in features', () => {
    const catalog = makeCatalog(['file', 'strings'])
    const classifier = new ChallengeClassifier(catalog)

    const result = classifier.classify({
      id: 'c9',
      title: 'Forensics',
      category: 'forensics',
      description: 'Analyze this image file',
      inputArtifactPaths: ['flag.png'],
    })

    expect(result.features.hasAttachments).toBe(true)
    expect(result.features.attachmentHints).toContain('flag.png')
  })

  it('upgrades crypto to heavy when heavy keyword detected', () => {
    const catalog = makeCatalog(['file', 'strings', 'rsactftool'])
    const classifier = new ChallengeClassifier(catalog)

    const result = classifier.classify({
      id: 'c10',
      title: 'Padding Oracle',
      category: 'crypto',
      description: 'Exploit a padding oracle attack on AES-CBC.',
    })

    expect(result.tier).toBe('heavy')
  })

  it('handles empty description gracefully', () => {
    const catalog = makeCatalog(['file', 'strings'])
    const classifier = new ChallengeClassifier(catalog)

    const result = classifier.classify({
      id: 'c11',
      title: 'Unknown',
      category: 'misc',
      description: '',
    })

    expect(result.tier).toBeDefined()
    expect(result.features.descriptionKeywords).toHaveLength(0)
  })
})
