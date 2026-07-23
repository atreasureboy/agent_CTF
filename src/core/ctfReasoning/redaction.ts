/**
 * redaction — Phase 2.1 §round-3 audit fix.
 *
 * Strips known secret patterns from strings before they reach
 * Observation / rawExcerpt / Evidenc's claim text. The redactor is
 * conservative — false positives are preferred over leaking secrets.
 */

const PATTERNS: Array<{ re: RegExp; label: string }> = [
  // AWS access key id
  { re: /\bAKIA[0-9A-Z]{16}\b/g, label: 'aws_access_key_id' },
  // GitHub tokens
  { re: /\bghp_[A-Za-z0-9]{36}\b/g, label: 'github_pat' },
  { re: /\bgh[osu]_[A-Za-z0-9]{36,}\b/g, label: 'github_token' },
  // Slack
  { re: /\bxox[baprs]-[A-Za-z0-9-]+\b/g, label: 'slack_token' },
  // JWT (header.payload.signature)
  { re: /\beyJ[A-Za-z0-9_=-]+\.eyJ[A-Za-z0-9_=-]+\.[A-Za-z0-9_=-]+/g, label: 'jwt' },
  // PEM private key block
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, label: 'pem_private_key' },
  // password= / token= assignments
  { re: /\b(password|passwd|token|api[_-]?key|secret|signature)\s*=\s*([^\s&"']+)/gi, label: 'kv_secret' },
  // Authorization: Bearer ...
  { re: /(Authorization:\s*Bearer\s+)([A-Za-z0-9_.-]+)/gi, label: 'bearer_token' },
]

const REDACTED = '<redacted>'

export function redactSecrets(input: string): string {
  if (!input) return input
  let out = input
  for (const { re, label } of PATTERNS) {
    out = out.replace(re, (match: string, ...args: unknown[]) => {
      if (label === 'kv_secret') {
        // Re-emit the key with the value replaced
        const k = match.split('=')[0]?.trim() ?? match
        return `${k}=${REDACTED}`
      }
      if (label === 'bearer_token') {
        const prefix = String(args[0] ?? 'Authorization: ')
        return `${prefix}${REDACTED}`
      }
      return REDACTED
    })
  }
  return out
}

export function redactSecretsDeep<T>(v: T): T {
  if (typeof v === 'string') return redactSecrets(v) as unknown as T
  if (Array.isArray(v)) return v.map((x) => redactSecretsDeep(x)) as unknown as T
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = redactSecretsDeep(val)
    }
    return out as unknown as T
  }
  return v
}