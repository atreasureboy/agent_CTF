#!/usr/bin/env python3
"""
General Flag Pattern Scanner — scans files/text for 15+ CTF flag patterns.
Handles text files, binary files (via strings), and recursively scans directories.
"""
import sys
import re
import os
import argparse
from typing import List, Tuple

# Comprehensive flag patterns for Chinese and Western CTF competitions
FLAG_PATTERNS = [
    re.compile(p, re.I) for p in [
        r'flag\{[^}]+\}',
        r'CTF\{[^}]+\}',
        r'DASCTF\{[^}]+\}',
        r'XHLJ\{[^}]+\}',
        r'key\{[^}]+\}',
        r'picoCTF\{[^}]+\}',
        r'HITB\{[^}]+\}',
        r'inctf\{[^}]+\}',
        r'ISITDTU\{[^}]+\}',
        r'X-MAS\{[^}]+\}',
        r'TFCCTF\{[^}]+\}',
        r'HackTM\{[^}]+\}',
        r'VolgaCTF\{[^}]+\}',
        r'ASIS\{[^}]+\}',
        r'FAUST\{[^}]+\}',
        r'CTF\{.+?\}',  # Non-greedy for nested braces
        r'FLAG_[A-Z_]+',
    ]
]

# Binary patterns for scanning raw bytes
FLAG_BYTES = [
    b'flag{',
    b'CTF{',
    b'picoCTF{',
    b'DASCTF{',
    b'XHLJ{',
    b'key{',
]


def scan_text(text: str) -> List[Tuple[str, str]]:
    """Scan text for flag patterns. Returns (pattern_matched, flag)."""
    results = []
    seen = set()
    for pattern in FLAG_PATTERNS:
        for match in pattern.finditer(text):
            flag = match.group(0)
            if flag not in seen:
                seen.add(flag)
                results.append((pattern.pattern, flag))
    return results


def scan_file(filepath: str) -> List[Tuple[str, str]]:
    """Scan a file for flag patterns."""
    results = []

    # Try as text first
    try:
        with open(filepath, 'r', encoding='utf-8', errors='replace') as f:
            content = f.read()
        flags = scan_text(content)
        if flags:
            results.extend(flags)
    except Exception:
        pass

    # If no flags found or file is binary, scan as binary
    if not results:
        try:
            with open(filepath, 'rb') as f:
                content = f.read()

            # Scan for flag byte patterns
            for flag_pattern in FLAG_BYTES:
                idx = 0
                while True:
                    idx = content.find(flag_pattern, idx)
                    if idx == -1:
                        break
                    end = content.find(b'}', idx + len(flag_pattern))
                    if end != -1 and end - idx < 200:
                        flag_bytes = content[idx:end + 1]
                        try:
                            flag_str = flag_bytes.decode('ascii')
                            results.append(('bytes_scan', flag_str))
                        except Exception:
                            results.append(('bytes_scan', repr(flag_bytes)))
                    idx += 1
        except Exception:
            pass

    return results


def scan_directory(dirpath: str) -> List[Tuple[str, str, str]]:
    """Recursively scan a directory. Returns (filepath, pattern, flag)."""
    results = []
    for root, dirs, files in os.walk(dirpath):
        for filename in files:
            filepath = os.path.join(root, filename)
            try:
                flags = scan_file(filepath)
                for pattern, flag in flags:
                    results.append((filepath, pattern, flag))
            except Exception:
                pass
    return results


def main():
    parser = argparse.ArgumentParser(description='General Flag Pattern Scanner')
    parser.add_argument('--file', '-f', required=True, help='Path to file or directory to scan')
    parser.add_argument('--recursive', '-r', action='store_true', help='Recursively scan directories')
    args = parser.parse_args()

    if os.path.isdir(args.file):
        if not args.recursive:
            print(f"'{args.file}' is a directory. Use --recursive to scan directories.")
            sys.exit(1)
        results = scan_directory(args.file)
        if results:
            for filepath, pattern, flag in results:
                print(f'{filepath}: {flag}')
        else:
            print("No flags found in directory.")
    else:
        flags = scan_file(args.file)
        if flags:
            for pattern, flag in flags:
                print(flag)
        else:
            # Try running strings on the file
            print("No flags found directly. Running strings...")
            try:
                import subprocess
                result = subprocess.run(
                    ['strings', '-n', '6', args.file],
                    capture_output=True, text=True, timeout=30
                )
                flags = scan_text(result.stdout)
                if flags:
                    for pattern, flag in flags:
                        print(flag)
                else:
                    print("No flags found in file or strings output.")
            except FileNotFoundError:
                print("'strings' command not available. Install binutils.")
            except Exception as e:
                print(f"strings error: {e}")


if __name__ == '__main__':
    main()
