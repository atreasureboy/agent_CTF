import type { Tool, ToolContext, ToolDefinition, ToolResult } from '../core/types.js'
import { TOOL_METADATA } from '../core/toolMetadata.js'

const FETCH_TIMEOUT_MS = 30_000

interface WebExplorerInput {
  url: string
  action:
    | 'extract_js'
    | 'extract_forms'
    | 'extract_links'
    | 'extract_apis'
    | 'guess_paths'
    | 'full_scan'
  commonPaths?: string[]
}

async function fetchWithTimeout(url: string, signal?: AbortSignal): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort('timeout'), FETCH_TIMEOUT_MS)

  if (signal) {
    if (signal.aborted) {
      clearTimeout(timer)
      throw new Error('Request cancelled')
    }
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        controller.abort('user_cancelled')
      },
      { once: true },
    )
  }

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'ovogogogo/0.1.0 (autonomous code execution engine)',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      redirect: 'follow',
    })
    clearTimeout(timer)
    return await response.text()
  } catch (err) {
    clearTimeout(timer)
    throw err
  }
}

function resolveUrl(href: string, baseUrl: string): string | null {
  try {
    const url = new URL(href, baseUrl)
    return url.href
  } catch {
    return null
  }
}

function extractJsUrls(html: string, baseUrl: string): string[] {
  const urls = new Set<string>()
  const scriptSrcRegex = /<script[^>]+src=["']([^"']+)["'][^>]*>/gi
  let match
  while ((match = scriptSrcRegex.exec(html)) !== null) {
    const resolved = resolveUrl(match[1], baseUrl)
    if (resolved) urls.add(resolved)
  }
  const inlineSrcRegex = /\bsrc=["']([^"']*\.js[^"']*)["']/gi
  while ((match = inlineSrcRegex.exec(html)) !== null) {
    const resolved = resolveUrl(match[1], baseUrl)
    if (resolved) urls.add(resolved)
  }
  return Array.from(urls)
}

interface FormField {
  name: string
  type: string
  value?: string
  required?: boolean
}

interface FormData {
  action: string
  method: string
  enctype: string
  fields: FormField[]
}

function extractForms(html: string, baseUrl: string): FormData[] {
  const forms: FormData[] = []
  const formRegex = /<form([^>]*)>([\s\S]*?)<\/form>/gi
  let formMatch
  while ((formMatch = formRegex.exec(html)) !== null) {
    const formAttrs = formMatch[1]
    const formContent = formMatch[2]
    const actionMatch = /action=["']([^"']*)["']/i.exec(formAttrs)
    const methodMatch = /method=["']([^"']*)["']/i.exec(formAttrs)
    const enctypeMatch = /enctype=["']([^"']*)["']/i.exec(formAttrs)
    const action = actionMatch ? (resolveUrl(actionMatch[1], baseUrl) ?? actionMatch[1]) : ''
    const method = methodMatch ? methodMatch[1].toUpperCase() : 'GET'
    const enctype = enctypeMatch ? enctypeMatch[1] : 'application/x-www-form-urlencoded'
    const fields: FormField[] = []
    const inputRegex = /<input([^>]*)>/gi
    let inputMatch
    while ((inputMatch = inputRegex.exec(formContent)) !== null) {
      const attrs = inputMatch[1]
      const nameMatch = /name=["']([^"']*)["']/i.exec(attrs)
      const typeMatch = /type=["']([^"']*)["']/i.exec(attrs)
      const valueMatch = /value=["']([^"']*)["']/i.exec(attrs)
      const requiredMatch = /required/i.test(attrs)
      if (nameMatch) {
        fields.push({
          name: nameMatch[1],
          type: typeMatch ? typeMatch[1] : 'text',
          value: valueMatch ? valueMatch[1] : undefined,
          required: requiredMatch,
        })
      }
    }
    const selectRegex = /<select([^>]*)>[\s\S]*?<\/select>/gi
    let selectMatch
    while ((selectMatch = selectRegex.exec(formContent)) !== null) {
      const attrs = selectMatch[1]
      const nameMatch = /name=["']([^"']*)["']/i.exec(attrs)
      if (nameMatch) {
        fields.push({ name: nameMatch[1], type: 'select' })
      }
    }
    const textareaRegex = /<textarea([^>]*)>[\s\S]*?<\/textarea>/gi
    let textareaMatch
    while ((textareaMatch = textareaRegex.exec(formContent)) !== null) {
      const attrs = textareaMatch[1]
      const nameMatch = /name=["']([^"']*)["']/i.exec(attrs)
      if (nameMatch) {
        fields.push({ name: nameMatch[1], type: 'textarea' })
      }
    }
    forms.push({ action, method, enctype, fields })
  }
  return forms
}

function extractLinks(html: string, baseUrl: string): string[] {
  const links = new Set<string>()
  const hrefRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>/gi
  let match
  while ((match = hrefRegex.exec(html)) !== null) {
    const resolved = resolveUrl(match[1], baseUrl)
    if (resolved) links.add(resolved)
  }
  const linkHrefRegex = /<link[^>]+href=["']([^"']+)["'][^>]*>/gi
  while ((match = linkHrefRegex.exec(html)) !== null) {
    const resolved = resolveUrl(match[1], baseUrl)
    if (resolved) links.add(resolved)
  }
  const dataAttrRegex = /\bdata-[a-z-]+=["']([^"']+)["']/gi
  while ((match = dataAttrRegex.exec(html)) !== null) {
    const value = match[1]
    if (value.startsWith('http://') || value.startsWith('https://') || value.startsWith('/')) {
      const resolved = resolveUrl(value, baseUrl)
      if (resolved) links.add(resolved)
    }
  }
  return Array.from(links)
}

function extractApis(html: string, baseUrl: string): string[] {
  const apis = new Set<string>()
  const baseUrlObj = new URL(baseUrl)
  const origin = baseUrlObj.origin
  const apiPathRegex = /["']\/api\/[^"']*["']/gi
  let match
  while ((match = apiPathRegex.exec(html)) !== null) {
    const path = match[0].slice(1, -1)
    apis.add(origin + path)
  }
  const fetchRegex = /fetch\(["']([^"']+)["']/gi
  while ((match = fetchRegex.exec(html)) !== null) {
    const resolved = resolveUrl(match[1], baseUrl)
    if (resolved) apis.add(resolved)
  }
  const axiosRegex = /axios\.(?:get|post|put|delete|patch)\(["']([^"']+)["']/gi
  while ((match = axiosRegex.exec(html)) !== null) {
    const resolved = resolveUrl(match[1], baseUrl)
    if (resolved) apis.add(resolved)
  }
  const xhrRegex =
    /\.(?:open|send)\(["'](?:GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)["'],\s*["']([^"']+)["']/gi
  while ((match = xhrRegex.exec(html)) !== null) {
    const resolved = resolveUrl(match[1], baseUrl)
    if (resolved) apis.add(resolved)
  }
  const restRegex = /(?:GET|POST|PUT|DELETE|PATCH)\s+["']([^"']+)["']/gi
  while ((match = restRegex.exec(html)) !== null) {
    const path = match[1]
    if (path.startsWith('/')) {
      apis.add(origin + path)
    } else {
      const resolved = resolveUrl(path, baseUrl)
      if (resolved) apis.add(resolved)
    }
  }
  return Array.from(apis)
}

const DEFAULT_COMMON_PATHS = [
  '/admin',
  '/login',
  '/flag',
  '/robots.txt',
  '/sitemap.xml',
  '/.git/config',
  '/.env',
  '/api',
  '/swagger.json',
  '/console',
  '/debug',
  '/backup',
  '/dump',
  '/phpinfo.php',
  '/server-status',
  '/wp-admin',
  '/administrator',
  '/.htaccess',
  '/.htpasswd',
  '/config.php',
  '/database.sql',
  '/test',
  '/dev',
  '/api/v1',
  '/graphql',
]

async function guessPaths(
  baseUrl: string,
  customPaths?: string[],
): Promise<{ path: string; status: number }[]> {
  const pathsToCheck = customPaths ?? DEFAULT_COMMON_PATHS
  const baseUrlObj = new URL(baseUrl)
  const origin = baseUrlObj.origin
  const results: { path: string; status: number }[] = []
  for (const path of pathsToCheck) {
    const fullUrl = origin + path
    try {
      const response = await fetch(fullUrl, {
        method: 'HEAD',
        headers: {
          'User-Agent': 'ovogogogo/0.1.0 (autonomous code execution engine)',
        },
        redirect: 'follow',
      })
      if (response.status !== 404) {
        results.push({ path, status: response.status })
      }
    } catch {
      // skip
    }
  }
  return results
}

export class WebExplorerTool implements Tool {
  name = 'web_explore'
  concurrencySafe = true

  definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'web_explore',
      description: `Explore a web page for CTF challenges. Extract JavaScript files, forms, links, API endpoints, or guess common paths.

Actions:
- extract_js: Find all JavaScript file URLs
- extract_forms: Parse HTML forms with their fields
- extract_links: Extract all links from the page
- extract_apis: Discover API endpoints from JavaScript code
- guess_paths: Check common CTF paths (admin, flag, backup, etc.)
- full_scan: Run all extractions and path guessing`,
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'Target URL to explore',
          },
          action: {
            type: 'string',
            enum: [
              'extract_js',
              'extract_forms',
              'extract_links',
              'extract_apis',
              'guess_paths',
              'full_scan',
            ],
            description: 'Exploration action to perform',
          },
          commonPaths: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional custom paths for guess_paths action',
          },
        },
        required: ['url', 'action'],
      },
    },
  }

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const { url, action, commonPaths } = input as unknown as WebExplorerInput

    if (!url || typeof url !== 'string') {
      return { content: 'Error: url is required', isError: true }
    }

    if (!action || typeof action !== 'string') {
      return { content: 'Error: action is required', isError: true }
    }

    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      return { content: 'Error: URL must start with http:// or https://', isError: true }
    }

    const ctfCtx = (
      context as unknown as {
        __ctf?: {
          contestScope?: {
            assertNetwork?: (h: string, p?: number) => { allowed: boolean; reason?: string }
          }
        }
      }
    ).__ctf
    const assertNet = ctfCtx?.contestScope?.assertNetwork?.bind(ctfCtx.contestScope)
    if (assertNet) {
      const host = new URL(url).hostname.toLowerCase()
      const v = assertNet(host)
      if (!v.allowed) {
        return {
          content: `web_explore refused: ${v.reason ?? `host "${host}" is not in contest scope`}`,
          isError: true,
        }
      }
    }

    try {
      const html = await fetchWithTimeout(url, context.signal)

      switch (action) {
        case 'extract_js': {
          const jsUrls = extractJsUrls(html, url)
          return {
            content: `Found ${jsUrls.length} JavaScript file(s):\n\n${jsUrls.join('\n')}`,
            isError: false,
          }
        }

        case 'extract_forms': {
          const forms = extractForms(html, url)
          if (forms.length === 0) {
            return { content: 'No forms found', isError: false }
          }
          const output = forms
            .map((form, idx) => {
              const fieldsStr = form.fields
                .map((f) => `  - ${f.name} (${f.type})${f.required ? ' [required]' : ''}`)
                .join('\n')
              return `Form ${idx + 1}:\n  Action: ${form.action}\n  Method: ${form.method}\n  Enctype: ${form.enctype}\n  Fields:\n${fieldsStr}`
            })
            .join('\n\n')
          return { content: `Found ${forms.length} form(s):\n\n${output}`, isError: false }
        }

        case 'extract_links': {
          const links = extractLinks(html, url)
          return {
            content: `Found ${links.length} link(s):\n\n${links.join('\n')}`,
            isError: false,
          }
        }

        case 'extract_apis': {
          const apis = extractApis(html, url)
          if (apis.length === 0) {
            return { content: 'No API endpoints found', isError: false }
          }
          return {
            content: `Found ${apis.length} API endpoint(s):\n\n${apis.join('\n')}`,
            isError: false,
          }
        }

        case 'guess_paths': {
          const results = await guessPaths(url, commonPaths)
          if (results.length === 0) {
            return { content: 'No interesting paths found (all returned 404)', isError: false }
          }
          const output = results.map((r) => `  ${r.path} -> HTTP ${r.status}`).join('\n')
          return {
            content: `Found ${results.length} interesting path(s):\n\n${output}`,
            isError: false,
          }
        }

        case 'full_scan': {
          const [jsUrls, forms, links, apis, pathResults] = await Promise.all([
            Promise.resolve(extractJsUrls(html, url)),
            Promise.resolve(extractForms(html, url)),
            Promise.resolve(extractLinks(html, url)),
            Promise.resolve(extractApis(html, url)),
            guessPaths(url, commonPaths),
          ])

          const sections: string[] = []

          if (jsUrls.length > 0) {
            sections.push(`JavaScript Files (${jsUrls.length}):\n${jsUrls.join('\n')}`)
          }

          if (forms.length > 0) {
            const formsStr = forms
              .map((form, idx) => {
                const fieldsStr = form.fields.map((f) => `    - ${f.name} (${f.type})`).join('\n')
                return `  Form ${idx + 1}: ${form.method} ${form.action}\n${fieldsStr}`
              })
              .join('\n')
            sections.push(`Forms (${forms.length}):\n${formsStr}`)
          }

          if (links.length > 0) {
            sections.push(`Links (${links.length}):\n${links.join('\n')}`)
          }

          if (apis.length > 0) {
            sections.push(`API Endpoints (${apis.length}):\n${apis.join('\n')}`)
          }

          if (pathResults.length > 0) {
            const pathsStr = pathResults.map((r) => `  ${r.path} -> HTTP ${r.status}`).join('\n')
            sections.push(`Interesting Paths (${pathResults.length}):\n${pathsStr}`)
          }

          if (sections.length === 0) {
            return { content: 'Full scan completed. No significant findings.', isError: false }
          }

          return {
            content: `Full Scan Results for ${url}:\n\n${sections.join('\n\n')}`,
            isError: false,
          }
        }

        default:
          return { content: `Error: Unknown action "${String(action)}"`, isError: true }
      }
    } catch (err: unknown) {
      const error = err as Error
      if (error.name === 'AbortError') {
        return { content: 'Request cancelled or timed out', isError: true }
      }
      return { content: `Exploration error: ${error.message}`, isError: true }
    }
  }
}

TOOL_METADATA['web_explore'] = {
  domains: ['web'],
  executionMode: 'foreground',
  costClass: 'medium',
  outputMode: 'inline',
  riskLevel: 'medium',
}

export function createWebExplorerTool(): Tool[] {
  return [new WebExplorerTool()]
}
