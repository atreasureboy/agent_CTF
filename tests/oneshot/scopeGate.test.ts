import { describe, it, expect } from 'vitest'
import {
  ScopeGate,
  parseTarget,
  ScopeDeniedError,
} from '../../src/ctf/oneshot/index.js'

describe('ScopeGate', () => {
  it('parseTarget extracts host + port', () => {
    expect(parseTarget('https://example.com:8443/path')).toEqual({
      host: 'example.com',
      port: 8443,
      domain: 'example.com',
    })
    expect(parseTarget('https://example.com/path').host).toBe('example.com')
    expect(parseTarget('10.0.0.1:22').ip).toBe('10.0.0.1')
    expect(parseTarget('10.0.0.1:22').port).toBe(22)
  })

  it('denies private IPs even if allow-list is empty', () => {
    const gate = new ScopeGate({ hosts: [], domains: [], ports: [], cidrs: [] }, { denyByDefault: false })
    expect(() => gate.assert('127.0.0.1')).toThrow(ScopeDeniedError)
    expect(() => gate.assert('10.0.0.1')).toThrow(ScopeDeniedError)
    expect(() => gate.assert('169.254.169.254')).toThrow(ScopeDeniedError)
  })

  it('denies private hostnames', () => {
    const gate = new ScopeGate({ hosts: [], domains: [], ports: [], cidrs: [] }, { denyByDefault: false })
    expect(() => gate.assert('localhost')).toThrow(ScopeDeniedError)
  })

  it('allows hosts in allow-list', () => {
    const gate = new ScopeGate(
      { hosts: ['ctf.example.com'], domains: [], ports: [], cidrs: [] },
      { denyByDefault: false },
    )
    expect(() => gate.assert('ctf.example.com')).not.toThrow()
  })

  it('denies non-matching hosts when denyByDefault=true', () => {
    const gate = new ScopeGate({ hosts: ['ctf.example.com'], domains: [], ports: [], cidrs: [] }, { denyByDefault: true })
    expect(() => gate.assert('evil.com')).toThrow(/not in allow-list/)
  })

  it('matches domains with subdomains', () => {
    const gate = new ScopeGate(
      { hosts: [], domains: ['example.com'], ports: [], cidrs: [] },
      { denyByDefault: true },
    )
    expect(() => gate.assert('sub.example.com')).not.toThrow()
  })

  it('matches CIDR ranges', () => {
    const gate = new ScopeGate(
      { hosts: [], domains: [], ports: [], cidrs: ['10.0.0.0/8'] },
      { denyByDefault: true },
    )
    expect(() => gate.assert('10.1.2.3')).not.toThrow()
    expect(() => gate.assert('11.1.2.3')).toThrow()
  })

  it('respects port restrictions', () => {
    const gate = new ScopeGate(
      { hosts: ['ctf.example.com'], domains: [], ports: [443], cidrs: [] },
      { denyByDefault: true },
    )
    expect(() => gate.assert('ctf.example.com:443')).not.toThrow()
    expect(() => gate.assert('ctf.example.com:80')).toThrow(/port/i)
  })

  it('filterAllowed returns matching targets', () => {
    const gate = new ScopeGate(
      { hosts: ['ctf.example.com'], domains: [], ports: [], cidrs: [] },
      { denyByDefault: true },
    )
    expect(gate.filterAllowed(['ctf.example.com', 'evil.com'])).toEqual(['ctf.example.com'])
  })

  it('check returns allowed=false on denial', () => {
    const gate = new ScopeGate({ hosts: [], domains: [], ports: [], cidrs: [] }, { denyByDefault: false })
    expect(gate.check('10.0.0.1')).toEqual({ allowed: false, reason: 'private' })
  })
})
