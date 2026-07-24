/**
 * EpisodicMemory — action trajectory persistence
 *
 * Records "what I did, what happened, was it successful" for each tool call
 * and agent action. Lets the agent review its recent history of attempts
 * without re-reading the full conversation.
 *
 * Storage: ~/.ovogo/projects/{slug}/memory/episodes.jsonl
 *
 * Durability: writes are atomic (temp + rename) so a mid-write crash does
 * not leave a truncated trailing line. Mirrors the pattern used by
 * SessionStore, BackgroundJobManager, ArtifactStore, and FindingStore.
 */

import { appendFileSync, existsSync, readFileSync, mkdirSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'

export interface EpisodicMemoryEntry {
  id: string
  turn: number
  toolName: string
  inputSummary: string // truncated input
  resultSummary: string // truncated result
  outcome: 'success' | 'failure' | 'partial'
  duration?: number // ms
  timestamp: string // ISO 8601
}

function nextId(): string {
  return `epi_${randomUUID()}`
}

// Hard cap on retained episodes. The file grows by one line per tool call, so
// without a bound it becomes unbounded over long sessions and every read (which
// loads the whole file then slices) turns O(n). When the file exceeds the cap we
// trim the oldest entries in place — keeping the freshest trajectory.
const MAX_EPISODES = 2000

export class EpisodicMemory {
  private filePath: string

  constructor(projectDir: string) {
    const memDir = join(projectDir, 'memory')
    try {
      mkdirSync(memDir, { recursive: true })
    } catch {
      /* best-effort */
    }
    this.filePath = join(memDir, 'episodes.jsonl')
  }

  /** Append a new episode entry (atomic via temp + rename). */
  write(entry: Omit<EpisodicMemoryEntry, 'id'>): EpisodicMemoryEntry {
    const full: EpisodicMemoryEntry = { ...entry, id: nextId() }
    const line = JSON.stringify(full) + '\n'
    try {
      // Phase 1.7 audit — atomic append. We write the NEW line plus the
      // existing file content into a temp sidecar, then rename over the
      // original. A crash mid-write leaves the original file untouched
      // (or the temp file; readers tolerate either).
      if (existsSync(this.filePath)) {
        let existing = ''
        try {
          existing = readFileSync(this.filePath, 'utf8')
        } catch {
          /* file unreadable — fall back to fresh line */
        }
        // Trim any dangling partial line from the previous crash so the
        // recovered file remains valid JSONL.
        const lastNl = existing.lastIndexOf('\n')
        if (lastNl >= 0 && existing.length - lastNl > 1) {
          existing = existing.slice(0, lastNl + 1)
        }
        const tmp = `${this.filePath}.tmp.${process.pid}`
        writeFileSync(tmp, existing + line, 'utf8')
        renameSync(tmp, this.filePath)
      } else {
        // First write — direct appendFileSync is safe (creates the file).
        appendFileSync(this.filePath, line, 'utf8')
      }
    } catch {
      /* best-effort */
    }
    return full
  }

  /** Read the most recent N episodes */
  recent(limit = 20): EpisodicMemoryEntry[] {
    const all = this.readAll()
    return all.slice(-limit)
  }

  /** Read all entries, trimming oldest when the file exceeds MAX_EPISODES */
  readAll(): EpisodicMemoryEntry[] {
    if (!existsSync(this.filePath)) return []
    try {
      const lines = readFileSync(this.filePath, 'utf8').trim().split('\n').filter(Boolean)
      // Lazy rotation: if the file outgrew the cap, rewrite it keeping the
      // newest MAX_EPISODES entries so subsequent reads stay cheap.
      let kept = lines
      if (lines.length > MAX_EPISODES) {
        kept = lines.slice(-MAX_EPISODES)
        // Phase 1.7 audit — atomic rotation. temp + rename so a crash
        // mid-rotation does not leave the file empty.
        try {
          const tmp = `${this.filePath}.tmp.${process.pid}`
          writeFileSync(tmp, kept.join('\n') + '\n', 'utf8')
          renameSync(tmp, this.filePath)
        } catch {
          /* best-effort rotation; in-memory slice still correct */
        }
      }
      return kept
        .map((l) => {
          try {
            return JSON.parse(l) as EpisodicMemoryEntry
          } catch {
            return null
          }
        })
        .filter((e): e is EpisodicMemoryEntry => e !== null)
    } catch {
      return []
    }
  }

  /** Search episodes by tool name */
  findByTool(toolName: string, limit = 10): EpisodicMemoryEntry[] {
    const all = this.readAll()
    return all.filter((e) => e.toolName === toolName).slice(-limit)
  }
}
