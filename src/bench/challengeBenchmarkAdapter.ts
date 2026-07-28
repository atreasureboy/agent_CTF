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
  // §audit-fix — Default fallback fixture. When a benchmark run is
  // launched without a path, the adapter returns a single safe
  // fixture so smoke tests don't depend on host filesystem layout.
  public static readonly DEFAULT_FIXTURE: BenchmarkChallenge = {
    id: 'local_fixture_default',
    category: 'web',
    description: 'Local web fixture challenge (default fallback)',
    artifactPaths: ['/tmp/fixture/app.py'],
    expectedFlagPattern: '^flag{[a-zA-Z0-9_]+}$',
    timeoutMs: 10000,
  }

  public async load(path: string): Promise<BenchmarkChallenge> {
    if (path) {
      // Use the requested path as the artifact path so the actual
      // benchmark fixture is honoured rather than the default.
      return {
        ...LocalFixtureBenchmarkAdapter.DEFAULT_FIXTURE,
        id: `local_fixture_${path.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
        artifactPaths: [path],
      }
    }
    return { ...LocalFixtureBenchmarkAdapter.DEFAULT_FIXTURE }
  }

  public async prepare(_challenge: BenchmarkChallenge): Promise<void> {
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
