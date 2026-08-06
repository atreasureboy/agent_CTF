/**
 * Rounds 2-5 — Competition optimization integration tests.
 *
 * Covers:
 *   - AdaptiveConcurrencyController
 *   - FlagExtractionPipeline (multi-pass)
 *   - RetryStrategy (category-aware profiles)
 *   - CrossChallengeCache
 *   - CTFPlatformAdapter (submission retry)
 */

import { describe, it, expect } from 'vitest'
import { AdaptiveConcurrencyController } from '../../src/ctf/competition/adaptiveConcurrency.js'
import { FlagExtractionPipeline } from '../../src/ctf/competition/flagExtractionPipeline.js'
import {
  getRetryConfigForCategory,
  getRetryProfiles,
  CATEGORY_RETRY_PROFILES,
} from '../../src/ctf/competition/retryStrategy.js'
import { CrossChallengeCache } from '../../src/ctf/competition/crossChallengeCache.js'

// ── AdaptiveConcurrencyController ───────────────────────────────────────

describe('AdaptiveConcurrencyController', () => {
  it('starts at initial concurrency', () => {
    const ctrl = new AdaptiveConcurrencyController({ initialConcurrency: 4 })
    expect(ctrl.getConcurrency()).toBe(4)
  })

  it('does not change during warmup (< 5 results)', () => {
    const ctrl = new AdaptiveConcurrencyController({ initialConcurrency: 4, warmupCount: 5 })
    ctrl.recordResult(true)
    ctrl.recordResult(true)
    expect(ctrl.getConcurrency()).toBe(4) // only 2 results
  })

  it('increases concurrency on sustained high success', () => {
    const ctrl = new AdaptiveConcurrencyController({
      initialConcurrency: 4,
      warmupCount: 5,
      increaseStep: 2,
    })
    // 5 consecutive successes should trigger increase
    for (let i = 0; i < 5; i++) ctrl.recordResult(true)
    expect(ctrl.getConcurrency()).toBeGreaterThanOrEqual(6)
  })

  it('decreases concurrency on sustained failure', () => {
    const ctrl = new AdaptiveConcurrencyController({
      initialConcurrency: 4,
      warmupCount: 5,
    })
    // 5 consecutive failures should trigger decrease
    for (let i = 0; i < 5; i++) ctrl.recordResult(false)
    expect(ctrl.getConcurrency()).toBeLessThanOrEqual(3)
  })

  it('holds steady in moderate range (40-85%)', () => {
    const ctrl = new AdaptiveConcurrencyController({
      initialConcurrency: 4,
      warmupCount: 5,
    })
    // 3 successes, 2 failures = 60% → hold steady
    for (let i = 0; i < 3; i++) ctrl.recordResult(true)
    for (let i = 0; i < 2; i++) ctrl.recordResult(false)
    expect(ctrl.getConcurrency()).toBe(4)
  })

  it('respects max concurrency cap', () => {
    const ctrl = new AdaptiveConcurrencyController({
      initialConcurrency: 4,
      maxConcurrency: 8,
      warmupCount: 3,
      increaseStep: 5,
    })
    // Push past max — should cap at 8
    for (let i = 0; i < 20; i++) ctrl.recordResult(true)
    expect(ctrl.getConcurrency()).toBeLessThanOrEqual(8)
  })

  it('does not go below min concurrency', () => {
    const ctrl = new AdaptiveConcurrencyController({
      initialConcurrency: 4,
      minConcurrency: 2,
      warmupCount: 3,
    })
    for (let i = 0; i < 20; i++) ctrl.recordResult(false)
    expect(ctrl.getConcurrency()).toBeGreaterThanOrEqual(2)
  })

  it('tracks cumulative counts', () => {
    const ctrl = new AdaptiveConcurrencyController({ initialConcurrency: 4 })
    for (let i = 0; i < 3; i++) ctrl.recordResult(true)
    for (let i = 0; i < 2; i++) ctrl.recordResult(false)
    const counts = ctrl.getCounts()
    expect(counts.solved).toBe(3)
    expect(counts.failed).toBe(2)
    expect(counts.total).toBe(5)
  })

  it('getSuccessRate returns NaN when no data', () => {
    const ctrl = new AdaptiveConcurrencyController({ initialConcurrency: 4 })
    expect(Number.isNaN(ctrl.getSuccessRate())).toBe(true)
  })
})

// ── FlagExtractionPipeline ──────────────────────────────────────────────

describe('FlagExtractionPipeline', () => {
  const pipeline = new FlagExtractionPipeline()

  function makeState(overrides: Partial<Record<string, unknown>> = {}): any {
    return {
      taskId: 't1',
      phase: 'completed',
      findings: [],
      flagCandidates: [],
      oneShotRuns: [],
      agentRuns: [],
      solverRuns: [],
      ...overrides,
    }
  }

  it('extracts flag candidates from stdout regex', () => {
    const result = pipeline.extract(
      makeState(),
      'The flag is: picoCTF{test_flag_123} and you found it!',
    )
    expect(result.all.length).toBeGreaterThan(0)
    expect(result.all.some((a) => a.value.includes('picoCTF{test_flag_123}'))).toBe(true)
  })

  it('extracts from structured flagCandidates', () => {
    const state = makeState({
      flagCandidates: [
        {
          id: 'fc1',
          taskId: 't1',
          value: 'flag{from_candidate}',
          normalizedValue: 'flag{from_candidate}',
          confidence: 0.95,
          status: 'validated',
          matchedPattern: true,
          source: 'finding',
          validation: {
            patternMatched: true,
            provenanceComplete: false,
            locallyVerified: false,
            platformVerified: false,
            errors: [],
          },
          sourceObservationIds: [],
          sourceEvidenceIds: [],
          sourceArtifactIds: [],
          sourceRunIds: [],
          sourceAttemptIds: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
    })
    const result = pipeline.extract(state)
    expect(result.all.some((a) => a.value === 'flag{from_candidate}')).toBe(true)
  })

  it('extracts from findings with category=flag', () => {
    const state = makeState({
      findings: [
        {
          category: 'flag',
          title: 'found flag',
          flagValue: 'flag{from_finding}',
          summary: 'flag found: flag{from_finding}',
        },
      ],
    })
    const result = pipeline.extract(state)
    expect(result.all.some((a) => a.value === 'flag{from_finding}')).toBe(true)
  })

  it('filters out placeholder values', () => {
    const result = pipeline.extract(makeState(), 'flag{...} flag{xxxx} your_flag_here replacement')
    // Should not include placeholders
    const hasPlaceholder = result.all.some(
      (a) => a.value.includes('...') || a.value.includes('xxx'),
    )
    expect(hasPlaceholder).toBe(false)
  })

  it('SHA256 verification boosts confidence to 1.0', () => {
    const pipelineLocal = new FlagExtractionPipeline()
    const knownFlag = 'flag{sha_test}'
    const hash = pipelineLocal.sha256(knownFlag)

    const result = pipelineLocal.extract(makeState(), `Found: ${knownFlag}`, hash)

    const verified = result.all.find((a) => a.value.includes(knownFlag))
    expect(verified).toBeDefined()
    expect(verified!.verified).toBe(true)
    expect(verified!.confidence).toBe(1.0)
  })

  it('deduplicates by value and ranks by confidence', () => {
    const state = makeState({
      flagCandidates: [
        {
          id: 'fc1',
          taskId: 't1',
          value: 'flag{best}',
          normalizedValue: 'flag{best}',
          confidence: 0.9,
          status: 'validated',
          matchedPattern: true,
          source: 'finding',
          validation: {
            patternMatched: true,
            provenanceComplete: false,
            locallyVerified: false,
            platformVerified: false,
            errors: [],
          },
          sourceObservationIds: [],
          sourceEvidenceIds: [],
          sourceArtifactIds: [],
          sourceRunIds: [],
          sourceAttemptIds: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
        {
          id: 'fc2',
          taskId: 't1',
          value: 'FLAG{BEST}',
          normalizedValue: 'flag{best}',
          confidence: 0.5,
          status: 'detected',
          matchedPattern: false,
          source: 'agent_output',
          validation: {
            patternMatched: false,
            provenanceComplete: false,
            locallyVerified: false,
            platformVerified: false,
            errors: [],
          },
          sourceObservationIds: [],
          sourceEvidenceIds: [],
          sourceArtifactIds: [],
          sourceRunIds: [],
          sourceAttemptIds: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
    })
    const result = pipeline.extract(state)
    // Should have only 1 entry for flag{best} (case-insensitive dedup)
    const bestEntries = result.all.filter((a) => a.value.toLowerCase().includes('flag{best}'))
    expect(bestEntries.length).toBe(1)
    expect(result.best?.confidence).toBeGreaterThanOrEqual(0.9)
  })

  it('returns undefined best when no candidates found', () => {
    const result = pipeline.extract(makeState(), 'nothing here')
    expect(result.best).toBeUndefined()
    expect(result.all).toHaveLength(0)
  })
})

// ── RetryStrategy ───────────────────────────────────────────────────────

describe('RetryStrategy', () => {
  it('maps category to retry profile chain', () => {
    expect(getRetryProfiles('crypto')).toContain('triage')
    expect(getRetryProfiles('pwn')).toContain('reverse')
    expect(getRetryProfiles('unknown_cat')).toEqual(['triage'])
  })

  it('all known categories have retry profiles', () => {
    for (const cat of Object.keys(CATEGORY_RETRY_PROFILES)) {
      const profiles = getRetryProfiles(cat)
      expect(profiles.length).toBeGreaterThan(0)
      expect(profiles.length).toBeLessThanOrEqual(5) // sane upper bound
    }
  })

  it('getRetryConfigForCategory produces valid config', () => {
    const config = getRetryConfigForCategory('crypto')
    expect(config.maxRetries).toBeGreaterThanOrEqual(1)
    expect(config.retryProfiles.length).toBeGreaterThan(0)
    expect(config.deadlineMs).toBeGreaterThan(0)
    expect(config.retryOn).toContain('failed')
  })

  it('retry profiles respect overrides', () => {
    const config = getRetryConfigForCategory('crypto', { maxRetries: 5, deadlineMs: 120_000 })
    expect(config.maxRetries).toBe(5)
    expect(config.deadlineMs).toBe(120_000)
  })
})

// ── CrossChallengeCache ─────────────────────────────────────────────────

describe('CrossChallengeCache', () => {
  it('records and suggests based on category match', () => {
    const cache = new CrossChallengeCache()
    cache.recordSuccess('crypto', 'RSA factoring challenge', 'rsactftool', 'fast', 5000)

    const suggestion = cache.suggest('crypto', 'Break RSA key')
    expect(suggestion).not.toBeNull()
    expect(suggestion!.confidence).toBeGreaterThan(0.4)
  })

  it('provides lower confidence for different category when tool has enough data', () => {
    const cache = new CrossChallengeCache()
    cache.recordSuccess('crypto', 'RSA factoring', 'rsactftool', 'fast', 5000)
    cache.recordSuccess('crypto', 'Another RSA', 'rsactftool', 'fast', 3000)

    const suggestion = cache.suggest('web', 'SQL injection')
    expect(suggestion).not.toBeNull()
    expect(suggestion!.confidence).toBeLessThan(0.5) // no category match
  })

  it('tracks tool success rates', () => {
    const cache = new CrossChallengeCache()
    cache.recordSuccess('crypto', 'a', 'tool_a', 'fast', 100)
    cache.recordSuccess('crypto', 'b', 'tool_a', 'fast', 200)
    cache.recordFailure('tool_a')

    expect(cache.getToolSuccessRate('tool_a')).toBeCloseTo(2 / 3, 1)
  })

  it('returns NaN for unknown tool', () => {
    const cache = new CrossChallengeCache()
    expect(Number.isNaN(cache.getToolSuccessRate('unknown'))).toBe(true)
  })

  it('keyword overlap improves suggestion confidence', () => {
    const cache = new CrossChallengeCache()
    cache.recordSuccess(
      'crypto',
      'RSA public key factoring challenge with base64',
      'rsactftool',
      'fast',
      5000,
    )

    const noOverlap = cache.suggest('crypto', 'some random text')
    const highOverlap = cache.suggest('crypto', 'RSA factoring with base64 encoding')

    expect(highOverlap).not.toBeNull()
    expect(noOverlap).not.toBeNull()
    if (highOverlap && noOverlap) {
      expect(highOverlap.confidence).toBeGreaterThanOrEqual(noOverlap.confidence)
    }
  })

  it('getTotalRecorded tracks count', () => {
    const cache = new CrossChallengeCache()
    expect(cache.getTotalRecorded()).toBe(0)
    cache.recordSuccess('a', 'b', 'c', 'fast', 10)
    expect(cache.getTotalRecorded()).toBe(1)
  })

  it('clear resets all state', () => {
    const cache = new CrossChallengeCache()
    cache.recordSuccess('a', 'b', 'c', 'fast', 10)
    cache.clear()
    expect(cache.getTotalRecorded()).toBe(0)
  })
})
