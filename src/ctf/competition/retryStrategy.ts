/**
 * RetryStrategy — category-aware retry with profile switching.
 *
 * When the initial LLM agent fails to find a flag, this module selects
 * the next-best profile to retry with, up to a configured max retries
 * and total deadline. Profile-level AttemptDeduplicator prevents the
 * same tool call from being re-issued.
 */

export interface RetryConfig {
  /** Max retry attempts (default 2). */
  maxRetries: number
  /** Ordered list of profile IDs to try on failure. */
  retryProfiles: string[]
  /** Base delay between retries in ms (default 0 = immediate). */
  retryDelayMs: number
  /** Which executor outcomes trigger a retry. */
  retryOn: Array<'failed' | 'timeout' | 'no_flag_found'>
  /** Hard deadline for all attempts combined in ms. */
  deadlineMs: number
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 2,
  retryProfiles: [],
  retryDelayMs: 0,
  retryOn: ['failed', 'timeout'],
  deadlineMs: 600_000, // 10min
}

/**
 * Category → retry profile chains.
 * Each entry is ordered: most specialized → more general → ultimate fallback.
 * The first profile is always the original from getProfileForCategory.
 */
export const CATEGORY_RETRY_PROFILES: Record<string, string[]> = {
  crypto: ['crypto', 'encoding', 'triage'],
  encoding: ['encoding', 'crypto', 'triage'],
  reverse: ['reverse', 'triage'],
  rev: ['reverse', 'triage'],
  pwn: ['pwn', 'reverse', 'triage'],
  web: ['web', 'triage'],
  forensics: ['image-stego', 'file-forensics', 'triage'],
  traffic: ['traffic', 'triage'],
  pcap: ['traffic', 'triage'],
  misc: ['triage', 'orchestrator'],
}

/**
 * Get the retry chain for a category.
 * The initial profile is skipped (it was already attempted).
 * If `retryOn` specifies 'no_flag_found', runMainAgent returning
 * successfully but without a flag also triggers retry.
 */
export function getRetryProfiles(category: string): string[] {
  const normalized = category.toLowerCase()
  return CATEGORY_RETRY_PROFILES[normalized] ?? ['triage']
}

/**
 * Resolve a full RetryConfig for a category.
 */
export function getRetryConfigForCategory(
  category: string,
  overrides: Partial<RetryConfig> = {},
): RetryConfig {
  const profiles = getRetryProfiles(category)
  return {
    ...DEFAULT_RETRY_CONFIG,
    retryProfiles: profiles,
    ...overrides,
  }
}
