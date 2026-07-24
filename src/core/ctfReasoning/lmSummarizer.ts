/**
 * LMSummarizer — Phase borrow-plan Tier C3 (swe-agent pattern).
 *
 * swe-agent v0.7's `LMSummarizer` runs a *separate* LLM on the
 * truncated observations to produce a structured summary. When the
 * LLM itself summarises its own context, it tends to keep the bits
 * the model needs.
 *
 * Our `LMSummarizer` is a thin adapter:
 *   - Takes a list of observations.
 *   - Calls a `LanguageModel.generate(prompt)` (an opaque adapter).
 *   - Returns a structured `Summary` with key claims, observed
 *     categories, and open questions.
 *
 * The default `noOpLMSummarizer` returns a deterministic summary
 * built from the observations' kind + summary fields. Production
 * wires a real LLM (Claude / GPT-4 / Qwen) into `LMSummarizer`.
 */

import type { CTFTaskState } from '../ctfRuntime/taskState.js'

export interface SummaryInput {
  taskId: string
  observations: ReadonlyArray<CTFTaskState['observations'][number]>
  maxLength: number
}

export interface Summary {
  text: string
  claims: string[]
  categories: string[]
  openQuestions: string[]
}

export interface LanguageModel {
  /** Generate completion for a prompt. Implementations route to
   *  Claude / OpenAI / etc. */
  generate(prompt: string): Promise<string>
}

/** Deterministic LMSummarizer for tests / dry-run. */
export class NoOpLMSummarizer implements LanguageModel {
  async generate(prompt: string): Promise<string> {
    // Echo the first 200 chars of the prompt to give the caller
    // something to verify.
    return prompt.slice(0, 200)
  }
}

export class LMSummarizer {
  constructor(private readonly model: LanguageModel) {}

  async summarize(input: SummaryInput): Promise<Summary> {
    const prompt = buildPrompt(input)
    const text = await this.model.generate(prompt)
    return parseSummary(text, input.observations)
  }
}

function buildPrompt(input: SummaryInput): string {
  const obs = input.observations.map((o) => `- [${o.kind}] ${o.summary}`).join('\n')
  return `Summarize the following CTF observations for task ${input.taskId} in at most ${input.maxLength} characters.
Return a structured summary with:
- text: a single paragraph
- claims: a list of key claims
- categories: a list of observed categories
- openQuestions: a list of open questions

Observations:
${obs}
`
}

function parseSummary(
  text: string,
  observations: ReadonlyArray<CTFTaskState['observations'][number]>,
): Summary {
  // Heuristic: extract lines starting with `-` as bullet items.
  const lines = text.split('\n')
  const claims: string[] = []
  const categories: string[] = []
  const openQuestions: string[] = []
  for (const l of lines) {
    const m1 = /^-\s*claim:\s*(.+)$/.exec(l)
    if (m1) {
      claims.push(m1[1].trim())
      continue
    }
    const m2 = /^-\s*category:\s*(.+)$/.exec(l)
    if (m2) {
      categories.push(m2[1].trim())
      continue
    }
    const m3 = /^-\s*question:\s*(.+)$/.exec(l)
    if (m3) {
      openQuestions.push(m3[1].trim())
      continue
    }
  }
  if (claims.length === 0) claims.push(...observations.slice(0, 3).map((o) => o.summary))
  if (categories.length === 0) {
    const seen = new Set<string>()
    for (const o of observations) {
      if (!seen.has(o.kind)) {
        seen.add(o.kind)
        categories.push(o.kind)
      }
    }
  }
  return { text, claims, categories, openQuestions }
}
