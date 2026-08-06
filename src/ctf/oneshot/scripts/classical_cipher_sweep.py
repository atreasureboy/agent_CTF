#!/usr/bin/env python3
"""
Classical Cipher Sweep — tries all common classical ciphers on the input.
Covers: ROT1-25, Atbash, Vigenere (with common keys), Bacon, Rail Fence,
        Polybius, Scytale, Columnar Transposition, Morse, ASCII shift, A1Z26.
"""
import sys
import re
import argparse
import string
from typing import List, Tuple, Optional

FLAG_PATTERN = re.compile(r'(flag\{[^}]+\}|CTF\{[^}]+\}|DASCTF\{[^}]+\}|XHLJ\{[^}]+\}|key\{[^}]+\}|picoCTF\{[^}]+\})', re.I)


def rot_n(text: str, n: int) -> str:
    """ROT-N cipher (both uppercase and lowercase)."""
    result = []
    for c in text:
        if 'a' <= c <= 'z':
            result.append(chr((ord(c) - ord('a') + n) % 26 + ord('a')))
        elif 'A' <= c <= 'Z':
            result.append(chr((ord(c) - ord('A') + n) % 26 + ord('A')))
        else:
            result.append(c)
    return ''.join(result)


def atbash(text: str) -> str:
    """Atbash cipher (a→z, b→y, etc.)."""
    result = []
    for c in text:
        if 'a' <= c <= 'z':
            result.append(chr(ord('z') - (ord(c) - ord('a'))))
        elif 'A' <= c <= 'Z':
            result.append(chr(ord('Z') - (ord(c) - ord('A'))))
        else:
            result.append(c)
    return ''.join(result)


COMMON_VIGENERE_KEYS = [
    'key', 'flag', 'ctf', 'secret', 'cipher', 'password', 'vigenere',
    'crypto', 'crypt', 'decode', 'cypher', 'pico', 'picoctf',
    'abcdef', 'abc', 'xyz', 'test',
]


def vigenere_decrypt(text: str, key: str) -> str:
    """Vigenere decryption."""
    result = []
    key = key.lower()
    key_idx = 0
    for c in text:
        if 'a' <= c <= 'z':
            shift = ord(key[key_idx % len(key)]) - ord('a')
            result.append(chr((ord(c) - ord('a') - shift) % 26 + ord('a')))
            key_idx += 1
        elif 'A' <= c <= 'Z':
            shift = ord(key[key_idx % len(key)]) - ord('a')
            result.append(chr((ord(c) - ord('A') - shift) % 26 + ord('A')))
            key_idx += 1
        else:
            result.append(c)
    return ''.join(result)


BACON_TABLE = {
    'AAAAA': 'a', 'AAAAB': 'b', 'AAABA': 'c', 'AAABB': 'd', 'AABAA': 'e',
    'AABAB': 'f', 'AABBA': 'g', 'AABBB': 'h', 'ABAAA': 'i', 'ABAAB': 'j',
    'ABABA': 'k', 'ABABB': 'l', 'ABBAA': 'm', 'ABBAB': 'n', 'ABBBA': 'o',
    'ABBBB': 'p', 'BAAAA': 'q', 'BAAAB': 'r', 'BAABA': 's', 'BAABB': 't',
    'BABAA': 'u', 'BABAB': 'v', 'BABBA': 'w', 'BABBB': 'x', 'BBAAA': 'y',
    'BBBAA': 'z',
}


def bacon_decode(text: str) -> Optional[str]:
    """Try to decode Bacon's cipher (A/B patterns)."""
    # Normalize to A/B
    binary = ''.join(c.upper() if c.upper() in 'AB' else ('A' if c.isupper() else '') for c in text)
    binary = re.sub(r'[^AB]', '', binary)
    if len(binary) < 5:
        return None

    result = []
    for i in range(0, len(binary) - 4, 5):
        chunk = binary[i:i + 5]
        result.append(BACON_TABLE.get(chunk, '?'))
    return ''.join(result)


def rail_fence_decrypt(text: str, rails: int) -> str:
    """Rail Fence decryption."""
    if rails <= 1:
        return text
    text = text.replace(' ', '')
    n = len(text)
    fence = [['' for _ in range(n)] for _ in range(rails)]
    direction = -1
    row, col = 0, 0

    # Mark positions
    for _ in range(n):
        if row == 0 or row == rails - 1:
            direction *= -1
        fence[row][col] = '*'
        col += 1
        row += direction

    # Fill with text
    idx = 0
    for i in range(rails):
        for j in range(n):
            if fence[i][j] == '*':
                fence[i][j] = text[idx]
                idx += 1

    # Read off
    result = []
    row, col = 0, 0
    direction = -1
    for _ in range(n):
        if row == 0 or row == rails - 1:
            direction *= -1
        result.append(fence[row][col])
        col += 1
        row += direction

    return ''.join(result)


def a1z26_decode(text: str) -> Optional[str]:
    """A1Z26 cipher: 1→a, 26→z. Supports dash-separated and space-separated."""
    result = []
    parts = re.split(r'[\s\-_,;]+', text.strip())
    if not parts:
        return None

    all_nums = True
    for part in parts:
        try:
            n = int(part)
            if n < 1 or n > 26:
                all_nums = False
                break
        except ValueError:
            all_nums = False
            break

    if not all_nums:
        return None

    for part in parts:
        n = int(part)
        result.append(chr(ord('a') + n - 1))
    return ''.join(result)


MORSE_TABLE_REV = {
    '.-': 'A', '-...': 'B', '-.-.': 'C', '-..': 'D', '.': 'E',
    '..-.': 'F', '--.': 'G', '....': 'H', '..': 'I', '.---': 'J',
    '-.-': 'K', '.-..': 'L', '--': 'M', '-.': 'N', '---': 'O',
    '.--.': 'P', '--.-': 'Q', '.-.': 'R', '...': 'S', '-': 'T',
    '..-': 'U', '...-': 'V', '.--': 'W', '-..-': 'X', '-.--': 'Y',
    '--..': 'Z',
    '.----': '1', '..---': '2', '...--': '3', '....-': '4',
    '.....': '5', '-....': '6', '--...': '7', '---..': '8',
    '----.': '9', '-----': '0',
    '--..--': ',', '.-.-.-': '.', '..--..': '?', '-.-.--': '!',
    '-....-': '-', '-..-.': '/', '.--.-.': '@', '-...-': '=',
}


def morse_decode(text: str) -> Optional[str]:
    """Morse code decoder."""
    parts = text.strip().split()
    if not re.match(r'^[.\- /]+$', text.strip()):
        return None
    result = []
    for part in parts:
        result.append(MORSE_TABLE_REV.get(part, '?'))
    return ''.join(result).lower()


def columnar_transposition_decrypt(text: str, key: str) -> str:
    """Simple columnar transposition decryption."""
    key_order = sorted(range(len(key)), key=lambda i: key[i])
    cols = len(key)
    rows = (len(text) + cols - 1) // cols
    matrix = [[''] * cols for _ in range(rows)]

    idx = 0
    for col in key_order:
        for row in range(rows):
            if idx < len(text):
                matrix[row][col] = text[idx]
                idx += 1

    result = []
    for row in range(rows):
        result.append(''.join(matrix[row]))
    return ''.join(result).rstrip()


def find_flags(text: str, cipher_name: str, results: List[Tuple[str, str]]) -> None:
    """Search for flags in decoded text and add to results."""
    flags = FLAG_PATTERN.findall(text)
    for f in flags:
        results.append((cipher_name, f))


def sweep(text: str) -> List[Tuple[str, str]]:
    """Try all classical ciphers."""
    results: List[Tuple[str, str]] = []

    # Check input for flags directly
    find_flags(text, 'raw', results)

    text_clean = text.strip()

    # ROT 1-25
    for n in range(1, 26):
        decoded = rot_n(text_clean, n)
        if FLAG_PATTERN.search(decoded):
            find_flags(decoded, f'ROT{n}', results)

    # Atbash
    decoded = atbash(text_clean)
    find_flags(decoded, 'atbash', results)

    # Vigenere with common keys
    for key in COMMON_VIGENERE_KEYS:
        decoded = vigenere_decrypt(text_clean, key)
        find_flags(decoded, f'vigenere({key})', results)

    # Bacon
    decoded = bacon_decode(text_clean)
    if decoded:
        find_flags(decoded, 'bacon', results)

    # Rail Fence
    for rails in range(2, 8):
        try:
            decoded = rail_fence_decrypt(text_clean, rails)
            find_flags(decoded, f'rail_fence({rails})', results)
        except Exception:
            pass

    # A1Z26
    decoded = a1z26_decode(text_clean)
    if decoded:
        find_flags(decoded, 'a1z26', results)

    # Morse
    decoded = morse_decode(text_clean)
    if decoded:
        find_flags(decoded, 'morse', results)

    # Reverse
    decoded = text_clean[::-1]
    find_flags(decoded, 'reverse', results)

    return results


def main():
    parser = argparse.ArgumentParser(description='Classical Cipher Sweep')
    parser.add_argument('--input', '-i', required=True, help='Ciphertext to analyze')
    args = parser.parse_args()

    results = sweep(args.input)
    if results:
        for cipher, flag in results:
            print(f'[{cipher}] {flag}')
    else:
        # Even without flags, show top ROT candidates
        print('No flags found. Showing ROT1-25 output previews:\n')
        for n in range(1, 26):
            decoded = rot_n(args.input.strip(), n)
            preview = decoded[:60].replace('\n', ' ')
            print(f'  ROT{n:2d}: {preview}')


if __name__ == '__main__':
    main()
