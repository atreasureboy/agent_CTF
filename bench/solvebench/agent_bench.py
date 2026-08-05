#!/usr/bin/env python3
"""
Agent main-path benchmark — spawns the actual CTF solver agent
(`ovogogogo-ctf` via `solve.ts`) on every SolveBench challenge, rather
than `real_solver.py` (which dispatches by challenge-id to a hand-
written Python function and reports "No solver for X" for everything
else).

This is what the user actually cares about: end-to-end Agent solving,
not solver-coverage accounting.

Usage:
  python3 agent_bench.py                       # all 20 challenges
  python3 agent_bench.py --ids encoding1,crypto5  # subset
  python3 agent_bench.py --timeout 240000     # per-challenge timeout
  python3 agent_bench.py --model MiniMax-M3   # override model

Env:
  OPENAI_API_KEY       required (LLM endpoint)
  OPENAI_BASE_URL      optional (defaults to https://api.minimax.io/v1)
  OVOGO_MODEL          optional (defaults to MiniMax-M3)
"""

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

BENCH_DIR = Path(__file__).parent
CHALLENGES_DIR = BENCH_DIR / "challenges"
RESULTS_DIR = BENCH_DIR / "results"
SOLVE_TS = BENCH_DIR.parent.parent / "src" / "ctf" / "cli" / "solve.ts"
PROJECT_ROOT = BENCH_DIR.parent.parent


def sha256(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()


def extract_flag(output: str) -> str | None:
    """Pull the most likely flag from agent stdout.

    The solve.ts runner already extracts and validates, but in case
    the CLI's regex fails we re-scan here with the same charset rule.
    """
    # Strip ANSI escape sequences.
    text = re.sub(r"\x1b\[[0-9;]*m", "", output)
    charset = r"[A-Za-z0-9_\-+=/.!?@#$%^&*]"
    candidates: list[str] = []
    for pat in (
        rf"(?:flag|picoCTF|ctf)\{{{charset}+\}}",
        rf"(?:flag|picoCTF|ctf)\({charset}*\)",
        rf"(?:flag|picoCTF|ctf)\({charset}*\}}",
    ):
        for m in re.findall(pat, text):
            inner = m[len(m) - len(m.lstrip("(flag|picoCTF|ctf)")) - 1 + 1 :]
            # Strip the actual prefix from m (the captured full string)
            # Simpler: reconstruct from known prefixes
            for prefix in ("flag{", "flag(", "picoCTF{", "picoCTF(", "ctf{", "ctf("):
                if m.startswith(prefix):
                    inner = m[len(prefix):-1]
                    break
            else:
                inner = ""
            if not inner or inner in ("...", "..") or re.fullmatch(r"\.+", inner):
                continue
            if re.search(r"x{4,}", inner, re.IGNORECASE):
                continue
            candidates.append(m)
    if not candidates:
        return None
    # Prefer the longest.
    return max(candidates, key=len)


def solve_challenge(
    challenge_dir: Path,
    timeout_s: int,
    extra_env: dict[str, str],
) -> dict:
    manifest_path = challenge_dir / "challenge.json"
    with open(manifest_path) as f:
        manifest = json.load(f)
    cid = manifest["id"]
    expected = manifest["expectedFlagSha256"]
    title = manifest.get("title", cid)
    category = manifest.get("category", "?")

    print(f"\n[{cid}] {title}  ({category})")
    print(f"  expected SHA256 = {expected[:16]}...")

    env = os.environ.copy()
    env.update(extra_env)
    # Always force LLM chat-mode for the agent main-path benchmark.
    env.pop("SOLVEBENCH_FORCE_WORKFLOW", None)

    start = time.time()
    server_process = None
    if manifest.get("startupCommand"):
        try:
            server_process = subprocess.Popen(
                manifest["startupCommand"].split(),
                cwd=challenge_dir,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            time.sleep(1.5)
        except Exception as e:
            print(f"  WARN: failed to start server: {e}")

    try:
        # Pass absolute paths so solve.ts doesn't depend on cwd.
        # The solve.ts CLI works as long as both the script and the
        # challenge.json are valid paths.
        tsx_bin = PROJECT_ROOT / "node_modules" / ".bin" / "tsx"
        cmd = [
            str(tsx_bin),
            str(SOLVE_TS),
            str(manifest_path),
        ]
        # cwd=challenge_dir so the spawned CLI reads attachments from
        # the right place (--input uses cwd-relative resolution).
        proc = subprocess.run(
            cmd,
            cwd=challenge_dir,
            env=env,
            capture_output=True,
            text=True,
            timeout=timeout_s,
        )
        elapsed = int((time.time() - start) * 1000)
        output = proc.stdout + proc.stderr

        flag = extract_flag(output)
        solved = False
        if flag:
            actual = sha256(flag)
            solved = actual == expected
            print(f"  flag={flag[:40]}{'...' if len(flag) > 40 else ''}")
            print(f"  {'✓ SOLVED' if solved else '✗ Wrong flag'}  (elapsed {elapsed}ms)")
        else:
            print(f"  ✗ No flag found in output  (elapsed {elapsed}ms)")

        return {
            "id": cid,
            "title": title,
            "category": category,
            "solved": solved,
            "flag": flag,
            "timeMs": elapsed,
            "exitCode": proc.returncode,
            "outputTail": output[-500:],
        }

    except subprocess.TimeoutExpired:
        elapsed = int((time.time() - start) * 1000)
        print(f"  ✗ TIMEOUT after {timeout_s}s")
        return {
            "id": cid,
            "title": title,
            "category": category,
            "solved": False,
            "flag": None,
            "timeMs": elapsed,
            "exitCode": -1,
            "outputTail": "TIMEOUT",
        }
    finally:
        if server_process:
            try:
                server_process.terminate()
                server_process.wait(timeout=5)
            except Exception:
                pass


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--ids", default=None,
                        help="comma-separated list of challenge ids to run (default: all)")
    parser.add_argument("--timeout", type=int, default=200,
                        help="per-challenge timeout in seconds (default 200)")
    parser.add_argument("--challenges-dir", default=str(CHALLENGES_DIR),
                        help="directory containing */challenge.json subdirs")
    args = parser.parse_args()

    cd_root = Path(args.challenges_dir)
    challenges = sorted(cd_root.glob("*/challenge.json"))
    if args.ids:
        wanted = set(args.ids.split(","))
        challenges = [c for c in challenges if json.loads(c.read_text())["id"] in wanted]

    if not challenges:
        print("No challenges found!")
        return 1

    print(f"Running {len(challenges)} challenges through Agent main path...")

    extra_env = {}
    if not os.environ.get("OPENAI_API_KEY"):
        print("ERROR: OPENAI_API_KEY not set. Agent main path requires LLM.")
        return 2

    results = []
    for cp in challenges:
        cd = cp.parent
        r = solve_challenge(cd, args.timeout, extra_env)
        results.append(r)

    RESULTS_DIR.mkdir(exist_ok=True)
    ts = datetime.now().strftime("%Y%m%dT%H%M%S")
    json_path = RESULTS_DIR / f"agent-mainpath-{ts}.json"
    md_path = RESULTS_DIR / f"agent-mainpath-{ts}.md"
    latest_json = RESULTS_DIR / "latest-agent.json"
    latest_md = RESULTS_DIR / "latest-agent.md"

    json_path.write_text(json.dumps(results, indent=2))
    latest_json.write_text(json.dumps(results, indent=2))

    solved = sum(1 for r in results if r["solved"])
    md = [
        "# Agent Main-Path Benchmark",
        "",
        f"**Date:** {datetime.now().isoformat()}",
        "",
        f"**Solved:** {solved}/{len(results)}  ({solved/len(results)*100:.0f}%)",
        "",
        "| Challenge | Category | Solved | Time |",
        "|-----------|----------|--------|------|",
    ]
    for r in results:
        s = "✓" if r["solved"] else "✗"
        md.append(f"| {r['title']} | {r['category']} | {s} | {r['timeMs']}ms |")
    md_text = "\n".join(md) + "\n"
    md_path.write_text(md_text)
    latest_md.write_text(md_text)

    print("\n" + "=" * 60)
    print(f"AGENT MAIN-PATH BENCHMARK COMPLETE")
    print(f"  Solved: {solved}/{len(results)}  ({solved/len(results)*100:.0f}%)")
    print(f"  JSON:   {json_path}")
    print(f"  Report: {md_path}")
    print("=" * 60)

    return 0 if solved == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())