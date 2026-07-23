/**
 * Zod schema for OneShotManifest.
 *
 * Strict validation: a bad manifest disables itself rather than crashing
 * the runtime. The Catalog wraps parse failures in a `parseManifest`
 * helper that returns `{ ok: false, error }` so the Doctor can list them.
 */

import { z } from 'zod'

const positiveInt = z.number().int().positive()
const nonNegativeInt = z.number().int().nonnegative()

export const oneShotManifestSchema = z
  .object({
    id: z.string().min(1).regex(/^[a-z0-9_-]+$/, 'id must be kebab/snake'),
    displayName: z.string().min(1),
    category: z.string().min(1),
    description: z.string().min(1),

    source: z
      .object({
        repository: z.string().url(),
        license: z.string().optional(),
        pinnedRef: z.string().optional(),
        imageDigest: z.string().optional(),
        homepage: z.string().optional(),
      })
      .strict(),

    maturity: z.enum(['stable', 'candidate', 'experimental']),
    enabledByDefault: z.boolean(),

    inputMatchers: z
      .object({
        mimeTypes: z.array(z.string()).optional(),
        extensions: z.array(z.string()).optional(),
        magicPatterns: z.array(z.string()).optional(),
        requiredArtifacts: z.array(z.string()).optional(),
        taskTags: z.array(z.string()).optional(),
        taskCategories: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),

    allowedProfiles: z.array(z.string().min(1)).min(1),
    excludedProfiles: z.array(z.string().min(1)).optional(),

    runner: z
      .object({
        type: z.enum(['process', 'container', 'service']),
        command: z.array(z.string()).optional(),
        image: z.string().optional(),
        endpoint: z.string().optional(),
        argv: z.array(z.string()).optional(),
      })
      .strict(),

    resources: z
      .object({
        timeoutSeconds: positiveInt,
        cpuLimit: positiveInt.optional(),
        memoryMb: positiveInt.optional(),
        pidsLimit: nonNegativeInt.optional(),
        maxOutputBytes: nonNegativeInt,
        maxArtifactBytes: positiveInt.optional(),
      })
      .strict(),

    network: z
      .object({
        mode: z.enum(['none', 'contest-target-only', 'outbound-readonly']),
        requiresScopeApproval: z.boolean(),
      })
      .strict(),

    output: z
      .object({
        parser: z.string().min(1),
        artifactGlobs: z.array(z.string()).optional(),
        flagPatterns: z.array(z.string()).optional(),
        successPatterns: z.array(z.string()).optional(),
        ignorePatterns: z.array(z.string()).optional(),
      })
      .strict(),

    scheduling: z
      .object({
        costTier: z.enum(['fast', 'medium', 'heavy']),
        estimatedSeconds: positiveInt.optional(),
        concurrencyGroup: z.string().optional(),
        falsePositiveRisk: z.enum(['low', 'medium', 'high']),
      })
      .strict(),

    healthcheck: z
      .object({
        command: z.array(z.string()).optional(),
        endpoint: z.string().optional(),
        expectedPattern: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((m, ctx) => {
    // Runner requirements per type — concrete cross-field validation.
    if (m.runner.type === 'process' || m.runner.type === 'container') {
      if (!m.runner.command || m.runner.command.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['runner', 'command'],
          message: `${m.runner.type} runner requires a non-empty command`,
        })
      }
    }
    if (m.runner.type === 'container' && !m.runner.image) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['runner', 'image'],
        message: 'container runner requires an image',
      })
    }
    if (m.runner.type === 'service' && !m.runner.endpoint) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['runner', 'endpoint'],
        message: 'service runner requires an endpoint',
      })
    }
    if (m.network.mode !== 'none' && m.network.mode !== 'contest-target-only') {
      // No-op guard — outbound-readonly is allowed without approval.
    }
    if (m.scheduling.costTier === 'heavy' && m.maturity === 'experimental') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['maturity'],
        message: 'heavy costTier with experimental maturity is unsafe (auto-disabled)',
      })
    }
  })

export type OneShotManifestInputRaw = z.input<typeof oneShotManifestSchema>
export type OneShotManifestValidated = z.output<typeof oneShotManifestSchema>

/** Throws ZodError on invalid input. */
export function parseManifest(raw: unknown): OneShotManifestValidated {
  return oneShotManifestSchema.parse(raw)
}

/** Discriminated result: invalid manifests are recorded but do not crash. */
export function safeParseManifest(
  raw: unknown,
): { ok: true; manifest: OneShotManifestValidated } | { ok: false; error: string } {
  const r = oneShotManifestSchema.safeParse(raw)
  if (r.success) return { ok: true, manifest: r.data }
  return { ok: false, error: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') }
}
