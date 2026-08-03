import { readFileSync } from 'node:fs'
import { z } from 'zod'

export const ChallengeManifestSchema = z.object({
  id: z.string(),
  title: z.string(),
  category: z.enum(['encoding', 'crypto', 'forensics', 'reverse', 'pwn', 'web', 'pcap', 'misc']),
  description: z.string(),
  flagPattern: z.string(),
  expectedFlagSha256: z.string().regex(/^[a-f0-9]{64}$/),
  attachmentPaths: z.array(z.string()).optional(),
  targetUrl: z.string().optional(),
  host: z.string().optional(),
  port: z.number().optional(),
  startupCommand: z.string().optional(),
  shutdownCommand: z.string().optional(),
  timeoutMs: z.number().default(60000),
  allowedTools: z.array(z.string()).default(['Bash', 'Read']),
})

export type ChallengeManifest = z.infer<typeof ChallengeManifestSchema>

export function loadChallengeManifest(path: string): ChallengeManifest {
  const content = readFileSync(path, 'utf-8')
  // `JSON.parse` returns `unknown` is correct, but TypeScript types it
  // as `any`. Cast through `unknown` so the Zod schema's narrowing works
  // and the eslint `no-unsafe-assignment` rule is satisfied.
  const json: unknown = JSON.parse(content)
  return ChallengeManifestSchema.parse(json)
}
