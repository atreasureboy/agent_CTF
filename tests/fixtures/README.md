# Synthetic CTF fixtures

Each fixture here is a tiny, deterministic byte-string intended only to exercise
the oneshot layer's selector + parser pipeline. They are NOT real CTF
challenges; they exist so the harness can be smoke-tested without standing up
large network or docker services.

| File | Category | What it encodes |
|------|----------|------------------|
| `base64_multi.txt`     | base64 / encoded | A real base64 string that decodes to "Flag is here: flag{base64_round_trip}" |
| `rsa_params.txt`       | crypto / rsa      | Trivial RSA-style text dump `n, e, ciphertext` for the rsa selector to match |
| `xor_input.bin`        | crypto / xor      | Plaintext "flag{this_is_the_plaintext_secret}" — useful to drive xortool / ciphey |
| `tiny.elf`             | binary / elf      | 8-byte ELF magic prefix |
| `tiny.pcap`            | network / pcap    | Standard pcap magic + minimal header |
| `macro.doc`            | office / oletools | OLE header (oletools target) |
| `nested.zip`           | archive / zip     | PK signature (zip magic) |

These fixtures never travel to the LLM context directly — the OneShot
framework only persists stdout/stderr to disk and forwards a short summary.
