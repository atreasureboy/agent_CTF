#!/usr/bin/env python3
"""
RSA Small-e Attack Solver — OneShot CTF

When the public exponent e is small (e=3, e=5, etc.), the ciphertext may
be directly recoverable via integer root extraction or Coppersmith-style
heuristics.

Usage:
    python3 crypto_rsa_small_e.py --n <hex> --e <int> --c <hex>
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from typing import Optional


def integer_nth_root(x: int, n: int) -> Optional[int]:
    """Compute floor(x^(1/n)) via integer Newton's method, then verify exactness."""
    if x < 0 and n % 2 == 0:
        return None
    sign = -1 if x < 0 else 1
    x = abs(x)
    # Initial guess via float
    guess = int(x ** (1.0 / n))
    # Newton's method to refine
    while True:
        delta = (guess ** n - x) // (n * guess ** (n - 1)) if guess > 0 else 0
        if delta == 0:
            break
        guess -= delta
    # Check both directions
    for g in range(max(0, guess - 2), guess + 3):
        if g ** n == x:
            return sign * g
    return None


def int_to_bytes(n: int) -> bytes:
    """Convert a non-negative integer to big-endian bytes."""
    if n == 0:
        return b"\x00"
    length = (n.bit_length() + 7) // 8
    return n.to_bytes(length, "big")


def try_decode_flag(candidate: bytes) -> Optional[str]:
    """Try to decode bytes as UTF-8; return string if it looks like a flag or printable text."""
    try:
        text = candidate.decode("utf-8", errors="replace")
        # Remove null bytes and check for flag patterns
        if any(pattern in text for pattern in ("flag{", "CTF{", "DASCTF{", "XHLJ{")):
            return text
        # Also return if it's mostly printable
        printable = sum(1 for c in text if 32 <= ord(c) <= 126 or c in "\n\r\t")
        if printable > len(text) * 0.8 and len(text) >= 4:
            return text
    except Exception:
        pass
    return None


def solve(n_hex: str, e_str: str, c_hex: str) -> dict:
    """Main solver logic."""
    try:
        n = int(n_hex, 16)
        e = int(e_str)
        c = int(c_hex, 16)
    except ValueError as exc:
        return {
            "status": "failed",
            "flag": None,
            "output": f"Invalid hex input: {exc}",
        }

    results = []

    # Strategy 1: Direct integer e-th root (works when m^e < n, i.e. no wrap)
    root = integer_nth_root(c, e)
    if root is not None:
        plain_bytes = int_to_bytes(root)
        flag = try_decode_flag(plain_bytes)
        if flag:
            results.append(f"[direct-root] {flag}")
        else:
            results.append(f"[direct-root] Non-flag payload (len={len(plain_bytes)}): {plain_bytes[:200]!r}")

    # Strategy 2: For e=3, try adding small multiples of n (m^3 = c + k*n)
    if e == 3 and root is None:
        for k in range(1, 500):
            candidate = c + k * n
            root_k = integer_nth_root(candidate, 3)
            if root_k is not None:
                plain_bytes = int_to_bytes(root_k)
                flag = try_decode_flag(plain_bytes)
                if flag:
                    results.append(f"[broadcast-k={k}] {flag}")
                    break
                # else keep searching

    # Strategy 3: For e=5, try same approach
    if e == 5 and root is None:
        for k in range(1, 200):
            candidate = c + k * n
            root_k = integer_nth_root(candidate, 5)
            if root_k is not None:
                plain_bytes = int_to_bytes(root_k)
                flag = try_decode_flag(plain_bytes)
                if flag:
                    results.append(f"[broadcast-k={k}] {flag}")
                    break

    if results:
        # Find the first flag-like result
        for r in results:
            if "flag{" in r.lower() or "ctf{" in r.lower():
                flag_val = r.split("] ", 1)[1] if "] " in r else r
                return {
                    "status": "solved",
                    "flag": flag_val,
                    "output": "\n".join(results),
                }
        return {
            "status": "solved",
            "flag": None,
            "output": "\n".join(results),
        }
    else:
        return {
            "status": "failed",
            "flag": None,
            "output": (
                f"e={e} is too large for direct root attack (e > 5). "
                f"Consider Wiener or Boneh-Durfee instead. "
                f"n bits={n.bit_length()}, c bits={c.bit_length()}"
            ),
        }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="RSA Small-e Attack Solver — OneShot CTF",
    )
    parser.add_argument("--n", required=True, help="RSA modulus n (hex string)")
    parser.add_argument("--e", required=True, help="Public exponent e (integer)")
    parser.add_argument("--c", required=True, help="Ciphertext c (hex string)")
    args = parser.parse_args()

    result = solve(args.n, args.e, args.c)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    sys.exit(0 if result["status"] == "solved" else 1)


if __name__ == "__main__":
    main()