/**
 * Phase 2.2 §二十六 — Evidence merge tests.
 *
 * Verifies that two parsers producing the same claim merge into one
 * Evidence with multiple Sources, and that conflict polarity is
 * preserved as a separate Evidence.
 */

import { describe, it, expect } from 'vitest'
import { CTFTaskStateStore } from '../src/core/ctfRuntime/taskStateStore.js'
import {
  createEvidence,
  mergeEvidence,
  combineIndependentConfidences,
} from '../src/core/ctfReasoning/evidence.js'
import { createTestTaskState } from './fixtures/createTestTaskState.js'

describe('Phase 2.2 §二十六 — Evidence merge', () => {
  it('FileParser + HexParser converge into one Evidence with two Sources', () => {
    const a = createEvidence('t', {
        kind: 'file_signature',
        claim: 'file is PNG',
        polarity: 'supports',
        source: {
          producer: { type: 'parser', id: 'file' },
          observationIds: ['o-file'],
          artifactIds: [],
          attemptIds: [],
          confidence: 0.85,
          createdAt: 0,
        },
      })
    const b = createEvidence('t', {
        kind: 'file_signature',
        claim: 'file is PNG',
        polarity: 'supports',
        source: {
          producer: { type: 'parser', id: 'hex' },
          observationIds: ['o-hex'],
          artifactIds: [],
          attemptIds: [],
          confidence: 0.98,
          createdAt: 0,
        },
      })
    // Identity excludes producer, so a.fingerprint === b.fingerprint.
    expect(a.fingerprint).toBe(b.fingerprint)
    const merged = mergeEvidence(a, b)
    expect(merged.sources.length).toBe(2)
    expect(merged.confidence).toBeGreaterThanOrEqual(0.98)
    expect(merged.confidence).toBeLessThanOrEqual(0.99)
    // Sources preserve both parser ids.
    const ids = merged.sources.map((s) => s.producer.id)
    expect(ids).toContain('file')
    expect(ids).toContain('hex')
  })

  it('conflict polarity produces two Evidences, not one', () => {
    const state = createTestTaskState({ taskId: 't' })
    const store = new CTFTaskStateStore(state)
    const png = createEvidence('t', {
      kind: 'file_signature', claim: 'file is PNG', polarity: 'supports',
      source: {
        producer: { type: 'parser', id: 'hex' }, observationIds: ['o1'], artifactIds: [], attemptIds: [],
        confidence: 0.95, createdAt: 0,
      },
    })
    const zip = createEvidence('t', {
      kind: 'file_signature', claim: 'file is ZIP', polarity: 'contradicts',
      source: {
        producer: { type: 'parser', id: 'file' }, observationIds: ['o2'], artifactIds: [], attemptIds: [],
        confidence: 0.85, createdAt: 0,
      },
    })
    store.apply({ type: 'EVIDENCE_ADDED', evidence: png })
    store.apply({ type: 'EVIDENCE_ADDED', evidence: zip })
    const evidence = store.getState().evidence
    expect(evidence.length).toBe(2)
    const supports = evidence.filter((e) => e.polarity === 'supports')
    const contradicts = evidence.filter((e) => e.polarity === 'contradicts')
    expect(supports.length).toBe(1)
    expect(contradicts.length).toBe(1)
  })

  it('confidence combination is bounded at 0.99', () => {
    const v = combineIndependentConfidences([
      { producer: { type: 'parser', id: 'a' }, observationIds: [], artifactIds: [], attemptIds: [], confidence: 0.9, createdAt: 0 },
      { producer: { type: 'parser', id: 'b' }, observationIds: [], artifactIds: [], attemptIds: [], confidence: 0.9, createdAt: 0 },
      { producer: { type: 'parser', id: 'c' }, observationIds: [], artifactIds: [], attemptIds: [], confidence: 0.9, createdAt: 0 },
    ])
    expect(v).toBeLessThanOrEqual(0.99)
    expect(v).toBeGreaterThanOrEqual(0.9)
  })
})