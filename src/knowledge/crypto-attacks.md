# 密码学攻击速查 (Crypto Attacks)

> CTF 密码学常见攻击技术、命令与 Payload 速查手册

---

## 一、RSA 攻击

### 1.1 小 e 攻击 (Low Public Exponent)

当 e 很小（如 e=3）且明文 m 也较小时，c ≡ mᵉ mod n，若 mᵉ < n 则直接开方。

```python
from gmpy2 import iroot
from Crypto.Util.number import long_to_bytes

c = 278032143692122784526610606342614718923755350391
e = 3
m, exact = iroot(c, e)
if exact:
    print(long_to_bytes(m))
```

**小 e + 明文线性相关 (Coppersmith)**：

```python
# sage
n = 0x...
c = 0x...
e = 3
PR.<x> = PolynomialRing(Zmod(n))
# 已知明文前缀 flag_prefix = b"flag{"
# m = flag_prefix + x
prefix_int = bytes_to_long(b"flag{")
# 构建多项式 f(x) = (prefix_int * 256^k + x)^e - c
# 使用 small_roots
```

### 1.2 Wiener 攻击 (小私钥 d)

当 d < n^(1/4)/3 时，可通过连分数恢复 d。

```python
# 使用 owiener 库
# pip install owiener
import owiener

e = 0x...
n = 0x...
c = 0x...

d = owiener.attack(e, n)
if d:
    m = pow(c, d, n)
    print(long_to_bytes(m))
```

**手动连分数实现**：

```python
from Crypto.Util.number import long_to_bytes

def continued_fraction(num, den):
    cf = []
    while den:
        q = num // den
        cf.append(q)
        num, den = den, num - q * den
    return cf

def convergents(cf):
    convs = []
    p0, q0 = 0, 1
    p1, q1 = 1, 0
    for a in cf:
        p = a * p1 + p0
        q = a * q1 + q0
        convs.append((p, q))
        p0, q0 = p1, q1
        p1, q1 = p, q
    return convs

def wiener_attack(e, n):
    cf = continued_fraction(e, n)
    for k, d in convergents(cf):
        if k == 0:
            continue
        if (e * d - 1) % k != 0:
            continue
        phi = (e * d - 1) // k
        # 验证 phi 是否正确
        b = n - phi + 1
        delta = b * b - 4 * n
        if delta >= 0:
            sqrt_delta = int(delta ** 0.5)
            if sqrt_delta * sqrt_delta == delta:
                p = (b + sqrt_delta) // 2
                q = (b - sqrt_delta) // 2
                if p * q == n:
                    return d
    return None
```

### 1.3 共模攻击 (Common Modulus)

相同明文 m 用不同 e 加密但相同 n：

```python
from gmpy2 import gcdext

def common_modulus_attack(c1, c2, e1, e2, n):
    g, s1, s2 = gcdext(e1, e2)  # g = 1 if gcd(e1,e2)=1
    if s1 < 0:
        c1 = pow(int(gmpy2.invert(c1, n)), -s1, n)
    else:
        c1 = pow(c1, s1, n)
    if s2 < 0:
        c2 = pow(int(gmpy2.invert(c2, n)), -s2, n)
    else:
        c2 = pow(c2, s2, n)
    m = (c1 * c2) % n
    return long_to_bytes(m)
```

### 1.4 Franklin-Reiter 相关消息攻击

两个明文 m1, m2 满足线性关系 m2 = a\*m1 + b，用相同公钥加密：

```python
# sage
def franklin_reiter(n, e, c1, c2, a, b):
    # m2 = a * m1 + b
    P.<x> = PolynomialRing(Zmod(n))
    f1 = x^e - c1
    f2 = (a*x + b)^e - c2
    # 求 gcd
    g = f1.gcd(f2)
    m = -g.coefficients()[0]
    if g.coefficients()[0] == 0:
        m = g.roots()[0][0]
    return long_to_bytes(int(m))
```

### 1.5 Hastad 广播攻击

相同的 e 个不同 n 加密同一明文：

```python
from sympy.ntheory.modular import crt
from gmpy2 import iroot

def hastad_broadcast_attack(ciphertexts, moduli, e):
    # CRT 合并
    M = crt(moduli, ciphertexts)
    if M is None:
        return None
    m, exact = iroot(M, e)
    if exact:
        return long_to_bytes(int(m))
    return None
```

### 1.6 Boneh-Durfee 攻击 (d < n^0.292)

```python
# 使用 defund/coppersmith 库
# https://github.com/defund/coppersmith
# sage coppersmith.sage 实现
```

### 1.7 多素数 RSA

```python
# 当 n = p * q * r 等多素数时
phi = (p-1) * (q-1) * (r-1)  # 所有因子减一的乘积
d = pow(e, -1, phi)
m = pow(c, d, n)
```

### 1.8 已知 p 高位 / q 高位

```python
# sage - Coppersmith 方法恢复低位
n = 0x...
p_high = 0x...  # 已知 p 的高位
kbits = 64      # 缺失的低位 bit 数

PR.<x> = PolynomialRing(Zmod(n))
p_high = p_high << kbits
f = p_high + x
roots = f.small_roots(X=2^kbits, beta=0.4)
if roots:
    p = p_high + int(roots[0])
    q = n // p
    assert p * q == n
```

---

## 二、对称密码

### 2.1 AES ECB 模式攻击

**检测 ECB 模式**：重复块检测

```python
def detect_ecb(ciphertext, block_size=16):
    blocks = [ciphertext[i:i+block_size] for i in range(0, len(ciphertext), block_size)]
    return len(blocks) != len(set(blocks))
```

**Byte-at-a-time ECB 解密**：

```python
# 逐字节恢复明文
def recover_byte(oracle, known, block_size=16):
    block_num = len(known) // block_size
    padding = b'A' * (block_size - 1 - (len(known) % block_size))
    target = oracle(padding)[block_num*block_size:(block_num+1)*block_size]

    for byte in range(256):
        candidate = padding + known + bytes([byte])
        result = oracle(candidate)[block_num*block_size:(block_num+1)*block_size]
        if result == target:
            return bytes([byte])
    return None
```

### 2.2 AES CBC Padding Oracle

```python
# 利用 padding oracle 逐字节解密
def padding_oracle_attack(ct, iv, oracle, block_size=16):
    blocks = [ct[i:i+block_size] for i in range(0, len(ct), block_size)]
    plaintext = b''

    for block_idx in range(len(blocks)):
        decrypted = bytearray(block_size)
        for pad_byte in range(1, block_size + 1):
            for guess in range(256):
                modified_prev = bytearray(block_size)
                # 设置已知的 padding 值
                for i in range(1, pad_byte):
                    modified_prev[-i] = decrypted[-i] ^ pad_byte
                modified_prev[-pad_byte] = guess

                prev_block = iv if block_idx == 0 else blocks[block_idx - 1]
                test_ct = bytes(modified_prev) + blocks[block_idx]
                if oracle(bytes(modified_prev) + blocks[block_idx]):
                    decrypted[-pad_byte] = guess ^ pad_byte
                    break
        # XOR with previous block to get plaintext
        prev = iv if block_idx == 0 else blocks[block_idx - 1]
        plaintext += bytes([d ^ p for d, p in zip(decrypted, prev)])

    return pkcs7_unpad(plaintext)
```

### 2.3 CBC 比特翻转攻击

```python
# 修改 IV 或前一密文块来翻转对应明文位
# 若想将 "admin=0" 改为 "admin=1"
# 修改位置: 前一块对应字节 ^ ord('0') ^ ord('1')
flip_mask = ord('0') ^ ord('1')
modified_prev = bytearray(prev_block)
modified_prev[target_offset] ^= flip_mask
```

### 2.4 XOR 已知明文攻击

```python
# 两个密文用相同密钥流加密
# c1 = p1 ^ key, c2 = p2 ^ key
# c1 ^ c2 = p1 ^ p2
# 如果知道 p1 的部分内容，可恢复 p2

def crib_drag(c1, c2, crib):
    """crib dragging attack"""
    xor = bytes(a ^ b for a, b in zip(c1, c2))
    for i in range(len(xor) - len(crib) + 1):
        result = bytes(xor[i+j] ^ crib[j] for j in range(len(crib)))
        if all(32 <= b < 127 for b in result):
            print(f"Offset {i}: {result.decode('ascii', errors='replace')}")
```

### 2.5 流密码密钥复用

```python
# Many-Time Pad (MTP) 攻击
def mtp_attack(ciphertexts):
    # 1. 截断到最短长度
    min_len = min(len(c) for c in ciphertexts)
    truncated = [c[:min_len] for c in ciphertexts]

    # 2. 计算 XOR 矩阵
    # 3. 使用空格特征：空格(0x20) XOR 字母 = 大写/小写切换
    #    c1[i] ^ c2[i] 若为字母，说明其中一个是空格
    key = bytearray(min_len)
    for i in range(min_len):
        space_count = [0] * len(truncated)
        for j in range(len(truncated)):
            for k in range(j+1, len(truncated)):
                if truncated[j][i] ^ truncated[k][i] >= 0x40:
                    space_count[j] += 1
                    space_count[k] += 1
        # 空格最多的位置可能是空格
        likely_space = space_count.index(max(space_count))
        key[i] = truncated[likely_space][i] ^ 0x20
    return key
```

---

## 三、古典密码

### 3.1 凯撒密码 (Caesar)

```python
# 识别：字母偏移固定量
def caesar_bruteforce(ciphertext):
    for shift in range(26):
        plain = ''.join(
            chr((ord(c) - ord('A') - shift) % 26 + ord('A')) if c.isupper()
            else chr((ord(c) - ord('a') - shift) % 26 + ord('a')) if c.islower()
            else c
            for c in ciphertext
        )
        print(f"Shift {shift}: {plain}")
```

**特征**：ROT13/ROT47 常见变体，字母频率分析可破

### 3.2 维吉尼亚密码 (Vigenère)

```python
# 识别：多表替换，Kasiski 测试或重合指数 (IC) 确定密钥长度
# 工具：https://www.dcode.fr/vigenere-cipher

def index_of_coincidence(text):
    """计算重合指数，英文约 0.065，随机约 0.038"""
    text = ''.join(c for c in text.upper() if c.isalpha())
    n = len(text)
    freq = {}
    for c in text:
        freq[c] = freq.get(c, 0) + 1
    ic = sum(f * (f - 1) for f in freq.values()) / (n * (n - 1))
    return ic

def kasiski_examination(ciphertext, min_len=3):
    """寻找重复子串间距，推测密钥长度"""
    # 找到重复的 trigram，计算间距的 GCD
    return suggested_key_length
```

**在线工具**：dcode.fr, quipqiup.com, boxentriq.com

### 3.3 Playfair 密码

```python
# 识别：5x5 矩阵，字母对替换，无 J（J 合并到 I）
# 特征：密文长度为偶数，字母对中不会出现相同字母的替换
# 解密工具：https://www.dcode.fr/playfair-cipher
```

### 3.4 Hill 密码

```python
# 识别：基于矩阵乘法的多表替换
# 攻击：已知明文攻击，解矩阵方程

# sage
# 已知明文-密文对，恢复密钥矩阵
# P * K = C  =>  K = P^(-1) * C
```

### 3.5 Enigma

```python
# 识别工具：CrypTool 2, Enigma simulator
# 在线解密：https://cryptii.com/pipes/enigma-machine
# 特征：转子替换，每日密钥设置
```

### 3.6 仿射密码 (Affine)

```python
# c = (a * m + b) mod 26
# 解密：m = a^(-1) * (c - b) mod 26
# a 必须与 26 互质
```

### 3.7 培根密码 (Baconian)

```python
# 识别：5-bit 编码，通常表现为 A/B 或大小写模式
# 解密：每 5 个字符一组映射到字母表
```

---

## 四、哈希攻击

### 4.1 长度扩展攻击 (Length Extension)

```python
# 适用：MD5, SHA-1, SHA-256, SHA-512（Merkle-Damgård 结构）
# 工具：hashpumpy, hash_extender

# pip install hashpumpy
import hashpumpy

# 已知 hash(secret + message)，在不知道 secret 的情况下
# 构造 hash(secret + message + padding + append)
original_hash = "e6b46f3a..."
original_message = b"user=guest"
append_data = b"&admin=1"
key_length_guess = 16  # 猜测的密钥长度

for key_len in range(1, 33):
    new_hash, new_message = hashpumpy.hashpump(
        original_hash, original_message, append_data, key_len
    )
    print(f"Key len {key_len}: {new_hash}, {new_message}")
```

**命令行工具**：

```bash
# hash_extender
hash_extender --data "user=guest" --secret 16 --append "&admin=1" \
  --signature "e6b46f3a..." --format sha256
```

### 4.2 彩虹表

```bash
# 在线查询
# crackstation.net
# hashes.com
# hashkiller.io

# john 使用彩虹表
john --format=raw-md5 --wordlist=rockyou.txt hash.txt

# hashcat
hashcat -m 0 -a 0 hash.txt rockyou.txt
hashcat -m 0 -a 3 hash.txt ?l?l?l?l?d?d  # 掩码攻击
```

### 4.3 哈希碰撞

```bash
# MD5 碰撞工具
# fastcoll, hashclash

# MD5 碰撞生成
fastcoll -p prefix -o col1.bin col2.bin
```

---

## 五、椭圆曲线 (ECC)

### 5.1 Pohlig-Hellman 攻击

当曲线阶 n 是光滑数（所有素因子很小）时适用：

```python
# sage
p = 0x...
a = 0x...
b = 0x...
E = EllipticCurve(GF(p), [a, b])
G = E(Gx, Gy)
Q = E(Qx, Qy)

# 计算阶
n = E.order()
print(f"Order: {n}")
print(f"Factorization: {factor(n)}")

# 若 n 光滑，使用离散对数
dlogs = []
factors = []
for prime, exp in factor(n):
    if prime > 2**40:
        print(f"Large factor: {prime}")
        continue
    t = n // (prime ** exp)
    g = t * G
    q = t * Q
    dlog = discrete_log(q, g, operation='+')
    dlogs.append(dlog)
    factors.append(prime ** exp)

# CRT 合并
d = crt(dlogs, factors)
print(f"Private key: {d}")
```

### 5.2 异常曲线 (Anomalous Curve)

当 `#E(Fp) = p` 时，可用 Smart 攻击：

```python
# sage
def SmartAttack(P, Q, p):
    E = P.curve()
    Eqp = EllipticCurve(Qp(p, 2), [ZZ(t) + randint(0,p)*p for t in E.a_invariants()])

    P_Qps = Eqp.lift_x(ZZ(P.xy()[0]), all=True)
    for P_Qp in P_Qps:
        if GF(p)(P_Qp.xy()[1]) == P.xy()[1]:
            break

    Q_Qps = Eqp.lift_x(ZZ(Q.xy()[0]), all=True)
    for Q_Qp in Q_Qps:
        if GF(p)(Q_Qp.xy()[1]) == Q.xy()[1]:
            break

    p_times_P = p * P_Qp
    p_times_Q = p * Q_Qp

    x_P, y_P = p_times_P.xy()
    x_Q, y_Q = p_times_Q.xy()

    return int(GF(p)((x_Q * y_P) / (x_P * y_Q)))

# 检查是否异常曲线
E = EllipticCurve(GF(p), [a, b])
if E.order() == p:
    print("Anomalous curve! Use Smart's attack")
    d = SmartAttack(G, Q, p)
```

### 5.3 MOV 攻击

当嵌入度很小（如 k=2）时，将 ECDLP 转化为有限域上的 DLP：

```python
# sage
# 检查嵌入度
E = EllipticCurve(GF(p), [a, b])
n = E.order()
k = 1
while (p^k - 1) % n != 0:
    k += 1
    if k > 12:
        break
print(f"Embedding degree: {k}")

if k <= 6:
    # MOV 攻击
    F = GF(p^k)
    E_ext = E.base_extend(F)
    G_ext = E_ext(G)
    Q_ext = E_ext(Q)
    # 在有限域上解离散对数
    n = G.order()
    # 使用配对
```

### 5.4 ECDSA nonce 重用

```python
# 相同 nonce k 签名两条消息
# r1 = r2 = r (相同)
# s1 = k^(-1) * (z1 + r*d) mod n
# s2 = k^(-1) * (z2 + r*d) mod n
# k = (z1 - z2) / (s1 - s2) mod n
# d = (s1*k - z1) / r mod n

def recover_private_key(r, s1, s2, z1, z2, n):
    k = ((z1 - z2) * pow(s1 - s2, -1, n)) % n
    d = ((s1 * k - z1) * pow(r, -1, n)) % n
    return d
```

---

## 六、其它常见攻击

### 6.1 费马分解 (Fermat Factorization)

当 p 和 q 接近时：

```python
from gmpy2 import isqrt, is_square

def fermat_factor(n):
    a = isqrt(n) + 1
    while True:
        b2 = a * a - n
        if is_square(b2):
            b = isqrt(b2)
            return a - b, a + b
        a += 1
```

### 6.2 Pollard p-1

```python
from math import gcd

def pollard_p_minus_1(n, B=100000):
    a = 2
    for i in range(2, B + 1):
        a = pow(a, i, n)
        g = gcd(a - 1, n)
        if 1 < g < n:
            return g, n // g
    return None
```

### 6.3 Pollard Rho

```python
# 使用 factordb 或 yafu
# yafu factor(@number)
# factordb.com 在线查询

# Python 实现
from math import gcd

def pollard_rho(n):
    x = 2
    y = 2
    d = 1
    f = lambda x: (x * x + 1) % n
    while d == 1:
        x = f(x)
        y = f(f(y))
        d = gcd(abs(x - y), n)
    return d, n // d
```

### 6.4 LCG (线性同余生成器) 破解

```python
# 已知连续输出，恢复参数
# X_{n+1} = (a * X_n + c) mod m
# 需要 3-6 个连续输出

def recover_lcg_params(outputs, m=None):
    if m is None:
        # 使用差值法恢复 m
        diffs = [outputs[i+1] - outputs[i] for i in range(len(outputs)-1)]
        m = recover_modulus(diffs)

    # 恢复 a
    a = ((outputs[2] - outputs[1]) * pow(outputs[1] - outputs[0], -1, m)) % m

    # 恢复 c
    c = (outputs[1] - a * outputs[0]) % m

    return a, c, m
```

### 6.5 格密码 (Lattice) 基础

```python
# sage - 背包密码 (Knapsack / Merkle-Hellman) LLL 攻击
def knapsack_lll(public_key, ciphertext):
    n = len(public_key)
    M = Matrix(ZZ, n + 1, n + 1)
    for i in range(n):
        M[i, i] = 1
        M[i, n] = public_key[i]
    M[n, n] = -ciphertext
    B = M.LLL()
    for row in B:
        if all(x in (0, 1) for x in row[:n]):
            return row[:n]
    return None
```

---

## 常用工具速查

| 工具              | 用途         | 命令示例                                                              |
| ----------------- | ------------ | --------------------------------------------------------------------- |
| **RsaCtfTool**    | RSA 综合攻击 | `RsaCtfTool --publickey pub.pem --uncipherfile flag.enc`              |
| **yafu**          | 大整数分解   | `yafu "factor(@)" -batchfile num.txt`                                 |
| **sage**          | 数学计算     | `sage -python script.py`                                              |
| **factordb**      | 在线因数分解 | `http://factordb.com/`                                                |
| **CyberChef**     | 编解码       | `https://gchq.github.io/CyberChef/`                                   |
| **hash_extender** | 长度扩展     | `hash_extender -d data -s secret -a append -f sha256 --signature sig` |
| **hashcat**       | 哈希破解     | `hashcat -m 0 -a 3 hash.txt ?a?a?a?a?a?a`                             |
| **john**          | 哈希破解     | `john --wordlist=rockyou.txt hash.txt`                                |
