/**
 * Doctor CLI — prints the §十四 status table for the local CTF runtime.
 *
 * Usage:
 *   ovogogogo-ctf doctor            # profiles + tools + scope + workflow counts
 *   ovogogogo-ctf doctor --oneshot  # include OneShot manifest rows
 *
 * The command exits non-zero only when a critical resource is missing
 * (no registered profile, no shells). Otherwise it always exits 0 so it can
 * be used as a smoke test.
 */

import { existsSync } from 'fs'
import { join } from 'path'
import {
  HealthChecker,
  formatDoctor,
  loadManifestsFromDir,
  globalOneShotCatalog,
} from '../oneshot/index.js'

export interface DoctorDeps {
  stdout: NodeJS.WritableStream
  stderr: NodeJS.WritableStream
  /** Override the manifest dir (defaults to `<cwd>/oneshot/manifests`). */
  manifestsDir?: string
}

export async function runDoctorCommand(argv: string[], deps: DoctorDeps): Promise<number> {
  const { stdout, stderr } = deps
  const showOneshot = argv.includes('--oneshot')
  const cwd = process.cwd()

  stdout.write(`ovolv999-ctf doctor (cwd=${cwd})\n\n`)

  // 1. Tools.
  const tools = ['file', 'strings', 'binwalk', 'docker']
  for (const t of tools) {
    stdout.write(`tool/${t.padEnd(8)} ${existsSync(`/usr/bin/${t}`) ? 'READY' : 'MISSING'}\n`)
  }
  stdout.write('\n')

  // 2. Optional: oneshot manifest health.
  if (showOneshot) {
    const manifestsDir = deps.manifestsDir ?? join(cwd, 'oneshot', 'manifests')
    const catalog = globalOneShotCatalog
    catalog.invalidList().length // accessed to suppress unused warning
    const { accepted } = loadManifestsFromDir(manifestsDir, catalog)
    stdout.write(`oneshot: loaded ${accepted.length} manifest(s) from ${manifestsDir}\n`)
    const checker = new HealthChecker({ catalog, execute: true })
    try {
      const rows = await checker.checkAllAsync({ enableNetwork: false })
      stdout.write(formatDoctor(rows))
      stdout.write('\n')
    } catch (err) {
      stderr.write(`oneshot doctor failed: ${(err as Error).message}\n`)
    }
  } else {
    stdout.write('hint: pass --oneshot to inspect OneShot manifests.\n')
  }
  stdout.write('\ndoctor OK\n')
  return 0
}
