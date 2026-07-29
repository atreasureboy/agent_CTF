# Common Crypto CTF Techniques

## Classical Ciphers
- Caesar: shift each letter by fixed amount, try all 25 shifts
- ROT13: Caesar with shift 13
- Vigenere: polyalphabetic substitution, use Kasiski examination
- Substitution: frequency analysis (e=most common in English)
- Rail Fence: zigzag pattern, try different rail counts
- Playfair: 5x5 grid, digraph substitution

## Encoding vs Encryption
- Base64: `SGVsbG8=` -> decode with `base64 -d`
- Hex: `48656c6c6f` -> decode with `xxd -r -p`
- URL encoding: `%48%65%6c%6c%6f`
- ASCII: `72 101 108 108 111` -> `chr()` in Python
- Binary: `01001000 01100101` -> convert to bytes
- Octal: `110 145 154 154 157`

## Modern Crypto Attacks
- RSA: small exponent, common modulus, Wiener's attack (small d)
- AES-ECB: detect identical blocks, ECB penguin
- XOR: known plaintext, single-byte brute force
- Hash collisions: MD5/SHA1 collision attacks
- Length extension: MD5/SHA1/SHA256 with known length

## RSA Specific
- Factor n if small: `factor n` or use factordb.com
- Check if e is small (e=3): cube root attack
- Check if d is small: Wiener's continued fraction attack
- Common modulus attack: same message, different e, same n
- Padding oracle: PKCS#1 v1.5, OAEP

## XOR Tricks
- `a ^ a = 0`
- `a ^ 0 = a`
- `a ^ b ^ b = a`
- Single-byte XOR: try all 256 keys, check for readable text
- Multi-byte XOR: use known plaintext or frequency analysis

## Hash Identification
- 32 chars: MD5
- 40 chars: SHA1
- 56 chars: SHA224
- 64 chars: SHA256
- 128 chars: SHA512
- Check hashcat modes or online databases (hashes.com)

## Tools
- CyberChef for encoding/decoding
- RsaCtfTool for RSA attacks
- xor-tool for XOR brute force
- hash-identifier for hash type detection
- John the Ripper / hashcat for cracking
