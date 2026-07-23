/**
 * PendingActionStore — Phase 2.2 §二十二.
 *
 * Each task holds a set of "pending" SuggestedActions that the
 * Planner can choose from. The lifecycle is:
 *
 *   pending  →  selected  →  executed
 *   pending  →  rejected
 *   pending  →  expired   (when its evidence or hypothesis is
 *                          retracted / rejected)
 *
 * The Planner reads from `listEligible()` which returns only
 * pending actions whose evidence / hypothesis is still valid.
 *
 * Implemented as a plain class so callers can inject a custom
 * backing store (the live task state carries the canonical list).
 */

import type { SuggestedAction } from './suggestedAction.js'

export type PendingActionStatus =
  | 'pending'
  | 'selected'
  | 'executed'
  | 'rejected'
  | 'expired'

export interface PendingSuggestedAction {
  /** Stable id (sha256 of fingerprint). */
  id: string
  action: SuggestedAction
  status: PendingActionStatus
  producedByObservationIds: string[]
  producedByEvidenceIds: string[]
  producedByHypothesisIds: string[]
  createdAt: number
  updatedAt: number
}

export interface PendingActionStore {
  add(actions: ReadonlyArray<{
    action: SuggestedAction
    observationIds: string[]
    evidenceIds: string[]
    hypothesisIds: string[]
  }>): string[]
  select(id: string): void
  markExecuted(id: string): void
  reject(id: string): void
  expire(ids: ReadonlyArray<string>): void
  listEligible(): ReadonlyArray<PendingSuggestedAction>
  size(): number
}

import { createHash } from 'crypto'

function fingerprint(action: SuggestedAction): string {
  const payload = JSON.stringify({
    type: action.type,
    targetId: targetIdOf(action),
    reason: action.reason,
    priority: action.priority,
    costTier: action.costTier,
  })
  return createHash('sha256').update(payload).digest('hex')
}

function targetIdOf(a: SuggestedAction): string {
  switch (a.type) {
    case 'run_workflow': return a.workflowId
    case 'run_oneshot': return a.manifestId
    case 'call_tool': return a.toolId
    case 'request_handoff': return a.capability
    case 'verify_flag': return a.candidateId
    case 'stop': return 'stop'
  }
}

export function createPendingActionStore(): PendingActionStore {
  const items = new Map<string, PendingSuggestedAction>()
  return {
    add(actions) {
      const ids: string[] = []
      const now = Date.now()
      for (const a of actions) {
        const id = fingerprint(a.action)
        if (items.has(id)) continue
        items.set(id, {
          id,
          action: a.action,
          status: 'pending',
          producedByObservationIds: a.observationIds,
          producedByEvidenceIds: a.evidenceIds,
          producedByHypothesisIds: a.hypothesisIds,
          createdAt: now,
          updatedAt: now,
        })
        ids.push(id)
      }
      return ids
    },
    select(id) {
      const item = items.get(id)
      if (!item) return
      if (item.status !== 'pending') return
      items.set(id, { ...item, status: 'selected', updatedAt: Date.now() })
    },
    markExecuted(id) {
      const item = items.get(id)
      if (!item) return
      items.set(id, { ...item, status: 'executed', updatedAt: Date.now() })
    },
    reject(id) {
      const item = items.get(id)
      if (!item) return
      items.set(id, { ...item, status: 'rejected', updatedAt: Date.now() })
    },
    expire(ids) {
      const now = Date.now()
      for (const id of ids) {
        const item = items.get(id)
        if (!item) continue
        if (item.status !== 'pending') continue
        items.set(id, { ...item, status: 'expired', updatedAt: now })
      }
    },
    listEligible() {
      return [...items.values()].filter((i) => i.status === 'pending')
    },
    size() {
      return items.size
    },
  }
}