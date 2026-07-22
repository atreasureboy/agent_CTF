/**
 * ProfileStore — single authoritative source of "what profile is current".
 *
 * Goals (§七):
 *   - One Profile object per task. Every component (ToolBroker, Harness
 *     system-prompt builder, WorkflowRunner, Permission gate) reads from
 *     the same store.
 *   - Subscribers are notified on switch so dependent caches can refresh.
 *   - Switching is atomic: prepare new profile, validate it, then commit;
 *     subscribers either see old or new, never a half-migrated state.
 *
 * The orchestrator owns the ProfileStore instance and calls `switchTo()`
 * from its own `switchProfile()` API. The ToolBroker delegates
 * `getProfile()` / `setProfile()` to this store.
 */

import type { CapabilityProfile } from '../capabilityProfile.js'
import { PROFILES, getBuiltinProfile } from '../../capabilityProfiles/index.js'

export type ProfileListener = (next: CapabilityProfile) => void
export type Unsubscribe = () => void

export interface ProfileStore {
  getCurrent(): CapabilityProfile
  switchTo(next: CapabilityProfile): void
  subscribe(listener: ProfileListener): Unsubscribe
}

/**
 * Resolve a profile id to its `CapabilityProfile` instance. Throws a
 * descriptive error when the id is unknown. Canonical lookup shared by
 * `createCTFTaskRuntime` and `CTFTaskOrchestrator.switchProfile`.
 */
export function resolveProfileById(id: string): CapabilityProfile {
  const found = getBuiltinProfile(id) ?? PROFILES[id]
  if (!found) throw new Error(`Unknown profile: ${id}`)
  return found
}

export class CTFProfileStore implements ProfileStore {
  private current: CapabilityProfile
  private readonly listeners = new Set<ProfileListener>()

  constructor(initial: CapabilityProfile) {
    this.current = initial
  }

  getCurrent(): CapabilityProfile {
    return this.current
  }

  switchTo(next: CapabilityProfile): void {
    if (!next || !next.id) {
      throw new Error('ProfileStore.switchTo: profile must have an id')
    }
    if (next.id === this.current.id) return
    this.current = next
    for (const l of this.listeners) {
      try {
        l(next)
      } catch {
        /* best-effort */
      }
    }
  }

  subscribe(listener: ProfileListener): Unsubscribe {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
}