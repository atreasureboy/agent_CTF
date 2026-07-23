/**
 * Catalog — in-memory index of every loaded OneShotManifest.
 *
 * The Catalog only holds parsed/validated manifests. Invalid manifests
 * are recorded separately (one-shot registry keeps the raw + error)
 * so a misconfigured manifest cannot crash the runtime — it only
 * disables the integration.
 */

import type { OneShotManifest } from './types.js'

export interface InvalidManifest {
  raw: unknown
  error: string
}

export class OneShotCatalog {
  private readonly byId = new Map<string, OneShotManifest>()
  private readonly byCategory = new Map<string, OneShotManifest[]>()
  private readonly invalidManifests: InvalidManifest[] = []

  /** Idempotent register: same id replaces. */
  upsert(manifest: OneShotManifest): void {
    if (this.byId.has(manifest.id)) this.remove(manifest.id)
    this.byId.set(manifest.id, manifest)
    const list = this.byCategory.get(manifest.category) ?? []
    list.push(manifest)
    this.byCategory.set(manifest.category, list)
  }

  has(id: string): boolean {
    return this.byId.has(id)
  }

  get(id: string): OneShotManifest | undefined {
    return this.byId.get(id)
  }

  remove(id: string): boolean {
    const m = this.byId.get(id)
    if (!m) return false
    this.byId.delete(id)
    const list = this.byCategory.get(m.category)
    if (list) {
      const idx = list.indexOf(m)
      if (idx >= 0) list.splice(idx, 1)
      if (list.length === 0) this.byCategory.delete(m.category)
    }
    return true
  }

  list(): OneShotManifest[] {
    return [...this.byId.values()]
  }

  listByCategory(category: string): OneShotManifest[] {
    return [...(this.byCategory.get(category) ?? [])]
  }

  listByLane(lane: 'fast' | 'medium' | 'heavy'): OneShotManifest[] {
    return this.list().filter((m) => m.scheduling.costTier === lane)
  }

  /** Manifests flagged enabled-by-default. */
  listDefaultEnabled(): OneShotManifest[] {
    return this.list().filter((m) => m.enabledByDefault)
  }

  /** Tracks bad manifests so Doctor can report them. */
  recordInvalid(raw: unknown, error: string): void {
    this.invalidManifests.push({ raw, error })
  }

  invalidList(): ReadonlyArray<InvalidManifest> {
    return this.invalidManifests
  }
}

/** Global default catalog, populated by the framework's bootstrap. */
export const globalOneShotCatalog = new OneShotCatalog()
