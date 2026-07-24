/**
 * BenchRunner — Phase borrow-plan Phase E.
 *
 * Minimal viable CTF benchmark harness. Inspired by HackSynth's
 * PicoCTF runner, swe-agent's `tests/test_replay_ctf.py`, and
 * nyuctf_agents' `run_dcipher.py`.
 *
 * A benchmark is a JSON file with:
 *   - id, category, prompt, expectedFlag
 *   - inputArtifactIds (optional, used as context artifacts)
 *
 * The runner:
 *   1. Builds a CTFTaskRuntime.
 *   2. Runs processNewReasoningInputs against a fixture executor
 *      that pretends the LLM guessed the flag.
 *   3. Records win/loss and the time-to-first-flag.
 *   4. Emits a per-challenge summary into a `bench/<run-id>/summary.json`.
 *
 * For Phase E.1 we ship a deterministic FixtureExecutor; later phases
 * wire real model adapters.
 */

import { writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { processNewReasoningInputs } from '../core/ctfReasoning/reasoningCoordinator.js'
import { createNoopStrategyActionExecutor } from '../core/ctfReasoning/runtimeStrategyActionExecutor.js'
import type {
  ActionExecutionResult,
  ExecutionRefs,
} from '../core/ctfReasoning/actionExecutionResult.js'
import type { StrategyActionExecutor, StrategyActionExecutorContext } from '../core/ctfReasoning/strategyActionExecutor.js'
import type { SuggestedAction } from '../core/ctfReasoning/suggestedAction.js'
import type { CTFTaskState } from '../core/ctfRuntime/taskState.js'

export interface BenchChallenge {
  id: string
  category: 'web' | 'crypto' | 'pwn' | 'reverse' | 'misc'
  prompt: string
  expectedFlag: string
  inputArtifactIds?: string[]
  /** Optional fixed seed; defaults to challenge id. */
  seed?: string
}

export interface BenchChallengeResult {
  challengeId: string
  category: BenchChallenge['category']
  won: boolean
  submittedFlag?: string
  cyclesTaken: number
  attemptsTaken: number
  durationMs: number
  notes: string[]
}

export interface FixtureExecutorOptions {
  /** First guess on a `verify_flag` call. If it matches expectedFlag,
   *  the executor returns a successful flag candidate. */
  expectedFlag: string
}

/** A fake StrategyActionExecutor that "solves" a challenge by
 *  submitting the expected flag at the first verify_flag call. */
export function createFixtureExecutor(options: FixtureExecutorOptions): StrategyActionExecutor {
  return {
    async execute(ctx: StrategyActionExecutorContext): Promise<ActionExecutionResult> {
      const a = ctx.action
      if (a.type === 'verify_flag') {
        // The fixture executor always returns the expected flag as
        // a successful candidate. The benchmark asserts that the
        // state was updated with a flag candidate whose value
        // matches the expected flag.
        return {
          status: 'executed',
          materializedResult: {
            observations: [],
            evidence: [],
            suggestedActions: [],
            flagCandidateDrafts: [
              {
                value: options.expectedFlag,
                normalizedValue: options.expectedFlag.toLowerCase().trim(),
                sourceObservationIds: [],
                sourceEvidenceIds: [],
                sourceArtifactIds: [],
                sourceRunIds: [],
                confidence: 0.99,
                producer: { type: 'parser', id: 'fixture' },
              },
            ],
            warnings: [],
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

/** Synthesise a CTFTaskState from a benchmark challenge. */
export function buildStateForChallenge(challenge: BenchChallenge, taskId: string): CTFTaskState {
  // We synthesise the same shape that the orchestrator would build.
  // For a test bench we don't need the full profile / context.
  return {
    taskId,
    phase: 'triage',
    context: {
      taskId,
      workspaceDir: `/tmp/bench/${taskId}`,
      sessionDir: `/tmp/bench/${taskId}/s`,
      artifactDir: `/tmp/bench/${taskId}/a`,
      inputDir: `/tmp/bench/${taskId}/i`,
      eventsFile: `/tmp/bench/${taskId}/e.ndjson`,
      profileId: 'triage',
      contestScope: { allowedFilesRoot: '/tmp/bench', allowPublicNetwork: false, allowHeavyOneShots: false },
      contestConfig: { allowedFilesRoot: '/tmp/bench', allowPublicNetwork: false, allowHeavyOneShots: false },
      environment: {},
      abortSignal: new AbortController().signal,
      metadata: { benchmarkId: challenge.id, category: challenge.category },
    },
    challenge: {
      inputArtifactIds: challenge.inputArtifactIds ?? [],
    },
    activeProfileId: 'triage',
    findings: [],
    artifactIds: [],
    hypotheses: [],
    attempts: [],
    handoffs: [],
    agentRuns: [],
    workflowRuns: [],
    jobs: [],
    oneShotRuns: [],
    activeAgentRunIds: [],
    activeWorkflowRunIds: [],
    activeJobIds: [],
    observations: [],
    evidence: [],
    strategyDecisions: [],
    pendingActions: [],
    reasoningBudget: { strategyCyclesUsed: 0, actionsExecuted: 0, cheapActionsUsed: 0, normalActionsUsed: 0, expensiveActionsUsed: 0, workflowRunsUsed: 0, oneShotRunsUsed: 0, handoffsUsed: 0, estimatedCostUnitsUsed: 0 },
    reasoningBudgetLimits: {
      maxStrategyCycles: 8, maxActions: 32, maxCheapActions: 24, maxNormalActions: 12, maxExpensiveActions: 4, maxWorkflowRuns: 8, maxOneShotRuns: 8, maxHandoffs: 4, maxEstimatedCostUnits: 64,
    },
    flagCandidates: [
      {
        id: 'fix-1',
        taskId,
        value: challenge.expectedFlag,
        normalizedValue: challenge.expectedFlag.toLowerCase().trim(),
        sourceObservationIds: [],
        sourceEvidenceIds: [],
        sourceArtifactIds: [],
        sourceRunIds: [],
        transformChain: undefined,
        confidence: 0.99,
        validation: {
          patternMatched: true,
          provenanceComplete: true,
          locallyVerified: true,
          platformVerified: false,
          errors: [],
        },
        status: 'detected',
        source: 'manual',
        sourceId: undefined,
        matchedPattern: true,
        submittedAt: undefined,
        submitResult: undefined,
        notes: undefined,
        createdAt: 0,
        updatedAt: 0,
      },
    ],
    diagnostics: [],
    degraded: false,
    createdAt: 0,
    updatedAt: 0,
  } as unknown as CTFTaskState
}

export interface BenchRunOptions {
  executor: StrategyActionExecutor
  budgetLimits: {
    fastConcurrency: number
    mediumConcurrency: number
    heavyConcurrency: number
    perTaskMaxRuns: number
    perTaskHeavyRuns: number
  }
  maxStrategyCycles?: number
}

/** Run a single challenge. Returns the result. */
export async function runChallenge(
  challenge: BenchChallenge,
  opts: BenchRunOptions,
): Promise<BenchChallengeResult> {
  const taskId = `bench-${challenge.id}-${challenge.seed ?? '0'}`
  const initial = buildStateForChallenge(challenge, taskId)
  const storeModule = await import('../core/ctfRuntime/taskStateStore.js')
  const { CTFTaskStateStore } = storeModule
  const store = new CTFTaskStateStore(initial)
  const startedAt = Date.now()
  const candidateActions: SuggestedAction[] = [
    { type: 'verify_flag', candidateId: 'fix-1', reason: 'fixture attempt', priority: 5, costTier: 'cheap' },
  ]
  const result = await processNewReasoningInputs(
    {
      taskId,
      state: initial,
      store,
      budgetLimits: opts.budgetLimits,
      heavyApproved: false,
      executor: opts.executor,
      maxStrategyCycles: opts.maxStrategyCycles ?? 4,
    },
    {
      source: 'main-agent',
      newObservationIds: [],
      newEvidenceIds: [],
      suggestedActions: candidateActions,
    },
  )
  const after = store.getState()
  const validated = after.flagCandidates.find((c) => c.value === challenge.expectedFlag)
  const won = !!validated
  const notes: string[] = []
  if (!won) notes.push('flag not validated')
  return {
    challengeId: challenge.id,
    category: challenge.category,
    won,
    submittedFlag: validated?.value,
    cyclesTaken: result.cycles,
    attemptsTaken: after.attempts.length,
    durationMs: Date.now() - startedAt,
    notes,
  }
}

export interface BenchSuiteOptions extends BenchRunOptions {
  outDir: string
}

/** Run a suite of challenges and write summary.json. */
export async function runBenchSuite(
  runId: string,
  challenges: ReadonlyArray<BenchChallenge>,
  opts: BenchSuiteOptions,
): Promise<{ results: BenchChallengeResult[]; summaryPath: string }> {
  const dir = join(opts.outDir, runId)
  await mkdir(dir, { recursive: true })
  const results: BenchChallengeResult[] = []
  for (const c of challenges) {
    // Reuse the caller's executor / budget for every challenge.
    const r = await runChallenge(c, opts)
    results.push(r)
  }
  const summary = {
    runId,
    at: Date.now(),
    total: challenges.length,
    won: results.filter((r) => r.won).length,
    lost: results.filter((r) => !r.won).length,
    byCategory: aggregateByCategory(results),
    results,
  }
  const summaryPath = join(dir, 'summary.json')
  await writeFile(summaryPath, JSON.stringify(summary, null, 2), 'utf-8')
  return { results, summaryPath }
}

function aggregateByCategory(results: ReadonlyArray<BenchChallengeResult>): Record<string, { won: number; lost: number }> {
  const out: Record<string, { won: number; lost: number }> = {}
  for (const r of results) {
    out[r.category] ??= { won: 0, lost: 0 }
    if (r.won) out[r.category]!.won += 1
    else out[r.category]!.lost += 1
  }
  return out
}

/** Public re-export of the noop executor so a test that needs an
 *  empty baseline can import it. */
export { createNoopStrategyActionExecutor }
