#!/usr/bin/env python3
"""
XOR Bruteforce — single-byte and multi-byte XOR key search.
Automatically finds the most English-like result using frequency analysis.
Supports hex input, raw file input, and known plaintext attack.
"""
import sys
import re
import argparse
from typing import List, Tuple, Optional

FLAG_PATTERN = re.compile(r'(flag\{[^}]+\}|CTF\{[^}]+\}|DASCTF\{[^}]+\}|XHLJ\{[^}]+\}|key\{[^}]+\}|picoCTF\{[^}]+\})', re.I)

# English letter frequency (simplified)
ENGLISH_FREQ = {
    'a': 8.2, 'b': 1.5, 'c': 2.8, 'd': 4.3, 'e': 12.7, 'f': 2.2,
    'g': 2.0, 'h': 6.1, 'i': 7.0, 'j': 0.15, 'k': 0.77, 'l': 4.0,
    'm': 2.4, 'n': 6.7, 'o': 7.5, 'p': 1.9, 'q': 0.1, 'r': 6.0,
    's': 6.3, 't': 9.1, 'u': 2.8, 'v': 0.98, 'w': 2.4, 'x': 0.15,
    'y': 2.0, 'z': 0.074, ' ': 15.0,
}


def score_english(text: str) -> float:
    """Score text on how English-like it is."""
    if not text:
        return 0.0

    # Count printable ASCII ratio
    printable = sum(1 for c in text if 32 <= ord(c) < 127 or c in '\n\r\t')
    printable_ratio = printable / max(len(text), 1)
    if printable_ratio < 0.8:
        return 0.0

    # Check for flag-like patterns
    flag_bonus = 10.0 if 'flag{' in text.lower() or 'ctf{' in text.lower() else 0.0

    # Frequency analysis
    lower_text = text.lower()
    char_counts = {}
    for c in lower_text:
        char_counts[c] = char_counts.get(c, 0) + 1

    total = max(sum(char_counts.values()), 1)
    score = flag_bonus

    # Score common English words
    common_words = ['the', 'and', 'for', 'are', 'but', 'not', 'you', 'all',
                    'can', 'had', 'her', 'was', 'one', 'our', 'out', 'has',
                    'flag', 'key', 'ctf', 'this', 'that', 'with', 'have', 'from']
    for word in common_words:
        if word in lower_text:
            score += 1.0

    # Letter frequency comparison
    for c, expected in ENGLISH_FREQ.items():
        actual = (char_counts.get(c, 0) / total) * 100
        diff = abs(actual - expected)
        score -= diff * 0.1

    return score


def single_byte_xor(data: bytes) -> List[Tuple[int, str, float]]:
    """Try all single-byte XOR keys. Returns (key, result, score)."""
    results = []
    for key in range(256):
        decoded = bytes(b ^ key for b in data)
        try:
            text = decoded.decode('utf-8', errors='replace')
            score = score_english(text)
            if score > 2.0:  # Minimum threshold
                results.append((key, text, score))
        except Exception:
            pass

    results.sort(key=lambda x: -x[2])
    return results[:10]


def multi_byte_xor(data: bytes, max_key_len: int = 8) -> List[Tuple[bytes, str]]:
    """Try multi-byte XOR keys up to max_key_len."""
    results = []

    # Strategy: for key length up to 4, try combinations of printable keys
    common_key_chars = (string.ascii_letters + string.digits + '_-=+!@#$%^&*()').encode()
    max_key_len_bruteforce = 4

    for key_len in range(1, min(max_key_len_bruteforce + 1, max_key_len + 1)):
        # Sample-based: try common keys first
        key_tries = 0
        max_tries = min(500000, len(common_key_chars) ** key_len)

        if key_len == 1:
            keys_to_try = [(bytes([c]),) for c in common_key_chars]
        elif key_len == 2:
            # Just try common bigrams
            keys_to_try = [
                (bytes([c1, c2]),)
                for c1 in common_key_chars[:50]  # Limit to 50 chars for 2-byte
                for c2 in common_key_chars[:50]
            ][:50000]
        else:
            # For longer keys, try patterns: aaaa, abcd, etc.
            keys_to_try = []
            # Repeating pattern
            for c in common_key_chars[:26]:
                keys_to_try.append((bytes([c]) * key_len,))
            # Ascending
            for start in range(len(common_key_chars) - key_len + 1):
                keys_to_try.append((
                    bytes(common_key_chars[start + i] for i in range(key_len)),
                ))

        for key_tuple in keys_to_try[:50000]:
            key = key_tuple[0]
            decoded = bytes(data[i] ^ key[i % len(key)] for i in range(len(data)))
            try:
                text = decoded.decode('utf-8', errors='replace')
                score = score_english(text)
                if score > 5.0:
                    results.append((key, text))
            except Exception:
                pass

            key_tries += 1
            if key_tries >= max_tries:
                # Sample the rest
                break

    # Deduplicate and sort by text quality
    seen = set()
    unique = []
    for key, text in results:
        if text not in seen:
            seen.add(text)
            unique.append((key, text))
    return unique[:20]


def known_plaintext_xor(ciphertext: bytes, known_plaintext: bytes) -> Optional[bytes]:
    """Recover XOR key from known plaintext. Returns key."""
    if len(known_plaintext) > len(ciphertext):
        return None

    key = bytearray()
    for i in range(len(known_plaintext)):
        key.append(ciphertext[i] ^ known_plaintext[i])

    # Try full key decryption
    decoded = bytes(ciphertext[i] ^ key[i % len(key)] for i in range(len(ciphertext)))
    try:
        text = decoded.decode('utf-8', errors='replace')
        return bytes(key)
    except Exception:
        return None


def main():
    parser = argparse.ArgumentParser(description='XOR Bruteforce Solver')
    parser.add_argument('--hex', help='Ciphertext in hex format')
    parser.add_argument('--file', '-f', help='Read ciphertext from file')
    parser.add_argument('--known-plaintext', help='Known plaintext for key recovery')
    parser.add_argument('--max-key-len', type=int, default=8, help='Maximum XOR key length')
    args = parser.parse_args()

    if args.hex:
        ciphertext = bytes.fromhex(args.hex.replace(' ', ''))
    elif args.file:
        with open(args.file, 'rb') as f:
            ciphertext = f.read()
    else:
        print("Error: --hex or --file required", file=sys.stderr)
        sys.exit(1)

    print(f'Ciphertext length: {len(ciphertext)} bytes')

    # Known plaintext attack first
    if args.known_plaintext:
        known = args.known_plaintext.encode()
        key = known_plaintext_xor(ciphertext, known)
        if key:
            decoded = bytes(ciphertext[i] ^ key[i % len(key)] for i in range(len(ciphertext)))
            text = decoded.decode('utf-8', errors='replace')
            flags = FLAG_PATTERN.findall(text)
            if flags:
                for f in flags:
                    print(f'Known-plaintext: {f}')
            else:
                print(f'Decrypted (key={key.hex()}): {text[:200]}')
        else:
            print('Known plaintext attack failed.')
        return

    # Single-byte XOR
    print('\n=== Single-byte XOR ===')
    results = single_byte_xor(ciphertext)
    if results:
        for key, text, score in results[:5]:
            flags = FLAG_PATTERN.findall(text)
            if flags:
                print(f'  key=0x{key:02x} ({chr(key) if 32 <= key < 127 else "?"}): {flags[0]}')
            else:
                preview = text[:60].replace('\n', ' ')
                print(f'  key=0x{key:02x} ({chr(key) if 32 <= key < 127 else "?"}): score={score:.1f} "{preview}"')
    else:
        print('  No convincing single-byte XOR results.')

    # Multi-byte XOR
    print(f'\n=== Multi-byte XOR (up to {args.max_key_len}-byte key) ===')
    results = multi_byte_xor(ciphertext, args.max_key_len)
    if results:
        shown = 0
        for key, text in results[:10]:
            flags = FLAG_PATTERN.findall(text)
            if flags:
                print(f'  key={key.hex()}: {flags[0]}')
                shown += 1
            elif shown < 3:
                preview = text[:80].replace('\n', ' ')
                print(f'  key={key.hex()}: "{preview}"')
                shown += 1
    else:
        print('  No convincing multi-byte XOR results.')


if __name__ == '__main__':
    import string
    main()
