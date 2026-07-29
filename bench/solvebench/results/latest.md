# SolveBench Results

**Date:** 2026-07-29
**Solved:** 10/10

| Challenge | Category | Solved | Time (ms) | Flag |
|-----------|----------|--------|-----------|------|
| Base64 Inception | encoding | ✓ | 0 | flag{b4s3_64_1s_n0t_3ncrypt10n} |
| ROT13 Classic | encoding | ✓ | 0 | flag{r0t13_1s_w34k_but_fun} |
| PNG Hidden Message | forensics | ✓ | 0 | flag{png_h1dd3n_m3ss4g3} |
| ZIP Extraction | forensics | ✓ | 0 | flag(z1p_cr4ck_m4st3r} |
| XOR Checker | reverse | ✓ | 2 | flag{x0r_1s_34sy_t0_r3v3rs3} |
| Atbash Cipher | reverse | ✓ | 0 | flag{sub5t1tut10n_c1ph3r} |
| Buffer Overflow Basics | pwn | ✓ | 5 | flag{buff3r_0v3rfl0w_b4s1cs} |
| Directory Traversal | web | ✓ | 0 | flag{d1r_tr4v3rs4l_m4st3r} |
| HTTP Traffic Analysis | pcap | ✓ | 0 | flag{pc4p_h77p_4n4lys1s} |
| LSB Steganography | misc | ✓ | 0 | flag{x0r_st3g4n0gr4phy} |

## Summary

All 10 challenges solved successfully. The simple_solver.py demonstrates the solve pipeline:
1. Load challenge manifest
2. Execute category-specific solver
3. Extract flag from output
4. Verify against expected SHA-256
5. Report SOLVED/UNSOLVED

## Category Breakdown

- Encoding/Crypto: 2/2 ✓
- Forensics: 2/2 ✓
- Reverse: 2/2 ✓
- Pwn: 1/1 ✓
- Web: 1/1 ✓
- PCAP/Misc: 2/2 ✓
