import { describe, it, expect } from 'vitest'
import {
  PermissionChecker,
  fingerprint,
  DEFAULT_PERMISSION_RULES,
  type Approver,
} from '../src/core/permission.js'

describe('fingerprint', () => {
  it('extracts the Bash command', () => {
    expect(fingerprint('Bash', { command: 'ls -la' })).toBe('ls -la')
  })

  it('extracts file paths for filesystem tools', () => {
    expect(fingerprint('Write', { file_path: '/tmp/a.txt' })).toBe('/tmp/a.txt')
    expect(fingerprint('Edit', { file_path: '/tmp/b.ts' })).toBe('/tmp/b.ts')
    expect(fingerprint('Read', { file_path: '/tmp/c.md' })).toBe('/tmp/c.md')
  })

  it('extracts patterns for search tools', () => {
    expect(fingerprint('Grep', { pattern: 'foo' })).toBe('foo')
    expect(fingerprint('Glob', { pattern: '*.ts' })).toBe('*.ts')
  })

  it('does not stringify objects as [object Object]', () => {
    // An object value should fall back to '' (default), not '[object Object]'.
    expect(fingerprint('Bash', { command: { nested: true } })).toBe('')
  })
})

describe('PermissionChecker — modes', () => {
  it('auto mode allows by default when no rule matches', async () => {
    const checker = new PermissionChecker('auto')
    const d = await checker.check({ tool: 'Read', input: { file_path: '/a' } })
    expect(d.allowed).toBe(true)
  })

  it('deny mode blocks by default when no rule matches', async () => {
    const checker = new PermissionChecker('deny')
    const d = await checker.check({ tool: 'Bash', input: { command: 'ls' } })
    expect(d.allowed).toBe(false)
  })

  it('ask mode prompts via the approver when no rule matches', async () => {
    let asked = false
    const approver: Approver = async () => { asked = true; return true }
    const checker = new PermissionChecker('ask', [], approver)
    const d = await checker.check({ tool: 'Read', input: { file_path: '/a' } })
    expect(asked).toBe(true)
    expect(d.allowed).toBe(true)
  })
})

describe('PermissionChecker — rules', () => {
  it('default rule escalates rm -rf to ask even in auto mode', async () => {
    let asked = false
    const approver: Approver = async () => { asked = true; return false }
    const checker = new PermissionChecker('auto', [], approver)
    const d = await checker.check({ tool: 'Bash', input: { command: 'rm -rf /tmp/x' } })
    expect(asked).toBe(true)
    expect(d.allowed).toBe(false)
    expect(d.reason).toContain('user')
  })

  it('a consumer allow rule overrides deny mode', async () => {
    const checker = new PermissionChecker('deny', [
      { tool: 'Read', action: 'allow' },
    ])
    const d = await checker.check({ tool: 'Read', input: { file_path: '/a' } })
    expect(d.allowed).toBe(true)
  })

  it('fails safe (deny) when ask is required but no approver is wired', async () => {
    const checker = new PermissionChecker('auto') // no approver
    const d = await checker.check({ tool: 'Bash', input: { command: 'sudo rm -rf /' } })
    expect(d.allowed).toBe(false)
    expect(d.reason).toContain('no approver')
  })

  it('approver rejection yields a denied decision', async () => {
    const approver: Approver = async () => false
    const checker = new PermissionChecker('ask', [], approver)
    const d = await checker.check({ tool: 'Write', input: { file_path: '/a' } })
    expect(d.allowed).toBe(false)
  })

  it('built-in destructive rules win over a consumer wildcard allow', async () => {
    // Audit P1 fix — defaults now precede consumer rules. A bare wildcard
    // allow must NOT mask the built-in `rm -rf` / `sudo ` / `git push
    // --force` escalations. The previous ordering let broad consumer
    // allows silently override built-in destructive asks.
    const checker = new PermissionChecker('auto', [
      { tool: '*', action: 'allow' },
    ])
    const d = await checker.check({ tool: 'Bash', input: { command: 'sudo rm -rf /' } })
    expect(d.allowed).toBe(false)
    expect(d.reason).toMatch(/no approver|ask|denied/)
  })

  it('consumer tool+pattern rule can still override a built-in ask (most-specific wins)', async () => {
    // When a consumer declares an EXPLICIT (tool+pattern) match, that
    // more-specific rule wins — but only because we re-sort consumer
    // rules ahead of built-in defaults by specificity. Wildcards still
    // rank lowest and cannot override built-ins.
    const approver: Approver = async () => true
    const checker = new PermissionChecker('auto', [
      { tool: 'Bash', pattern: 'ls', action: 'allow' },
    ], approver)
    // `ls` does not match any built-in destructive pattern, so the
    // consumer allow rule is the first match and wins.
    const d = await checker.check({ tool: 'Bash', input: { command: 'ls -la' } })
    expect(d.allowed).toBe(true)
  })

  it('throws on invalid mode', () => {
    // Audit P1 fix — typo in mode would have silently fallen through
    // to "auto" semantics.
    expect(() => new PermissionChecker('plz-allow' as never)).toThrow(/invalid mode/)
  })

  it('deduplicates rules that share tool+pattern', async () => {
    // Audit P1 fix — the legacy pwn profile shipped `'sqlmap'` twice
    // in deniedTools. Verify dedup keeps a single rule.
    const checker = new PermissionChecker('auto', [
      { tool: 'Bash', pattern: 'sqlmap', action: 'deny' },
      { tool: 'Bash', pattern: 'sqlmap', action: 'allow' },
    ])
    // First occurrence (deny) wins; second (allow) is dropped.
    const d = await checker.check({ tool: 'Bash', input: { command: 'sqlmap --help' } })
    expect(d.allowed).toBe(false)
  })

  it('a thrown approver error is caught and treated as deny', async () => {
    const approver: Approver = async () => { throw new Error('boom') }
    const checker = new PermissionChecker('ask', [], approver)
    const d = await checker.check({ tool: 'Read', input: { file_path: '/a' } })
    expect(d.allowed).toBe(false)
  })

  it('default rules include common destructive patterns', () => {
    const patterns = DEFAULT_PERMISSION_RULES.map(r => r.pattern)
    expect(patterns).toContain('rm -rf')
    expect(patterns).toContain('sudo ')
    expect(patterns).toContain('git push --force')
  })
})
