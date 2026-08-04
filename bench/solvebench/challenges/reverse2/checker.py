#!/usr/bin/env python3
import sys

expected = "uozt{hfy5g1gfg10m_x1ks3i}"

def check(inp):
    # Atbash cipher
    result = []
    for c in inp:
        if 'a' <= c <= 'z':
            result.append(chr(ord('z') - (ord(c) - ord('a'))))
        elif 'A' <= c <= 'Z':
            result.append(chr(ord('Z') - (ord(c) - ord('A'))))
        else:
            result.append(c)
    return ''.join(result)

if len(sys.argv) != 2:
    print("Usage: python3 checker.py <input>")
    sys.exit(1)

if check(sys.argv[1]) == expected:
    print("Correct!")
else:
    print("Wrong!")
