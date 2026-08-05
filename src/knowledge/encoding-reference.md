# 编码识别速查 (Encoding Reference)

> CTF 常见编码识别、特征分析与转换速查手册

---

## 一、Base 家族编码

### 1.1 各 Base 编码特征总览

| 编码 | 字符集 | 特征 | 示例 |
|------|--------|------|------|
| **Base16** (Hex) | `0-9 A-F` | 大写/小写，长度为偶数 | `48656C6C6F` |
| **Base32** | `A-Z 2-7` | 大写，`=` padding | `JBSWY3DP` |
| **Base36** | `0-9 A-Z` | 数字+大写字母，无 padding | `3LWUHP` |
| **Base45** | `0-9 A-Z $%*+-./:` | 特殊字符 | `QED8WEX0` |
| **Base58** | 无 `0OIl` | 比特币地址风格 | `2gPihUTjt3` |
| **Base62** | `0-9 a-z A-Z` | 无特殊字符，无 padding | `1Z8gHQ` |
| **Base64** | `A-Z a-z 0-9 +/` | `=` padding，常见 | `SGVsbG8=` |
| **Base64 URL** | `A-Z a-z 0-9 -_` | 无 `+/`，用 `-_` 替代 | `SGVsbG8` |
| **Base85** | ASCII 33-117 | 无引号，`~>` 结尾 | `BOu!rD]j7BEbo7` |
| **Base91** | ASCII 33-126 | 高效，无 padding | `>OwJh>}` |
| **Base92** | 不含 `\` `'` | 比 Base91 多一个字符 | `F#_8H` |

### 1.2 Base64

```python
import base64

# 编码/解码
base64.b64encode(b"Hello")          # b'SGVsbG8='
base64.b64decode(b'SGVsbG8=')       # b'Hello'

# URL-safe Base64
base64.urlsafe_b64encode(b"Hello")   # b'SGVsbG8='
base64.urlsafe_b64decode(b'SGVsbG8=')

# 自定义字符表 Base64
import string
custom_b64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
# 如果被替换，先还原
def custom_b64_decode(data, custom_table):
    std_table = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
    trans = str.maketrans(custom_table, std_table)
    return base64.b64decode(data.translate(trans))
```

```bash
# 命令行
echo -n "SGVsbG8=" | base64 -d
echo -n "Hello" | base64
```

**Base64 识别技巧**：
- 长度通常是 4 的倍数
- 末尾有 `=` 或 `==` padding
- 字符集：`A-Za-z0-9+/=`
- 若末尾无 `=` 但长度是 4 的倍数，可能是 URL-safe Base64

### 1.3 Base32

```python
import base64

base64.b32encode(b"Hello")           # b'JBSWY3DP'
base64.b32decode(b'JBSWY3DP')        # b'Hello'

# Base32 变体 (RFC 4648 使用 = padding)
# 有些实现无 padding
# Crockford Base32: 使用 *~$=U 作为校验
```

**Base32 识别**：
- 只包含 `A-Z` 和 `2-7`
- 长度通常是 8 的倍数
- 可能有 `=` padding (最多 6 个 `=`)

### 1.4 Base58

```python
# 比特币地址使用 Base58Check
# 字符集：123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz
# 去掉 0, O, I, l

import base58

base58.b58encode(b"Hello")           # b'2gPihUTjt3'
base58.b58decode(b'2gPihUTjt3')      # b'Hello'

# Base58Check (带校验和)
base58.b58encode_check(b"Hello")
base58.b58decode_check(b"3umnGZ5iiHa")
```

### 1.5 Base85 / Ascii85

```python
import base64

# Ascii85 (Adobe 版本，用 ~> 结尾)
base64.a85encode(b"Hello")           # b'BOu!rD]'
base64.a85decode(b'BOu!rD]')

# Base85 (RFC 1924, 用 ~> 结尾)
base64.b85encode(b"Hello")           # b'BOu!rD]j7BEbo7'
base64.b85decode(b'BOu!rD]j7BEbo7')
```

### 1.6 Base91 / Base92

```python
# Base91: 使用 ASCII 33-126，高密度编码
# pip install base91
import base91
base91.encode(b"Hello")              # b'>OwJh>['  
base91.decode(b'>OwJh>[')

# Base92: 比 Base91 多一个字符，不使用 \ 和 '
# pip install base92
import base92
base92.encode(b"Hello")
base92.decode(b'F#_8H')
```

### 1.7 Base45

```python
# QRCodes 中使用的 Base45
# 字符集：0-9 A-Z $%*+-./:
# 每 2 字节 → 3 个 Base45 字符
```

### 1.8 Base36 / Base62

```python
# Base36: 0-9A-Z
def base36_encode(n):
    chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    if n == 0: return "0"
    result = ""
    while n > 0:
        result = chars[n % 36] + result
        n //= 36
    return result

# Base62: 0-9a-zA-Z
# 常用于 URL 缩短
def base62_encode(n):
    chars = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
    if n == 0: return "0"
    result = ""
    while n > 0:
        result = chars[n % 62] + result
        n //= 62
    return result
```

---

## 二、进制转换

### 2.1 二进制 (Binary)

```python
# 字符串 → 二进制
bin_str = ' '.join(format(ord(c), '08b') for c in "Hello")
# '01001000 01100101 01101100 01101100 01101111'

# 二进制 → 字符串
binary = "01001000 01100101 01101100 01101100 01101111"
''.join(chr(int(b, 2)) for b in binary.split())

# 8-bit 二进制直接解码
def bin_to_str(binary_str):
    binary_str = binary_str.replace(' ', '')
    return bytes(int(binary_str[i:i+8], 2) for i in range(0, len(binary_str), 8))
```

### 2.2 八进制 (Octal)

```python
# 字符串 → 八进制
oct_str = ' '.join(format(ord(c), '03o') for c in "Hello")
# '110 145 154 154 157'

# 八进制 → 字符串
octal = "110 145 154 154 157"
''.join(chr(int(o, 8)) for o in octal.split())
```

### 2.3 十进制

```python
# 字符串 → 十进制
dec_str = ' '.join(str(ord(c)) for c in "Hello")
# '72 101 108 108 111'

# 十进制 → 字符串
decimal = "72 101 108 108 111"
''.join(chr(int(d)) for d in decimal.split())
```

### 2.4 十六进制 (Hexadecimal)

```python
# 字符串 → 十六进制
hex_str = "Hello".encode().hex()          # '48656c6c6f'
hex_str = ' '.join(f"{ord(c):02x}" for c in "Hello")

# 十六进制 → 字符串
bytes.fromhex("48656c6c6f").decode()      # 'Hello'

# 带分隔符的十六进制
hex_str = "48:65:6c:6c:6f"
bytes.fromhex(hex_str.replace(':', '')).decode()
```

```bash
# 命令行
echo -n "Hello" | xxd -p              # 48656c6c6f
echo -n "48656c6c6f" | xxd -r -p      # Hello
printf "Hello" | od -A n -t x1        # 48 65 6c 6c 6f
```

### 2.5 进制识别技巧

| 进制 | 特征 | 示例 |
|------|------|------|
| 二进制 | 只有 0/1 | `01001000` |
| 八进制 | 0-7，常以 0 开头 | `0110 0145` |
| 十进制 | 0-9 | `72 101 108` |
| 十六进制 | 0-9 A-F，常成对出现 | `48 65 6C` |

### 2.6 大整数转换

```python
# 大整数 ↔ 字符串
from Crypto.Util.number import long_to_bytes, bytes_to_long

n = 0x48656c6c6f
long_to_bytes(n)                       # b'Hello'
bytes_to_long(b"Hello")                # 0x48656c6c6f

# Python 内置
n = int.from_bytes(b"Hello", 'big')    # 大整数
n.to_bytes((n.bit_length() + 7) // 8, 'big')  # 字符串
```

---

## 三、常见编码

### 3.1 URL 编码 (Percent-Encoding)

```python
from urllib.parse import quote, unquote

quote("Hello World")                   # 'Hello%20World'
unquote("Hello%20World")               # 'Hello World'

# 全部编码
quote("Hello World", safe='')          # '%48%65%6c%6c%6f%20%57%6f%72%6c%64'
```

**特征**：`%` 后跟两个十六进制字符。`%20` = 空格，`%00` = NULL。

**双重 URL 编码**：`%2520` → 解码一次 → `%20` → 再解码 → 空格

### 3.2 HTML 实体编码

```python
import html

html.escape("<script>")                # '&lt;script&gt;'
html.unescape("&lt;script&gt;")        # '<script>'

# 常见实体
# &lt;   → <
# &gt;   → >
# &amp;  → &
# &quot; → "
# &#39;  → '
# &#x27; → '
```

**特征**：
- 命名实体：`&name;`
- 十进制实体：`&#65;` → `A`
- 十六进制实体：`&#x41;` → `A`

### 3.3 Unicode 转义

```python
# Unicode 转义序列
# \uXXXX (BMP), \UXXXXXXXX (全范围)

# Python
"\u0048\u0065\u006c\u006c\u006f"     # 'Hello'
"\U00000048"                          # 'H'

# 解码
text = "\\u0048\\u0065\\u006c\\u006c\\u006f"
text.encode().decode('unicode_escape') # 'Hello'
```

**特征**：`\u` 后跟 4 个十六进制字符，或 `\U` 后跟 8 个十六进制字符。

### 3.4 Quoted-Printable

```python
import quopri

quopri.encodestring(b"Hello=World")    # b'Hello=3DWorld'
quopri.decodestring(b'Hello=3DWorld')  # b'Hello=World'

# 特征：= 后跟两个十六进制字符
# =3D → =, =20 → 空格, =0A → 换行
```

### 3.5 Punycode

```python
# 国际化域名编码
# "münchen".encode('punycode') → b'mnchen-kva'
# 特征：以 xn-- 开头的域名
```

### 3.6 Morse 电码

```python
MORSE_CODE = {
    'A': '.-', 'B': '-...', 'C': '-.-.', 'D': '-..', 'E': '.',
    'F': '..-.', 'G': '--.', 'H': '....', 'I': '..', 'J': '.---',
    'K': '-.-', 'L': '.-..', 'M': '--', 'N': '-.', 'O': '---',
    'P': '.--.', 'Q': '--.-', 'R': '.-.', 'S': '...', 'T': '-',
    'U': '..-', 'V': '...-', 'W': '.--', 'X': '-..-', 'Y': '-.--',
    'Z': '--..',
    '0': '-----', '1': '.----', '2': '..---', '3': '...--', '4': '....-',
    '5': '.....', '6': '-....', '7': '--...', '8': '---..', '9': '----.',
}

def morse_decode(morse_str):
    reverse = {v: k for k, v in MORSE_CODE.items()}
    return ''.join(reverse.get(c, '?') for c in morse_str.split())
```

**特征**：`.` 和 `-` 的组合，分隔符为空格或 `/`。

### 3.7 Hex 编码 (双重编码)

```python
# 有时 Base64 结果被再次 Hex 编码
# 或 Hex 被 Base64 编码
# 需要递归解码

def recursive_decode(data):
    """尝试递归解码直到不可解码"""
    while True:
        # 尝试 Base64
        try:
            decoded = base64.b64decode(data)
            if all(32 <= b < 127 or b in (10, 13) for b in decoded):
                data = decoded
                continue
        except:
            pass
        # 尝试 Hex
        try:
            decoded = bytes.fromhex(data.decode())
            if all(32 <= b < 127 or b in (10, 13) for b in decoded):
                data = decoded
                continue
        except:
            pass
        break
    return data
```

---

## 四、特征识别

### 4.1 字符串长度特征

| 编码 | 原始 N 字节 | 编码后长度 | 膨胀率 |
|------|------------|------------|--------|
| Hex | N | 2N | 200% |
| Base64 | N | ~4N/3 | 133% |
| Base32 | N | ~8N/5 | 160% |
| Base85 | N | ~5N/4 | 125% |
| Base91 | N | ~N | ~100% |
| Binary | N | 8N | 800% |

### 4.2 字符集快速识别

```python
import re

def identify_encoding(data_str):
    """快速识别编码类型"""
    if re.match(r'^[01\s]+$', data_str):
        return 'binary'
    if re.match(r'^[0-9A-Fa-f\s]+$', data_str):
        return 'hex'
    if re.match(r'^[A-Z2-7=]+$', data_str):
        return 'base32'
    if re.match(r'^[A-Za-z0-9+/=]+$', data_str) and len(data_str) % 4 == 0:
        return 'base64'
    if re.match(r'^[A-Za-z0-9\-_]+$', data_str) and len(data_str) % 4 == 0:
        return 'base64_urlsafe'
    if re.match(r'^[1-9A-HJ-NP-Za-km-z]+$', data_str):
        return 'base58'
    if re.match(r'^[0-9A-Z$%*+\-./:]+$', data_str):
        return 'base45'
    if re.match(r'^[.\-/\s]+$', data_str):
        return 'morse'
    if re.match(r'^%[0-9A-Fa-f]{2}', data_str):
        return 'url_encoded'
    if re.match(r'^&#x?[0-9a-fA-F]+;', data_str):
        return 'html_entity'
    if re.match(r'^\\u[0-9a-fA-F]{4}', data_str):
        return 'unicode_escape'
    return 'unknown'
```

### 4.3 Padding 特征

| 编码 | Padding 字符 | Padding 模式 |
|------|-------------|-------------|
| Base64 | `=` | 1 或 2 个 `=` |
| Base32 | `=` | 1-6 个 `=` |
| Base16 | 无 | 无 |
| Base58 | 无 | 无 |
| Base85 | `~>` | 以 `~>` 结尾 |
| Base91 | 无 | 无 |
| Base45 | 无 | 无 |

### 4.4 使用 CyberChef "Magic"

在 CyberChef (https://gchq.github.io/CyberChef/) 中使用 **Magic** 操作可自动检测编码：

```
输入密文 → 添加 "Magic" 操作 → 设置 Intensive mode → 查看结果
```

---

## 五、工具命令速查

### 5.1 CyberChef 常用配方

| 配方 | 用途 |
|------|------|
| Magic | 自动检测 |
| From Base64 | Base64 解码 |
| From Base32 | Base32 解码 |
| From Hex | Hex 解码 |
| From Binary | 二进制解码 |
| From Morse Code | 摩斯电码解码 |
| URL Decode | URL 解码 |
| HTML Entity | HTML 实体解码 |
| XOR Brute Force | XOR 爆破 |
| Text Encoding Brute Force | 综合编码爆破 |

### 5.2 命令行工具

```bash
# 自动检测编码
# detect-it-easy (DIE)

# base64 编解码
echo "SGVsbG8=" | base64 -d
echo -n "Hello" | base64

# xxd hex 编解码
echo -n "Hello" | xxd -p
echo "48656c6c6f" | xxd -r -p

# 进制转换
printf "%d" 0xFF                       # 255 (hex→dec)
printf "%x" 255                        # ff (dec→hex)
printf "%o" 255                        # 377 (dec→oct)

# Python 一行
python -c "print(bytes.fromhex('48656c6c6f'))"
python -c "import base64; print(base64.b64decode('SGVsbG8='))"
```

### 5.3 在线工具

| 工具 | URL | 用途 |
|------|-----|------|
| CyberChef | gchq.github.io/CyberChef | 万能编解码 |
| dCode | dcode.fr | 密码/编码识别 |
| DenCode | dencode.com | 编码检测 |
| Boxentriq | boxentriq.com | 密码分析 |
| Base64 Guru | base64.guru | Base64 工具 |
| RapidTables | rapidtables.com | 进制转换 |

---

## 六、编码特征对比表

### 常见密文特征速查

```
纯数字(0-9), 3位一组, 空格分隔  → 十进制 ASCII
纯 0/1, 8位一组, 空格分隔        → 二进制 ASCII
0-9 A-F, 成对出现                → 十六进制
A-Z 2-7, 大写, = padding         → Base32
A-Z a-z 0-9 + /, = padding       → Base64
A-Z a-z 0-9 - _, 无 padding      → Base64 URL-safe
1-9 A-Z a-z (除0OIl), 无 padding → Base58
0-9 A-Z 大写, 无 padding         → Base36
ASCII 33-117, ~> 结尾            → Base85
%XX 模式                         → URL 编码
&#XX; 或 &name;                  → HTML 实体
\uXXXX 或 \UXXXXXXXX             → Unicode 转义
.-/ 组合                         → 摩斯电码
=XX 模式                         → Quoted-Printable
```