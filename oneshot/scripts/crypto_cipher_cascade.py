#!/usr/bin/env python3
"""
Multi-Decoder Cipher Cascade — OneShot CTF

Recursively tries Base64, Base32, Base85, Hex, ROT13, and URL-decode on
an encoded string.  Checks for flag patterns after each decode step.

Usage:
    python3 crypto_cipher_cascade.py --input <encoded_string>
"""

from __future__ import annotations

import argparse
import base64
import binascii
import codecs
import json
import re
import sys
import urllib.parse
from typing import List, Optional, Set


FLAG_PATTERN = re.compile(
    r"(flag\{[^}]+\}|CTF\{[^}]+\}|DASCTF\{[^}]+\}|XHLJ\{[^}]+\}|key\{[^}]+\})",
    re.IGNORECASE,
)


def try_base64_decode(data: str) -> Optional[str]:
    """Try Base64 decode, auto-pad if needed."""
    try:
        # Auto-pad
        missing = len(data) % 4
        if missing:
            data += "=" * (4 - missing)
        decoded = base64.b64decode(data, validate=True)
        return decoded.decode("utf-8", errors="replace")
    except Exception:
        return None


def try_base32_decode(data: str) -> Optional[str]:
    try:
        missing = len(data) % 8
        if missing:
            data += "=" * (8 - missing)
        decoded = base64.b32decode(data.upper(), casefold=True)
        return decoded.decode("utf-8", errors="replace")
    except Exception:
        return None


def try_base85_decode(data: str) -> Optional[str]:
    try:
        decoded = base64.b85decode(data.encode())
        return decoded.decode("utf-8", errors="replace")
    except Exception:
        return None


def try_hex_decode(data: str) -> Optional[str]:
    try:
        decoded = bytes.fromhex(data)
        return decoded.decode("utf-8", errors="replace")
    except Exception:
        return None


def try_rot13_decode(data: str) -> str:
    return codecs.decode(data, "rot_13")


def try_url_decode(data: str) -> Optional[str]:
    try:
        return urllib.parse.unquote(data)
    except Exception:
        return None


def try_ascii85_decode(data: str) -> Optional[str]:
    """Try a85decode (Adobe Ascii85)."""
    try:
        decoded = base64.a85decode(data.encode(), adobe=True)
        return decoded.decode("utf-8", errors="replace")
    except Exception:
        return None


def try_reverse(data: str) -> str:
    return data[::-1]


DECODERS = [
    ("base64", try_base64_decode),
    ("base32", try_base32_decode),
    ("base85", try_base85_decode),
    ("hex", try_hex_decode),
    ("rot13", try_rot13_decode),
    ("url_decode", try_url_decode),
    ("ascii85", try_ascii85_decode),
    ("reverse", try_reverse),
]


def find_flags(text: str) -> List[str]:
    return FLAG_PATTERN.findall(text)


def cascade_decode(
    data: str,
    max_depth: int = 3,
    visited: Optional[Set[str]] = None,
    depth: int = 0,
    path: str = "",
) -> List[dict]:
    """Recursively try all decoders and collect flag results."""
    if visited is None:
        visited = set()

    results: List[dict] = []
    data_hash = hash(data)
    if data_hash in visited:
        return results
    visited.add(data_hash)

    if depth > max_depth:
        return results

    # Check current data for flags
    flags = find_flags(data)
    if flags:
        for f in flags:
            results.append({
                "flag": f,
                "path": path or "original",
                "depth": depth,
            })

    # Try each decoder
    for name, decoder_fn in DECODERS:
        try:
            decoded = decoder_fn(data)
            if decoded is None or decoded == data:
                continue
            if len(decoded) < 2:
                continue
            new_path = f"{path}/{name}" if path else name
            sub_results = cascade_decode(
                decoded,
                max_depth=max_depth,
                visited=visited,
                depth=depth + 1,
                path=new_path,
            )
            results.extend(sub_results)
        except Exception:
            continue

    return results


def solve(encoded: str) -> dict:
    """Main solver logic."""
    if not encoded or not encoded.strip():
        return {
            "status": "failed",
            "flag": None,
            "output": "Empty input string.",
        }

    encoded = encoded.strip()
    results = cascade_decode(encoded, max_depth=3)

    if not results:
        return {
            "status": "failed",
            "flag": None,
            "output": (
                f"No flag patterns found after {len(DECODERS)} decoder cascade "
                f"(max depth 3). Input length: {len(encoded)} chars."
            ),
        }

    # Deduplicate by flag value
    seen_flags: Set[str] = set()
    unique_results = []
    for r in results:
        if r["flag"] not in seen_flags:
            seen_flags.add(r["flag"])
            unique_results.append(r)

    output_lines = []
    for r in unique_results:
        output_lines.append(f"[{r['path']}] (depth={r['depth']}) {r['flag']}")

    return {
        "status": "solved",
        "flag": unique_results[0]["flag"],
        "output": "\n".join(output_lines),
        "all_flags": [r["flag"] for r in unique_results],
        "decode_paths": [r["path"] for r in unique_results],
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Multi-Decoder Cipher Cascade — OneShot CTF",
    )
    parser.add_argument(
        "--input", required=True, help="Encoded string to decode"
    )
    args = parser.parse_args()

    result = solve(args.input)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    sys.exit(0 if result["status"] == "solved" else 1)


if __name__ == "__main__":
    main()