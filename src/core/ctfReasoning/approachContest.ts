/**
 * ApproachContest — Phase borrow-plan Tier B2 (CAI pattern).
 *
 * CAI's `run_dual_approach_contest` spawns two clones of one
 * specialist with opposing framings in parallel. Whichever wins, the
 * other is cancelled. Inspired by CAI's `parallel_specialists.py`
 * and the `Contest` pattern in `patterns/parallel_offensive_patterns.py`.
 *
 * Our adapter wraps a single `StrategyActionExecutor` and dispatches
 * each "framing" (a hint string the LLM is given) in parallel. The
 * first to emit a `flagCandidateDrafts` wins; the rest are cancelled.
 *
 * The framer is itself pure — it returns the framing text. In a
 * production deployment, the framer is a small prompt that says
 * "be aggressive" vs "be defensive" / "try RSA" vs "try XOR"; in
 * tests we ship a `staticFramer` that just returns the literal
 * framer text.
 */

import type {
  ActionExecutionResult,
  ExecutionRefs,
} from './actionExecutionResult.js'
import type { MaterializedResult } from './parserRegistry.js'
import type {
  StrategyActionExecutor,
  StrategyActionExecutorContext,
} from './strategyActionExecutor.js'
import type { SuggestedAction } from './suggestedAction.js'

export interface ApproachContestFraming {
  /** Stable id (e.g. 'aggressive', 'defensive', 'rsa-first', 'xor-first'). */
  id: string
  /** Prompt fragment to send to the LLM along with the original
   *  input. The framer is free to construct any shape. */
  prompt: string
  /** Optional predicate: this framing is willing to take a flag
   *  candidate as the winning answer. Defaults to true. */
  acceptsFlag?: boolean
}

export interface ApproachContestOptions {
  /** Underlying executor. The contest wraps it. */
  executor: StrategyActionExecutor
  /** Two or more framings to race. Order doesn't matter; the first
   *  winner wins. */
  framings: ApproachContestFraming[]
  /** A pure function that mutates `ctx.action` per framing. Defaults
   *  to no-op. */
  applyFraming?: (ctx: StrategyActionExecutorContext, framing: ApproachContestFraming) => StrategyActionExecutorContext
  /** When true, only the flag-candidate-winning framing's
   *  `materializedResult` is returned. Non-flag races use the
   *  first-completed result. Default true. */
  flagOnly?: boolean
  /** AbortController timeout. Default 60s. */
  winnerTimeoutMs?: number
}

export function createApproachContestExecutor(options: ApproachContestOptions): StrategyActionExecutor {
  return {
    async execute(ctx: StrategyActionExecutorContext): Promise<ActionExecutionResult> {
      if (options.framings.length === 0) {
        return options.executor.execute(ctx)
      }
      if (options.framings.length === 1) {
        return options.executor.execute(options.applyFraming ? options.applyFraming(ctx, options.framings[0]!) : ctx)
      }
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(new Error('approach_contest_winner_timeout')), options.winnerTimeoutMs ?? 60_000)
      const flagOnly = options.flagOnly ?? true
      try {
        const tasks = options.framings.map((f) =>
          options.executor.execute(
            options.applyFraming ? options.applyFraming(ctx, f) : ctx,
          ).then((res) => ({ framing: f, res })),
        )
        const winner = await waitForApproachWinner(tasks, ac, flagOnly)
        ac.abort(new Error('approach_contest_winner_found'))
        const settled = await Promise.allSettled(tasks)
        const partials: MaterializedResult[] = settled
          .filter((s) => s.status === 'fulfilled')
          .map((s) => (s as PromiseFulfilledResult<{ framing: ApproachContestFraming; res: ActionExecutionResult }>).value)
          .filter((w): w is { framing: ApproachContestFraming; res: Extract<ActionExecutionResult, { status: 'executed' }> } => w.res.status === 'executed')
          .map((w) => w.res.materializedResult)
        return mergeContestResult(winner.res, winner.framing.id, partials, ctx.attempt.id)
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

async function waitForApproachWinner(
  tasks: Promise<{ framing: ApproachContestFraming; res: ActionExecutionResult }>[],
  ac: AbortController,
  flagOnly: boolean,
): Promise<{ framing: ApproachContestFraming; res: ActionExecutionResult }> {
  return new Promise((resolve, reject) => {
    let resolved = false
    const onAbort = (): void => {
      if (resolved) return
      resolved = true
      Promise.race(tasks).then((r) => resolve(r)).catch(reject)
    }
    ac.signal.addEventListener('abort', onAbort, { once: true })
    void consumeFirstApproach(tasks, 0, (result) => {
      if (resolved) return false
      if (result.res.status !== 'executed') return false
      if (flagOnly) {
        if (result.res.materializedResult.flagCandidateDrafts.length > 0) {
          resolved = true
          ac.signal.removeEventListener('abort', onAbort)
          resolve(result)
          return true
        }
        return false
      }
      resolved = true
      ac.signal.removeEventListener('abort', onAbort)
      resolve(result)
      return true
    }, resolve, reject)
  })
}

async function consumeFirstApproach(
  items: Promise<{ framing: ApproachContestFraming; res: ActionExecutionResult }>[],
  index: number,
  accept: (r: { framing: ApproachContestFraming; res: ActionExecutionResult }) => boolean | Promise<boolean>,
  resolve: (r: { framing: ApproachContestFraming; res: ActionExecutionResult }) => void,
  reject: (err: unknown) => void,
): Promise<void> {
  if (index >= items.length) {
    try {
      const r = await Promise.race(items)
      resolve(r)
    } catch (err) {
      reject(err)
    }
    return
  }
  try {
    const r = await items[index]!
    const ok = await accept(r)
    if (ok) return
    await consumeFirstApproach(items, index + 1, accept, resolve, reject)
  } catch (err) {
    reject(err)
  }
}

function mergeContestResult(
  winner: ActionExecutionResult,
  winnerFramingId: string,
  partials: MaterializedResult[],
  attemptId: string,
): ActionExecutionResult {
  if (winner.status !== 'executed') {
    return winner
  }
  const obs = [...winner.materializedResult.observations]
  const ev = [...winner.materializedResult.evidence]
  const cand = [...winner.materializedResult.flagCandidateDrafts]
  const warnings = [...winner.materializedResult.warnings, `approach-contest: winner=${winnerFramingId}`]
  const seenObs = new Set(obs.map((o) => o.summary + o.kind))
  const seenCand = new Set(cand.map((c) => c.normalizedValue || c.value))
  partials.forEach((p) => {
    for (const o of p.observations) {
      const k = o.summary + o.kind
      if (!seenObs.has(k)) {
        obs.push(o)
        seenObs.add(k)
      }
    }
    for (const e of p.evidence) ev.push(e)
    for (const c of p.flagCandidateDrafts) {
      const key = c.normalizedValue || c.value
      if (!seenCand.has(key)) {
        cand.push(c)
        seenCand.add(key)
      }
    }
    for (const w of p.warnings) warnings.push(w)
  })
  return {
    status: 'executed',
    materializedResult: {
      observations: obs,
      evidence: ev,
      suggestedActions: winner.materializedResult.suggestedActions,
      flagCandidateDrafts: cand,
      warnings,
      rawArtifactIds: winner.materializedResult.rawArtifactIds,
    },
    executionRefs: { ...winner.executionRefs, attemptId } as ExecutionRefs,
    resultAlreadyProjected: winner.resultAlreadyProjected,
  }
}

/** Static framer: returns the literal framer prompt as the
 *  framing. Useful for tests. */
export const staticFramer = (framer: ApproachContestFraming) => (): ApproachContestFraming => framer
