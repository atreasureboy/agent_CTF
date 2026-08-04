# SolveBench Results

**Date:** 2026-08-04T06:54:17.554212

**Solved:** 10/20

| Challenge | Category | Solved | Time (ms) | Flag |
|-----------|----------|--------|-----------|------|
| AES-ECB Decryption | crypto | ✓ | 71 | flag{iv_r3us3_br34ks... |
| Base64 Inception | encoding | ✗ | 59 | N/A |
| ROT13 Classic | encoding | ✗ | 61 | N/A |
| PNG Hidden Message | forensics | ✗ | 68 | N/A |
| ZIP Extraction | forensics | ✗ | 60 | N/A |
| Nested Files in PNG | forensics | ✓ | 61 | flag{n3st3d_f1l3s_1n... |
| LSB Steganography | misc | ✗ | 75 | N/A |
| Multi-Layer Encoding | encoding | ✓ | 64 | flag{mult1_l4y3r_3nc... |
| HTTP Traffic Analysis | pcap | ✗ | 65 | N/A |
| HTTP Traffic Analysis | pcap | ✓ | 64 | flag{pc4p_h77p_4n4ly... |
| Buffer Overflow Basics | pwn | ✗ | 70 | N/A |
| Buffer Overflow - Return to Win | pwn | ✓ | 81 | flag{r3turn_2_w1n_b0... |
| XOR Checker | reverse | ✗ | 63 | N/A |
| Atbash Cipher | reverse | ✗ | 66 | N/A |
| ELF Custom Encryption | reverse | ✓ | 81 | flag{r3v3rs1ng_r34l_... |
| RSA Wiener's Attack | crypto | ✓ | 62 | flag{wi3n3r_4tt4ck_b... |
| BMP LSB Steganography | forensics | ✓ | 71 | flag{lsb_st3g0_in_bm... |
| Directory Traversal | web | ✗ | 1065 | N/A |
| SQL Injection Login Bypass | web | ✓ | 1584 | flag{sql1_1nj3ct10n_... |
| XOR with Known Plaintext | crypto | ✓ | 68 | flag{x0r_kn0wn_pl41n... |

## Details

### AES-ECB Decryption

- **ID:** aes_zero_iv
- **Category:** crypto
- **Solved:** True
- **Time:** 71ms
- **Flag:** flag{iv_r3us3_br34ks_cbc}

**Output:**
```
Solving: aes_zero_iv
Flag: flag{iv_r3us3_br34ks_cbc}
SHA256: d854ff315016555cc27cfb457fc5a40a4fba449d4e9b5ad7b5fb450019109e1a
Expected: d854ff315016555cc27cfb457fc5a40a4fba449d4e9b5ad7b5fb450019109e1a
Time: 0.4673004150390625ms
✓ SOLVED

```

### Base64 Inception

- **ID:** encoding1
- **Category:** encoding
- **Solved:** False
- **Time:** 59ms

**Output:**
```
Solving: encoding1
No solver for encoding1

```

### ROT13 Classic

- **ID:** encoding2
- **Category:** encoding
- **Solved:** False
- **Time:** 61ms

**Output:**
```
Solving: encoding2
No solver for encoding2

```

### PNG Hidden Message

- **ID:** forensics1
- **Category:** forensics
- **Solved:** False
- **Time:** 68ms

**Output:**
```
Solving: forensics1
No solver for forensics1

```

### ZIP Extraction

- **ID:** forensics2
- **Category:** forensics
- **Solved:** False
- **Time:** 60ms

**Output:**
```
Solving: forensics2
No solver for forensics2

```

### Nested Files in PNG

- **ID:** forensics_nested
- **Category:** forensics
- **Solved:** True
- **Time:** 61ms
- **Flag:** flag{n3st3d_f1l3s_1n_png}

**Output:**
```
Solving: forensics_nested
Flag: flag{n3st3d_f1l3s_1n_png}
SHA256: 00a950cfc160aa57f4c9274ba78414c281bf8450e1fe9c08cf620ae952cbcdaf
Expected: 00a950cfc160aa57f4c9274ba78414c281bf8450e1fe9c08cf620ae952cbcdaf
Time: 0.6098747253417969ms
✓ SOLVED

```

### LSB Steganography

- **ID:** misc1
- **Category:** misc
- **Solved:** False
- **Time:** 75ms

**Output:**
```
Solving: misc1
No solver for misc1

```

### Multi-Layer Encoding

- **ID:** multi_encoding
- **Category:** encoding
- **Solved:** True
- **Time:** 64ms
- **Flag:** flag{mult1_l4y3r_3nc0d1ng}

**Output:**
```
Solving: multi_encoding
Flag: flag{mult1_l4y3r_3nc0d1ng}
SHA256: f45b7e4204e9216019150892693f7fca929eb1fe0ee5197d24d8eab3119d698b
Expected: f45b7e4204e9216019150892693f7fca929eb1fe0ee5197d24d8eab3119d698b
Time: 0.0762939453125ms
✓ SOLVED

```

### HTTP Traffic Analysis

- **ID:** pcap1
- **Category:** pcap
- **Solved:** False
- **Time:** 65ms

**Output:**
```
Solving: pcap1
No solver for pcap1

```

### HTTP Traffic Analysis

- **ID:** pcap_http
- **Category:** pcap
- **Solved:** True
- **Time:** 64ms
- **Flag:** flag{pc4p_h77p_4n4lys1s}

**Output:**
```
Solving: pcap_http
Flag: flag{pc4p_h77p_4n4lys1s}
SHA256: cf829ae1e69d91f99e0b15c685054c85ae0916b7125a68135048b688dcee9ff3
Expected: cf829ae1e69d91f99e0b15c685054c85ae0916b7125a68135048b688dcee9ff3
Time: 0.13756752014160156ms
✓ SOLVED

```

### Buffer Overflow Basics

- **ID:** pwn1
- **Category:** pwn
- **Solved:** False
- **Time:** 70ms

**Output:**
```
Solving: pwn1
No solver for pwn1

```

### Buffer Overflow - Return to Win

- **ID:** pwn_overflow
- **Category:** pwn
- **Solved:** True
- **Time:** 81ms
- **Flag:** flag{r3turn_2_w1n_b0f}

**Output:**
```
Solving: pwn_overflow
Flag: flag{r3turn_2_w1n_b0f}
SHA256: 9d83fe53532113f77fe6f5568bff9cd3f749a3c36b8674a5b19015405a1941f6
Expected: 9d83fe53532113f77fe6f5568bff9cd3f749a3c36b8674a5b19015405a1941f6
Time: 2.669095993041992ms
✓ SOLVED

```

### XOR Checker

- **ID:** reverse1
- **Category:** reverse
- **Solved:** False
- **Time:** 63ms

**Output:**
```
Solving: reverse1
No solver for reverse1

```

### Atbash Cipher

- **ID:** reverse2
- **Category:** reverse
- **Solved:** False
- **Time:** 66ms

**Output:**
```
Solving: reverse2
No solver for reverse2

```

### ELF Custom Encryption

- **ID:** reverse_elf
- **Category:** reverse
- **Solved:** True
- **Time:** 81ms
- **Flag:** flag{r3v3rs1ng_r34l_3lf}

**Output:**
```
Solving: reverse_elf
Flag: flag{r3v3rs1ng_r34l_3lf}
SHA256: 3b98117f2562a200aaa70d1b4a69d11fd3bb96a153afcd29efa67e98df6ef561
Expected: 3b98117f2562a200aaa70d1b4a69d11fd3bb96a153afcd29efa67e98df6ef561
Time: 6.0672760009765625ms
✓ SOLVED

```

### RSA Wiener's Attack

- **ID:** rsa_wiener
- **Category:** crypto
- **Solved:** True
- **Time:** 62ms
- **Flag:** flag{wi3n3r_4tt4ck_b34t5_sm4ll_d}

**Output:**
```
Solving: rsa_wiener
Flag: flag{wi3n3r_4tt4ck_b34t5_sm4ll_d}
SHA256: a6febee199c6d7321c80e7ee24b1691abc0e8d463a2f8b29581e2bc66f50f54e
Expected: a6febee199c6d7321c80e7ee24b1691abc0e8d463a2f8b29581e2bc66f50f54e
Time: 0.5893707275390625ms
✓ SOLVED

```

### BMP LSB Steganography

- **ID:** stego_bmp
- **Category:** forensics
- **Solved:** True
- **Time:** 71ms
- **Flag:** flag{lsb_st3g0_in_bmp}

**Output:**
```
Solving: stego_bmp
Flag: flag{lsb_st3g0_in_bmp}
SHA256: c2c447b6cdb6673f1a7b6a648f7529aed6e2275ae0a0c345c616376fb316b8f0
Expected: c2c447b6cdb6673f1a7b6a648f7529aed6e2275ae0a0c345c616376fb316b8f0
Time: 0.2410411834716797ms
✓ SOLVED

```

### Directory Traversal

- **ID:** web1
- **Category:** web
- **Solved:** False
- **Time:** 1065ms

**Output:**
```
Solving: web1
No solver for web1

```

### SQL Injection Login Bypass

- **ID:** web_sqli
- **Category:** web
- **Solved:** True
- **Time:** 1584ms
- **Flag:** flag{sql1_1nj3ct10n_m4st3r}

**Output:**
```
Solving: web_sqli
Flag: flag{sql1_1nj3ct10n_m4st3r}
SHA256: e0325fe747745b8fc7adf017926c1511c95ec0a79b7997a0be3a52eb26d826bc
Expected: e0325fe747745b8fc7adf017926c1511c95ec0a79b7997a0be3a52eb26d826bc
Time: 515.9447193145752ms
✓ SOLVED

```

### XOR with Known Plaintext

- **ID:** xor_known
- **Category:** crypto
- **Solved:** True
- **Time:** 68ms
- **Flag:** flag{x0r_kn0wn_pl41nt3xt}

**Output:**
```
Solving: xor_known
Flag: flag{x0r_kn0wn_pl41nt3xt}
SHA256: df1404f7305f4a8f3e64af245d73d04f6cb64b406c37821d97f24ce44491b52e
Expected: df1404f7305f4a8f3e64af245d73d04f6cb64b406c37821d97f24ce44491b52e
Time: 0.0934600830078125ms
✓ SOLVED

```

