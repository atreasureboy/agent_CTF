/**
 * Manifest loader — read all JSON manifests from a directory into the
 * Catalog. Designed to be invoked at process start.
 *
 * Failures (read errors, parse errors) are recorded as InvalidManifests so
 * Doctor can list them; they never crash the runtime.
 */

import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { OneShotCatalog } from './catalog.js'
import { safeParseManifest } from './manifestSchema.js'
import type { OneShotManifest } from './types.js'

export interface LoadResult {
  accepted: OneShotManifest[]
  invalid: Array<{ file: string; error: string }>
}

/** Read all *.json manifests in `dir`, register valid ones into `catalog`. */
export function loadManifestsFromDir(
  dir: string,
  catalog: OneShotCatalog = new OneShotCatalog(),
): LoadResult {
  const accepted: OneShotManifest[] = []
  const invalid: LoadResult['invalid'] = []
  let files: string[]
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'))
  } catch (err) {
    invalid.push({ file: dir, error: `cannot read directory: ${(err as Error).message}` })
    return { accepted, invalid }
  }
  for (const file of files) {
    const fullPath = join(dir, file)
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(fullPath, 'utf8'))
    } catch (err) {
      invalid.push({ file, error: `cannot parse: ${(err as Error).message}` })
      continue
    }
    const r = safeParseManifest(raw)
    if (r.ok) {
      catalog.upsert(r.manifest)
      accepted.push(r.manifest)
    } else {
      catalog.recordInvalid(raw, r.error)
      invalid.push({ file, error: r.error })
    }
  }
  return { accepted, invalid }
}
