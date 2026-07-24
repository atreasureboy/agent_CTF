export interface BenchmarkChallenge {
  id: string
  category: string
  description: string
  artifactPaths: string[]
  expectedFlagPattern?: string
  expectedFlagHash?: string
  timeoutMs: number
  dockerComposePath?: string
}

export interface ChallengeBenchmarkAdapter {
  load(path: string): Promise<BenchmarkChallenge>
  prepare(challenge: BenchmarkChallenge): Promise<void>
  verifyCandidate(challenge: BenchmarkChallenge, candidate: string): Promise<boolean>
  cleanup(): Promise<void>
}

export class LocalFixtureBenchmarkAdapter implements ChallengeBenchmarkAdapter {
  public async load(path: string): Promise<BenchmarkChallenge> {
    return {
      id: 'local_fixture_01',
      category: 'web',
      description: 'Local web stego fixture challenge',
      artifactPaths: ['/tmp/fixture/app.py'],
      expectedFlagPattern: '^flag{[a-zA-Z0-9_]+}$',
      timeoutMs: 10000,
    }
  }

  public async prepare(challenge: BenchmarkChallenge): Promise<void> {
    // No-op for offline local fixture
  }

  public async verifyCandidate(challenge: BenchmarkChallenge, candidate: string): Promise<boolean> {
    if (challenge.expectedFlagPattern) {
      const regex = new RegExp(challenge.expectedFlagPattern)
      return regex.test(candidate.trim())
    }
    return candidate.trim().length > 0
  }

  public async cleanup(): Promise<void> {
    // Cleanup workspace
  }
}
