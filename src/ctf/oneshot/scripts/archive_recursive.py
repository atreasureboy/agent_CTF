#!/usr/bin/env python3
"""
Archive Recursive Extractor — recursively extracts nested archives (zip in zip in tar etc.).
Handles: ZIP, TAR, GZIP, BZIP2, XZ, 7Z, RAR.
Searches for flags in extracted content.
"""
import sys
import re
import os
import argparse
import shutil
import tempfile
import subprocess
from typing import List, Tuple, Set

FLAG_PATTERN = re.compile(
    r'(flag\{[^}]+\}|CTF\{[^}]+\}|DASCTF\{[^}]+\}|XHLJ\{[^}]+\}|key\{[^}]+\}|picoCTF\{[^}]+\})',
    re.I,
)

ARCHIVE_EXTENSIONS = {
    '.zip', '.tar', '.gz', '.tgz', '.bz2', '.tbz2', '.xz', '.txz',
    '.7z', '.rar', '.jar', '.war', '.ear', '.apk', '.ipa',
}

# Tool availability cache
TOOL_CACHE: dict = {}


def has_tool(name: str) -> bool:
    """Check if a tool is available."""
    if name in TOOL_CACHE:
        return TOOL_CACHE[name]
    result = shutil.which(name) is not None
    TOOL_CACHE[name] = result
    return result


def extract_archive(filepath: str, output_dir: str) -> bool:
    """Extract an archive to output_dir. Returns True if successful."""
    try:
        if filepath.endswith('.zip') or filepath.endswith('.jar'):
            if has_tool('7z'):
                subprocess.run(['7z', 'x', '-y', f'-o{output_dir}', filepath],
                             capture_output=True, timeout=30)
            else:
                subprocess.run(['unzip', '-o', '-q', filepath, '-d', output_dir],
                             capture_output=True, timeout=30)
        elif filepath.endswith('.tar') or filepath.endswith('.tgz') or filepath.endswith('.tar.gz'):
            subprocess.run(['tar', '-xf', filepath, '-C', output_dir],
                         capture_output=True, timeout=30)
        elif filepath.endswith('.gz'):
            subprocess.run(['gunzip', '-c', filepath],
                         capture_output=True, timeout=15)
            outfile = os.path.join(output_dir, os.path.basename(filepath).replace('.gz', ''))
            if os.path.exists(outfile):
                return True
        elif filepath.endswith('.bz2') or filepath.endswith('.tbz2'):
            subprocess.run(['bunzip2', '-c', filepath],
                         capture_output=True, timeout=30)
        elif filepath.endswith('.xz') or filepath.endswith('.txz'):
            subprocess.run(['xz', '-d', '-c', filepath],
                         capture_output=True, timeout=30)
        elif filepath.endswith('.7z'):
            if has_tool('7z'):
                subprocess.run(['7z', 'x', '-y', f'-o{output_dir}', filepath],
                             capture_output=True, timeout=30)
        elif filepath.endswith('.rar'):
            if has_tool('unrar'):
                subprocess.run(['unrar', 'x', '-y', filepath, output_dir],
                             capture_output=True, timeout=30)
            elif has_tool('7z'):
                subprocess.run(['7z', 'x', '-y', f'-o{output_dir}', filepath],
                             capture_output=True, timeout=30)
        else:
            return False

        # Check if files were actually extracted
        extracted = os.listdir(output_dir)
        return len(extracted) > 0
    except Exception:
        return False


def is_archive(filepath: str) -> bool:
    """Check if a file is likely an archive."""
    ext = os.path.splitext(filepath.lower())[1]
    if ext in ARCHIVE_EXTENSIONS:
        return True
    # Check magic bytes for compressed formats
    try:
        with open(filepath, 'rb') as f:
            header = f.read(4)
        if header[:2] == b'\x1f\x8b':  # gzip
            return True
        if header[:3] == b'BZh':  # bzip2
            return True
        if header[:2] == b'PK':  # zip
            return True
        if header[:4] == b'\xfd7zX':  # xz
            return True
    except Exception:
        pass
    return False


def recursive_extract(filepath: str, base_dir: str, depth: int = 0, max_depth: int = 10) -> List[str]:
    """Recursively extract nested archives. Returns list of flag results."""
    if depth >= max_depth:
        return []

    flags_found = []
    indent = '  ' * depth

    # Scan current file/directory for flags
    if os.path.isdir(filepath):
        for root, dirs, files in os.walk(filepath):
            for fname in files:
                fpath = os.path.join(root, fname)
                try:
                    with open(fpath, 'r', encoding='utf-8', errors='replace') as f:
                        content = f.read()
                    found = FLAG_PATTERN.findall(content)
                    for flag in found:
                        flags_found.append(f'{indent}{fname}: {flag}')
                        print(f'{indent}📌 Found in {fname}: {flag}')
                except Exception:
                    # Binary file — try strings
                    try:
                        sresult = subprocess.run(
                            ['strings', '-n', '6', fpath],
                            capture_output=True, text=True, timeout=5,
                        )
                        found = FLAG_PATTERN.findall(sresult.stdout)
                        for flag in found:
                            flags_found.append(f'{indent}{fname}: {flag}')
                            print(f'{indent}📌 Found in {fname} (strings): {flag}')
                    except Exception:
                        pass

                # Check if this file is itself an archive
                if is_archive(fpath):
                    extract_dir = os.path.join(base_dir, f'layer{depth}_{fname}')
                    os.makedirs(extract_dir, exist_ok=True)
                    print(f'{indent}📦 Extracting nested: {fname} → layer{depth}_{fname}/')
                    if extract_archive(fpath, extract_dir):
                        nested_flags = recursive_extract(extract_dir, base_dir, depth + 1, max_depth)
                        flags_found.extend(nested_flags)
    else:
        # Single file
        try:
            with open(filepath, 'r', encoding='utf-8', errors='replace') as f:
                content = f.read()
            found = FLAG_PATTERN.findall(content)
            for flag in found:
                flags_found.append(f'{indent}{os.path.basename(filepath)}: {flag}')
                print(f'{indent}📌 Found: {flag}')
        except Exception:
            pass

    if flags_found:
        return flags_found

    # If directory doesn't have more archives, we're done at this level
    return flags_found


def main():
    parser = argparse.ArgumentParser(description='Archive Recursive Extractor')
    parser.add_argument('--file', '-f', required=True, help='Archive file to recursively extract')
    parser.add_argument('--max-depth', type=int, default=10, help='Maximum recursion depth')
    args = parser.parse_args()

    if not os.path.exists(args.file):
        print(f"File not found: {args.file}", file=sys.stderr)
        sys.exit(1)

    # Scan for flags at top level
    print(f'📄 Analyzing: {args.file}\n')
    flags_found = recursive_extract(args.file, tempfile.mkdtemp(prefix='archive_rec_'), 0, args.max_depth)

    if not flags_found:
        # If no flags found yet, extract the base archive
        if is_archive(args.file):
            tmpdir = tempfile.mkdtemp(prefix='archive_rec_')
            print(f'📦 Extracting base archive: {os.path.basename(args.file)}\n')
            if extract_archive(args.file, tmpdir):
                flags_found = recursive_extract(tmpdir, tmpdir, 1, args.max_depth)
            # Cleanup
            try:
                shutil.rmtree(tmpdir)
            except Exception:
                pass

    if not flags_found:
        print('\n❌ No flags found in any layer.')


if __name__ == '__main__':
    main()
