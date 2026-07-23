/**
 * Registry — single registration API for one-shot integrations.
 *
 * Decouples the runtime from any concrete catalog (tests can use their
 * own catalog, production uses the global).
 */

import { parseManifest, safeParseManifest } from './manifestSchema.js'
import type { OneShotCatalog } from './catalog.js'
import { globalOneShotCatalog } from './catalog.js'
import type { OneShotManifest } from './types.js'

export class OneShotRegistry {
  constructor(private readonly catalog: OneShotCatalog = globalOneShotCatalog) {}

  /** Strict register: invalid manifest throws ZodError. */
  register(manifest: unknown): OneShotManifest {
    const validated = parseManifest(manifest)
    this.catalog.upsert(validated)
    return validated
  }

  /**
   * Lenient register: invalid manifests are recorded as invalid (visible to
   * Doctor) but do not crash the runtime. Returns the parsed manifest if
   * valid, else null.
   */
  registerSafe(manifest: unknown): OneShotManifest | null {
    const r = safeParseManifest(manifest)
    if (r.ok) {
      this.catalog.upsert(r.manifest)
      return r.manifest
    }
    this.catalog.recordInvalid(manifest, r.error)
    return null
  }

  bulkRegisterSafe(manifests: ReadonlyArray<unknown>): OneShotManifest[] {
    const accepted: OneShotManifest[] = []
    for (const m of manifests) {
      const r = this.registerSafe(m)
      if (r) accepted.push(r)
    }
    return accepted
  }

  has(id: string): boolean {
    return this.catalog.has(id)
  }

  get(id: string): OneShotManifest | undefined {
    return this.catalog.get(id)
  }

  list(): OneShotManifest[] {
    return this.catalog.list()
  }
}

export const globalOneShotRegistry = new OneShotRegistry()
