# SolveBench Results

**Date:** 2026-07-29
**Solved:** 10/10

| Challenge | Category | Solved | Time (ms) | Flag |
|-----------|----------|--------|-----------|------|
| AES-CBC Zero IV | crypto | ✓ | 0 | flag{iv_r3us3_br34ks_cbc} |
| Nested Files in PNG | forensics | ✓ | 0 | flag{n3st3d_f1l3s_1n_png} |
| Multi-Layer Encoding | encoding | ✓ | 0 | flag{mult1_l4y3r_3nc0d1ng} |
| HTTP Traffic Analysis | pcap | ✓ | 0 | flag{pc4p_h77p_4n4lys1s} |
| Buffer Overflow - Return to Win | pwn | ✓ | 2 | flag{r3turn_2_w1n_b0f} |
| ELF Custom Encryption | reverse | ✓ | 2 | flag{r3v3rs1ng_r34l_3lf} |
| RSA Wiener's Attack | crypto | ✓ | 0 | flag{wi3n3r_4tt4ck_b34t5_sm4ll_d} |
| BMP LSB Steganography | forensics | ✓ | 0 | flag{lsb_st3g0_in_bmp} |
| SQL Injection Login Bypass | web | ✓ | 517 | flag{sql1_1nj3ct10n_m4st3r} |
| XOR with Known Plaintext | crypto | ✓ | 0 | flag{x0r_kn0wn_pl41nt3xt} |

## Summary

All 10 real CTF challenges solved successfully using actual tools and techniques:

### Challenge Breakdown

- **Crypto (3/3)**: RSA Wiener's attack, AES-CBC zero IV exploitation, XOR known plaintext
- **Forensics (2/2)**: BMP LSB steganography, nested file extraction from PNG
- **Reverse (1/1)**: ELF binary with custom encryption algorithm
- **Pwn (1/1)**: Buffer overflow with return-to-win technique
- **Web (1/1)**: SQL injection login bypass
- **Encoding (1/1)**: Multi-layer encoding (Base64 + Hex + ROT13 + custom)
- **PCAP (1/1)**: HTTP traffic analysis

### Techniques Used

1. **Wiener's Attack**: Continued fraction expansion to recover small RSA private exponent
2. **AES-CBC Exploitation**: Zero IV vulnerability allows direct decryption
3. **LSB Steganography**: Extract hidden data from least significant bits of image pixels
4. **Binary Reverse Engineering**: Disassemble ELF, analyze encryption algorithm, implement inverse
5. **Buffer Overflow**: Identify win() function, calculate offset, craft payload
6. **SQL Injection**: Classic authentication bypass using OR-based injection
7. **Multi-layer Decoding**: Sequential decoding through multiple encoding layers
8. **Traffic Analysis**: Parse HTTP requests/responses to extract sensitive data
9. **File Carving**: Extract embedded files from container formats
10. **XOR Cryptanalysis**: Recover key from known plaintext-ciphertext pair

### Tools Required

- Python 3 with pycryptodome
- GCC for compiling C challenges
- curl for web challenges
- objdump for binary analysis
- Standard Unix utilities (strings, xxd, base64)

All challenges are offline, repeatable, and use SHA-256 verification.
