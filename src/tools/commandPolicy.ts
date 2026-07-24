/**
 * Bash command policy — first-token enforcement used by BashTool.
 *
 * Reads `__ctf` from the legacy ToolContext. The Broker wires it so a
 * Bash call's command is checked against:
 *   - CapabilityProfile.allowedCommands / deniedCommands  (binary allow/deny)
 *   - CapabilityProfile.allowShell (default false; if false, refused outright)
 *   - ContestScope.assertNetwork when --target-style options are seen
 *
 * The check is synchronous and structured: on violation, returns a
 * { isError: true, content } that the model sees verbatim. Audit trail is
 * written via context.__ctf.eventLog.
 */

import type { CapabilityProfile } from '../core/capabilityProfile.js'
import type { ContestScopeChecker } from '../core/contestScope.js'
import type { EventLog } from '../core/eventLog.js'
import type { ToolContext } from '../core/types.js'
import { allExecutablesShellSafe, firstExecutableSafe, parseShellCommand } from './shellParser.js'

export interface BashPolicyCheck {
  firstExecutable: string
  allowed: boolean
  reason: string
  /** True when the new state-machine parser could not classify the command,
   *  so we fail-closed regardless of policy lookup. */
  unknown?: boolean
}

/**
 * Real bash builtins only — these are tokenised INSIDE the shell, never
 * dispatched to $PATH. Anything else MUST go through the deny / allow check
 * the same as an external binary. The previous list contaminated this set
 * with `/usr/bin/*` binaries (wget, curl, strace, sudo, tar, …) which made
 * `deniedCommands` silently bypassed by profiles: `image-stego` denying
 * `wget` was a no-op. Audit P0 fix.
 */
const SHELL_BUILTINS: ReadonlySet<string> = new Set([
  '.',
  ':',
  '[',
  'alias',
  'bg',
  'bind',
  'break',
  'builtin',
  'caller',
  'cd',
  'command',
  'compgen',
  'complete',
  'compopt',
  'continue',
  'declare',
  'dirs',
  'disown',
  'echo',
  'enable',
  'eval',
  'exec',
  'exit',
  'export',
  'false',
  'fc',
  'fg',
  'getopts',
  'hash',
  'help',
  'history',
  'jobs',
  'kill',
  'let',
  'local',
  'logout',
  'mapfile',
  'popd',
  'printf',
  'pushd',
  'pwd',
  'read',
  'readarray',
  'return',
  'set',
  'shift',
  'shopt',
  'source',
  'suspend',
  'test',
  'times',
  'trap',
  'true',
  'type',
  'typeset',
  'ulimit',
  'umask',
  'unalias',
  'unset',
  'wait',
])

/**
 * Return the first executable token from a bash command line.
 * Skips leading `VAR=value` assignments, `sudo`, `env`, and `env -i VAR=val …`.
 */
export function firstExecutable(command: string): string | null {
  const trimmed = command.trim()
  if (!trimmed) return null

  // Tokenise on whitespace, drop VAR=val pairs.
  const tokens: string[] = trimmed.split(/\s+/).filter(Boolean)
  let cursor = 0

  const skipAssignments = () => {
    while (cursor < tokens.length && /^[A-Z_][A-Z0-9_]*=/.test(tokens[cursor])) cursor++
  }

  if (tokens[cursor] === 'sudo') {
    cursor++
  }
  if (tokens[cursor] === 'env') {
    cursor++
    if (tokens[cursor] === '-i') cursor++
    skipAssignments()
  }
  skipAssignments()
  return tokens[cursor] ?? null
}

export function allExecutables(command: string): string[] {
  // Audit round 11 — use the state-machine splitter for accurate segment
  // boundary detection (handles parens, subshells, backticks, heredocs,
  // and balanced quotes — the legacy regex splitter cannot).
  const safe = allExecutablesShellSafe(command)
  if (safe.unknown) return [] // fail-closed: no executables resolvable.
  return Array.from(new Set(safe.executables))
}

/** State-machine-backed variant of `firstExecutable`. */
export function firstExecutableShellSafe(command: string): string | null {
  return firstExecutableSafe(command)
}

function stripSubshells(s: string): string {
  // Replace $(...) and `...` with empty strings so their contents
  // don't introduce a separate first-token into the parent.
  return s
    .replace(/`[^`]*`/g, '')
    .replace(/\$\((?:[^()]|\([^()]*\))*\)/g, '')
    .replace(/\$\{[^}]*\}/g, '')
}

/**
 * Extract host or host:port or full URL args following a network-y verb.
 * Walks the argv after a network verb, skipping leading flags
 * (-x / --xxx) AND the value-after-equals form, and falls back to the first
 * positional argument that looks like a host.
 */
export function extractNetworkTargets(command: string): string[] {
  const out: string[] = []
  const NETWORK_VERBS = new Set([
    'curl',
    'wget',
    'nc',
    'netcat',
    'nmap',
    'httpx',
    'httpie',
    'sqlmap',
    'nikto',
  ])
  const tokens = command.split(/\s+/).filter(Boolean)
  for (let i = 0; i < tokens.length; i++) {
    const verb = tokens[i].replace(/[^a-zA-Z]/g, '')
    if (!NETWORK_VERBS.has(verb)) continue
    for (let j = i + 1; j < tokens.length; j++) {
      const arg = tokens[j]
      // Long-form flag like --max-time 30 → skip the value too.
      if (arg.startsWith('--')) {
        const eq = arg.indexOf('=')
        if (eq === -1) {
          j++
        } // next token is the flag's value
        continue
      }
      // Short flag with attached value like -m30 or standalone flag -v.
      if (arg.startsWith('-') && arg.length === 2) continue
      if (arg.startsWith('-')) continue
      // Match URL / bracketed IPv6 / bare host.
      if (/^https?:\/\/[^/]+/i.test(arg)) {
        out.push(arg)
        break
      }
      if (/^\[[0-9a-fA-F:]+\](?::\d+)?$/i.test(arg)) {
        out.push(arg)
        break
      }
      if (/^[A-Za-z0-9][A-Za-z0-9._-]+(?::\d+)?(\/.*)?$/.test(arg)) {
        out.push(arg)
        break
      }
    }
  }
  return Array.from(new Set(out))
}

export interface CommandPolicyInput {
  command: string
  profile: CapabilityProfile
  contestScope?: ContestScopeChecker
  eventLog?: EventLog
}

export interface CommandPolicyResult {
  allowed: boolean
  reason: string
  firstExecutable: string | null
  /** True when the parser failed closed. */
  unknown?: boolean
}

export function evaluateCommandPolicy(input: CommandPolicyInput): CommandPolicyResult {
  const cmd = input.command.trim()
  if (!cmd) return { allowed: false, reason: 'empty command', firstExecutable: null }

  if (!input.profile.allowShell) {
    return {
      allowed: false,
      reason: `profile "${input.profile.id}" has allowShell=false — Bash is disabled for this agent.`,
      firstExecutable: null,
    }
  }

  // Audit round 11 — use the state-machine splitter so a missing lexer
  // state fails closed (unknown=true) instead of being silently allowed.
  const parse = parseShellCommand(cmd)
  if (parse.unknown) {
    input.eventLog?.append(
      'permission',
      'bash-policy',
      {
        decision: 'deny',
        reason: 'unparseable shell — fail-closed',
        profile: input.profile.id,
      },
      ['bash-policy', 'parse-error', 'deny'],
    )
    return {
      allowed: false,
      reason: 'shell parser failed closed (complex/unparseable command)',
      firstExecutable: null,
      unknown: true,
    }
  }
  const first = parse.segments[0]?.firstExecutable ?? null
  if (!first) return { allowed: false, reason: 'unable to parse command', firstExecutable: null }

  const denied = input.profile.deniedCommands
  const allowed = input.profile.allowedCommands
  const deniedTools = input.profile.deniedTools

  // Build a denylist predicate. Even when the first executable is a builtin
  // (e.g. `echo ok; nmap`) we must still scan every segment — the legacy
  // short-circuit was the source of the §十二 bypass.
  const denyOne = (exe: string): string | null => {
    if (denied && denied.includes(exe))
      return `"${exe}" is denied by profile "${input.profile.id}" (deniedCommands)`
    if (deniedTools && deniedTools.includes(exe))
      return `"${exe}" is denied by profile "${input.profile.id}" (deniedTools)`
    if (allowed && allowed.length > 0 && !allowed.includes(exe) && !SHELL_BUILTINS.has(exe)) {
      return `"${exe}" is not in profile "${input.profile.id}" allowedCommands`
    }
    return null
  }

  for (const seg of parse.segments) {
    if (!seg.firstExecutable) continue
    const exe = seg.firstExecutable
    // Shell builtins are tokenised inside the shell — `deniedCommands` does
    // not apply. Keeping the explicit allow lets `echo ok; nmap evil.com`
    // still trip the `nmap` deny.
    if (SHELL_BUILTINS.has(exe)) continue
    const reason = denyOne(exe)
    if (reason) {
      input.eventLog?.append(
        'permission',
        'bash-policy',
        {
          decision: 'deny',
          command: exe,
          reason,
          profile: input.profile.id,
        },
        ['bash-policy', 'deny', 'composite-bypass'],
      )
      return { allowed: false, reason, firstExecutable: exe }
    }
  }

  // No segment triggered a deny — apply the path-specific verdict for the
  // first executable so audit logs still record why the call was allowed.
  if (SHELL_BUILTINS.has(first)) {
    return { allowed: true, reason: 'shell builtin', firstExecutable: first }
  }

  // Audit rounds 6-10 — composite commands can chain executable tokens
  // via `;`, `&&`, `||`, `|`, `$(...)`, and subshells. The legacy
  // policy only inspects the FIRST token, so `echo ok; nmap evil.com`
  // would pass the first token (`echo`) and bypass deniedCommands.
  // We extract every executable from the command and apply the
  // denied/allowed checks against each.
  const allExecs = allExecutables(cmd)
  for (const exec of allExecs) {
    if (exec === first) continue // already checked above
    if (denied && denied.includes(exec)) {
      const reason = `command "${exec}" is denied by profile "${input.profile.id}" (deniedCommands, via composite).`
      input.eventLog?.append(
        'permission',
        'bash-policy',
        {
          decision: 'deny',
          command: exec,
          reason,
          profile: input.profile.id,
        },
        ['bash-policy', 'deny', 'composite-bypass'],
      )
      return { allowed: false, reason, firstExecutable: exec }
    }
    if (input.profile.deniedTools && input.profile.deniedTools.includes(exec)) {
      const reason = `command "${exec}" is denied by profile "${input.profile.id}" (deniedTools, via composite).`
      input.eventLog?.append(
        'permission',
        'bash-policy',
        {
          decision: 'deny',
          command: exec,
          reason,
          profile: input.profile.id,
        },
        ['bash-policy', 'deny', 'composite-bypass'],
      )
      return { allowed: false, reason, firstExecutable: exec }
    }
    if (allowed && allowed.length > 0 && !allowed.includes(exec)) {
      const reason = `command "${exec}" is not in profile "${input.profile.id}" allowedCommands (composite).`
      input.eventLog?.append(
        'permission',
        'bash-policy',
        {
          decision: 'deny',
          command: exec,
          reason,
          profile: input.profile.id,
        },
        ['bash-policy', 'deny', 'composite-bypass'],
      )
      return { allowed: false, reason, firstExecutable: exec }
    }
  }

  // Network targets — strip and verify.
  if (input.contestScope) {
    const targets = extractNetworkTargets(cmd)
    for (const target of targets) {
      const hostPort = target.replace(/^https?:\/\//, '').split('/')[0]
      try {
        input.contestScope.assertNetwork(hostPort)
      } catch (err) {
        const reason = `command targets "${hostPort}" which is outside contest network scope: ${(err as Error).message}`
        input.eventLog?.append(
          'permission',
          'bash-policy',
          {
            decision: 'deny',
            command: first,
            reason,
            target: hostPort,
          },
          ['bash-policy', 'network', 'deny'],
        )
        return { allowed: false, reason, firstExecutable: first }
      }
    }
  }

  return { allowed: true, reason: 'allowed', firstExecutable: first }
}

export interface BashPolicyContext {
  profile?: CapabilityProfile
  contestScope?: ContestScopeChecker
  eventLog?: EventLog
}

export function readPolicyFromContext(context: ToolContext): BashPolicyContext {
  const ext = context as unknown as { __ctf?: BashPolicyContext }
  return ext.__ctf ?? {}
}
