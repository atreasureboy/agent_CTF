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
  const fs = require('fs')
  const content = fs.readFileSync(path, 'utf-8')
  const json = JSON.parse(content)
  return ChallengeManifestSchema.parse(json)
}
