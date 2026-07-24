import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'swe-agent/**', 'CAI/**', 'HackSynth/**', 'cyber-zero/**', 'oneshot/**'],
  },
})

