#!/usr/bin/env python3
"""
Agent main-path benchmark — canonical, reproducible, isolated.

What this script does:
  - Reads the SolveBench challenges in --challenges-dir.
  - For every challenge, copies its `challenge.json` + the files in
    `attachmentPaths` to a fresh per-challenge tmp dir under
    --work-dir. Anything else (sessions/, .ovogo/, intermediate
    artifacts) is excluded so the agent can't peek at an already-
    solved sibling.
  - Spawns the Agent main path via `tsx src/ctf/cli/solve.ts
    <challenge.json>` and parses the flag from stdout.
  - Verifies the flag against expected SHA-256.
  - Writes ONE canonical report containing: git HEAD SHA, model
    name, endpoint, per-challenge pass/fail, median time, failure
    reasons, and any sub-reports from prior runs.

What this script does NOT do:
  - It does NOT call `real_solver.py` — that's the legacy
    hand-coded solver benchmark. This script measures Agent
    reasoning + tool orchestration, the real capability that
    matters in competition.

Usage:
  python3 agent_bench.py [--challenges-dir DIR] [--work-dir DIR] [--output FILE]
                         [--rounds N] [--per-challenge-timeout S]
                         [--model NAME]

Env:
  OPENAI_API_KEY       required
  OPENAI_BASE_URL      optional (default https://api.minimax.io/v1)
  OVOGO_MODEL          optional (default MiniMax-M3)
"""

from __future__ import annotations

import argparse
import dataclasses
import datetime
import hashlib
import json
import os
import re
import shutil
import statistics
import subprocess
import sys
import tempfile
import time
from pathlib import Path

BENCH_DIR = Path(__file__).parent
PROJECT_ROOT = BENCH_DIR.parent.parent
SOLVE_TS = PROJECT_ROOT / "src" / "ctf" / "cli" / "solve.ts"
TSX_BIN = PROJECT_ROOT / "node_modules" / ".bin" / "tsx"


def sha256(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()


def git_head(root: Path) -> str:
    """Return the current commit SHA so the report is traceable."""
    try:
        cp = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=root, capture_output=True, text=True, timeout=5, check=False,
        )
        return cp.stdout.strip() or "unknown"
    except Exception:
        return "unknown"


def git_dirty(root: Path) -> bool:
    try:
        cp = subprocess.run(
            ["git", "status", "--porcelain"],
            cwd=root, capture_output=True, text=True, timeout=5, check=False,
        )
        return bool(cp.stdout.strip())
    except Exception:
        return False


def stage_challenge(challenge_dir: Path, work_dir: Path) -> Path | None:
    """Copy challenge.json + declared attachments into a fresh tmp dir.

    Excludes runtime artifacts (.ovogo/, sessions/, *.log, app.db,
    trailing.zip etc.) so the agent can't reuse prior runs' work.
    """
    manifest_path = challenge_dir / "challenge.json"
    if not manifest_path.is_file():
        return None
    try:
        manifest = json.loads(manifest_path.read_text())
    except Exception:
        return None
    expected = manifest.get("expectedFlagSha256")
    if not expected or expected == "unknown":
        return None
    # Skip remote-only challenges (LLM can't reach external URLs in
    # the sandbox).
    desc = (manifest.get("description") or "").lower()
    if "http://" in desc or "https://" in desc or " nc " in desc:
        return None

    target = work_dir / manifest.get("id", challenge_dir.name)
    target.mkdir(parents=True, exist_ok=True)
    shutil.copy(manifest_path, target / "challenge.json")
    attachments = manifest.get("attachmentPaths") or []
    for name in attachments:
        src = challenge_dir / name
        if src.is_file():
            shutil.copy(src, target / name)
    return target


def extract_flag(output: str) -> str | None:
    """Pull the most likely flag from agent stdout."""
    text = re.sub(r"\x1b\[[0-9;]*m", "", output)
    charset = r"[A-Za-z0-9_\-+=/.!?@#$%^&*]"
    candidates: list[str] = []
    for pat in (
        rf"(?:flag|picoCTF|ctf)\{{{charset}+\}}",
        rf"(?:flag|picoCTF|ctf)\({charset}*\)",
        rf"(?:flag|picoCTF|ctf)\({charset}*\}}",
    ):
        for m in re.findall(pat, text):
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
    return max(candidates, key=len)


@dataclasses.dataclass
class ChallengeResult:
    id: str
    title: str
    category: str
    expected_sha256: str
    solved: bool
    flag: str | None
    time_ms: int
    exit_code: int
    failure_reason: str | None
    finding_count: int = 0  # parsed from findings.jsonl emitted by solve.ts
    artifact_count: int = 0


def run_challenge(
    challenge_staged_dir: Path,
    challenge_meta: dict,
    timeout_s: int,
    env: dict[str, str],
) -> ChallengeResult:
    """Spawn the Agent for one staged challenge. Returns metrics."""
    cid = challenge_meta["id"]
    title = challenge_meta.get("title", cid)
    category = challenge_meta.get("category", "?")
    expected = challenge_meta["expectedFlagSha256"]

    start = time.time()
    proc = subprocess.run(
        [str(TSX_BIN), str(SOLVE_TS), str(challenge_staged_dir / "challenge.json")],
        cwd=PROJECT_ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=timeout_s,
    )
    elapsed_ms = int((time.time() - start) * 1000)
    output = proc.stdout + proc.stderr
    flag = extract_flag(output)

    # Pull finding/artifact counts from the agent's findings.jsonl
    # if it was written under the staged dir's sessions/. This proves
    # the TaskState projector + Finding/Artifact lifecycle ran, not
    # just stdout regex matching.
    findings = 0
    artifacts = 0
    findings_glob = list(challenge_staged_dir.glob("sessions/**/findings.jsonl"))
    for fp in findings_glob[:1]:
        try:
            for line in fp.read_text(errors="ignore").splitlines():
                if line.strip():
                    findings += 1
        except Exception:
            pass
    artifacts_glob = list(challenge_staged_dir.glob("sessions/**/artifacts"))
    if artifacts_glob:
        try:
            artifacts = sum(1 for _ in artifacts_glob[0].iterdir() if _.is_file())
        except Exception:
            pass

    failure_reason: str | None = None
    solved = False
    if flag:
        actual = sha256(flag)
        if actual == expected:
            solved = True
        else:
            failure_reason = f"hash mismatch (got {actual[:8]}…, want {expected[:8]}…)"
    else:
        failure_reason = "no flag in output"
    return ChallengeResult(
        id=cid, title=title, category=category,
        expected_sha256=expected, solved=solved, flag=flag,
        time_ms=elapsed_ms, exit_code=proc.returncode,
        failure_reason=failure_reason,
        finding_count=findings, artifact_count=artifacts,
    )


def aggregate_round(results: list[ChallengeResult]) -> dict:
    solved = [r for r in results if r.solved]
    return {
        "solved_count": len(solved),
        "total_count": len(results),
        "pass_at_1": len(solved) / len(results) if results else 0.0,
        "median_time_ms": statistics.median([r.time_ms for r in results]) if results else 0,
        "findings_total": sum(r.finding_count for r in results),
        "artifacts_total": sum(r.artifact_count for r in results),
        "by_failure_reason": _failure_reasons(results),
    }


def _failure_reasons(results: list[ChallengeResult]) -> dict[str, int]:
    out: dict[str, int] = {}
    for r in results:
        if not r.failure_reason:
            continue
        key = r.failure_reason.split("(")[0].strip()
        out[key] = out.get(key, 0) + 1
    return out


def write_canonical_report(
    output_path: Path,
    rounds: list[dict],
    challenges_meta: dict[str, dict],
    rounds_total: int,
    pass_at_1_overall: float,
    per_round_pass_at_1: list[float],
    median_pass_at_1: float,
    env: dict[str, str],
) -> None:
    payload = {
        "schemaVersion": "1.0",
        "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "git_head": git_head(PROJECT_ROOT),
        "git_dirty": git_dirty(PROJECT_ROOT),
        "model": env.get("OVOGO_MODEL", "MiniMax-M3"),
        "endpoint": env.get("OPENAI_BASE_URL", "https://api.minimax.io/v1"),
        "rounds": rounds,
        "rounds_total": rounds_total,
        "pass_at_1_overall": pass_at_1_overall,
        "per_round_pass_at_1": per_round_pass_at_1,
        "median_pass_at_1": median_pass_at_1,
        "challenges_total": len(challenges_meta),
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(payload, indent=2, default=str))


def main() -> int:
    parser = argparse.ArgumentParser(description="Agent main-path benchmark (Round-8).")
    parser.add_argument("--challenges-dir", type=Path,
                        default=BENCH_DIR / "challenges",
                        help="Directory containing */challenge.json subdirs.")
    parser.add_argument("--work-dir", type=Path, default=None,
                        help="Per-run staging dir. Default: tempdir.")
    parser.add_argument("--output", type=Path,
                        default=BENCH_DIR / "results" / "agent-mainpath-canonical.json",
                        help="Canonical JSON report path.")
    parser.add_argument("--rounds", type=int, default=3,
                        help="Number of independent rounds to run (default 3).")
    parser.add_argument("--per-challenge-timeout", type=int, default=180,
                        help="Per-challenge wall-clock timeout in seconds.")
    args = parser.parse_args()

    if not os.environ.get("OPENAI_API_KEY"):
        print("ERROR: OPENAI_API_KEY not set; Agent main path requires an LLM.", file=sys.stderr)
        return 2

    # Discover challenges
    challenges = []
    for d in sorted(args.challenges_dir.glob("*/challenge.json")):
        try:
            meta = json.loads(d.read_text())
            challenges.append(meta)
        except Exception:
            continue
    if not challenges:
        print(f"No challenges found under {args.challenges_dir}", file=sys.stderr)
        return 1
    by_id = {c["id"]: c for c in challenges}

    work_root = args.work_dir or Path(tempfile.mkdtemp(prefix="agent-bench-"))
    work_root.mkdir(parents=True, exist_ok=True)

    rounds_data: list[dict] = []
    per_round_pass_at_1: list[float] = []

    for round_idx in range(args.rounds):
        round_dir = work_root / f"round_{round_idx + 1}"
        if round_dir.exists():
            shutil.rmtree(round_dir)
        round_dir.mkdir(parents=True, exist_ok=True)
        print(f"\n=== Round {round_idx + 1}/{args.rounds} ===")
        env = os.environ.copy()
        env.pop("SOLVEBENCH_FORCE_WORKFLOW", None)
        results: list[ChallengeResult] = []
        for meta in challenges:
            cid = meta["id"]
            staged = stage_challenge(
                args.challenges_dir / cid, round_dir,
            )
            if staged is None:
                continue
            print(f"  [{cid}] running…", end=" ", flush=True)
            try:
                r = run_challenge(staged, meta, args.per_challenge_timeout, env)
            except subprocess.TimeoutExpired:
                r = ChallengeResult(
                    id=cid, title=meta.get("title", cid),
                    category=meta.get("category", "?"),
                    expected_sha256=meta["expectedFlagSha256"],
                    solved=False, flag=None,
                    time_ms=args.per_challenge_timeout * 1000,
                    exit_code=-1, failure_reason="timeout",
                )
            print("✓" if r.solved else f"✗ ({r.failure_reason})", flush=True)
            results.append(r)
        agg = aggregate_round(results)
        agg["round"] = round_idx + 1
        agg["results"] = [dataclasses.asdict(r) for r in results]
        rounds_data.append(agg)
        per_round_pass_at_1.append(agg["pass_at_1"])
        print(
            f"  Round {round_idx + 1} done: "
            f"{agg['solved_count']}/{agg['total_count']} "
            f"({agg['pass_at_1']:.0%}) median {agg['median_time_ms']:.0f}ms"
        )

    overall_solved = sum(r["solved_count"] for r in rounds_data)
    overall_total = sum(r["total_count"] for r in rounds_data)
    pass_at_1_overall = overall_solved / overall_total if overall_total else 0.0
    median_pass = statistics.median(per_round_pass_at_1) if per_round_pass_at_1 else 0.0

    write_canonical_report(
        output_path=args.output,
        rounds=rounds_data,
        challenges_meta=by_id,
        rounds_total=args.rounds,
        pass_at_1_overall=pass_at_1_overall,
        per_round_pass_at_1=per_round_pass_at_1,
        median_pass_at_1=median_pass,
        env=os.environ,
    )
    print(
        f"\n=== Canonical report ===\n"
        f"  output: {args.output}\n"
        f"  rounds: {args.rounds}\n"
        f"  per-round pass@1: {[f'{p:.0%}' for p in per_round_pass_at_1]}\n"
        f"  overall: {overall_solved}/{overall_total} ({pass_at_1_overall:.0%})\n"
        f"  median pass@1: {median_pass:.0%}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())