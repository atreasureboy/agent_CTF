/**
 * Benchmark CLI — `ovogogogo-ctf benchmark`.
 *
 * Runs the §十七 harness over tests/fixtures/ and emits a summary.
 */

import { join } from 'path'
import { runBenchmark, formatBenchmarkSummary } from './benchmark.js'

export interface BenchmarkCliDeps {
  stdout: NodeJS.WritableStream
  stderr: NodeJS.WritableStream
  fixturesRoot?: string
}

export async function runBenchmarkCommand(argv: string[], deps: BenchmarkCliDeps): Promise<number> {
  const { stdout } = deps
  const cwd = process.cwd()
  const fixturesRoot = deps.fixturesRoot ?? join(cwd, 'tests', 'fixtures')
  const runs = Number.parseInt(argv[0] ?? '1', 10) || 1
  stdout.write(`benchmark — fixtures root: ${fixturesRoot}, runs=${runs}\n`)
  const all = []
  for (let i = 0; i < runs; i++) {
    const summary = runBenchmark({ fixturesRoot })
    all.push(summary)
    stdout.write(`run #${i + 1}: ${summary.rows.length} rows\n`)
  }
  if (all.length > 0) stdout.write(formatBenchmarkSummary(all[0]))
  return 0
}
