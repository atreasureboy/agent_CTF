/**
 * Selector — given a task description + already-known Findings, decide
 * which one-shot manifests are eligible.
 *
 * Selection order (six_goal §八 / §九):
 *   1. manifest enabled-by-default (or runtime override).
 *   2. profile-allowed filter — match manifest.allowedProfiles.
 *   3. category match — heuristics on task description / extension / mime.
 *   4. dedupe by id (one shot per matched manifest).
 */

import type {
  OneShotJobProjectionEvent,
  OneShotLane,
  OneShotManifest,
} from './types.js'
import type { OneShotCatalog } from './catalog.js'

export interface SelectionInput {
  taskId: string
  /** Active profile (e.g. 'image-stego'). */
  profileId: string
  /** Free-form description / objective. */
  taskText: string
  /** Already-known artifacts (file paths, mime types, tags). */
  artifactHints?: string[]
  /** Already-known findings — boosts manifests that say "skip if covered". */
  existingFindingTitles?: string[]
  /** Defaults to true on production, false in unit tests. */
  includeExperimental?: boolean
}

export interface SelectedRun {
  manifest: OneShotManifest
  lane: OneShotLane
  reason: string
}

const TAG_HINTS: Array<{ match: RegExp; tag: string }> = [
  { match: /\bpng\b|\.png\b/i, tag: 'image' },
  { match: /\bjpe?g\b|\.jpe?g\b/i, tag: 'image' },
  { match: /\bzip\b|\.zip\b/i, tag: 'archive' },
  { match: /\b(pcap|pcapng)\b|\.pcap\b/i, tag: 'pcap' },
  { match: /\b(elf|pe|exe|dll|so)\b/i, tag: 'binary' },
  { match: /\b(rsa|n\s*=\s*\d|pub.*key)/i, tag: 'rsa' },
  { match: /\b(base64|hex)\b/i, tag: 'encoded' },
]

function deriveTags(input: SelectionInput): Set<string> {
  const tags = new Set<string>()
  const blob = `${input.taskText} ${(input.artifactHints ?? []).join(' ')}`
  for (const { match, tag } of TAG_HINTS) {
    if (match.test(blob)) tags.add(tag)
  }
  return tags
}

export function selectManifests(input: SelectionInput, catalog: OneShotCatalog): SelectedRun[] {
  const tags = deriveTags(input)
  const selected: SelectedRun[] = []

  for (const manifest of catalog.list()) {
    if (!manifest.enabledByDefault && !input.includeExperimental) continue
    if (manifest.excludedProfiles?.includes(input.profileId)) continue
    if (!manifest.allowedProfiles.includes(input.profileId)) continue

    const m = manifest.inputMatchers
    if (m?.extensions || m?.mimeTypes || m?.magicPatterns) {
      const extMatch = m.extensions?.some((e) => input.artifactHints?.some((h) => h.toLowerCase().endsWith(e.toLowerCase()))) ?? false
      // §P1 audit fix — match MIME by full equality on `type/subtype` or
      // by major type prefix. The previous `h.includes(t)` substring
      // check accepted any hint that contained the MIME as a substring
      // (e.g. `"image"` would match anything containing the word "image").
      const mimeMatch = m.mimeTypes?.some((t) =>
        input.artifactHints?.some((h) => h === t || h.startsWith(`${t.split('/')[0]}/`)),
      ) ?? false
      const magicMatch = m.magicPatterns?.some((p) => input.taskText.includes(p)) ?? false
      const requiredArtifactMatch = m.requiredArtifacts?.some((r) => input.artifactHints?.some((h) => h.includes(r))) ?? false
      const taskTagMatch = m.taskTags?.some((t) => tags.has(t)) ?? false
      if (!(extMatch || mimeMatch || magicMatch || requiredArtifactMatch || taskTagMatch)) {
        continue
      }
    }

    // §二十三 / P1 audit fix — `fast-tier` is NOT unconditionally eligible.
    // Selection must rest on a real match (profile + inputMatchers) or
    // a recent successful attempt; otherwise the fast tier is rejected
    // along with everything else.
    let reason = 'profile match'
    if (manifest.inputMatchers?.taskTags?.some((t) => tags.has(t))) {
      reason = 'task-tag match'
    } else if (manifest.inputMatchers?.extensions ||
               manifest.inputMatchers?.mimeTypes ||
               manifest.inputMatchers?.magicPatterns ||
               manifest.inputMatchers?.requiredArtifacts) {
      reason = 'input match'
    }

    // §二十三 / P1 audit fix — skip when an existing finding already covers
    // the manifest's category/tag (de-duplication across runs).
    if (input.existingFindingTitles && input.existingFindingTitles.length > 0) {
      const manifestCategory = manifest.category
      const covered = input.existingFindingTitles.some((title) =>
        title.toLowerCase().includes(manifestCategory.toLowerCase()),
      )
      if (covered) {
        continue
      }
    }

    selected.push({
      manifest,
      lane: manifest.scheduling.costTier,
      reason,
    })
  }
  return selected
}

/** Convert a SelectedRun into a queued projection event the BackgroundJobManager
 *  can surface to TaskState. */
export function projectQueued(run: SelectedRun, taskId: string, at: string): OneShotJobProjectionEvent {
  return {
    type: 'ONESHOT_QUEUED',
    runId: '', // assigned by dispatcher
    manifestId: run.manifest.id,
    taskId,
    lane: run.lane,
    at,
    detail: { reason: run.reason },
  }
}
