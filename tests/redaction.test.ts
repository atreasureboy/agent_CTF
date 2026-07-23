/**
 * Phase 2.1 — Redaction tests (round-4).
 */

import { describe, it, expect } from 'vitest'
import { redactSecrets, redactSecretsDeep } from '../src/core/ctfReasoning/redaction.js'

describe('redactSecrets', () => {
  it('redacts AWS long-term access key', () => {
    const r = redactSecrets('AKIAIOSFODNN7EXAMPLE leaked')
    expect(r).toContain('<redacted>')
    expect(r).not.toContain('AKIAIOSFODNN7EXAMPLE')
  })

  it('redacts AWS STS temporary credential (ASIA)', () => {
    const r = redactSecrets('ASIA1234567890ABCDEF leaked')
    expect(r).not.toContain('ASIA1234567890ABCDEF')
  })

  it('redacts GitHub PAT', () => {
    const r = redactSecrets('ghp_abc123def456ghi789jkl012mno345pqr678stu')
    expect(r).not.toContain('ghp_abc123def456ghi789jkl012mno345pqr678stu')
  })

  it('redacts Slack token', () => {
    const r = redactSecrets('xoxb-12345-67890-abcdefghij')
    expect(r).not.toContain('xoxb-12345-67890-abcdefghij')
  })

  it('redacts JWT', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MTIzIn0.signature'
    const r = redactSecrets(jwt)
    expect(r).not.toContain('eyJhbGciOiJIUzI1NiJ9')
  })

  it('redacts PEM block across newlines', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nABCDEF\nGHIJKL\n-----END RSA PRIVATE KEY-----'
    const r = redactSecrets(pem)
    expect(r).not.toContain('ABCDEF')
    expect(r).not.toContain('GHIJKL')
    expect(r).not.toContain('-----BEGIN RSA PRIVATE KEY-----')
    expect(r).toContain('<redacted>')
  })

  it('redacts password=... assignments', () => {
    const r = redactSecrets('user=admin password=hunter2 next=ok')
    expect(r).toContain('password=<redacted>')
    expect(r).not.toContain('hunter2')
    expect(r).toContain('user=admin')
  })

  it('redacts Bearer token but preserves trailing punctuation', () => {
    const r = redactSecrets('Authorization: Bearer abc.def-ghi.')
    expect(r).toContain('Authorization: Bearer <redacted>.')
    expect(r).not.toContain('abc.def-ghi')
  })

  it('is idempotent', () => {
    const a = redactSecrets('AKIAIOSFODNN7EXAMPLE password=secret')
    const b = redactSecrets(a)
    expect(b).toBe(a)
  })

  it('passes non-secret text through unchanged', () => {
    expect(redactSecrets('hello world')).toBe('hello world')
  })
})

describe('redactSecretsDeep', () => {
  it('walks nested objects and arrays', () => {
    const r = redactSecretsDeep({
      outer: { inner: 'AKIAIOSFODNN7EXAMPLE' },
      list: ['ghp_abc123def456ghi789jkl012mno345pqr678stu', 'plain', { x: 'AKIAIOSFODNN7EXAMPLE' }],
    }) as {
      outer: { inner: string }
      list: (string | { x: string })[]
    }
    expect(r.outer.inner).toBe('<redacted>')
    expect(r.list[0]).toBe('<redacted>')
    expect(r.list[1]).toBe('plain')
    expect((r.list[2] as { x: string }).x).toBe('<redacted>')
  })
})