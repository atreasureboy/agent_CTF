import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      'swe-agent/**',
      'CAI/**',
      'HackSynth/**',
      'cyber-zero/**',
      'BUUCTF_Agent/**',
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/__tests__/**', 'src/testing/**', 'src/bench/**'],
      thresholds: {
        lines: 60,
        branches: 50,
      },
    },
  },
})
