/**
 * argumentResolver — Phase 2.0 §十二.
 *
 * Resolves `manifest.input.argumentTemplate` into a concrete argv for the
 * runner. The model never supplies argv directly; instead:
 *
 *   manifest.input.argumentTemplate = ["--input", "${artifact:0}", "--mode", "${options.mode}"]
 *
 * The resolver:
 *   1. Validates `input.artifactKinds` / `minArtifacts` / `maxArtifacts`.
 *   2. Resolves `${artifact:N}` to the filesystem path of the Nth input
 *      artifact (authorised by `resolveArtifactPath`).
 *   3. Resolves `${options.foo}` against the model-supplied `options`,
 *      validated against `manifest.input.optionsSchema`.
 *   4. Resolves `${flags.*}` against `manifest.input.allowedExtraArgs`.
 *   5. Throws on unknown placeholders / extra args.
 */

import type { OneShotManifest } from './types.js'

export interface ResolveArgsInput {
  artifactIds: string[]
  options: Record<string, unknown>
  resolveArtifactPath?: (artifactId: string) => string | undefined
  taskWorkspaceDir: string
  /**
   * §round-2 audit fix — authoritative containment boundary. When
   * supplied, the narrowest of `allowedFilesRoot` and `taskWorkspaceDir`
   * is used for path-containment checks.
   */
  allowedFilesRoot?: string
}

/**
 * Validate options against a minimal JSON-Schema subset. We deliberately
 * avoid pulling in ajv — the schema here is restricted to `type`,
 * `properties`, `required`, `additionalProperties`, `enum`. If the
 * manifest declares a richer schema, we accept it but only enforce the
 * restricted subset (a more permissive schema fails open).
 */
function validateOptions(schema: unknown, options: Record<string, unknown>): void {
  if (!schema || typeof schema !== 'object') return
  const s = schema as Record<string, unknown>
  if (s['additionalProperties'] === false) {
    const allowed = new Set(Object.keys((s['properties'] as Record<string, unknown>) ?? {}))
    for (const key of Object.keys(options)) {
      if (!allowed.has(key)) {
        throw new Error(`option "${key}" not permitted by schema`)
      }
    }
  }
  const props = (s['properties'] as Record<string, Record<string, unknown>>) ?? {}
  for (const [k, def] of Object.entries(props)) {
    if (!(k in options)) continue
    const v = options[k]
    const type = def['type']
    if (type === 'string' && typeof v !== 'string') {
      throw new Error(`option "${k}" expected string`)
    }
    if (type === 'number' && typeof v !== 'number') {
      throw new Error(`option "${k}" expected number`)
    }
    if (type === 'boolean' && typeof v !== 'boolean') {
      throw new Error(`option "${k}" expected boolean`)
    }
    if (Array.isArray(def['enum']) && !(def['enum'] as unknown[]).includes(v)) {
      throw new Error(`option "${k}" not in enum`)
    }
  }
  if (Array.isArray(s['required'])) {
    for (const req of s['required'] as string[]) {
      if (!(req in options)) {
        throw new Error(`option "${req}" required`)
      }
    }
  }
}

/**
 * Authorise a resolved file path. Refuses `..`, absolute paths that escape
 * the workspace, and any path that didn't come through resolveArtifactPath
 * (i.e. model-supplied string paths).
 */
function authorisePath(p: string, containmentRoot: string): string {
  if (p.includes('..')) {
    throw new Error(`path traversal rejected: ${p}`)
  }
  if (p.startsWith('/') && !p.startsWith(`${containmentRoot}/`)) {
    throw new Error(`absolute path outside workspace rejected: ${p}`)
  }
  return p
}

/** §round-2 audit fix — pick the narrowest available containment
 *  boundary between `taskWorkspaceDir` and `allowedFilesRoot`. */
function pickContainmentRoot(
  taskWorkspaceDir: string,
  allowedFilesRoot: string | undefined,
): string {
  if (!allowedFilesRoot) return taskWorkspaceDir
  const taskInAllowed = taskWorkspaceDir === allowedFilesRoot ||
    taskWorkspaceDir.startsWith(`${allowedFilesRoot}/`)
  if (taskInAllowed) return taskWorkspaceDir
  const allowedInTask = allowedFilesRoot === taskWorkspaceDir ||
    allowedFilesRoot.startsWith(`${taskWorkspaceDir}/`)
  if (allowedInTask) return allowedFilesRoot
  // Neither contains the other — fall back to allowedFilesRoot.
  return allowedFilesRoot
}

const PLACEHOLDER = /\$\{([^}]+)\}/g

export function resolveArgumentTemplate(
  manifest: OneShotManifest,
  input: ResolveArgsInput,
): string[] {
  // Backward compatibility — manifests without `input` accept raw argv
  // by routing through the legacy path. Production paths should declare
  // `input.argumentTemplate`.
  if (!manifest.input || !Array.isArray(manifest.input.argumentTemplate)) {
    return []
  }
  const def = manifest.input
  const min = def.minArtifacts ?? 0
  const max = def.maxArtifacts ?? Number.POSITIVE_INFINITY
  if (input.artifactIds.length < min) {
    throw new Error(`manifest ${manifest.id} requires at least ${min} artifact(s)`)
  }
  if (input.artifactIds.length > max) {
    throw new Error(`manifest ${manifest.id} accepts at most ${max} artifact(s)`)
  }
  if (def.optionsSchema) {
    validateOptions(def.optionsSchema, input.options)
  }

  // §round-2 audit fix — pick the narrowest containment root available.
  // `allowedFilesRoot` is the contest boundary; `taskWorkspaceDir` is the
  // per-task workspace. The longest realpath wins as the most specific
  // boundary (since the narrower root is contained in the wider one).
  const containmentRoot = pickContainmentRoot(
    input.taskWorkspaceDir,
    input.allowedFilesRoot,
  )

  const resolvedPaths = input.artifactIds.map((id, i) => {
    if (!input.resolveArtifactPath) {
      throw new Error(`manifest ${manifest.id} requires artifact path resolution (artifact #${i})`)
    }
    const p = input.resolveArtifactPath(id)
    if (!p) {
      throw new Error(`artifact ${id} not found in workspace`)
    }
    return authorisePath(p, containmentRoot)
  })

  const optionValues: Record<string, string> = {}
  for (const [k, v] of Object.entries(input.options)) {
    if (typeof v === 'string') optionValues[k] = v
    else if (typeof v === 'number' || typeof v === 'boolean') optionValues[k] = String(v)
  }

  const out: string[] = []
  for (const piece of def.argumentTemplate) {
    if (typeof piece !== 'string') continue
    const matches = [...piece.matchAll(PLACEHOLDER)]
    if (matches.length === 0) {
      out.push(piece)
      continue
    }
    // Reassemble the string with each placeholder replaced.
    let rebuilt = ''
    let last = 0
    for (const m of matches) {
      rebuilt += piece.slice(last, m.index)
      const expr = m[1] ?? ''
      last = (m.index ?? 0) + m[0].length
      if (expr.startsWith('artifact:')) {
        const idx = Number.parseInt(expr.slice('artifact:'.length), 10)
        const p = resolvedPaths[idx]
        if (p === undefined) {
          throw new Error(`placeholder ${expr} out of range (have ${resolvedPaths.length} artifacts)`)
        }
        rebuilt += p
      } else if (expr.startsWith('options.')) {
        const key = expr.slice('options.'.length)
        const v = optionValues[key]
        if (v === undefined) {
          throw new Error(`placeholder ${expr} not provided in options`)
        }
        rebuilt += v
      } else if (expr.startsWith('flags.')) {
        const flag = expr.slice('flags.'.length)
        const allowed = new Set(def.allowedExtraArgs ?? [])
        if (!allowed.has(flag)) {
          throw new Error(`flag "${flag}" not in allowedExtraArgs`)
        }
        rebuilt += flag
      } else {
        throw new Error(`unknown placeholder: ${expr}`)
      }
    }
    rebuilt += piece.slice(last)
    out.push(rebuilt)
  }
  return out
}