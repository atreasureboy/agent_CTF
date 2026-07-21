/**
 * ToolFirstPolicy — verify the built-in rules fire correctly across categories.
 */

import { describe, expect, it } from 'vitest'

import { ToolFirstPolicy } from '../src/core/toolFirstPolicy.js'
import { PROFILES } from '../src/capabilityProfiles/builtin.js'

describe('ToolFirstPolicy', () => {
  const policy = new ToolFirstPolicy()

  it('fires web-enumeration rule when curl is used after port-scan keyword', () => {
    const v = policy.advise(
      'Bash',
      { command: 'We need a full port scan. Try curl http://target:80' },
      PROFILES['triage'],
    )
    expect(v.rule).toBe('web-enumeration')
    expect(v.advice).toMatch(/nmap/)
  })

  it('fires image-stego rule when input mentions a PNG and pixel extraction', () => {
    const v = policy.advise(
      'Bash',
      { command: 'python extract_lsb.py logo.png' },
      PROFILES['image-stego'],
    )
    expect(v.rule).toBe('image-stego')
    expect(v.advice).toMatch(/image_quick_scan/)
  })

  it('fires rsa rule only for crypto profile', () => {
    const vOther = policy.advise(
      'Bash',
      { command: 'rsa n=12345 e=65537' },
      PROFILES['image-stego'],
    )
    expect(vOther.rule).toBe('__none__')

    const vCrypto = policy.advise(
      'Bash',
      { command: 'rsa n=12345 e=65537' },
      PROFILES['crypto'],
    )
    expect(vCrypto.rule).toBe('rsa-common-attacks')
    expect(vCrypto.advice).toMatch(/rsa_common_attacks/)
  })

  it('fires unknown-file-triage when an opaque file is being classified', () => {
    const v = policy.advise(
      'Bash',
      { command: 'strings unknown_file_input | head' },
      PROFILES['triage'],
    )
    expect(v.rule).toBe('unknown-file-triage')
  })

  it('returns no advice for benign calls', () => {
    const v = policy.advise(
      'Read',
      { file_path: '/project/README.md' },
      PROFILES['triage'],
    )
    expect(v.rule).toBe('__none__')
    expect(v.advice).toBe('')
  })
})
