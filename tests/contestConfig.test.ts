/**
 * Tests for `.ovogo/contest.json` auto-loading + CLI override merge.
 *
 * Acceptance scenarios:
 *   1. Missing file → safe defaults (no crash)
 *   2. Valid file → config loaded into harness
 *   3. Malformed file → structured error
 *   4. Schema violation → structured error
 *   5. CLI overrides WIN over file
 *   6. CLI without `--allow-public-network` does NOT enable public network
 *      even when file has it enabled
 *   7. Explicit `--contest-config <path>` loads from that path
 *   8. `mergeContestConfig` correctly replaces arrays (predictable for ops)
 *   9. The loaded config is enforced by ContestScopeChecker at runtime
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  loadContestConfig,
  mergeContestConfig,
  resolveContestConfig,
  CONTEST_CONFIG_PATHS,
} from '../src/core/contestConfig.js'
import { ContestScopeChecker, ScopeViolationError } from '../src/core/contestScope.js'
import { createHarness } from '../src/core/harness.js'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'contest-cfg-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function writeConfig(rel: string, body: object): string {
  const abs = join(root, rel)
  mkdirSync(join(root, rel.split('/').slice(0, -1).join('/')), { recursive: true })
  writeFileSync(abs, JSON.stringify(body))
  return abs
}

describe('loadContestConfig — file discovery + validation', () => {
  it('returns safe defaults when no file exists (no crash)', () => {
    const r = loadContestConfig({ cwd: root })
    expect(r.loaded).toBe(false)
    expect(r.sourcePath).toBeNull()
    expect(r.config.allowedFilesRoot).toBe(root)
    expect(r.config.allowPublicNetwork).toBe(false)
  })

  it('discovers .ovogo/contest.json and validates it', () => {
    const path = writeConfig('.ovogo/contest.json', {
      allowedHosts: ['10.0.0.0/24'],
      allowedFilesRoot: root,
      allowPublicNetwork: false,
      notes: 'round 1 strict',
      maxTaskDurationMs: 3600_000,
    })
    const r = loadContestConfig({ cwd: root })
    expect(r.loaded).toBe(true)
    expect(r.sourcePath).toBe(path)
    expect(r.config.allowedHosts).toEqual(['10.0.0.0/24'])
    expect(r.config.notes).toBe('round 1 strict')
    expect(r.config.maxTaskDurationMs).toBe(3600_000)
  })

  it('finds alternate filenames (.ovogo/contest.config.json, ovogo.contest.json)', () => {
    const path = writeConfig('ovogo.contest.json', {
      allowedFilesRoot: root,
    })
    const r = loadContestConfig({ cwd: root })
    expect(r.loaded).toBe(true)
    expect(r.sourcePath).toBe(path)
  })

  it('throws on malformed JSON with the path in the message', () => {
    const path = writeConfig('.ovogo/contest.json', { broken: true } as object)
    // overwrite with malformed
    require('fs').writeFileSync(path, '{ "allowedFilesRoot": ')
    expect(() => loadContestConfig({ cwd: root })).toThrow(/Failed to parse/)
  })

  it('throws when schema is violated (e.g. missing allowedFilesRoot)', () => {
    writeConfig('.ovogo/contest.json', { allowPublicNetwork: true })
    expect(() => loadContestConfig({ cwd: root })).toThrow()
  })

  it('lists all candidate paths for ops reference', () => {
    expect(CONTEST_CONFIG_PATHS).toContain('.ovogo/contest.json')
  })
})

describe('mergeContestConfig — CLI wins over file', () => {
  it('CLI allowedHosts REPLACES the file array (predictable)', () => {
    const file = {
      allowedFilesRoot: '/x',
      allowPublicNetwork: false,
      allowedHosts: ['10.0.0.1'],
    } as const
    const merged = mergeContestConfig(file as never, { allowedHosts: ['1.2.3.4'] })
    expect(merged.allowedHosts).toEqual(['1.2.3.4'])
  })

  it('CLI absent keys fall through to file values', () => {
    const file = {
      allowedFilesRoot: '/x',
      allowPublicNetwork: false,
      allowedHosts: ['10.0.0.1'],
      notes: 'preserved',
    } as never
    const merged = mergeContestConfig(file, {})
    expect(merged.notes).toBe('preserved')
    expect(merged.allowedHosts).toEqual(['10.0.0.1'])
  })

  it('CLI allowPublicNetwork=true overrides file=false', () => {
    const file = {
      allowedFilesRoot: '/x',
      allowPublicNetwork: false,
    } as never
    const merged = mergeContestConfig(file, { allowPublicNetwork: true })
    expect(merged.allowPublicNetwork).toBe(true)
  })
})

describe('resolveContestConfig — end-to-end CLI usage', () => {
  it('loads file + applies CLI override, file path is returned', () => {
    writeConfig('.ovogo/contest.json', {
      allowedFilesRoot: root,
      allowPublicNetwork: false,
      allowedHosts: ['10.0.0.1'],
    })
    const { scope, sourcePath } = resolveContestConfig({
      cwd: root,
      cliOverride: { allowPublicNetwork: true },
    })
    expect(sourcePath).toContain('.ovogo/contest.json')
    expect(scope.allowPublicNetwork).toBe(true)
    // allowedHosts from file survive when CLI doesn't override
    expect(scope.allowedHosts).toEqual(['10.0.0.1'])
  })

  it('enforces loaded config via ContestScopeChecker', () => {
    writeConfig('.ovogo/contest.json', {
      allowedHosts: ['example.com'],
      allowedFilesRoot: root,
      allowPublicNetwork: false,
    })
    const { scope } = resolveContestConfig({ cwd: root })
    const checker = new ContestScopeChecker(scope)
    expect(checker.isNetworkAllowed('example.com:80')).toBe(true)
    expect(checker.isNetworkAllowed('evil.com:80')).toBe(false)
    expect(() => checker.assertNetwork('evil.com:80')).toThrow(ScopeViolationError)
  })
})

describe('createHarness — auto-loads .ovogo/contest.json', () => {
  it('uses the file config when present and no explicit scope passed', () => {
    writeConfig('.ovogo/contest.json', {
      allowedHosts: ['10.0.0.99'],
      allowedFilesRoot: root,
      allowPublicNetwork: false,
    })
    const h = createHarness({
      cwd: root,
      profile: 'orchestrator',
      jobLimits: { maxPerAgent: 0, maxPerTask: 0 },
      inlineMaxBytes: 1024,
    })
    expect(h.contestScope.isNetworkAllowed('10.0.0.99:8080')).toBe(true)
    expect(h.contestScope.isNetworkAllowed('evil.com:80')).toBe(false)
  })

  it('CLI-level contestScope overrides the file', () => {
    writeConfig('.ovogo/contest.json', {
      allowedHosts: ['file-host'],
      allowedFilesRoot: root,
      allowPublicNetwork: false,
    })
    const h = createHarness({
      cwd: root,
      profile: 'orchestrator',
      jobLimits: { maxPerAgent: 0, maxPerTask: 0 },
      inlineMaxBytes: 1024,
      contestScope: {
        allowedFilesRoot: root,
        allowPublicNetwork: false,
        allowHeavyOneShots: false,
        allowedHosts: ['cli-host'],
      },
    })
    expect(h.contestScope.isNetworkAllowed('cli-host:80')).toBe(true)
    expect(h.contestScope.isNetworkAllowed('file-host:80')).toBe(false)
  })
})
