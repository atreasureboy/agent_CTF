/**
 * Findings — structured cross-agent observations that flow from specialist
 * Agents back to the Orchestrator (and onward to the next specialist via
 * HandoffRequest).
 *
 * A Finding is a typed, evidence-backed assertion. It is NOT raw tool output:
 * the Broker is responsible for keeping tool outputs as artifacts; Findings
 * are what the model returns to summarise a domain-level conclusion.
 */

import { randomBytes } from 'crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs'
import { dirname, join } from 'path'
import type { ArtifactMeta } from './artifacts.js'

export type FindingCategory =
  | 'triage'
  | 'forensics'
  | 'image'
  | 'crypto'
  | 'web'
  | 'reverse'
  | 'pwn'
  | 'network'
  | 'workflow'
  | 'obfuscation'
  | 'handoff'
  | 'verifier'

export type FindingConfidence = 'low' | 'medium' | 'high'

export interface Finding {
  id: string
  taskId: string
  producerAgentId: string
  category: FindingCategory
  title: string
  summary: string
  confidence: FindingConfidence
  evidence: string[]
  artifactIds: string[]
  recommendedNextActions?: string[]
  suggestedAgent?: string
  /** Phase 1.7 §十三.3 — Run-id association so the projector can
   *  filter by agent / workflow / handoff instead of relying on
   *  global snapshot diffs. All optional so existing emitters
   *  without explicit run context still work. */
  agentRunId?: string
  workflowRunId?: string
  handoffId?: string
  createdAt: string
}

export interface NewFinding {
  taskId: string
  producerAgentId: string
  category: FindingCategory
  title: string
  summary: string
  confidence: FindingConfidence
  evidence?: string[]
  artifactIds?: string[]
  recommendedNextActions?: string[]
  suggestedAgent?: string
  /** Phase 1.7 §十三.3 — Run-id association. */
  agentRunId?: string
  workflowRunId?: string
  handoffId?: string
}

function makeId(): string {
  return `find_${randomBytes(8).toString('hex')}`
}

export class FindingStore {
  private readonly filePath: string

  constructor(rootDir: string) {
    this.filePath = join(rootDir, 'findings.jsonl')
    mkdirSync(dirname(this.filePath), { recursive: true })
  }

  append(input: NewFinding): Finding {
    const f: Finding = {
      id: makeId(),
      taskId: input.taskId,
      producerAgentId: input.producerAgentId,
      category: input.category,
      title: input.title,
      summary: input.summary,
      confidence: input.confidence,
      evidence: input.evidence ?? [],
      artifactIds: input.artifactIds ?? [],
      recommendedNextActions: input.recommendedNextActions,
      suggestedAgent: input.suggestedAgent,
      // §十三.3 — propagate run-id so the projector can filter by it.
      agentRunId: input.agentRunId,
      workflowRunId: input.workflowRunId,
      handoffId: input.handoffId,
      createdAt: new Date().toISOString(),
    }
    appendFileSync(this.filePath, JSON.stringify(f) + '\n', 'utf8')
    return f
  }

  list(filter?: (f: Finding) => boolean): Finding[] {
    if (!existsSync(this.filePath)) return []
    const out: Finding[] = []
    for (const line of readFileSync(this.filePath, 'utf8').split('\n').filter(Boolean)) {
      try {
        const f = JSON.parse(line) as Finding
        if (!filter || filter(f)) out.push(f)
      } catch {
        continue
      }
    }
    return out
  }

  /** Resolve artifact metadata references inside a finding. */
  static resolveArtifacts(
    f: Finding,
    store: { read(id: string): ArtifactMeta | null },
  ): ArtifactMeta[] {
    return f.artifactIds.map((id) => store.read(id)).filter((a): a is ArtifactMeta => a !== null)
  }
}

/** Render a finding as a short Markdown block for the model. */
export function formatFindingForPrompt(f: Finding): string {
  const lines: string[] = [
    `- [${f.confidence.toUpperCase()}] (${f.category}) ${f.title}`,
    `  ${f.summary}`,
  ]
  if (f.evidence.length > 0) {
    lines.push(`  evidence:`)
    for (const e of f.evidence) lines.push(`    - ${e}`)
  }
  if (f.artifactIds.length > 0) {
    lines.push(`  artifacts: ${f.artifactIds.join(', ')}`)
  }
  if (f.recommendedNextActions && f.recommendedNextActions.length > 0) {
    lines.push(`  next: ${f.recommendedNextActions.join('; ')}`)
  }
  return lines.join('\n')
}
