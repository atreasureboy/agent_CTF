/**
 * Phase A4 — CVE-aware loop detection.
 */

import { describe, it, expect } from 'vitest'
import { checkRepeat, fingerprintForHistory, LOOP_DETECTOR_CVE_LIMIT, LOOP_DETECTOR_REPEAT_LIMIT, type LoopDetectorEntry } from '../src/core/ctfReasoning/loopDetector.js'
import type { SuggestedAction } from '../src/core/ctfReasoning/suggestedAction.js'

describe('CVE-aware loop detector (A4)', () => {
  const baseAction: SuggestedAction = {
    type: 'call_tool',
    toolId: 'exploit',
    input: { cve: 'CVE-2024-1234' },
    reason: 'attempt',
    priority: 5,
    costTier: 'cheap',
  }

  function makeEntries(cve: string, count: number, now: number): LoopDetectorEntry[] {
    return Array.from({ length: count }, () => ({
      fingerprint: 'fp',
      actionType: 'call_tool' as const,
      targetId: 'exploit',
      at: now,
      cveId: cve === '' ? undefined : cve.toUpperCase(),
    }))
  }

  it('returns the standard verdict when no CVE is referenced', () => {
    const noCve: SuggestedAction = { ...baseAction, input: { cmd: 'whoami' } }
    const now = Date.now()
    const v = checkRepeat(makeEntries('', 0, now), noCve, now)
    expect(v.cveId).toBeUndefined()
    expect(v.cveRepeated).toBeUndefined()
  })

  it('detects a CVE and counts cveRepeated', () => {
    const now = Date.now()
    const history = makeEntries('CVE-2024-1234', LOOP_DETECTOR_CVE_LIMIT, now)
    const v = checkRepeat(history, baseAction, now)
    expect(v.cveId).toBe('CVE-2024-1234')
    expect(v.cveRepeated).toBe(true)
  })

  it('CVE short-circuit fires at LOOP_DETECTOR_CVE_LIMIT before the general LOOP_DETECTOR_REPEAT_LIMIT', () => {
    const now = Date.now()
    // 3 calls — short circuits on cve; general limit (5) is not yet hit.
    const history = makeEntries('CVE-2024-1234', 3, now)
    const v = checkRepeat(history, baseAction, now)
    expect(v.cveRepeated).toBe(true)
    expect(v.repeated).toBe(false) // only 3 of 5
  })

  it('detects GHSA / OSVDB identifiers too', () => {
    const now = Date.now()
    const action: SuggestedAction = { ...baseAction, input: { ghsa: 'GHSA-xxxx-yyyy' } }
    const v = checkRepeat(makeEntries('GHSA-xxxx-yyyy', LOOP_DETECTOR_CVE_LIMIT, now), action, now)
    expect(v.cveId).toBe('GHSA-XXXX-YYYY')
    expect(v.cveRepeated).toBe(true)
  })
})
