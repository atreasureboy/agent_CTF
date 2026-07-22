/**
 * WebSearch — search the web and return results
 * Reference: src/tools/WebSearchTool/
 *
 * Backends (in priority order):
 *   1. OVOGO_SEARCH_API_KEY + OVOGO_SEARCH_ENGINE_ID → Google Custom Search JSON API
 *   2. SERPAPI_KEY → SerpAPI (google results)
 *   3. Fallback → DuckDuckGo Instant Answer API (no key needed, limited)
 *
 * Set env vars to unlock fuller results.
 */

import type { Tool, ToolContext, ToolDefinition, ToolResult } from '../core/types.js'
import type { ContestScopeChecker } from '../core/contestScope.js'

const SEARCH_TIMEOUT_MS = 15_000

export interface WebSearchInput {
  query: string
  num_results?: number
}

interface SearchResult {
  title: string
  url: string
  snippet: string
}

/**
 * Audit P1 #23 — Compose an AbortController that fires when EITHER the
 * search-specific timeout elapses OR the caller's `context.signal` aborts
 * (Ctrl+C / parent cancellation). Mirrors the WebFetch pattern at
 * webFetch.ts:105-115. Also returns a `tryScope` helper that calls the
 * CTF contest-scope `assertNetwork` so SSRF-style probes against the
 * search API get refused before the fetch leaves the harness.
 */
function composeAbort(
  context: ToolContext,
  timeoutMs: number,
): { controller: AbortController; clearTimer: () => void } {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort('timeout'), timeoutMs)
  if (context.signal) {
    if (context.signal.aborted) {
      // Already cancelled — short-circuit so the fetch never runs.
      controller.abort('user_cancelled')
    } else {
      context.signal.addEventListener(
        'abort',
        () => { controller.abort('user_cancelled') },
        { once: true },
      )
    }
  }
  return {
    controller,
    clearTimer: () => clearTimeout(timer),
  }
}

function getAssertNetwork(context: ToolContext): ((host: string) => { allowed: boolean; reason?: string }) | null {
  const ctfCtx = (context as unknown as {
    __ctf?: { contestScope?: ContestScopeChecker }
  }).__ctf
  const scope = ctfCtx?.contestScope
  if (!scope || typeof scope.assertNetwork !== 'function') return null
  const assertFn = scope.assertNetwork
  // assertNetwork throws on denial — wrap it so callers get a boolean.
  return (host: string) => {
    try {
      assertFn(host)
      return { allowed: true }
    } catch (err) {
      return { allowed: false, reason: (err as Error).message }
    }
  }
}

// ─── Backend: DuckDuckGo Instant Answer (no key) ────────────

async function duckduckgoSearch(
  query: string,
  numResults: number,
  context: ToolContext,
): Promise<SearchResult[]> {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`

  const assertNet = getAssertNetwork(context)
  if (assertNet) {
    try {
      const host = new URL(url).hostname.toLowerCase()
      const v = assertNet(host)
      if (!v.allowed) return []
    } catch {
      return []
    }
  }

  const { controller, clearTimer } = composeAbort(context, SEARCH_TIMEOUT_MS)

  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'ovogogogo/0.1.0' },
    })
    clearTimer()

    if (!resp.ok) return []

    const data = await resp.json() as {
      AbstractText?: string
      AbstractURL?: string
      AbstractSource?: string
      RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>
    }

    const results: SearchResult[] = []

    // Abstract (main answer)
    if (data.AbstractText && data.AbstractURL) {
      results.push({
        title: data.AbstractSource ?? 'Answer',
        url: data.AbstractURL,
        snippet: data.AbstractText,
      })
    }

    // Related topics
    for (const topic of data.RelatedTopics ?? []) {
      if (topic.Text && topic.FirstURL) {
        results.push({
          title: topic.Text.split(' - ')[0] ?? topic.Text,
          url: topic.FirstURL,
          snippet: topic.Text,
        })
        if (results.length >= numResults) break
      }
    }

    return results
  } catch {
    clearTimer()
    return []
  }
}

// ─── Backend: Google Custom Search JSON API ──────────────────

async function googleSearch(
  query: string,
  numResults: number,
  apiKey: string,
  engineId: string,
  context: ToolContext,
): Promise<SearchResult[]> {
  const url =
    `https://www.googleapis.com/customsearch/v1?key=${apiKey}` +
    `&cx=${engineId}&q=${encodeURIComponent(query)}&num=${Math.min(numResults, 10)}`

  const assertNet = getAssertNetwork(context)
  if (assertNet) {
    try {
      const host = new URL(url).hostname.toLowerCase()
      const v = assertNet(host)
      if (!v.allowed) return []
    } catch {
      return []
    }
  }

  const { controller, clearTimer } = composeAbort(context, SEARCH_TIMEOUT_MS)

  try {
    const resp = await fetch(url, { signal: controller.signal })
    clearTimer()
    if (!resp.ok) return []

    const data = await resp.json() as {
      items?: Array<{ title: string; link: string; snippet: string }>
    }

    return (data.items ?? []).map(item => ({
      title: item.title,
      url: item.link,
      snippet: item.snippet,
    }))
  } catch {
    clearTimer()
    return []
  }
}

// ─── Backend: SerpAPI ────────────────────────────────────────

async function serpApiSearch(
  query: string,
  numResults: number,
  apiKey: string,
  context: ToolContext,
): Promise<SearchResult[]> {
  const url =
    `https://serpapi.com/search.json?api_key=${apiKey}` +
    `&q=${encodeURIComponent(query)}&num=${Math.min(numResults, 10)}&engine=google`

  const assertNet = getAssertNetwork(context)
  if (assertNet) {
    try {
      const host = new URL(url).hostname.toLowerCase()
      const v = assertNet(host)
      if (!v.allowed) return []
    } catch {
      return []
    }
  }

  const { controller, clearTimer } = composeAbort(context, SEARCH_TIMEOUT_MS)

  try {
    const resp = await fetch(url, { signal: controller.signal })
    clearTimer()
    if (!resp.ok) return []

    const data = await resp.json() as {
      organic_results?: Array<{ title: string; link: string; snippet: string }>
    }

    return (data.organic_results ?? []).map(r => ({
      title: r.title,
      url: r.link,
      snippet: r.snippet,
    }))
  } catch {
    clearTimer()
    return []
  }
}

// ─────────────────────────────────────────────────────────────

function formatResults(results: SearchResult[], query: string, backend: string): string {
  if (results.length === 0) {
    return `No results found for: ${query}\n\nTip: Set OVOGO_SEARCH_API_KEY + OVOGO_SEARCH_ENGINE_ID (Google) or SERPAPI_KEY for better results.`
  }

  const lines = [`Search: ${query}  [via ${backend}]`, '']
  results.forEach((r, i) => {
    lines.push(`${i + 1}. ${r.title}`)
    lines.push(`   ${r.url}`)
    lines.push(`   ${r.snippet}`)
    lines.push('')
  })
  return lines.join('\n')
}

export class WebSearchTool implements Tool {
  name = 'WebSearch'
  concurrencySafe = true

  definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'WebSearch',
      description: `Search the web and return results with titles, URLs, and snippets.

Use this to:
- Look up documentation, APIs, error messages
- Find recent information (post training cutoff)
- Verify package names, versions, or compatibility

Results include URLs you can then fetch with WebFetch for full content.

Backends (set env vars for better results):
- OVOGO_SEARCH_API_KEY + OVOGO_SEARCH_ENGINE_ID → Google Custom Search
- SERPAPI_KEY → SerpAPI
- Fallback: DuckDuckGo Instant Answer (no key needed, limited)`,
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query',
          },
          num_results: {
            type: 'number',
            description: 'Number of results to return (default: 5, max: 10)',
          },
        },
        required: ['query'],
      },
    },
  }

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const { query, num_results } = input as unknown as WebSearchInput

    if (!query || typeof query !== 'string') {
      return { content: 'Error: query is required', isError: true }
    }

    const numResults = Math.min(typeof num_results === 'number' ? num_results : 5, 10)

    // Try backends in priority order
    const googleKey = process.env.OVOGO_SEARCH_API_KEY
    const googleEngineId = process.env.OVOGO_SEARCH_ENGINE_ID
    const serpKey = process.env.SERPAPI_KEY

    let results: SearchResult[] = []
    let backend = 'DuckDuckGo'

    if (googleKey && googleEngineId) {
      results = await googleSearch(query, numResults, googleKey, googleEngineId, context)
      backend = 'Google Custom Search'
    } else if (serpKey) {
      results = await serpApiSearch(query, numResults, serpKey, context)
      backend = 'SerpAPI'
    }

    // Fallback to DDG if primary returned nothing
    if (results.length === 0) {
      results = await duckduckgoSearch(query, numResults, context)
      backend = 'DuckDuckGo'
    }

    return {
      content: formatResults(results, query, backend),
      isError: false,
    }
  }
}