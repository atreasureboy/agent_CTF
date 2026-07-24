/**
 * ToolVisibility — Phase borrow-plan Tier C1 (CHYing-agent pattern).
 *
 * CHYing-agent declares each MCP server's
 * `visibility: "subagent:browser"` / `"subagent:reverse"` so the
 * orchestrator's tool list is pruned to ~10 strategic tools while
 * sub-agents get the full 30+. The CLI source is patched to add this
 * field.
 *
 * Our `ToolVisibilityScope` is the analog:
 *   - `currentRole`: the subagent role the executor is running in
 *     (e.g. `'orchestrator'`, `'browser'`, `'reverse'`, `'pwn'`,
 *     `'crypto'`, `'web'`, `'misc'`).
 *   - `toolId`: the tool being called.
 *   - `RoleVisibilityMap`: per-role allowlist. Tools not in the
 *     allowlist for the current role are rejected before reaching
 *     the executor.
 *
 * The `enforceVisibility()` helper is called by the
 * `StrategyActionExecutor` before delegating to a tool. For tests
 * we ship a permissive default that allows everything.
 */

export type SubagentRole =
  | 'orchestrator'
  | 'browser'
  | 'reverse'
  | 'pwn'
  | 'crypto'
  | 'web'
  | 'misc'
  | 'planner'
  | 'specialist'

export interface RoleVisibilityMap {
  /** For each role, the set of toolIds that role is allowed to
   *  call. */
  roles: Record<SubagentRole, ReadonlySet<string>>
  /** Tools that are always allowed regardless of role. */
  universal: ReadonlySet<string>
}

export const PERMISSIVE_VISIBILITY: RoleVisibilityMap = {
  roles: {
    orchestrator: new Set(),
    browser: new Set(),
    reverse: new Set(),
    pwn: new Set(),
    crypto: new Set(),
    web: new Set(),
    misc: new Set(),
    planner: new Set(),
    specialist: new Set(),
  },
  universal: new Set(), // empty universal + empty role sets = allow all
}

export const DEFAULT_VISIBILITY: RoleVisibilityMap = {
  roles: {
    orchestrator: new Set([
      'verify_flag',
      'submit_flag',
      'request_handoff',
      'run_workflow',
      'run_oneshot',
      'call_tool',
    ]),
    browser: new Set(['webFetch', 'notifyCoordinator', 'request_handoff']),
    reverse: new Set(['decompile', 'strings', 'binwalk', 'runCommand']),
    pwn: new Set(['decompile', 'runCommand', 'gdb', 'verify_flag']),
    crypto: new Set(['decompile', 'runCommand', 'strings', 'verify_flag']),
    web: new Set(['webFetch', 'runCommand', 'verify_flag']),
    misc: new Set(['runCommand', 'strings', 'verify_flag']),
    planner: new Set(['verify_flag', 'run_workflow', 'request_handoff', 'stop']),
    specialist: new Set(['run_workflow', 'run_oneshot', 'call_tool']),
  },
  universal: new Set(['runCommand']),
}

export interface VisibilityResult {
  allowed: boolean
  reason?: 'role_denied' | 'universal' | 'role_allowed'
  role: SubagentRole
  toolId: string
}

export function checkVisibility(
  map: RoleVisibilityMap,
  role: SubagentRole,
  toolId: string,
): VisibilityResult {
  // Special case: a fully empty map (no role sets, no universal)
  // means "permissive — allow everything".
  const allRolesEmpty = Object.values(map.roles).every((s) => s.size === 0)
  if (allRolesEmpty && map.universal.size === 0) {
    return { allowed: true, reason: 'role_allowed', role, toolId }
  }
  if (map.universal.has(toolId)) {
    return { allowed: true, reason: 'universal', role, toolId }
  }
  const allowed = map.roles[role]
  if (allowed && allowed.has(toolId)) {
    return { allowed: true, reason: 'role_allowed', role, toolId }
  }
  return { allowed: false, reason: 'role_denied', role, toolId }
}
