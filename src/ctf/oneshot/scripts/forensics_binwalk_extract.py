#!/usr/bin/env python3
"""
Binwalk Forensics Extractor — runs binwalk to extract embedded files and
recursively searches for flag patterns in extracted content.
"""
import sys
import re
import os
import argparse
import subprocess
import tempfile
import shutil
from typing import List, Tuple

FLAG_PATTERN = re.compile(
    r'(flag\{[^}]+\}|CTF\{[^}]+\}|DASCTF\{[^}]+\}|XHLJ\{[^}]+\}|key\{[^}]+\}|picoCTF\{[^}]+\})',
    re.I,
)


def find_binwalk() -> str:
    """Find the binwalk binary."""
    # Try various paths
    for path in ['/usr/bin/binwalk', '/usr/local/bin/binwalk']:
        if os.path.exists(path):
            return path

    # Try which
    try:
        result = subprocess.run(['which', 'binwalk'], capture_output=True, text=True, timeout=5)
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip()
    except Exception:
        pass

    # Try as Python module
    try:
        result = subprocess.run(['python3', '-c', 'import binwalk; print("ok")'],
                              capture_output=True, text=True, timeout=5)
        if result.returncode == 0:
            return 'python3 -m binwalk'
    except Exception:
        pass

    return ''


def run_binwalk(filepath: str, binwalk_path: str, output_dir: str) -> bool:
    """Run binwalk to extract embedded files."""
    try:
        cmd_parts = binwalk_path.split()
        cmd = cmd_parts + ['-e', '-q', '--directory=' + output_dir, filepath]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        print(f'Binwalk output: {result.stdout[:500]}')
        if result.stderr:
            print(f'Binwalk stderr: {result.stderr[:500]}', file=sys.stderr)
        return result.returncode == 0
    except subprocess.TimeoutExpired:
        print("Binwalk timed out after 120s", file=sys.stderr)
        return False
    except Exception as e:
        print(f"Binwalk error: {e}", file=sys.stderr)
        return False


def scan_for_flags(directory: str) -> List[Tuple[str, str]]:
    """Recursively scan extracted files for flags."""
    results = []

    for root, dirs, files in os.walk(directory):
        for filename in files:
            filepath = os.path.join(root, filename)
            # Skip large files (> 10MB)
            try:
                if os.path.getsize(filepath) > 10_000_000:
                    continue
            except Exception:
                continue

            # Try text scan
            try:
                with open(filepath, 'r', encoding='utf-8', errors='replace') as f:
                    content = f.read()
                flags = FLAG_PATTERN.findall(content)
                for f in flags:
                    results.append((filepath, f))
            except Exception:
                pass

            # Try strings on binary files
            if not results or any(filepath.endswith(ext) for ext in ['.bin', '.img', '.raw', '.data']):
                try:
                    sresult = subprocess.run(
                        ['strings', '-n', '6', filepath],
                        capture_output=True, text=True, timeout=10,
                    )
                    flags = FLAG_PATTERN.findall(sresult.stdout)
                    for f in flags:
                        results.append((filepath, f))
                except Exception:
                    pass

    return results


def fallback_analysis(filepath: str) -> None:
    """If binwalk is not available, do basic analysis."""
    print("binwalk not available — performing basic analysis...")

    # Check file type
    try:
        result = subprocess.run(['file', filepath], capture_output=True, text=True, timeout=5)
        print(f'File type: {result.stdout.strip()}')
    except Exception:
        pass

    # Check for common magic bytes
    try:
        with open(filepath, 'rb') as f:
            header = f.read(16)
        known_headers = {
            b'\x89PNG': 'PNG image',
            b'\xff\xd8\xff': 'JPEG image',
            b'GIF8': 'GIF image',
            b'PK\x03\x04': 'ZIP archive',
            bytes([0x1f, 0x8b]): 'GZIP archive',
            b'BZh': 'BZIP2 archive',
            bytes([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]): 'XZ archive',
            b'\x7fELF': 'ELF binary',
            b'MZ': 'PE/EXE binary',
            b'\x00\x00\x01\xba': 'MPEG file',
            b'RIFF': 'RIFF/WAV file',
        }
        for magic, desc in known_headers.items():
            if header.startswith(magic):
                print(f'Detected: {desc}')
                break
        else:
            print(f'Unknown magic: {header[:8].hex()}')
    except Exception as e:
        print(f'Header analysis error: {e}')

    # Run strings as last resort
    try:
        sresult = subprocess.run(
            ['strings', '-n', '8', filepath],
            capture_output=True, text=True, timeout=30,
        )
        flags = FLAG_PATTERN.findall(sresult.stdout)
        if flags:
            for f in flags:
                print(f)
        else:
            # Print interesting strings
            interesting = []
            for line in sresult.stdout.split('\n'):
                if any(kw in line.lower() for kw in ['flag', 'key', 'secret', 'password', 'http']):
                    interesting.append(line.strip())
            if interesting:
                print(f'\nInteresting strings found:')
                for line in interesting[:50]:
                    print(f'  {line}')
    except Exception:
        pass


def main():
    parser = argparse.ArgumentParser(description='Binwalk Forensics Extractor')
    parser.add_argument('--file', '-f', required=True, help='Path to file to analyze')
    args = parser.parse_args()

    if not os.path.exists(args.file):
        print(f"File not found: {args.file}", file=sys.stderr)
        sys.exit(1)

    binwalk_path = find_binwalk()

    if binwalk_path:
        tmpdir = tempfile.mkdtemp(prefix='binwalk_extract_')
        print(f'Running binwalk extraction to {tmpdir}...')

        success = run_binwalk(args.file, binwalk_path, tmpdir)
        if success:
            flags = scan_for_flags(tmpdir)
            if flags:
                for filepath, flag in set(flags):
                    print(f'{os.path.basename(filepath)}: {flag}')
            else:
                print('No flags found in extracted content.')
        else:
            print('Binwalk extraction failed.')

        # Cleanup
        try:
            shutil.rmtree(tmpdir)
        except Exception:
            pass
    else:
        fallback_analysis(args.file)


if __name__ == '__main__':
    main()
