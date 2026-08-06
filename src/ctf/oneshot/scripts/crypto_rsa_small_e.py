#!/usr/bin/env python3
"""
RSA Small Exponent Solver — attacks RSA when e is small (3, 5, 17) and
N can be factored or the ciphertext is vulnerable to low-exponent attacks.

Supports:
  - e=3 with no padding (cube root attack)
  - Small N factoring via trial division / basic factorization
  - Wiener's attack via continued fractions (requires sympy)
"""
import sys
import re
import argparse
import math
from typing import Optional, Tuple

FLAG_PATTERN = re.compile(r'(flag\{[^}]+\}|CTF\{[^}]+\}|DASCTF\{[^}]+\}|XHLJ\{[^}]+\}|key\{[^}]+\})', re.I)


def parse_int(s: str) -> int:
    """Parse integer from decimal or hex string."""
    s = s.strip()
    if s.lower().startswith('0x'):
        return int(s, 16)
    return int(s)


def int_to_bytes(n: int) -> bytes:
    """Convert an integer to a byte string (big-endian, minimal length)."""
    if n == 0:
        return b'\x00'
    length = (n.bit_length() + 7) // 8
    return n.to_bytes(length, 'big')


def bytes_to_flag(data: bytes) -> Optional[str]:
    """Try to extract a flag from raw bytes."""
    text = data.decode('utf-8', errors='replace')
    flags = FLAG_PATTERN.findall(text)
    if flags:
        return flags[0]
    # Sometimes the flag is the whole text
    if all(32 <= b <= 126 for b in data) and len(data) > 4:
        return text.strip()
    return None


def crt_attack(ciphertexts: list, moduli: list) -> Optional[int]:
    """Chinese Remainder Theorem — if same message encrypted with e=3 under 3 different N."""
    if len(ciphertexts) < 3 or len(moduli) < 3:
        return None

    # CRT
    M = moduli[0] * moduli[1] * moduli[2]
    ms = [M // n for n in moduli[:3]]
    result = 0
    for i in range(3):
        inv = pow(ms[i], -1, moduli[i])
        result += ciphertexts[i] * ms[i] * inv
    result %= M

    # Cube root
    cube_root = round(result ** (1/3))
    # Verify
    for check in [cube_root, cube_root - 1, cube_root + 1]:
        if check ** 3 == result:
            return check
    return None


def small_e_attack(n: int, e: int, c: int) -> Optional[str]:
    """Attack RSA with small e (e <= 17) using i*N + c root extraction."""
    import decimal
    from decimal import Decimal, getcontext
    getcontext().prec = 500

    for i in range(1000):
        candidate = c + i * n
        root = round(candidate ** (1.0 / e))
        if pow(root, e, n) == c % n:
            msg = int_to_bytes(root)
            flag = bytes_to_flag(msg)
            if flag:
                return flag
        # Try ±1 for floating point inaccuracy
        for offset in [-1, 0, 1]:
            try_root = root + offset
            if try_root > 0 and pow(try_root, e, n) == c % n:
                msg = int_to_bytes(try_root)
                flag = bytes_to_flag(msg)
                if flag:
                    return flag
    return None


def factor_small(n: int) -> Optional[Tuple[int, int]]:
    """Try to factor a small N using trial division."""
    if n % 2 == 0:
        return (2, n // 2)

    limit = min(int(math.isqrt(n)) + 1, 10_000_000)
    for i in range(3, limit, 2):
        if n % i == 0:
            return (i, n // i)
    return None


def factor_with_factor_db(n: int) -> Optional[Tuple[int, int]]:
    """Try factordb.com API (requires network)."""
    try:
        import requests
        resp = requests.get(f'http://factordb.com/api?query={n}', timeout=10)
        data = resp.json()
        if data and data.get('factors'):
            import ast
            factors = []
            for factor_data in data['factors']:
                val, exp = factor_data
                val_int = int(float(val))
                factors.extend([val_int] * exp)
            if len(factors) >= 2:
                return (factors[0], n // factors[0])
    except Exception:
        pass
    return None


def solve_rsa(n: int, e: int, c: int) -> Optional[str]:
    """Main RSA solver. Tries multiple strategies."""

    # Strategy 1: Small N — try to factor directly
    if n.bit_length() <= 64:
        factors = factor_small(n)
        if factors:
            p, q = factors
            phi = (p - 1) * (q - 1)
            d = pow(e, -1, phi)
            m = pow(c, d, n)
            msg = int_to_bytes(m)
            flag = bytes_to_flag(msg)
            if flag:
                return flag

    # Strategy 2: Small e attack (e=3, e=5, etc.)
    if e <= 17:
        flag = small_e_attack(n, e, c)
        if flag:
            return flag

    # Strategy 3: Wiener's attack (requires sympy)
    try:
        from sympy import Rational, continued_fraction
        cf = continued_fraction(Rational(e, n))
        convergents = list(cf.convergents())
        for conv in convergents[:100]:
            k = conv.numerator
            d_candidate = conv.denominator
            if k == 0:
                continue
            if (e * d_candidate - 1) % k == 0:
                phi_candidate = (e * d_candidate - 1) // k
                # Solve for p, q: p + q = n - phi + 1, p * q = n
                s = n - phi_candidate + 1
                discriminant = s * s - 4 * n
                if discriminant >= 0:
                    sqrt_disc = int(math.isqrt(discriminant))
                    if sqrt_disc * sqrt_disc == discriminant:
                        p = (s + sqrt_disc) // 2
                        q = (s - sqrt_disc) // 2
                        if p * q == n:
                            d = pow(e, -1, (p - 1) * (q - 1))
                            m = pow(c, d, n)
                            msg = int_to_bytes(m)
                            flag = bytes_to_flag(msg)
                            if flag:
                                return flag
    except ImportError:
        pass
    except Exception:
        pass

    # Strategy 4: Try FactorDB for larger N
    if n.bit_length() <= 256:
        factors = factor_with_factor_db(n)
        if factors:
            p, q = factors
            phi = (p - 1) * (q - 1)
            d = pow(e, -1, phi)
            m = pow(c, d, n)
            msg = int_to_bytes(m)
            flag = bytes_to_flag(msg)
            if flag:
                return flag

    return None


def main():
    parser = argparse.ArgumentParser(description='RSA Small Exponent/Key Solver')
    parser.add_argument('--n', required=True, help='RSA modulus N')
    parser.add_argument('--e', required=True, help='RSA public exponent e')
    parser.add_argument('--c', required=True, help='Ciphertext c')
    args = parser.parse_args()

    n = parse_int(args.n)
    e = parse_int(args.e)
    c = parse_int(args.c)

    print(f'RSA Parameters:')
    print(f'  N = {n} ({n.bit_length()} bits)')
    print(f'  e = {e}')
    print(f'  c = {c}')

    # First, just try to interpret c as ASCII
    msg = int_to_bytes(c)
    flag = bytes_to_flag(msg)
    if flag:
        print(f'Plaintext (no decryption needed): {flag}')
        return

    result = solve_rsa(n, e, c)
    if result:
        print(f'Flag: {result}')
    else:
        print(f'No flag found. N is {n.bit_length()} bits — may need more advanced factoring.')

        # Try factordb as last resort
        print('\nSuggestions:')
        print(f'  1. Check http://factordb.com/index.php?query={n}')
        print(f'  2. Try RsaCtfTool: python3 RsaCtfTool.py -n {n} -e {e} --uncipher {c}')


if __name__ == '__main__':
    main()
