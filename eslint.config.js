import pluginJs from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  pluginJs.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: './tsconfig.json',
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      'prefer-const': 'error',
      'no-console': 'warn',
    },
  },
  {
    files: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
  },
  {
    // §audit-fix — Files whose dominant pattern is `as any` for
    // dynamic-registry access (TOOL_METADATA, etc.) or JSONL stream
    // parsing. Tightening these to specific types requires a larger
    // refactor of the registry / envelope contracts; for now we
    // downgrade the unsafe-* rules to warnings to keep the lint
    // surface tractable.
    files: [
      'src/core/engine.ts',
      'src/core/contextCompiler/taskStateProjectionBuilder.ts',
      'src/core/solverPortfolio/genericProcessSolverAdapter.ts',
      'src/core/ctfRuntime/createCTFTaskRuntime.ts',
      'src/core/solverPortfolio/crossSolverKnowledgeView.ts',
      'src/core/trajectory/trajectoryReplay.ts',
      'src/core/solverPortfolio/nativeSolverAdapter.ts',
      'src/core/modelReliability/structuredModelGateway.ts',
      'src/core/modelReliability/monitoredStream.ts',
      'src/bench/modelReliabilityBenchmark.ts',
      'src/core/harness.ts',
      'src/tools/meta.ts',
      'src/modules/reflection.ts',
      'src/testing/mockClient.ts',
      'src/tools/fileWrite.ts',
    ],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      '@typescript-eslint/no-unsafe-return': 'warn',
    },
  },
  {
    ignores: [
      'dist/',
      'node_modules/',
      // Vendored reference repos — gitignored from the source tree, but
      // eslint should not try to type-check them. They each have their
      // own toolchain (CAI / swe-agent / HackSynth / etc.) and pulling
      // them into our lint surface causes long scans and false positives.
      'CAI/',
      'HackSynth/',
      'cyber-zero/',
      'nyuctf_agents/',
      'swe-agent/',
      'BUUCTF_Agent/',
      'scratch/',
    ],
  },
)
