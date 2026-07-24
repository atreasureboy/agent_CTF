/**
 * SolverSwarm — Phase borrow-plan Phase B.
 *
 * Inspired by ctf-agent (Veria): up to N model adapters race against
 * the same challenge; first correct answer cancels the rest. We adapt
 * the pattern to our `StrategyActionExecutor`:
 *
 *   - The `Coordinator` hands an action to a `SwarmActionExecutor`
 *     that fans out to N underlying executors.
 *   - Each executor runs concurrently; results are deduplicated.
 *   - When any executor emits a `verify_flag`-style success, the rest
 *     are cancelled via `AbortSignal`.
 *   - The winning materialised result (Observation / Evidence / Artifact /
 *     FlagCandidate) is returned.
 *
 * Pure adapter — does not own the LLM clients. Each underlying
 * executor is a `StrategyActionExecutor`; production wires Claude +
 * Codex + Pydantic-AI backends; tests wire a single fake executor.
 */

import type { ActionExecutionResult, ExecutionRefs } from './actionExecutionResult.js'
import type { MaterializedResult } from './parserRegistry.js'
import type {
  StrategyActionExecutor,
  StrategyActionExecutorContext,
} from './strategyActionExecutor.js'
import type { SuggestedAction } from './suggestedAction.js'

export interface SolverSwarmMember {
  /** Stable id; the first one to emit a `verify_flag`-style
   *  success wins. */
  id: string
  executor: StrategyActionExecutor
}

export interface SolverSwarmOptions {
  members: SolverSwarmMember[]
  /** Maximum number of members to run in parallel. Default = all. */
  maxParallel?: number
  /** How long to wait for the first winner. After this we surface
   *  the best partial. Default 60s. */
  winnerTimeoutMs?: number
  /** True when this is a `verify_flag` / `submit_flag` style action;
   *  the swarm will abort other members as soon as one returns a
   *  successful `materializedResult.flagCandidateDrafts`. */
  isFlagCheck: (action: SuggestedAction) => boolean
}

export function createSolverSwarmExecutor(options: SolverSwarmOptions): StrategyActionExecutor {
  return {
    async execute(ctx: StrategyActionExecutorContext): Promise<ActionExecutionResult> {
      const isFlagCheck = options.isFlagCheck(ctx.action)
      const maxParallel = options.maxParallel ?? options.members.length
      const members = options.members.slice(0, maxParallel)
      if (members.length === 0) {
        return {
          status: 'executed',
          materializedResult: emptyMaterializedResult(),
          executionRefs: { attemptId: ctx.attempt.id },
        }
      }
      // Live cancellation via a shared AbortController.
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(new Error('swarm_winner_timeout')), options.winnerTimeoutMs ?? 60_000)
      try {
        const tasks = members.map((m) =>
          runMember(m, ctx, ac.signal, isFlagCheck).then((res) => ({ memberId: m.id, res })),
        )
        // First resolve that has at least one flag-candidate draft wins.
        const winnerP = waitForWinner(tasks, ac)
        const winner = await winnerP
        ac.abort(new Error('swarm_winner_found'))
        const settled = await Promise.allSettled(tasks)
        const partials: MaterializedResult[] = settled
          .filter((s) => s.status === 'fulfilled')
          .map((s) => (s as PromiseFulfilledResult<{ memberId: string; res: ActionExecutionResult }>).value.res)
          .filter((r) => r.status === 'executed')
          .map((r) => r.materializedResult)
        return mergeResult(winner.res, partials, winner.memberId, ctx.attempt.id, winner.index)
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

async function runMember(
  m: SolverSwarmMember,
  ctx: StrategyActionExecutorContext,
  signal: AbortSignal,
  isFlagCheck: boolean,
): Promise<ActionExecutionResult> {
  try {
    return await m.executor.execute({ ...ctx, signal: ctx.signal })
  } catch (err) {
    if (isFlagCheck) {
      // For flag-check actions, an executor error means "this model
      // could not produce a candidate" — record as a soft failure and
      // let the swarm continue.
      return {
        status: 'failed',
        error: { message: err instanceof Error ? err.message : String(err) },
      }
    }
    return {
      status: 'failed',
      error: { message: err instanceof Error ? err.message : String(err) },
    }
  }
}

async function waitForWinner(
  tasks: Promise<{ memberId: string; res: ActionExecutionResult }>[],
  ac: AbortController,
): Promise<{ memberId: string; res: ActionExecutionResult }> {
  // Use Promise.race against the first winning result. If none of the
  // first N resolve with a flag candidate, fall back to the first
  // executed result.
  const wrapped = tasks.map((t, i) =>
    t.then((r) => ({ index: i, ...r })),
  )
  return new Promise((resolve, reject) => {
    let resolved = false
    const onAbort = (): void => {
      if (resolved) return
      resolved = true
      // No winner before timeout — pick the first task that completes.
      Promise.race(wrapped).then((r) => resolve(r)).catch(reject)
    }
    ac.signal.addEventListener('abort', onAbort, { once: true })
    // Sequential race: first to resolve with a flag candidate wins.
    void consumeFirst(wrapped, 0, (result) => {
      if (resolved) return
      if (result.res.status !== 'executed') return false
      if (result.res.materializedResult.flagCandidateDrafts.length > 0) {
        resolved = true
        ac.signal.removeEventListener('abort', onAbort)
        resolve(result)
        return true
      }
      return false
    }, resolve, reject)
  })
}

async function consumeFirst<T extends { res: ActionExecutionResult }>(
  items: Promise<T>[],
  index: number,
  accept: (r: T) => boolean | Promise<boolean>,
  resolve: (r: T) => void,
  reject: (err: unknown) => void,
): Promise<void> {
  if (index >= items.length) {
    // No winner — accept the first completed result.
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
    await consumeFirst(items, index + 1, accept, resolve, reject)
  } catch (err) {
    reject(err)
  }
}

function mergeResult(
  winner: ActionExecutionResult,
  partials: MaterializedResult[],
  winnerMemberId: string,
  attemptId: string,
  winnerIndex: number,
): ActionExecutionResult {
  if (winner.status !== 'executed') {
    return winner
  }
  // The winner's materialised result is the primary. Other partials
  // contribute their unique observations / evidence / candidates.
  const winnerIds = new Set<string>()
  for (const o of winner.materializedResult.observations) winnerIds.add(o.summary + o.kind)
  const winnerCandidateKeys = new Set<string>()
  for (const c of winner.materializedResult.flagCandidateDrafts) {
    winnerCandidateKeys.add(c.normalizedValue || c.value)
  }
  const obs = [...winner.materializedResult.observations]
  const ev = [...winner.materializedResult.evidence]
  const cand = [...winner.materializedResult.flagCandidateDrafts]
  const warnings = [...winner.materializedResult.warnings]
  partials.forEach((p, i) => {
    if (i === winnerIndex) return
    for (const o of p.observations) {
      const k = o.summary + o.kind
      if (!winnerIds.has(k)) {
        obs.push(o)
        winnerIds.add(k)
      }
    }
    for (const e of p.evidence) ev.push(e)
    for (const c of p.flagCandidateDrafts) {
      const key = c.normalizedValue || c.value
      if (!winnerCandidateKeys.has(key)) {
        cand.push(c)
        winnerCandidateKeys.add(key)
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
      warnings: [...warnings, `swarm: winner=${winnerMemberId}`],
      rawArtifactIds: winner.materializedResult.rawArtifactIds,
    },
    executionRefs: { ...winner.executionRefs, attemptId } as ExecutionRefs,
    resultAlreadyProjected: winner.resultAlreadyProjected,
  }
}

function combineSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  if (a.aborted) return a
  if (b.aborted) return b
  const ac = new AbortController()
  const onA = (): void => ac.abort(a.reason)
  const onB = (): void => ac.abort(b.reason)
  a.addEventListener('abort', onA, { once: true })
  b.addEventListener('abort', onB, { once: true })
  return ac.signal
}

function emptyMaterializedResult(): MaterializedResult {
  return {
    observations: [],
    evidence: [],
    suggestedActions: [],
    flagCandidateDrafts: [],
    warnings: [],
    rawArtifactIds: [],
  }
}