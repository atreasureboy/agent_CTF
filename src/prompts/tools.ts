/**
 * Tool descriptions
 */

export const BASH_DESCRIPTION = `Executes a bash command and returns its output (stdout + stderr combined).

The working directory persists between calls via absolute paths. Shell state (variables, aliases) does NOT persist.

IMPORTANT: Avoid using this for file operations when dedicated tools exist:
- File search: Use Glob (NOT find or ls)
- Content search: Use Grep (NOT grep or rg)
- Read files: Use Read (NOT cat/head/tail)
- Edit files: Use Edit (NOT sed/awk)
- Write files: Use Write (NOT echo > or cat <<EOF)

Reserve Bash for: shell commands, build tools, test runners, git, scripts, system operations.

## Timeout Strategy (ALL values in MILLISECONDS)

The timeout parameter is ALWAYS in milliseconds. Default: 1800000 (30 min). Max: 14400000 (4 h).

Do NOT pass small numbers like 300 or 1800 — those mean 0.3s / 1.8s and will kill your command instantly. If unsure, OMIT the timeout field and let the default (30 min) apply.

When you do set an explicit timeout, use milliseconds:
- Build / compile: timeout=300000 (5 min)
- Test suites: timeout=600000 (10 min)
- Long-running tasks: timeout=3600000+ (1 h+)

## DEFAULT MODE = FOREGROUND (the common case)

Do NOT set run_in_background=true unless the command is expected to take
>30 SECONDS. For stat, ls, cat, file, exiftool, strings, python3 -c, head,
tail, wc, xxd, grep, sed, awk, jq, base64, sha256sum, and similar short
inspection commands — just call Bash WITHOUT run_in_background. The result
returns synchronously with stdout/stderr in the same turn.

Background mode hides stdout and returns only a job id; you must then call
collect_background_result before seeing any output. Using background mode
for short commands is a wasteful two-step dance — call Bash directly.

When to use run_in_background=true (rare):
  - Compilations / builds expected to take >30s (make, npm install, gcc on
    a large file, cargo build)
  - Long-running servers (nc -l, python3 -m http.server) the user asked you
    to keep running across turns
  - Loops that iterate >100 times
  - Anything you genuinely expect to take more than half a minute

When NOT to use run_in_background (most calls):
  - File inspection: stat, file, ls, head, tail, cat, wc, xxd, strings
  - Quick checks: python3 -c "...", curl with timeout, sha256sum, base64
  - Standard CTF tools: tshark -r file.pcap, binwalk, exiftool, pdfinfo
  - Anything you expect to finish in under 30 seconds

## Parallel Execution

To run multiple commands simultaneously, call Bash multiple times in the
SAME response — each call runs in parallel and returns its own output.
Do not abuse run_in_background for parallelism; the framework already
parallelises independent foreground calls.

## Interactive Processes — CRITICAL WARNING

NEVER run interactive processes that wait for user input in a foreground Bash call.
These will block until timeout (30 min) and produce no useful output:

BLOCKED patterns:
- python3 / irb / node REPL (blocks on stdin)
- CLI tools that show a "> " or "$ " prompt and wait for keystrokes
- nc / ncat without -l in a piped shell

CORRECT pattern — use TmuxSession for ALL interactive processes:
  TmuxSession({ action: "new", session: "py", command: "python3 -i" })
  TmuxSession({ action: "wait_for", session: "py", pattern: ">>>", timeout: 10000 })
  TmuxSession({ action: "send", session: "py", text: "print('hello')" })
  TmuxSession({ action: "capture", session: "py", lines: 10 })

## Other Instructions
- Always quote paths with spaces: "path with spaces/file.txt"
- Use absolute paths to avoid cwd confusion
- For dependent sequential commands, chain with && in one call`

export const READ_FILE_DESCRIPTION = `Reads a file from the filesystem and returns its contents with line numbers.

Usage:
- Provide an absolute file path
- Optionally specify offset (start line) and limit (number of lines) for large files
- Returns content in cat -n format: "line_number\\tcontent"
- Can read text files, code files, JSON, YAML, etc.`

export const WRITE_FILE_DESCRIPTION = `Writes content to a file, creating it if it doesn't exist or overwriting if it does.

IMPORTANT: For existing files, prefer Edit (precise string replacement) over Write (full overwrite).
Only use Write for:
- Creating new files
- Complete rewrites where the entire content changes

Always read the file first before overwriting to avoid losing content.`

export const EDIT_FILE_DESCRIPTION = `Performs exact string replacement in a file.

Usage:
- Provide the file path, the exact string to find (old_string), and the replacement (new_string)
- The old_string must match EXACTLY including whitespace and indentation
- If old_string appears multiple times, use more context to make it unique
- Use replace_all=true to replace all occurrences

This is the preferred way to modify existing files — it's precise and shows exactly what changed.`

export const GLOB_DESCRIPTION = `Finds files matching a glob pattern, sorted by modification time (newest first).

Examples:
- "**/*.ts" — all TypeScript files recursively
- "src/**/*.{js,ts}" — JS/TS files under src/
- "*.json" — JSON files in current directory

Returns a list of matching absolute file paths.`

export const GREP_DESCRIPTION = `Searches file contents using regex patterns (powered by ripgrep).

Parameters:
- pattern: regex pattern to search for
- path: directory or file to search (defaults to cwd)
- glob: file pattern filter (e.g. "*.ts")
- output_mode: "files_with_matches" (default) | "content" | "count"
- context: lines before/after each match (when output_mode="content")
- case_insensitive: true/false

Examples:
- Find files containing "useEffect": pattern="useEffect", glob="*.tsx"
- Show matching lines: pattern="TODO", output_mode="content"
- Count matches: pattern="console.log", output_mode="count"`
