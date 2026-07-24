/**
 * SpecialistAgentFactory — translates a CapabilityProfile into a runtime
 * EngineConfig extension the existing ExecutionEngine understands.
 *
 * The factory is the *only* approved way to spawn a specialist Agent in the
 * CTF Harness. The legacy AgentConfig presets are kept as adapters so callers
 * using `subagent_type: "explore"` continue to work — the adapter maps the
 * preset to a built-in CapabilityProfile.
 *
 * Prompts are assembled by `composeSystemPrompt` from:
 *   1. profile.systemPromptModules — module names registered in `PROMPT_MODULES`
 *   2. profile.id / displayName / description — identity header
 *   3. inheritedFindings and inheritedArtifacts — context handoff
 *
 * The output is intentionally defensive: the factory never throws on a wrong
 * profile — it returns an AgentConfig with `allowedTools` already filtered.
 */

import type { AgentConfig } from './agentPresets.js'
import type { CapabilityProfile } from './capabilityProfile.js'

/** A prompt module — produces one or more sections contributed to the
 * agent's system prompt by name. Modules are registered via `registerPromptModule`. */
export interface PromptModuleContext {
  cwd: string
  taskWorkspaceDir?: string
  inheritedFindings?: Array<{ id: string; summary: string; confidence: string }>
  inheritedArtifacts?: Array<{ id: string; type: string; summary: string }>
  profile: CapabilityProfile
}

export type PromptModule = (ctx: PromptModuleContext) => string[]

const promptModules = new Map<string, PromptModule>()

export function registerPromptModule(name: string, mod: PromptModule): void {
  promptModules.set(name, mod)
}

export function listPromptModules(): string[] {
  return [...promptModules.keys()]
}

export interface ComposeSystemPromptInput {
  cwd: string
  taskWorkspaceDir?: string
  profile: CapabilityProfile
  inheritedFindings?: Array<{ id: string; summary: string; confidence: string }>
  inheritedArtifacts?: Array<{ id: string; type: string; summary: string }>
  basePrompt?: string
}

/**
 * Compose a system prompt for the specialist agent:
 *   - identity header
 *   - profile-pinned prompt modules (in declared order)
 *   - inherited findings + artifacts
 *   - caller-supplied base prompt tail
 */
export function composeSystemPrompt(input: ComposeSystemPromptInput): string {
  const sections: string[] = []
  sections.push(
    `# ${input.profile.displayName}\n\n${input.profile.description ?? ''}\n\nProfile id: \`${input.profile.id}\``,
  )

  // Prompt modules
  const seenModules = new Set<string>()
  for (const name of input.profile.systemPromptModules) {
    const mod = promptModules.get(name)
    if (!mod || seenModules.has(name)) continue
    seenModules.add(name)
    try {
      const extra = mod({
        cwd: input.cwd,
        taskWorkspaceDir: input.taskWorkspaceDir,
        inheritedFindings: input.inheritedFindings,
        inheritedArtifacts: input.inheritedArtifacts,
        profile: input.profile,
      })
      sections.push(extra.join('\n\n'))
    } catch (err) {
      sections.push(`[prompt module "${name}" failed: ${(err as Error).message}]`)
    }
  }

  // Inherited findings
  if (input.inheritedFindings && input.inheritedFindings.length > 0) {
    sections.push(
      `## Inherited Findings\n\n${input.inheritedFindings
        .map((f) => `- [${f.confidence.toUpperCase()}] (${f.id}) ${f.summary}`)
        .join('\n')}`,
    )
  }

  if (input.inheritedArtifacts && input.inheritedArtifacts.length > 0) {
    sections.push(
      `## Inherited Artifacts\n\n${input.inheritedArtifacts
        .map((a) => `- ${a.id} (${a.type}): ${a.summary}`)
        .join('\n')}`,
    )
  }

  if (input.basePrompt) sections.push(input.basePrompt)

  return sections.join('\n\n---\n\n')
}

/**
 * Convert a CapabilityProfile + tool/workflow registry lookups into an
 * AgentConfig the legacy engine consumes.
 */
export function profileToAgentConfig(
  profile: CapabilityProfile,
  resolver: {
    resolveToolIds(): string[]
    resolveWorkflowIds(): string[]
    allowedTools?: string[]
  },
  cwd: string,
  basePrompt?: string,
  taskWorkspaceDir?: string,
  inheritedFindings?: ComposeSystemPromptInput['inheritedFindings'],
  inheritedArtifacts?: ComposeSystemPromptInput['inheritedArtifacts'],
): AgentConfig {
  const allowedToolIds = resolver.resolveToolIds()
  const allowedWorkflowIds = resolver.resolveWorkflowIds()

  const systemPrompt = composeSystemPrompt({
    cwd,
    profile,
    basePrompt,
    taskWorkspaceDir,
    inheritedFindings,
    inheritedArtifacts,
  })

  const caps: AgentConfig['modules'] = {}
  if (profile.allowBackgroundJobs) caps.workspace = { enabled: true, sessionDir: taskWorkspaceDir }
  if (profile.allowAgentHandoff) {
    // No toggle currently — left to consumer via agent.json. The capability
    // declaration is informational at the AgentConfig layer.
  }

  return {
    identity: {
      systemPrompt: () => systemPrompt,
      planMode: false,
    },
    modules: caps,
    tools: allowedToolIds,
    maxIterations: profile.limits?.maxIterations ?? 60,
    maxOutputTokens: 8192,
  }
}

export interface CreateSpecialistInput {
  profile: CapabilityProfile
  cwd: string
  taskWorkspaceDir?: string
  basePrompt?: string
  inheritedFindings?: ComposeSystemPromptInput['inheritedFindings']
  inheritedArtifacts?: ComposeSystemPromptInput['inheritedArtifacts']
  resolver: {
    resolveToolIds(): string[]
    resolveWorkflowIds(): string[]
    allowedTools?: string[]
  }
}

export function createSpecialistAgentConfig(input: CreateSpecialistInput): AgentConfig {
  return profileToAgentConfig(
    input.profile,
    input.resolver,
    input.cwd,
    input.basePrompt,
    input.taskWorkspaceDir,
    input.inheritedFindings,
    input.inheritedArtifacts,
  )
}
