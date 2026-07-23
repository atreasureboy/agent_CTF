/**
 * OneShot CLI — `ovogogogo-ctf oneshot list|check <id>` sub-commands.
 *
 * The "run" command is intentionally NOT wired here — running one-shots
 * requires creating a Runtime + Dispatcher, which belongs in the LLM path.
 * Operators who want to run a one-shot ad-hoc should use the LLM with the
 * Shotgun Coordinator agent.
 */

import {
  globalOneShotCatalog,
  loadManifestsFromDir,
  HealthChecker,
  formatDoctor,
} from '../oneshot/index.js'
import { join } from 'path'

export interface OneshotDeps {
  stdout: NodeJS.WritableStream
  stderr: NodeJS.WritableStream
  manifestsDir?: string
}

export async function runOneshotCommand(
  argv: string[],
  deps: OneshotDeps,
): Promise<number> {
  const { stdout } = deps
  const sub = argv[0]
  const cwd = process.cwd()
  const manifestsDir = deps.manifestsDir ?? join(cwd, 'oneshot', 'manifests')

  if (sub === 'list') {
    const catalog = globalOneShotCatalog
    const { accepted, invalid } = loadManifestsFromDir(manifestsDir, catalog)
    stdout.write(`accepted ${accepted.length}, invalid ${invalid.length}\n`)
    for (const m of catalog.list()) {
      stdout.write(
        `${m.category}/${m.id.padEnd(20)} ${m.displayName.padEnd(28)} ${m.scheduling.costTier.padEnd(6)} ${m.maturity.padEnd(11)} ${m.enabledByDefault ? 'enabled ' : 'disabled'}\n`,
      )
    }
    for (const inv of invalid) {
      stdout.write(`INVALID ${inv.file}: ${inv.error}\n`)
    }
    return 0
  }
  if (sub === 'check') {
    const id = argv[1]
    if (!id) {
      stdout.write('usage: oneshot check <manifestId>\n')
      return 1
    }
    const catalog = globalOneShotCatalog
    loadManifestsFromDir(manifestsDir, catalog)
    const m = catalog.get(id)
    if (!m) {
      stdout.write(`unknown manifest: ${id}\n`)
      return 1
    }
    const checker = new HealthChecker({ catalog, execute: false })
    const row = await checker.checkManifest(m, { enableNetwork: false })
    stdout.write(formatDoctor([row]) + '\n')
    return row.status === 'READY' ? 0 : 2
  }
  stdout.write(`unknown sub-command: ${String(sub)}\n`)
  stdout.write('usage:\n')
  stdout.write('  ovogogogo-ctf oneshot list\n')
  stdout.write('  ovogogogo-ctf oneshot check <manifestId>\n')
  return 1
}
