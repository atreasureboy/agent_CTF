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

export interface BashPolicyCheck {
  firstExecutable: string
  allowed: boolean
  reason: string
}

const SHELL_BUILTINS = new Set([
  'echo','printf','read','test','[',']','true','false','exit','set','unset',
  'export','source','alias','cd','pwd','jobs','bg','fg','history','hash',
  'help','type','ulimit','umask','wait','kill','let','local','declare','typeset',
  'shopt','caller','return','shift','times','trap','suspend','enable','eval',
  'exec','command','getopts','hash','mapfile','readarray','coproc','bind','builtin',
  'compgen','complete','compopt','dircolors','dirs','disown','fc','getconf','hash',
  'hostnamectl','locale','localedef','mktemp','nproc','numfmt','od','patch','pathchk',
  'pinky','printenv','pwd','rename','renice','runcon','seq','shred','shuf','stat',
  'strace','sudo','sync','tac','tail','tar','tee','test','time','timeout','tload',
  'top','touch','tr','tree','true','truncate','tsort','tty','tzselect','uclampset',
  'umask','umount','uname','unexpand','uniq','unlink','users','vdir','wc','wget',
  'whereis','which','who','whoami','xargs','yes','zcat','zdiff','zegrep','zfgrep',
  'zforce','zgrep','zless','zmore','znew',
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

/**
 * Extract host or host:port or full URL args following a network-y verb.
 * Walks the argv after a network verb, skipping leading flags
 * (-x / --xxx) AND the value-after-equals form, and falls back to the first
 * positional argument that looks like a host.
 */
export function extractNetworkTargets(command: string): string[] {
  const out: string[] = []
  const NETWORK_VERBS = new Set(['curl', 'wget', 'nc', 'netcat', 'nmap', 'httpx', 'httpie', 'sqlmap', 'nikto'])
  const tokens = command.split(/\s+/).filter(Boolean)
  for (let i = 0; i < tokens.length; i++) {
    const verb = tokens[i].replace(/[^a-zA-Z]/g, '')
    if (!NETWORK_VERBS.has(verb)) continue
    for (let j = i + 1; j < tokens.length; j++) {
      const arg = tokens[j]
      // Long-form flag like --max-time 30 → skip the value too.
      if (arg.startsWith('--')) {
        const eq = arg.indexOf('=')
        if (eq === -1) { j++ }  // next token is the flag's value
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

  const first = firstExecutable(cmd)
  if (!first) return { allowed: false, reason: 'unable to parse command', firstExecutable: null }

  // Allow built-ins + shell control.
  if (SHELL_BUILTINS.has(first)) {
    return { allowed: true, reason: 'shell builtin', firstExecutable: first }
  }

  const denied = input.profile.deniedCommands
  if (denied && denied.includes(first)) {
    const reason = `command "${first}" is denied by profile "${input.profile.id}" (deniedCommands).`
    input.eventLog?.append('permission', 'bash-policy', {
      decision: 'deny',
      command: first,
      reason,
      profile: input.profile.id,
    }, ['bash-policy', 'deny'])
    return { allowed: false, reason, firstExecutable: first }
  }

  // A profile's deniedTools list may also be enforced at the binary level —
  // e.g. an image-stego profile denies the `nmap` tool. If the LLM bypasses
  // the broker and writes `nmap -sV ...` directly into a Bash command, the
  // command policy must still refuse.
  if (input.profile.deniedTools && input.profile.deniedTools.includes(first)) {
    const reason = `command "${first}" is denied by profile "${input.profile.id}" (deniedTools).`
    input.eventLog?.append('permission', 'bash-policy', {
      decision: 'deny',
      command: first,
      reason,
      profile: input.profile.id,
    }, ['bash-policy', 'deny', 'bypass'])
    return { allowed: false, reason, firstExecutable: first }
  }

  const allowed = input.profile.allowedCommands
  if (allowed && allowed.length > 0 && !allowed.includes(first)) {
    const reason = `command "${first}" is not in profile "${input.profile.id}" allowedCommands.`
    input.eventLog?.append('permission', 'bash-policy', {
      decision: 'deny',
      command: first,
      reason,
      profile: input.profile.id,
    }, ['bash-policy', 'deny'])
    return { allowed: false, reason, firstExecutable: first }
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
        input.eventLog?.append('permission', 'bash-policy', {
          decision: 'deny',
          command: first,
          reason,
          target: hostPort,
        }, ['bash-policy', 'network', 'deny'])
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
