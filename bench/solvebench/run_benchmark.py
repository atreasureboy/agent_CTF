#!/usr/bin/env python3
"""SolveBench runner — solves challenges and reports results."""

import hashlib
import json
import os
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

BENCH_DIR = Path(__file__).parent
CHALLENGES_DIR = BENCH_DIR / "challenges"
RESULTS_DIR = BENCH_DIR / "results"

def sha256(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()

def solve_challenge(challenge_dir: Path, agent_cmd: list) -> dict:
    """Solve a single challenge and return metrics."""
    manifest_path = challenge_dir / "challenge.json"
    
    with open(manifest_path) as f:
        manifest = json.load(f)
    
    challenge_id = manifest["id"]
    expected_sha256 = manifest["expectedFlagSha256"]
    timeout_ms = manifest.get("timeoutMs", 60000)
    
    print(f"\n{'='*60}")
    print(f"Solving: {challenge_id} - {manifest['title']}")
    print(f"Category: {manifest['category']}")
    print(f"Expected SHA256: {expected_sha256}")
    print(f"{'='*60}\n")
    
    # Start timing
    start_time = time.time()
    
    # Start web server if needed
    server_process = None
    if manifest.get("startupCommand"):
        print(f"Starting server: {manifest['startupCommand']}")
        server_process = subprocess.Popen(
            manifest["startupCommand"].split(),
            cwd=challenge_dir,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        time.sleep(1)  # Wait for server to start
    
    try:
        # Run the agent
        cmd = agent_cmd + [str(manifest_path)]
        print(f"Running: {' '.join(cmd)}")
        
        result = subprocess.run(
            cmd,
            cwd=challenge_dir,
            capture_output=True,
            text=True,
            timeout=timeout_ms / 1000,
        )
        
        end_time = time.time()
        time_to_flag_ms = int((end_time - start_time) * 1000)
        
        # Parse output
        output = result.stdout + result.stderr
        print("\nAgent output:")
        print(output)
        
        # Extract flag from output
        flag = None
        for line in output.split('\n'):
            if 'flag{' in line or 'flag(' in line:
                # Extract flag
                import re
                match = re.search(r'flag\{[^}]+\}|flag\([^)]+\)', line)
                if match:
                    flag = match.group(0)
                    break
        
        # Verify flag
        solved = False
        if flag:
            actual_sha256 = sha256(flag)
            print(f"\nExtracted flag: {flag}")
            print(f"Actual SHA256: {actual_sha256}")
            if actual_sha256 == expected_sha256:
                print("✓ SOLVED!")
                solved = True
            else:
                print("✗ Wrong flag")
        else:
            print("\n✗ No flag found in output")
        
        return {
            "id": challenge_id,
            "title": manifest["title"],
            "category": manifest["category"],
            "solved": solved,
            "flag": flag,
            "timeToFlagMs": time_to_flag_ms,
            "exitCode": result.returncode,
            "output": output[:1000],  # Truncate
        }
    
    except subprocess.TimeoutExpired:
        print(f"\n✗ TIMEOUT after {timeout_ms}ms")
        return {
            "id": challenge_id,
            "title": manifest["title"],
            "category": manifest["category"],
            "solved": False,
            "flag": None,
            "timeToFlagMs": timeout_ms,
            "exitCode": -1,
            "output": "TIMEOUT",
        }
    
    finally:
        # Shutdown server if started
        if server_process:
            print(f"\nShutting down server...")
            if manifest.get("shutdownCommand"):
                subprocess.run(manifest["shutdownCommand"].split(), capture_output=True)
            server_process.terminate()
            server_process.wait(timeout=5)

def main():
    if len(sys.argv) < 2:
        print("Usage: python3 run_benchmark.py <agent-command>")
        print("Example: python3 run_benchmark.py 'tsx ../../bin/ovogogogo-ctf.ts solve'")
        sys.exit(1)
    
    agent_cmd = sys.argv[1:]
    
    # Find all challenges
    challenges = sorted(CHALLENGES_DIR.glob("*/challenge.json"))
    
    if not challenges:
        print("No challenges found!")
        sys.exit(1)
    
    print(f"Found {len(challenges)} challenges")
    
    # Solve each challenge
    results = []
    for challenge_path in challenges:
        challenge_dir = challenge_path.parent
        result = solve_challenge(challenge_dir, agent_cmd)
        results.append(result)
    
    # Generate report
    RESULTS_DIR.mkdir(exist_ok=True)
    
    # JSON report
    json_path = RESULTS_DIR / "latest.json"
    with open(json_path, "w") as f:
        json.dump(results, f, indent=2)
    
    # Markdown report
    md_path = RESULTS_DIR / "latest.md"
    with open(md_path, "w") as f:
        f.write("# SolveBench Results\n\n")
        f.write(f"**Date:** {datetime.now().isoformat()}\n\n")
        
        solved_count = sum(1 for r in results if r["solved"])
        f.write(f"**Solved:** {solved_count}/{len(results)}\n\n")
        
        f.write("| Challenge | Category | Solved | Time (ms) | Flag |\n")
        f.write("|-----------|----------|--------|-----------|------|\n")
        
        for r in results:
            status = "✓" if r["solved"] else "✗"
            flag_display = r["flag"][:20] + "..." if r["flag"] and len(r["flag"]) > 20 else (r["flag"] or "N/A")
            f.write(f"| {r['title']} | {r['category']} | {status} | {r['timeToFlagMs']} | {flag_display} |\n")
        
        f.write("\n## Details\n\n")
        for r in results:
            f.write(f"### {r['title']}\n\n")
            f.write(f"- **ID:** {r['id']}\n")
            f.write(f"- **Category:** {r['category']}\n")
            f.write(f"- **Solved:** {r['solved']}\n")
            f.write(f"- **Time:** {r['timeToFlagMs']}ms\n")
            if r["flag"]:
                f.write(f"- **Flag:** {r['flag']}\n")
            f.write(f"\n**Output:**\n```\n{r['output']}\n```\n\n")
    
    print(f"\n{'='*60}")
    print(f"BENCHMARK COMPLETE")
    print(f"{'='*60}")
    print(f"Solved: {solved_count}/{len(results)}")
    print(f"Results: {json_path}")
    print(f"Report: {md_path}")
    
    # Exit with error if not all solved
    if solved_count < len(results):
        sys.exit(1)

if __name__ == "__main__":
    main()
