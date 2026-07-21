/**
 * Capability Profile Catalogue — wires the built-in agents into the registry.
 *
 * One-stop import: ctfspecialists.register() bootstraps prompt modules and
 * registers the canonical profiles (Orchestrator / Triage / ImageStego /
 * Crypto / FileForensics).
 */

import { registerPromptModule } from '../core/specialistAgent.js'
import { BUILT_IN_PROMPT_MODULES } from './promptModules.js'
import { PROFILES, getBuiltinProfile, listBuiltinProfiles } from './builtin.js'

let registered = false

export function ensureProfilesRegistered(): void {
  if (registered) return
  for (const [name, mod] of Object.entries(BUILT_IN_PROMPT_MODULES)) {
    registerPromptModule(name, mod)
  }
  registered = true
}

export { PROFILES, getBuiltinProfile, listBuiltinProfiles }
