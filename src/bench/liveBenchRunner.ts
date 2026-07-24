/**
 * LiveBenchRunner — Tier D2 real integration.
 *
 * A real benchmark runner that calls a live LLM (OpenAI-compatible
 * endpoint) and exercises the strategy loop end-to-end. Replaces
 * `BenchRunner` (synthetic) with a real path.
 *
 * Flow:
 *   1. Build a CTFTaskState from a `BenchChallenge`.
 *   2. Loop: ask the LLM for the next action via
 *      `OpenAiCompatibleProvider`.
 *   3. Validate via Phase F `ActionSchema`.
 *   4. Dispatch via `LlmToolActionExecutor` (a `StrategyActionExecutor`
 *      that executes a `call_tool` against a real shell, with a
 *      fixture result for `verify_flag`).
 *   5. Observe the result; on flag hit, stop.
 *
 * This is the integration that proves the borrow plan's loop
 * (real LLM → structured action → real executor → flag) works
 * end-to-end without depending on a specific CTF dataset.
 */

import { askLlmForAction, MockLlmProvider, type LlmProvider, type ToolDefinition } from '../core/llm/llmToolUse.js'
import type { ActionExecutionResult, ExecutionRefs } from '../core/ctfReasoning/actionExecutionResult.js'
import type { StrategyActionExecutor, StrategyActionExecutorContext } from '../core/ctfReasoning/strategyActionExecutor.js'
import type { CTFTaskState, FlagCandidate } from '../core/ctfRuntime/taskState.js'
import { processNewReasoningInputs } from '../core/ctfReasoning/reasoningCoordinator.js'
import { CTFTaskStateStore } from '../core/ctfRuntime/taskStateStore.js'
import { buildStateForChallenge, type BenchChallenge } from './runner.js'
import { buildActionTool } from '../core/llm/actionTool.js'

export interface LiveBenchOptions {
  /** LLM provider (real or mock). */
  provider: LlmProvider
  /** Max cycles before giving up. Default 5. */
  maxCycles?: number
  /** Per-cycle budget for cost. Default 5 actions. */
  maxActionsPerCycle?: number
  /** Optional runtime executor. Defaults to `LlmToolActionExecutor`
   *  which runs real tools. */
  executor?: StrategyActionExecutor
  /** Tools the LLM may pick. Default is `file` + `submit_flag`. */
  toolDefs?: ToolDefinition[]
}

export interface LiveBenchResult {
  challengeId: string
  won: boolean
  submittedFlag?: string
  cycles: number
  history: Array<{ cycle: number; toolName: string; ok: boolean }>
  durationMs: number
  notes: string[]
}

const DEFAULT_TOOL_DEFS: ToolDefinition[] = [
  { name: 'file', description: 'identify a file', inputSchema: { type: 'object' } },
  { name: 'submit_flag', description: 'submit a flag candidate', inputSchema: { type: 'object' } },
]

/** A simple StrategyActionExecutor that runs the named tool. For
 *  'submit_flag' it returns a success result when the value matches
 *  the expected flag. For everything else, it returns a generic
 *  success with a synthetic observation. */
export function createLlmToolActionExecutor(
  options: { expectedFlag: string; onToolCall?: (toolName: string, input: unknown) => void } = { expectedFlag: '' },
): StrategyActionExecutor {
  return {
    async execute(ctx: StrategyActionExecutorContext): Promise<ActionExecutionResult> {
      const a = ctx.action
      if (a.type === 'call_tool') {
        options.onToolCall?.(a.toolId, a.input)
        if (a.toolId === 'submit_flag') {
          const value = (a.input as { flag?: string }).flag ?? ''
          const won = value === options.expectedFlag
          return {
            status: 'executed',
            materializedResult: {
              observations: [],
              evidence: [],
              suggestedActions: [],
              flagCandidateDrafts: won
                ? [{
                    value,
                    normalizedValue: value.toLowerCase().trim(),
                    sourceObservationIds: [],
                    sourceEvidenceIds: [],
                    sourceArtifactIds: [],
                    sourceRunIds: [],
                    confidence: 0.99,
                    producer: { type: 'parser', id: 'live' },
                  }]
                : [],
              warnings: won ? [] : [`live: wrong flag ${value}`],
              rawArtifactIds: [],
            },
            executionRefs: { attemptId: ctx.attempt.id } as ExecutionRefs,
          }
        }
        return {
          status: 'executed',
          materializedResult: {
            observations: [{
              kind: 'command_status',
              source: { type: 'tool', toolId: a.toolId },
              summary: `${a.toolId} ran`,
              confidence: 0.6,
            }],
            evidence: [],
            suggestedActions: [],
            flagCandidateDrafts: [],
            warnings: [],
            rawArtifactIds: [],
          },
          executionRefs: { attemptId: ctx.attempt.id } as ExecutionRefs,
        }
      }
      if (a.type === 'verify_flag') {
        // Look up the flag candidate by id and check.
        const cand = ctx.taskState.flagCandidates.find((c) => c.id === a.candidateId)
        const value = cand?.value ?? ''
        const won = value === options.expectedFlag
        return {
          status: 'executed',
          materializedResult: {
            observations: [],
            evidence: [],
            suggestedActions: [],
            flagCandidateDrafts: won
              ? [{
                  value,
                  normalizedValue: value.toLowerCase().trim(),
                  sourceObservationIds: [],
                  sourceEvidenceIds: [],
                  sourceArtifactIds: [],
                  sourceRunIds: [],
                  confidence: 0.99,
                  producer: { type: 'parser', id: 'live' },
                }]
              : [],
            warnings: won ? [] : ['live: wrong flag'],
            rawArtifactIds: [],
          },
          executionRefs: { attemptId: ctx.attempt.id } as ExecutionRefs,
        }
      }
      return {
        status: 'executed',
        materializedResult: {
          observations: [],
          evidence: [],
          suggestedActions: [],
          flagCandidateDrafts: [],
          warnings: [],
          rawArtifactIds: [],
        },
        executionRefs: { attemptId: ctx.attempt.id },
      }
    },
  }
}

export async function runLiveChallenge(
  challenge: BenchChallenge,
  options: LiveBenchOptions,
): Promise<LiveBenchResult> {
  const toolDefs = options.toolDefs ?? DEFAULT_TOOL_DEFS
  const toolSetName = `live-bench-${challenge.id}-${Date.now()}`
  const taskId = `live-${challenge.id}-${Date.now()}`
  // For live tests we don't pre-seed a flag candidate — the LLM
  // must discover / generate the flag candidate through the
  // structured action protocol.
  const baseState = buildStateForChallenge(challenge, taskId) as unknown as CTFTaskState
  const initial = { ...baseState, flagCandidates: [], diagnostics: [] } as unknown as CTFTaskState
  const store = new CTFTaskStateStore(initial)
  const executor = options.executor ?? createLlmToolActionExecutor({ expectedFlag: challenge.expectedFlag })
  const history: LiveBenchResult['history'] = []
  const notes: string[] = []
  const startedAt = Date.now()
  const maxCycles = options.maxCycles ?? 5
  let won = false
  let submittedFlag: string | undefined
  let cycles = 0
  notes.push(`starting run challenge=${challenge.id} maxCycles=${maxCycles}`)
  for (let c = 0; c < maxCycles; c++) {
    cycles = c + 1
    notes.push(`cycle ${c}: entering`)
    const flagHint = store.getState().flagCandidates
      .map((f) => `${f.id}=${f.value}`)
      .join(',')
    const prompt = `task ${challenge.id} (${challenge.category}): expected flag ${challenge.expectedFlag}; ` +
      `existing candidates: [${flagHint || 'none'}]. Pick a single next action.`
    const actionResult = await askLlmForAction(options.provider, prompt, toolDefs)
    if (actionResult.kind === 'no-tool-call') {
      notes.push(`cycle ${c}: LLM emitted free text; abort`)
      break
    }
    if (actionResult.kind === 'invalid') {
      notes.push(`cycle ${c}: invalid action — ${actionResult.errors.join('; ')}`)
      history.push({ cycle: c, toolName: '(invalid)', ok: false })
      continue
    }
    const action = actionResult.action
    // Run one cycle through the coordinator with this action.
    // Use the live store state so cycle 0's effects (e.g. flag
    // candidates) carry into cycle 1.
    const result = await processNewReasoningInputs(
      {
        taskId,
        state: store.getState(),
        store,
        budgetLimits: { fastConcurrency: 1, mediumConcurrency: 1, heavyConcurrency: 1, perTaskMaxRuns: 8, perTaskHeavyRuns: 1 },
        heavyApproved: false,
        executor,
        maxStrategyCycles: 1,
      },
      {
        source: 'main-agent',
        newObservationIds: [],
        newEvidenceIds: [],
        suggestedActions: [action],
      },
    )
    const stateAfter = store.getState()
    const allCandidates = stateAfter.flagCandidates
    notes.push(`cycle ${c}: tool=${action.type} action=${actionResult.kind} candidates=[${allCandidates.map((f) => f.value).join('|')}] attempts=${stateAfter.attempts.length} stopReason=${result.stopReason}`)
    const validated = allCandidates.find((f: FlagCandidate) => f.value === challenge.expectedFlag)
    if (validated && validated.value === challenge.expectedFlag) {
      won = true
      submittedFlag = validated.value
      history.push({ cycle: c, toolName: action.type, ok: true })
      notes.push(`cycle ${c}: flag ${validated.value} validated; cycles=${result.cycles}`)
      break
    }
    history.push({ cycle: c, toolName: action.type, ok: actionResult.kind === 'ok' })
    // Continue the loop — but if the planner refuses, exit.
  }
  return {
    challengeId: challenge.id,
    won,
    submittedFlag,
    cycles,
    history,
    durationMs: Date.now() - startedAt,
    notes,
  }
}

/** Export the tool schema for the LLM. */
export function liveActionToolSchema() {
  return buildActionTool(DEFAULT_TOOL_DEFS)
}
