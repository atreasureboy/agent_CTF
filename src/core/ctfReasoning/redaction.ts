/**
 * redaction — Phase 2.1 §round-3 audit fix.
 *
 * Strips known secret patterns from strings before they reach
 * Observation / rawExcerpt / Evidenc's claim text. The redactor is
 * conservative — false positives are preferred over leaking secrets.
 */

const PATTERNS: Array<{ re: RegExp; label: string }> = [
  // AWS access key id (long-term) + ASIA STS temporary credentials.
  { re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, label: 'aws_access_key_id' },
  // GitHub tokens
  { re: /ghp_[A-Za-z0-9]{36,}/g, label: 'github_pat' },
  { re: /gh[opsu]_[A-Za-z0-9]{36,}/g, label: 'github_token' },
  // Slack
  { re: /\bxox[baprs]-[A-Za-z0-9-]+\b/g, label: 'slack_token' },
  // JWT (header.payload.signature)
  { re: /\beyJ[A-Za-z0-9_=-]+\.eyJ[A-Za-z0-9_=-]+\.[A-Za-z0-9_=-]+/g, label: 'jwt' },
  // PEM private key block
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, label: 'pem_private_key' },
  // password= / token= assignments
  { re: /\b(password|passwd|pass|pwd|token|api[_-]?key|secret|signature)\s*=\s*([^\s&"']+)/gi, label: 'kv_secret' },
  // Authorization: Bearer ... — stop at trailing punctuation by
  // excluding `.` and only matching word chars + `-` + `_`.
  { re: /(Authorization:\s*Bearer\s+)([A-Za-z0-9_-]+)/gi, label: 'bearer_token' },
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

const MAX_REDACT_DEPTH = 32

export function redactSecretsDeep<T>(v: T): T {
  const seen = new WeakSet<object>()
  const visit = (val: unknown, depth: number): unknown => {
    if (depth > MAX_REDACT_DEPTH) return val
    if (typeof val === 'string') return redactSecrets(val)
    if (Array.isArray(val)) return val.map((x) => visit(x, depth + 1))
    if (val && typeof val === 'object') {
      if (seen.has(val as object)) return val
      seen.add(val as object)
      const out: Record<string, unknown> = {}
      for (const [k, x] of Object.entries(val as Record<string, unknown>)) {
        out[k] = visit(x, depth + 1)
      }
      return out
    }
    return val
  }
  return visit(v, 0) as T
}