/**
 * Public surface for the CTF one-shot layer.
 *
 * Importers should prefer this barrel over sub-modules so the public contract
 * stays narrow and re-exportable.
 */

export * from './types.js'
export * from './manifestSchema.js'
export * from './catalog.js'
export * from './registry.js'
export * from './scopeGate.js'
export * from './outputParser.js'
export * from './resultNormalizer.js'
export * from './evidenceCollector.js'
export * from './budgetManager.js'
export * from './healthChecker.js'
export * from './selector.js'
export * from './dispatcher.js'
export { runnerFor, setRunnerOverride, clearRunnerOverrides } from './runner.js'
export type { RunnerInputs, OneShotRunner } from './runner.js'
export { ProcessRunner } from './processRunner.js'
export { ContainerRunner } from './containerRunner.js'
export { ServiceRunner } from './serviceRunner.js'
export { loadManifestsFromDir } from './manifestLoader.js'
