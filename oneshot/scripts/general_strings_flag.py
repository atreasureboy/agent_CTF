#!/usr/bin/env python3
"""
General Flag Pattern Extractor — OneShot CTF

Scans file contents or raw text input for flag patterns using multiple
regex variants covering common CTF flag formats.

Usage:
    python3 general_strings_flag.py --file <path>       # Scan a binary/text file
    python3 general_strings_flag.py --text <string>     # Scan raw text
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import List, Set


# Comprehensive flag patterns
FLAG_PATTERNS: List[re.Pattern] = [
    # Standard CTF flag formats (negative lookbehind prevents CTF{ matching inside DASCTF{)
    re.compile(rb"(?<![A-Za-z])flag\{[^}]+\}", re.IGNORECASE),
    re.compile(rb"(?<![A-Za-z])CTF\{[^}]+\}", re.IGNORECASE),
    # Regional / competition-specific
    re.compile(rb"DASCTF\{[^}]+\}", re.IGNORECASE),
    re.compile(rb"XHLJ\{[^}]+\}", re.IGNORECASE),
    re.compile(rb"key\{[^}]+\}", re.IGNORECASE),
    # Chinese CTF formats (as UTF-8 byte patterns via encode)
    re.compile("西湖论剑\\{[^}]+\\}".encode("utf-8")),
    re.compile("网鼎杯\\{[^}]+\\}".encode("utf-8")),
    re.compile("强网杯\\{[^}]+\\}".encode("utf-8")),
    re.compile("长城杯\\{[^}]+\\}".encode("utf-8")),
    re.compile("蓝帽杯\\{[^}]+\\}".encode("utf-8")),
    re.compile("鹏城杯\\{[^}]+\\}".encode("utf-8")),
    re.compile("网安\\{[^}]+\\}".encode("utf-8")),
    # Other common formats
    re.compile(rb"hgame\{[^}]+\}", re.IGNORECASE),
    re.compile(rb"hackergame\{[^}]+\}", re.IGNORECASE),
    re.compile(rb"picoCTF\{[^}]+\}", re.IGNORECASE),
    re.compile(rb"HSCTF\{[^}]+\}", re.IGNORECASE),
    re.compile(rb"utflag\{[^}]+\}", re.IGNORECASE),
    re.compile(rb"brics\{[^}]+\}", re.IGNORECASE),
    re.compile(rb"VolgaCTF\{[^}]+\}", re.IGNORECASE),
    # Generic key/token format
    re.compile(rb"[A-Za-z0-9+/=]{20,}={0,2}"),
]


def scan_bytes(data: bytes) -> List[str]:
    """Scan binary data for flag patterns, return unique matches."""
    flags: Set[str] = set()
    # First: try extracting ASCII strings from binary
    strings_data = extract_strings(data, min_len=4)
    text_data = strings_data.encode("utf-8", errors="replace")

    for pattern in FLAG_PATTERNS:
        for match in pattern.findall(data):
            try:
                flags.add(match.decode("utf-8", errors="replace"))
            except Exception:
                pass
        for match in pattern.findall(text_data):
            try:
                flags.add(match.decode("utf-8", errors="replace"))
            except Exception:
                pass

    return list(flags)


def extract_strings(data: bytes, min_len: int = 4) -> str:
    """Extract printable ASCII/UTF-8 strings from binary data."""
    result = []
    current = bytearray()
    for byte in data:
        if 32 <= byte <= 126 or byte in (9, 10, 13):  # printable ASCII + tab, newline
            current.append(byte)
        else:
            if len(current) >= min_len:
                result.append(current.decode("ascii", errors="replace"))
            current = bytearray()
    if len(current) >= min_len:
        result.append(current.decode("ascii", errors="replace"))
    return "\n".join(result)


def solve(file_path: str = "", text: str = "") -> dict:
    """Main solver logic."""
    if file_path:
        path = Path(file_path)
        if not path.exists():
            return {
                "status": "failed",
                "flag": None,
                "output": f"File not found: {file_path}",
            }
        try:
            data = path.read_bytes()
        except Exception as exc:
            return {
                "status": "failed",
                "flag": None,
                "output": f"Failed to read file: {exc}",
            }
        size_info = f"File: {path.name} ({len(data)} bytes)"
    elif text:
        data = text.encode("utf-8", errors="replace")
        size_info = f"Text input ({len(text)} chars)"
    else:
        return {
            "status": "failed",
            "flag": None,
            "output": "No input provided. Use --file or --text.",
        }

    flags = scan_bytes(data)

    if not flags:
        return {
            "status": "failed",
            "flag": None,
            "output": f"{size_info} — No flag patterns matched.",
        }

    # Filter out obviously non-flag base64-like matches
    flag_like = [f for f in flags if "{" in f and "}" in f]
    if not flag_like:
        flag_like = flags

    output_lines = [size_info] + [f"  [{i+1}] {f}" for i, f in enumerate(flag_like)]

    return {
        "status": "solved",
        "flag": flag_like[0],
        "output": "\n".join(output_lines),
        "all_flags": flag_like,
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="General Flag Pattern Extractor — OneShot CTF",
    )
    parser.add_argument("--file", default="", help="Path to file to scan")
    parser.add_argument("--text", default="", help="Raw text to scan")
    args = parser.parse_args()

    if not args.file and not args.text:
        parser.print_help()
        print(json.dumps({
            "status": "failed",
            "flag": None,
            "output": "No input provided. Use --file or --text.",
        }, ensure_ascii=False, indent=2))
        sys.exit(1)

    result = solve(file_path=args.file, text=args.text)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    sys.exit(0 if result["status"] == "solved" else 1)


if __name__ == "__main__":
    main()