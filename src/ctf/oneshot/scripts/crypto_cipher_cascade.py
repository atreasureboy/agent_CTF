#!/usr/bin/env python3
"""
Multi-Decoder Cipher Cascade — tries every common encoding chain on input.
Covers: Base64, Base32, Base16/Hex, ROT13, Base85, URL-decode, Morse, binary, octal.
Outputs the chain path and any flag-like results found.
"""
import sys
import re
import base64
import codecs
import argparse
import hashlib
from typing import Optional, List, Tuple

FLAG_PATTERN = re.compile(r'(flag\{[^}]+\}|CTF\{[^}]+\}|DASCTF\{[^}]+\}|XHLJ\{[^}]+\}|key\{[^}]+\})', re.I)


def try_decode(data: str, name: str) -> Optional[str]:
    """Attempt a single decode. Returns decoded text or None."""
    try:
        if name == 'base64':
            return base64.b64decode(data, validate=True).decode('utf-8', errors='replace')
        elif name == 'base32':
            return base64.b32decode(data.upper().strip(), casefold=True).decode('utf-8', errors='replace')
        elif name == 'base16' or name == 'hex':
            return bytes.fromhex(data.strip().replace(' ', '')).decode('utf-8', errors='replace')
        elif name == 'rot13':
            return codecs.decode(data, 'rot_13')
        elif name == 'base85':
            return base64.a85decode(data.encode()).decode('utf-8', errors='replace')
        elif name == 'ascii85':
            return base64.b85decode(data.encode()).decode('utf-8', errors='replace')
        elif name == 'url':
            from urllib.parse import unquote_plus
            return unquote_plus(data)
        elif name == 'morse':
            return decode_morse(data)
        elif name == 'binary':
            # Binary string: "01001000 01101001" → "Hi"
            parts = data.strip().split()
            return ''.join(chr(int(b, 2)) for b in parts if all(c in '01' for c in b))
        elif name == 'octal':
            # Octal string: "150 151" → "hi"
            parts = data.strip().split()
            return ''.join(chr(int(o, 8)) for o in parts if all(c in '01234567' for c in o))
        elif name == 'reverse':
            return data[::-1]
        elif name == 'from_hex_text':
            # "666c6167" → "flag"
            return bytes.fromhex(data.strip().replace(' ', '')).decode('utf-8', errors='replace')
    except Exception:
        pass
    return None


MORSE_TABLE = {
    '.-': 'A', '-...': 'B', '-.-.': 'C', '-..': 'D', '.': 'E',
    '..-.': 'F', '--.': 'G', '....': 'H', '..': 'I', '.---': 'J',
    '-.-': 'K', '.-..': 'L', '--': 'M', '-.': 'N', '---': 'O',
    '.--.': 'P', '--.-': 'Q', '.-.': 'R', '...': 'S', '-': 'T',
    '..-': 'U', '...-': 'V', '.--': 'W', '-..-': 'X', '-.--': 'Y',
    '--..': 'Z', '.----': '1', '..---': '2', '...--': '3', '....-': '4',
    '.....': '5', '-....': '6', '--...': '7', '---..': '8', '----.': '9',
    '-----': '0', '/': ' ',
}


def decode_morse(text: str) -> Optional[str]:
    """Decode Morse code (dots/dashes separated by spaces, words by /)."""
    text = text.strip()
    if not re.match(r'^[.\- /]+$', text):
        return None
    result = []
    for word in text.split('/'):
        chars = []
        for symbol in word.strip().split():
            chars.append(MORSE_TABLE.get(symbol, '?'))
        result.append(''.join(chars))
    return ' '.join(result)


DECODERS = ['base64', 'base32', 'hex', 'rot13', 'base85', 'ascii85', 'url', 'morse', 'binary', 'octal', 'reverse']


def cascade_decode(input_data: str, depth: int = 3) -> List[Tuple[str, str]]:
    """Try cascading decodes up to `depth` levels deep."""
    results = []
    visited = set()

    def dfs(data: str, path: List[str], d: int):
        if d > depth:
            return
        key = (hashlib.md5(data.encode()).hexdigest(), d)
        if key in visited:
            return
        visited.add(key)

        # Check for flags in current data
        flags = FLAG_PATTERN.findall(data)
        for f in flags:
            results.append((' → '.join(path) if path else 'raw', f))

        # Try each decoder
        for dec in DECODERS:
            decoded = try_decode(data, dec)
            if decoded and len(decoded) > 1 and decoded != data:
                dfs(decoded, path + [dec], d + 1)

    dfs(input_data.strip(), [], 1)
    return results


def main():
    parser = argparse.ArgumentParser(description='Multi-decoder cipher cascade')
    parser.add_argument('--input', '-i', required=True, help='Encoded string to decode')
    args = parser.parse_args()

    results = cascade_decode(args.input)
    if results:
        for path, flag in results:
            if path:
                print(f'[{path}] → {flag}')
            else:
                print(flag)
    else:
        print(f'No flags found via any decoding chain for input: {args.input[:50]}...')


if __name__ == '__main__':
    main()
