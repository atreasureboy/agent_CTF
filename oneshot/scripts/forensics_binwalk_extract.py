#!/usr/bin/env python3
"""
Binwalk Forensics Extractor — OneShot CTF

Runs binwalk to extract embedded files from a forensic artifact, then
recursively searches extracted content for flag patterns.

Usage:
    python3 forensics_binwalk_extract.py --file <path_to_artifact>
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import List, Optional


FLAG_PATTERN = re.compile(
    rb"(flag\{[^}]+\}|CTF\{[^}]+\}|DASCTF\{[^}]+\}|XHLJ\{[^}]+\}|key\{[^}]+\})",
    re.IGNORECASE,
)


def find_binwalk() -> Optional[str]:
    """Locate the binwalk binary."""
    for candidate in ["binwalk", "binwalk.exe"]:
        try:
            result = subprocess.run(
                [candidate, "--version"],
                capture_output=True,
                text=True,
                timeout=5,
            )
            if result.returncode == 0:
                return candidate
        except (FileNotFoundError, subprocess.TimeoutExpired):
            continue
    return None


def run_binwalk_extract(file_path: str, output_dir: str) -> Optional[str]:
    """Run binwalk -e to extract embedded files."""
    binwalk = find_binwalk()
    if not binwalk:
        return "binwalk not found in PATH. Install with: pip install binwalk or apt install binwalk"

    try:
        result = subprocess.run(
            [binwalk, "-e", "--directory", output_dir, file_path],
            capture_output=True,
            text=True,
            timeout=300,
        )
        stdout = result.stdout
        stderr = result.stderr
        if result.returncode != 0 and not stdout.strip():
            return f"binwalk exited with code {result.returncode}: {stderr}"
        return stdout
    except subprocess.TimeoutExpired:
        return "binwalk timed out after 300 seconds"
    except Exception as exc:
        return f"binwalk execution failed: {exc}"


def search_extracted_dir(root_dir: str, max_depth: int = 5) -> List[dict]:
    """Recursively search extracted files for flag patterns."""
    results: List[dict] = []
    root = Path(root_dir)

    for path in root.rglob("*"):
        if path.is_file():
            try:
                size = path.stat().st_size
                if size > 10 * 1024 * 1024:  # Skip files > 10MB
                    continue
                data = path.read_bytes()
                flags = FLAG_PATTERN.findall(data)
                for f in flags:
                    flag_str = f.decode("utf-8", errors="replace")
                    results.append({
                        "flag": flag_str,
                        "file": str(path.relative_to(root)),
                        "size": size,
                    })
            except (PermissionError, OSError):
                continue

    return results


def manual_extract_and_search(file_path: str) -> List[dict]:
    """Fallback: manual common file carving without binwalk."""
    results: List[dict] = []
    path = Path(file_path)

    if not path.exists():
        return results

    data = path.read_bytes()

    # Check raw file for flag patterns
    flags = FLAG_PATTERN.findall(data)
    for f in flags:
        flag_str = f.decode("utf-8", errors="replace")
        results.append({
            "flag": flag_str,
            "file": path.name,
            "size": len(data),
        })

    # Try extracting strings
    strings_data = extract_strings(data)
    flags = FLAG_PATTERN.findall(strings_data.encode("utf-8", errors="replace"))
    for f in flags:
        flag_str = f.decode("utf-8", errors="replace")
        results.append({
            "flag": flag_str,
            "file": f"{path.name} (strings)",
            "size": len(data),
        })

    return results


def extract_strings(data: bytes, min_len: int = 4) -> str:
    result = []
    current = bytearray()
    for byte in data:
        if 32 <= byte <= 126 or byte in (9, 10, 13):
            current.append(byte)
        else:
            if len(current) >= min_len:
                result.append(current.decode("ascii", errors="replace"))
            current = bytearray()
    if len(current) >= min_len:
        result.append(current.decode("ascii", errors="replace"))
    return "\n".join(result)


def solve(file_path: str) -> dict:
    """Main solver logic."""
    path = Path(file_path)
    if not path.exists():
        return {
            "status": "failed",
            "flag": None,
            "output": f"File not found: {file_path}",
        }

    results: List[dict] = []

    # Try binwalk extraction first
    output_dir = tempfile.mkdtemp(prefix="binwalk_extract_")
    try:
        binwalk_output = run_binwalk_extract(file_path, output_dir)
        if isinstance(binwalk_output, str) and binwalk_output.startswith("binwalk not found"):
            # Fallback: manual search
            results = manual_extract_and_search(file_path)
        else:
            extracted = search_extracted_dir(output_dir)
            results.extend(extracted)
            # Also search the original file
            original = manual_extract_and_search(file_path)
            for r in original:
                if not any(e["flag"] == r["flag"] for e in results):
                    results.append(r)
    finally:
        # Cleanup temp dir
        try:
            import shutil
            shutil.rmtree(output_dir, ignore_errors=True)
        except Exception:
            pass

    if not results:
        return {
            "status": "failed",
            "flag": None,
            "output": (
                f"No flag patterns found in extracted content from {path.name} "
                f"({path.stat().st_size} bytes)."
            ),
        }

    # Deduplicate
    seen: set = set()
    unique = []
    for r in results:
        if r["flag"] not in seen:
            seen.add(r["flag"])
            unique.append(r)

    output_lines = [f"Source: {path.name} ({path.stat().st_size} bytes)"]
    for r in unique:
        output_lines.append(f"  [{r['file']}] {r['flag']}")

    return {
        "status": "solved",
        "flag": unique[0]["flag"],
        "output": "\n".join(output_lines),
        "all_flags": [r["flag"] for r in unique],
        "source_files": [r["file"] for r in unique],
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Binwalk Forensics Extractor — OneShot CTF",
    )
    parser.add_argument("--file", required=True, help="Path to forensic artifact")
    args = parser.parse_args()

    result = solve(args.file)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    sys.exit(0 if result["status"] == "solved" else 1)


if __name__ == "__main__":
    main()