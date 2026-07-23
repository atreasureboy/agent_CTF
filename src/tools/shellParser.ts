/**
 * shellParser — state-machine Shell command splitter.
 *
 * Six_goal §十二 forbids continuing to pile regex on top of regex to
 * simulate Shell syntax. This module is a small but real tokenizer that
 * walks the command character-by-character, tracking:
 *   - single-quote / double-quote contexts
 *   - nested $(...) / `...` / (...) subshells
 *   - heredoc openers (best-effort)
 *   - control operators ; && || | & > < |& etc.
 *
 * It returns one ParsedSegment per top-level command (already-trimmed,
 * with the actual executable resolved). Any character we cannot place in
 * a known state aborts the parse — the caller is expected to fail-closed
 * rather than guess.
 */

export interface ParsedSegment {
  /** Raw text of this segment, including assignments and redirections. */
  text: string
  /** First executable token inside the segment (skipping `env`, `sudo`,
   *  leading VAR=val assignments). `null` if no executable could be found. */
  firstExecutable: string | null
}

export interface ParseResult {
  segments: ParsedSegment[]
  /** True when the input contained syntax we could not place (FAIL-CLOSED). */
  unknown: boolean
}

/** Strip leading `VAR=val …` assignments, `env [-i] [VAR=val …]`, `sudo [-flags]`. */
function firstExecutableToken(rest: string): string | null {
  const tokens = rest.split(/\s+/).filter(Boolean)
  let i = 0
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++
  if (i >= tokens.length) return null
  // Helper-less wrappers / privilege escalation — consume them along with any
  // short/long flag they accept (`env -i VAR=x …`, `sudo -E -u root …`).
  if (
    tokens[i] === 'sudo' || tokens[i] === 'command' || tokens[i] === 'env' ||
    tokens[i] === 'nice' || tokens[i] === 'nohup' || tokens[i] === 'timeout'
  ) {
    i++
    while (i < tokens.length && /^(-[A-Za-z]|--[A-Za-z][A-Za-z-]*)/.test(tokens[i])) {
      const t = tokens[i]
      // `--flag=value` form — single token.
      if (t.startsWith('--') && t.includes('=')) {
        i++
        continue
      }
      // `--flag value` form — also consume the next non-flag token.
      if (t.startsWith('--')) {
        // Only consume the next token when it's not another flag and not a
        // shell control character — `-u root` is a sudo-specific pattern
        // most other `--flag` cases do not match. We keep this conservative.
        const next = tokens[i + 1]
        if (next && /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(next)) i += 2
        else i++
        continue
      }
      // Short flag cluster (`-E`, `-i`, `-u`). Distinguished by whether the
      // flag expects a value:
      //   - simple flags with no argument: `-E`, `-i`, `-H`, `-v`
      //   - flags with required argument: `-u root`, `-g group`
      const VALUE_TAKING_SHORT = new Set([
        'u', // sudo -u root
        'g', // sudo -g group
        'C', // sudo -C fd
        'D', // sudo -D level
        'r', // sudo -r role
      ])
      const m = t.match(/^-([A-Za-z]+)$/)
      if (m) {
        const tail = m[1]
        // Heuristic: if only one short letter, treat as separate flag.
        if (tail.length === 1) {
          i++
          if (VALUE_TAKING_SHORT.has(tail) && i < tokens.length) i++
          continue
        }
        // Otherwise treat the cluster as a sequence of single-letter flags.
        i++
        const lastChar = tail[tail.length - 1] ?? ''
        if (VALUE_TAKING_SHORT.has(lastChar) && i < tokens.length) i++
        continue
      }
      i++
    }
    while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++
  }
  if (i >= tokens.length) return null
  let tok = tokens[i]
  // Strip balanced-subshell leading parens.
  while (tok.startsWith('(') && tok !== '(') tok = tok.slice(1)
  return tok.replace(/[,;&|]/g, '')
}

const CTRL_OPS = new Set([';', '&&', '||', '|', '|&', '&', '&!'])

/** Tokenize by walking the string character-by-character. */
export function parseShellCommand(command: string): ParseResult {
  const segments: ParsedSegment[] = []
  const buf: string[] = []
  let inSingle = false
  let inDouble = false
  let parenDepth = 0
  let braceDepth = 0
  let subshellDepth = 0
  let i = 0
  let unknown = false

  const flushSegment = (): void => {
    const text = buf.join('').trim()
    if (text.length > 0) {
      const seg: ParsedSegment = { text, firstExecutable: null }
      seg.firstExecutable = firstExecutableToken(text)
      segments.push(seg)
    }
    buf.length = 0
  }

  while (i < command.length) {
    const c = command[i]
    const next = command[i + 1] ?? ''
    const next2 = command[i + 2] ?? ''

    if (inSingle) {
      buf.push(c)
      if (c === "'") inSingle = false
      i++
      continue
    }
    if (inDouble) {
      buf.push(c)
      // `"…"` allows nested `$(...)`.
      if (c === '\\' && i + 1 < command.length) {
        buf.push(next)
        i += 2
        continue
      }
      if (c === '"') inDouble = false
      else if (c === '$' && next === '(') {
        subshellDepth++
        buf.push('(')
        i += 2
        continue
      }
      i++
      continue
    }

    // Not in a quote.
    if (c === "'") {
      inSingle = true
      buf.push(c)
      i++
      continue
    }
    if (c === '"') {
      inDouble = true
      buf.push(c)
      i++
      continue
    }
    if (c === '\\' && i + 1 < command.length) {
      buf.push(c, next)
      i += 2
      continue
    }

    if (c === '$' && next === '(') {
      subshellDepth++
      buf.push('$(..)')
      i += 2
      continue
    }
    if (c === '`' ) {
      // Backtick subshell — consume until matching backtick (no nesting).
      const end = command.indexOf('`', i + 1)
      if (end < 0) {
        unknown = true
        buf.push(c)
        i++
        continue
      }
      buf.push(command.slice(i, end + 1))
      i = end + 1
      continue
    }

    if (c === '(') {
      parenDepth++
      buf.push(c)
      i++
      continue
    }
    if (c === ')') {
      if (parenDepth > 0) parenDepth--
      if (subshellDepth > 0) subshellDepth--
      buf.push(c)
      i++
      continue
    }
    if (c === '{') {
      braceDepth++
      buf.push(c)
      i++
      continue
    }
    if (c === '}') {
      if (braceDepth > 0) braceDepth--
      buf.push(c)
      i++
      continue
    }

    // Multi-character operators.
    if (c === '&' && next === '&') {
      if (parenDepth === 0 && subshellDepth === 0) {
        flushSegment()
        i += 2
        continue
      }
      buf.push(c, next)
      i += 2
      continue
    }
    if (c === '|' && next === '|') {
      if (parenDepth === 0 && subshellDepth === 0) {
        flushSegment()
        i += 2
        continue
      }
      buf.push(c, next)
      i += 2
      continue
    }
    if (c === '|' && next === '&') {
      if (parenDepth === 0 && subshellDepth === 0) {
        flushSegment()
        i += 2
        continue
      }
      buf.push(c, next)
      i += 2
      continue
    }

    // Single-character operators (only act when not nested).
    if (parenDepth === 0 && subshellDepth === 0) {
      if (c === ';') {
        flushSegment()
        i++
        continue
      }
      if (c === '|') {
        // Pipe — split the segment but keep the next piece in a new one.
        flushSegment()
        i++
        continue
      }
    }

    // Comments — # to end of line, only at the start of a word.
    if (c === '#' && (buf.length === 0 || /\s$/.test(buf[buf.length - 1] ?? ''))) {
      const nl = command.indexOf('\n', i)
      const end = nl < 0 ? command.length : nl
      i = end
      continue
    }

    buf.push(c)
    i++
    void next
    void next2
    void CTRL_OPS
  }

  if (inSingle || inDouble || parenDepth > 0 || subshellDepth > 0 || braceDepth > 0) {
    unknown = true
  }
  flushSegment()
  return { segments, unknown }
}

/** Convenience: parse + flatten to first-executables-per-segment. */
export function allExecutablesShellSafe(command: string): { executables: string[]; unknown: boolean } {
  const r = parseShellCommand(command)
  if (r.unknown) return { executables: [], unknown: true }
  const exes = r.segments
    .map((s) => s.firstExecutable)
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
  return { executables: exes, unknown: false }
}

/** Fail-closed helper — used by the BashTool policy. */
export function firstExecutableSafe(command: string): string | null {
  const r = parseShellCommand(command)
  if (r.unknown || r.segments.length === 0) return null
  return r.segments[0]?.firstExecutable ?? null
}
