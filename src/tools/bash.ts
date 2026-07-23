/**
 * BashTool — shell command execution with proper abort support
 *
 * Key change vs the previous promisified exec() approach:
 * We use exec() in callback form so we hold a reference to the ChildProcess.
 * When context.signal fires (Ctrl+C), we kill the entire process group
 * (SIGTERM → SIGKILL after 5 s)
 */

import { exec, spawn } from 'child_process'
import type { Tool, ToolContext, ToolDefinition, ToolResult } from '../core/types.js'
import { BASH_DESCRIPTION } from '../prompts/tools.js'
import { mkdirSync } from 'fs'
import { join } from 'path'
import { evaluateCommandPolicy, readPolicyFromContext } from './commandPolicy.js'

const MAX_OUTPUT_LENGTH = 30_000
const DEFAULT_TIMEOUT_MS = 1_800_000  // 30 min — long-running commands default
const MAX_TIMEOUT_MS = 14_400_000    // 4 h — max for very long tasks
const MIN_TIMEOUT_MS = 1_000         // 1 s — sub-second timeouts are almost
                                      // always a unit mistake (LLM passing
                                      // seconds, e.g. 300 meaning "5 min").
                                      // Clamp up to default instead of killing
                                      // the command instantly.

// Shell detection — OVOGO_SHELL env overrides; otherwise bash (resolves via PATH
// on Windows if Git Bash/WSL is installed, /bin/bash on Unix).
const SHELL = process.env.OVOGO_SHELL || 'bash'

export interface BashInput {
  command: string
  timeout?: number
  run_in_background?: boolean
  description?: string
  follow_mode?: boolean   // Stream output to user's tmux pane for spectator view
}

function truncateOutput(output: string, maxLen: number): string {
  if (output.length <= maxLen) return output
  const half = Math.floor(maxLen / 2)
  const head = output.slice(0, half)
  const tail = output.slice(output.length - half)
  return `${head}\n\n[... ${output.length - maxLen} characters truncated ...]\n\n${tail}`
}

export class BashTool implements Tool {
  name = 'Bash'
  concurrencySafe = true

  definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'Bash',
      description: BASH_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'The bash command to execute',
          },
          timeout: {
            type: 'number',
            description: `Timeout in MILLISECONDS. Default: ${DEFAULT_TIMEOUT_MS} (30 min). Max: ${MAX_TIMEOUT_MS} (4 h). Values below ${MIN_TIMEOUT_MS} are treated as unit mistakes and clamped to the default. For long-running commands, prefer run_in_background:true instead of raising timeout.`,
          },
          run_in_background: {
            type: 'boolean',
            description: 'Run command in background and return immediately',
          },
          description: {
            type: 'string',
            description: 'Brief description of what this command does (shown to user)',
          },
          follow_mode: {
            type: 'boolean',
            description: 'If true, stream output to a tmux pane for real-time user viewing (spectator mode). The LLM still receives the full output after completion.',
          },
        },
        required: ['command'],
      },
    },
  }

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const { command, timeout, run_in_background, follow_mode, description } = input as unknown as BashInput

    if (!command || typeof command !== 'string') {
      return { content: 'Error: command is required and must be a string', isError: true }
    }

    // Surface the LLM-supplied description (Phase 1.7 audit — was
    // silently dropped before). When the Broker wired an eventLog, we
    // record the intent so audit consumers can correlate the command
    // with the model's rationale. Renderer hookup is intentionally
    // out-of-scope here (the existing observer surface remains the
    // eventLog + ToolResult).
    if (description) {
      const ev = (context as unknown as { __ctf?: { eventLog?: { append: (type: string, source: string, detail: Record<string, unknown>) => unknown } } }).__ctf?.eventLog
      ev?.append('tool_call', 'Bash', {
        tool: 'Bash',
        description,
        intent: description,
      })
    }

    // ── CapabilityProfile + ContestScope short-circuit ─────────────────
    // The CTF Harness injects `__ctf` into ToolContext via the ToolBroker.
    // When present, the command is checked against profile.allowedShell /
    // deniedCommands / allowedCommands and the contest network scope, BEFORE
    // any process is spawned. Violations return a structured refusal;
    // the audit trail records the decision.
    {
      const policy = readPolicyFromContext(context)
      // Audit P0 #9 — refuse ALL commands if the Broker did not supply a
      // profile. Previous behaviour was fail-open (run anything), which
      // meant an un-profiled context could execute arbitrary commands.
      // Default-deny is the only safe default.
      if (policy.profile === undefined) {
        const ev = policy.eventLog
        ev?.append('permission', 'bash', {
          decision: 'deny',
          reason: 'no profile in context — Bash requires a Broker-supplied profile',
          command,
        }, ['bash', 'no-profile', 'deny'])
        // Also surface to stderr so unit-test runs / CI logs show the
        // fail-closed posture. process.stderr is a no-op in non-TTY tests.
        try { process.stderr.write('[bash] refusing command: no profile in context\n') } catch { /* ignore */ }
        return {
          content: 'Bash refused: no profile in context; tool requires a Broker-supplied profile',
          isError: true,
        }
      }
      if (policy.profile) {
        const verdict = evaluateCommandPolicy({
          command,
          profile: policy.profile,
          contestScope: policy.contestScope,
          eventLog: policy.eventLog,
        })
        if (!verdict.allowed) {
          return {
            content: `Bash refused: ${verdict.reason}\nIf this command is required for your task, return a HandoffRequest to an agent whose profile permits it.`,
            isError: true,
          }
        }
      }
    }

    const timeoutMs = Math.min(
      typeof timeout === 'number' && timeout >= MIN_TIMEOUT_MS
        ? timeout
        : DEFAULT_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
    )

    // ── Background mode (fire-and-forget with auto log redirect) ─────────────
    if (run_in_background) {
      // Auto-redirect stdout/stderr to a session-scoped log file so output
      // is never lost even if the caller forgets to add `> file 2>&1`.
      const bgLogDir = context.sessionDir ? join(context.sessionDir, '.bg_logs') : join(context.cwd, '.bg_logs')
      try { mkdirSync(bgLogDir, { recursive: true }) } catch { /* best-effort */ }

      const ts = Date.now()
      const safeCmd = command.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 40)
      const logFile = join(bgLogDir, `${ts}_${safeCmd}.log`)

      // Append redirect if the caller didn't already redirect
      const alreadyRedirected = command.includes('>') || command.includes('2>&1') || command.includes('/dev/null')
      const actualCommand = alreadyRedirected ? command : `${command} >> "${logFile}" 2>&1`

      const child = spawn(SHELL, ['-c', actualCommand], {
        detached: true,
        stdio: 'ignore',
        cwd: context.cwd,
        env: process.env,
      })
      child.unref()

      // Audit P1 #A2 — background-mode spawn previously ignored
      // `context.signal` entirely. Register an abort listener that
      // kills the spawned process group so Ctrl+C actually stops the
      // background command. The listener is a no-op when the signal
      // has already fired, and harmless after the process exits.
      //
      // Audit P1 #2b — the original code sent SIGTERM on abort but had
      // no SIGKILL fallback, so a stubborn process (e.g. a child that
      // traps SIGTERM) would keep running after Ctrl+C. We schedule a
      // SIGKILL 5s after SIGTERM; the timer id is captured so the
      // process-exit handler can clear it when the child exits cleanly.
      if (context.signal && !context.signal.aborted) {
        let sigkillTimer: NodeJS.Timeout | null = null
        const killChild = (): void => {
          const pid = child.pid
          if (pid === undefined) return
          try { process.kill(-pid, 'SIGTERM') } catch { /* ignore */ }
          try { child.kill('SIGTERM') } catch { /* ignore */ }
          sigkillTimer = setTimeout(() => {
            try { process.kill(-pid, 'SIGKILL') } catch { /* ignore */ }
            try { child.kill('SIGKILL') } catch { /* ignore */ }
          }, 5_000)
        }
        const onAbort = (): void => {
          killChild()
        }
        // Clear the SIGKILL fallback if the child exits before the 5s window
        // closes. `child.once('exit', …)` covers the normal-exit path; the
        // `{ once: true }` flag on the abort listener handles its own cleanup.
        child.once('exit', () => {
          if (sigkillTimer) {
            clearTimeout(sigkillTimer)
            sigkillTimer = null
          }
        })
        context.signal.addEventListener('abort', onAbort, { once: true })
      }

      const redirectInfo = alreadyRedirected ? '' : `\n输出自动重定向到: ${logFile}`
      return {
        content: `Command started in background (PID: ${child.pid})${redirectInfo}`,
        isError: false,
      }
    }

    // ── Foreground mode with abort support ──────────────────────
    // Use exec() callback form so we can kill the child on abort.
    // Kill by process group approach.
    return new Promise<ToolResult>((resolve) => {
      let settled = false

      // ── follow_mode: set up tmux spectator pane ───────────────
      let actualCommand = command
      let followCleanup: (() => void) | null = null
      let followModeHint = ''
      if (follow_mode) {
        const followLogDir = context.sessionDir ? join(context.sessionDir, '.bg_logs') : join(context.cwd, '.bg_logs')
        try { mkdirSync(followLogDir, { recursive: true }) } catch { /* best-effort */ }
        const ts = Date.now()
        const safeCmd = command.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 40)
        const followLogFile = join(followLogDir, `${ts}_${safeCmd}_follow.log`)

        // Wrap command: tee duplicates output so the LLM captures it AND the follow log gets it
        actualCommand = `{ ${command}; } 2>&1 | tee -a "${followLogFile}"`

        // Launch a tmux session with tail -f for user viewing
        const tmuxSessionName = `ovogo-follow-${ts}`
        let paneJoined = false
        try {
          spawn('tmux', ['new-session', '-d', '-s', tmuxSessionName, '-x', '200', '-y', '50'], {
            cwd: context.cwd,
            detached: true,
          })
          spawn('tmux', ['send-keys', '-t', tmuxSessionName, `tail -n +1 -f "${followLogFile}"`, 'Enter'], {
            cwd: context.cwd,
          })
          // Try to join the follow pane into the user's current tmux window
          try {
            const currentTmux = process.env.TMUX_PANE ? process.env.TMUX?.split(',')[0]?.replace(/^\//, '') : null
            if (currentTmux) {
              spawn('tmux', ['join-pane', '-t', `${currentTmux}`, '-s', `${tmuxSessionName}`, '-l', '15'], {
                cwd: context.cwd,
              })
              paneJoined = true
            }
          } catch { /* best-effort: user can manually attach */ }

          followModeHint = paneJoined
            ? '[观战面板已嵌入当前 tmux 窗口底部]'
            : `[观战面板: tmux attach -t ${tmuxSessionName}]`

          followCleanup = () => {
            try { spawn('tmux', ['kill-session', '-t', tmuxSessionName], { detached: true }) } catch { /* ignore */ }
          }
        } catch { /* tmux not available, degrade gracefully */ }
      }

      const child = exec(
        actualCommand,
        {
          cwd: context.cwd,
          timeout: timeoutMs,
          maxBuffer: 50 * 1024 * 1024,
          env: { ...process.env, TERM: 'dumb' },
          shell: SHELL,
        },
        (err, stdout, stderr) => {
          // Audit P1 #2a — exec callback runs after kill(); onAbort has
          // already settled the promise with 'Command cancelled.'. Wrap
          // cleanup in try/finally so the abort listener is removed
          // even when we early-return on `settled`, and so a thrown
          // timer clear cannot leak the SIGKILL fallback (Phase 1.7 audit
          // round 1 — without this the timer fired 5s after a clean exit
          // and tried to kill a dead pid).
          try {
            // The promise was already settled by onAbort (Ctrl+C) — the
            // exec callback is a no-op for cancellation purposes.
            if (settled) return

            // Audit P1 #2a — distinguish user-cancellation (abort fired
            // first) from exec-timeout (SIGTERM without abort). The old
            // code reported BOTH as `Command timed out after N s`, which
            // hid user-cancellation behind a timeout message.
            if (context.signal?.aborted) {
              settled = true
              resolve({ content: 'Command cancelled by user.', isError: true })
              return
            }

            settled = true

            if (!err) {
              const combined = [stdout, stderr].filter(Boolean).join('\n').trimEnd()
              const prefix = follow_mode ? `[Spectator mode: output streamed to tmux pane] ${followModeHint}\n` : ''
              resolve({ content: truncateOutput(prefix + combined, MAX_OUTPUT_LENGTH) || '(no output)', isError: false })
              return
            }

            const nodeErr = err as NodeJS.ErrnoException & {
              killed?: boolean
              signal?: string
              stdout?: string
              stderr?: string
              code?: number
            }

            if (nodeErr.killed || nodeErr.signal === 'SIGTERM') {
              resolve({ content: `Command timed out after ${timeoutMs / 1000}s`, isError: true })
              return
            }

            // Non-zero exit — provide stdout+stderr so the LLM can diagnose
            const out = [nodeErr.stdout ?? stdout, nodeErr.stderr ?? stderr].filter(Boolean).join('\n').trimEnd()
            const exitCode = nodeErr.code ?? 1
            const prefix = follow_mode ? `[Spectator mode: output streamed to tmux pane] ${followModeHint}\n` : ''
            resolve({
              content: truncateOutput(prefix + `Exit code: ${exitCode}\n${out}`, MAX_OUTPUT_LENGTH).trimEnd(),
              isError: false,  // non-zero exit is not necessarily fatal
            })
          } finally {
            // Remove the abort listener to prevent it firing after process ends
            if (context.signal) {
              context.signal.removeEventListener('abort', onAbort)
            }

            // Clean up follow mode resources
            if (followCleanup) {
              followCleanup()
            }

            // Cancel the SIGKILL fallback timer
            if (sigkillTimer) {
              clearTimeout(sigkillTimer)
              sigkillTimer = null
            }
          }
        },
      )

      // ── Abort handler — kill entire process group ────────────
      // Send SIGTERM to process group
      let sigkillTimer: NodeJS.Timeout | null = null
      const onAbort = () => {
        if (settled) return
        settled = true

        const pid = child.pid
        if (pid !== undefined) {
          // Kill the process group (includes any subshells spawned by the command)
          try { process.kill(-pid, 'SIGTERM') } catch {
            try { child.kill('SIGTERM') } catch { /* ignore */ }
          }
          // SIGKILL fallback after 5 s for stubborn processes. The timer
          // is captured so exec handlers can clear it on the normal-exit
          // path (Phase 1.7 audit round 1 — without this the timer
          // fires 5 s after a clean exit and tries to kill a dead pid).
          sigkillTimer = setTimeout(() => {
            try { process.kill(-pid, 'SIGKILL') } catch {
              try { child.kill('SIGKILL') } catch { /* ignore */ }
            }
          }, 5_000)
        }

        resolve({ content: 'Command cancelled.', isError: true })
      }

      if (context.signal) {
        if (context.signal.aborted) {
          onAbort()
        } else {
          context.signal.addEventListener('abort', onAbort, { once: true })
        }
      }
    })
  }
}
