/**
 * HTML trajectory renderer — Phase borrow-plan Tier D1.
 *
 * Inspired by swe-agent's Trajectory JSONL + cyber-zero's
 * `print_transcript.py`. We render a `ReplayOutput` as a single
 * self-contained HTML file with collapsible attempt trees and a
 * per-cycle timeline.
 *
 * Pure: no I/O, no LLM call. The caller writes the HTML to disk.
 */

import type { ReplayOutput, ReplayCycle, ReplayAttempt } from './replayer.js'

export function renderTrajectoryHtml(out: ReplayOutput): string {
  const cycleRows = out.cycles.map(renderCycle).join('\n')
  const summary = renderSummary(out)
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Trajectory ${escape(out.taskId)}</title>
<style>
body { font-family: -apple-system, system-ui, sans-serif; max-width: 960px; margin: 2rem auto; padding: 0 1rem; color: #222; }
h1 { font-size: 1.4rem; }
h2 { font-size: 1.05rem; margin-top: 1.5rem; }
.cycle { border: 1px solid #ddd; border-radius: 6px; padding: 0.75rem 1rem; margin: 0.75rem 0; }
.cycle header { display: flex; gap: 1rem; align-items: baseline; }
.cycle-num { font-weight: 600; color: #555; min-width: 4rem; }
.decision { background: #f5f5f5; padding: 0.5rem; border-radius: 4px; margin: 0.5rem 0; font-family: ui-monospace, monospace; font-size: 0.9rem; }
.attempt { border-left: 3px solid #ccc; padding: 0.25rem 0.5rem; margin: 0.5rem 0; }
.attempt.succeeded { border-left-color: #2a7; }
.attempt.failed { border-left-color: #c33; }
.attempt.cancelled { border-left-color: #888; }
.attempt.skipped { border-left-color: #aaa; opacity: 0.6; }
.tag { display: inline-block; background: #eef; color: #335; padding: 0 0.4rem; border-radius: 3px; font-size: 0.8rem; }
.flag { background: #ffe; color: #950; padding: 0 0.4rem; border-radius: 3px; font-size: 0.85rem; }
.summary { background: #eef; padding: 0.75rem 1rem; border-radius: 6px; margin-bottom: 1.5rem; }
.summary h2 { margin-top: 0; }
details > summary { cursor: pointer; font-weight: 500; }
</style>
</head>
<body>
<h1>Trajectory: ${escape(out.taskId)}</h1>
${summary}
<h2>Cycles (${out.cycles.length})</h2>
${cycleRows}
</body>
</html>`
}

function renderSummary(out: ReplayOutput): string {
  const fs = out.finalState
  return `<div class="summary">
<h2>Summary</h2>
<dl>
<dt>Started</dt><dd>${out.startedAt ? new Date(out.startedAt).toISOString() : 'n/a'}</dd>
<dt>Completed</dt><dd>${out.completedAt ? new Date(out.completedAt).toISOString() : 'n/a'}</dd>
<dt>Stopped reason</dt><dd>${escape(out.stoppedReason ?? 'n/a')}</dd>
<dt>Total observations</dt><dd>${fs.totalObservations}</dd>
<dt>Total evidence</dt><dd>${fs.totalEvidence}</dd>
<dt>Total artifacts</dt><dd>${fs.totalArtifacts}</dd>
<dt>Flag candidates (validated / total)</dt><dd>${fs.validatedFlagCandidates} / ${fs.totalFlagCandidates}</dd>
</dl>
</div>`
}

function renderCycle(c: ReplayCycle): string {
  const decisions = c.strategyDecisions
    .map(
      (d) => `<div class="decision">selected: ${escape(d.selectedAction ?? '(none)')} | reason: ${escape(d.reason)} | hypotheses: ${d.basedOnHypothesisIds.length}</div>`,
    )
    .join('\n')
  const attempts = c.attempts.map(renderAttempt).join('\n')
  return `<div class="cycle">
<header><span class="cycle-num">cycle #${c.index}</span><span>actions after this cycle: ${c.budgetAfter}</span></header>
${decisions}
${attempts}
</div>`
}

function renderAttempt(a: ReplayAttempt): string {
  const statusClass = a.status
  const ids: string[] = []
  if (a.observationIds.length) ids.push(`<span class="tag">${a.observationIds.length} obs</span>`)
  if (a.evidenceIds.length) ids.push(`<span class="tag">${a.evidenceIds.length} ev</span>`)
  if (a.flagCandidateIds.length) ids.push(`<span class="flag">${a.flagCandidateIds.length} flag</span>`)
  return `<div class="attempt ${escape(statusClass)}">
<strong>${escape(a.action)}</strong> — ${escape(a.status)} ${ids.join(' ')}
${a.error ? `<div class="decision">${escape(a.error)}</div>` : ''}
</div>`
}

function escape(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
