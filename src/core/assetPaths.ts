/**
 * Package-asset location helpers.
 *
 * The runtime ships domain assets alongside the code (`src/knowledge/*.md`,
 * `oneshot/manifests/*.json`, `oneshot/scripts/*.py`). Operators may run the
 * CLI from any working directory (repo checkout, npm global install, contest
 * workspace), so asset resolution must not assume `cwd == package root`.
 *
 * These helpers resolve an asset relative to an anchor directory — the
 * directory of the *calling module* — probing the anchor itself and up to
 * four parent levels. That covers every module depth in both layouts:
 *
 *   source tree:  src/core/x.ts              → 2 levels to root
 *                 src/core/ctfRuntime/x.ts   → 3 levels to root
 *   compiled:     dist/src/core/x.js         → 3 levels to root
 *                 dist/src/core/ctfRuntime/x.js → 4 levels to root
 *
 * Callers keep cwd-first semantics: probe cwd explicitly, then fall back to
 * `locateAssetFromModule(import.meta.url, rel)`.
 */

import { existsSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

/** Candidate paths for `rel` from `anchorDir`, in priority order. */
export function assetCandidates(anchorDir: string, rel: string): string[] {
  return [
    resolve(anchorDir, rel),
    resolve(anchorDir, '..', rel),
    resolve(anchorDir, '..', '..', rel),
    resolve(anchorDir, '..', '..', '..', rel),
    resolve(anchorDir, '..', '..', '..', '..', rel),
  ]
}

/** First existing candidate for `rel` from `anchorDir`, or '' when absent. */
export function locateAsset(anchorDir: string, rel: string): string {
  for (const candidate of assetCandidates(anchorDir, rel)) {
    if (existsSync(candidate)) return candidate
  }
  return ''
}

/** `locateAsset` anchored at the directory of the module at `moduleUrl`. */
export function locateAssetFromModule(moduleUrl: string | URL, rel: string): string {
  return locateAsset(dirname(fileURLToPath(moduleUrl)), rel)
}
