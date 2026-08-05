# 隐写术速查 (Steganography)

> CTF 隐写术常见技术与工具速查手册

---

## 一、图片隐写

### 1.1 LSB (最低有效位) 隐写

**检测与提取**：

```bash
# zsteg — 最常用的 PNG/BMP LSB 检测工具
zsteg image.png
zsteg -a image.png                    # 所有检测方法
zsteg -E "b1,r,lsb,xy" image.png     # 提取指定通道
zsteg --all image.png                 # 详尽检测

# stegsolve — 图形化逐位平面分析
java -jar StegSolve.jar

# Python 手动提取 LSB
from PIL import Image

def extract_lsb(image_path, bit_plane=0):
    img = Image.open(image_path)
    pixels = list(img.getdata())
    bits = ''
    for pixel in pixels:
        for channel in pixel[:3]:  # R, G, B
            bits += str((channel >> bit_plane) & 1)
    # 将 bits 转为 bytes
    data = bytes(int(bits[i:i+8], 2) for i in range(0, len(bits), 8))
    return data
```

**LSB 写入**：

```bash
# steghide
steghide embed -cf cover.jpg -ef secret.txt -p password
steghide extract -sf stego.jpg -p password
```

### 1.2 PNG 文件格式分析

**PNG 结构**：

```
| PNG Signature | IHDR | IDAT(s) | IEND |
  89 50 4E 47 0D 0A 1A 0A
```

```bash
# pngcheck — 检查 PNG 完整性
pngcheck -v image.png                 # 详细输出
pngcheck -vt image.png                # 显示所有 chunk

# pngsplit — 分割 PNG chunks
pngsplit image.png

# 手动提取 IDAT 数据
# 使用 Python 逐 chunk 解析
```

**Python 解析 PNG chunks**：

```python
import struct

def parse_png(filename):
    with open(filename, 'rb') as f:
        # 验证 PNG 签名
        signature = f.read(8)
        assert signature == b'\x89PNG\r\n\x1a\n'
        
        chunks = []
        while True:
            length_bytes = f.read(4)
            if len(length_bytes) < 4:
                break
            length = struct.unpack('>I', length_bytes)[0]
            chunk_type = f.read(4)
            chunk_data = f.read(length)
            crc = f.read(4)
            
            chunks.append({
                'type': chunk_type.decode('ascii'),
                'length': length,
                'data': chunk_data,
                'crc': crc
            })
            
            if chunk_type == b'IEND':
                break
    return chunks
```

**隐藏 chunk 检测**：

```bash
# 检查是否有非标准 chunk
pngcheck -v image.png | grep -v "IHDR\|IDAT\|IEND\|pHYs\|iCCP\|sRGB\|gAMA\|cHRM\|tEXt\|tIME\|bKGD\|PLTE\|tRNS"

# tEXt chunk 中可能藏有信息
exiftool image.png | grep -i "comment\|description\|author"
```

### 1.3 JPEG 隐写

**DCT 系数隐写**：

```bash
# jsteg / jphide / outguess
# steghide (默认使用 JPEG)
steghide extract -sf image.jpg

# jstego — 检测 JSteg
jstego image.jpg

# stegdetect — 检测多种 JPEG 隐写
stegdetect *.jpg

# outguess
outguess -r image.jpg output.txt
outguess -k "password" -r image.jpg output.txt
```

**JPEG 结构分析**：

```bash
# JPEGsnoop — JPEG 深度分析
JPEGsnoop.exe image.jpg

# 检查 EXIF 数据
exiftool image.jpg
exiftool -a -u -g1 image.jpg         # 所有元数据

# 检查是否有追加数据
binwalk -Me image.jpg
```

**FF D8 / FF D9 标记**：JPEG 从 FF D8 开始，FF D9 结束。数据可能在 FF D9 之后。

```bash
# 提取 FF D9 之后的数据
xxd image.jpg | grep -A 100 "ffd9"
```

### 1.4 调色板隐写

```python
# GIF 调色板分析
# 调色板中相邻颜色可能编码信息
# 使用 stegsolve 的 Frame Browser 逐帧分析 GIF

# Python: 提取调色板
from PIL import Image
img = Image.open("image.gif")
palette = img.getpalette()
# 检查颜色值的最低有效位
```

### 1.5 多图片分析

```bash
# 对比两张图片的差异
compare image1.png image2.png diff.png
# 或使用 ImageMagick
magick composite -compose difference image1.png image2.png diff.png

# 像素 XOR
# Python PIL 逐像素 XOR

# 盲水印提取
# 使用 BlindWatermark 工具
```

---

## 二、音频隐写

### 2.1 频谱图分析

```bash
# Audacity — 频谱图查看
# 打开音频 → 选择轨道 → 频谱图视图
# 快捷键：轨道名左侧下拉菜单 → Spectrogram

# sox — 生成频谱图
sox audio.wav -n spectrogram -o spectrogram.png
sox audio.wav -n spectrogram -y 1025 -o spec.png  # 高分辨率
```

### 2.2 音频 LSB

```python
# 从 WAV 文件中提取 LSB
import wave

def extract_audio_lsb(wav_file, bit=0):
    wav = wave.open(wav_file, 'rb')
    frames = wav.readframes(wav.getnframes())
    wav.close()
    
    bits = ''
    for i in range(0, len(frames), 2):  # 16-bit samples
        sample = int.from_bytes(frames[i:i+2], 'little', signed=True)
        bits += str((sample >> bit) & 1)
    
    data = bytes(int(bits[i:i+8], 2) for i in range(0, len(bits) - 7, 8))
    return data
```

### 2.3 MP3 隐写

```bash
# MP3Stego
# 编码：encode -E hidden.txt -P pass sound.wav sound.mp3
# 解码：decode -X -P pass sound.mp3

# 检查 ID3 标签
exiftool audio.mp3
```

### 2.4 DTMF 音调

```bash
# DTMF 解码 — 电话按键音
# 使用 dtmf-decoder 或 multimon-ng
multimon-ng -t wav -a DTMF audio.wav
```

### 2.5 SSTV (慢扫描电视)

```bash
# 常用于业余无线电 CTF
# 使用 QSSTV (Linux) 或 MMSSTV (Windows)
# 或在线解码器
```

### 2.6 相位编码 / 回声隐藏

理论上存在，CTF 中较少见，通常需要专业工具。

---

## 三、视频隐写

### 3.1 帧间隐写

```bash
# ffmpeg 提取帧
ffmpeg -i video.mp4 -r 1 frames/frame_%04d.png

# 分析特定帧
# 使用 stegsolve 或 Python PIL 分析帧差异

# 查看帧间差异
ffmpeg -i video.mp4 -vf "select=gt(scene\,0.01)" -vsync vfr diff_frames/%04d.png
```

### 3.2 时间轴隐写

```python
# 帧持续时间可能编码信息
# 检查 FPS 变化或帧时长模式
```

### 3.3 视频文件结构

```bash
# 检查视频文件是否有追加数据
binwalk -Me video.mp4

# 检查元数据
exiftool video.mp4
mediainfo video.mp4
```

---

## 四、文本隐写

### 4.1 零宽字符 (Zero-Width Characters)

```python
# 零宽字符：U+200B (ZWSP), U+200C (ZWNJ), U+200D (ZWJ), U+FEFF (BOM)
# 在线工具：https://330k.github.io/misc_tools/unicode_steganography.html

# Python 提取
def extract_zero_width(text):
    result = ''
    for c in text:
        if c == '\u200b':
            result += '0'
        elif c == '\u200c':
            result += '1'
        elif c == '\u200d':
            result += ' '  # 分隔符
    return result

# 检测零宽字符
import unicodedata
has_zw = any(unicodedata.category(c) == 'Cf' for c in text)
```

### 4.2 空格/制表符编码

```python
# snow — 空格/制表符隐写
# 加密
snow -C -m "hidden message" -p "password" original.txt stego.txt
# 解密
snow -C -p "password" stego.txt

# 手动检测：行尾多余空格或制表符
# 在编辑器中显示空白字符
# 或使用 cat -A / hexdump
```

**Whitespace 语言**：某些题目可能用 whitespace 编程语言隐藏逻辑。

### 4.3 同形字 (Homoglyph)

```python
# 某些 Unicode 字符看起来像 ASCII 但实际不同
# 例如：а (U+0430) vs a (U+0061)
# 检测：
import unicodedata

def detect_homoglyphs(text):
    suspicious = []
    for c in text:
        name = unicodedata.name(c, 'UNKNOWN')
        if 'CYRILLIC' in name or 'GREEK' in name:
            if ord(c) < 0x400:
                suspicious.append(c)
    return suspicious
```

### 4.4 文字编码隐写

- **Baconian 密码**：大小写模式编码
- **Base64 藏于文本中**
- **HTML 注释隐藏**

---

## 五、文件格式与通用工具

### 5.1 文件头 (Magic Bytes)

```bash
# 常见 magic bytes
# PNG:  89 50 4E 47 0D 0A 1A 0A
# JPEG: FF D8 FF E0/E1
# GIF:  47 49 46 38 (GIF8)
# PDF:  25 50 44 46 (%PDF)
# ZIP:  50 4B 03 04 (PK)
# RAR:  52 61 72 21 (Rar!)
# 7z:   37 7A BC AF 27 1C
# WAV:  52 49 46 46 (RIFF)
# ELF:  7F 45 4C 46
# PE:   4D 5A (MZ)

# 查看文件头
xxd filename | head -5
hexdump -C filename | head -5
file filename
```

### 5.2 工具链速查

#### **zsteg** — PNG/BMP LSB 检测

```bash
zsteg image.png                       # 基础检测
zsteg -a image.png                    # 所有方法
zsteg -E b1,r,lsb,xy image.png       # 提取 LSB
zsteg --all image.png                 # 详尽输出
```

#### **steghide** — JPEG/BMP/WAV 隐写

```bash
steghide info image.jpg               # 查看是否有隐藏数据
steghide extract -sf image.jpg        # 提取（无密码）
steghide extract -sf image.jpg -p pass # 提取（有密码）
steghide embed -cf cover.jpg -ef secret.txt  # 嵌入
# 密码爆破
stegseek image.jpg                    # 自动爆破
stegseek image.jpg wordlist.txt       # 指定字典
```

#### **binwalk** — 文件雕刻

```bash
binwalk file.bin                      # 扫描嵌入文件
binwalk -Me file.bin                  # 自动提取
binwalk -D '.*' file.bin              # 提取所有类型
binwalk -e file.bin                   # 提取已知类型
binwalk --dd='.*' file.bin            # 提取所有
```

#### **exiftool** — 元数据

```bash
exiftool image.jpg                    # 基础元数据
exiftool -a -u -g1 image.jpg         # 所有元数据
exiftool -b -ThumbnailImage image.jpg > thumb.jpg  # 提取缩略图
exiftool -Comment image.jpg           # 查看注释
exiftool -XMP:All image.jpg           # XMP 数据
```

#### **foremost** — 文件雕刻

```bash
foremost -i file.bin -o output_dir
foremost -t all -i file.bin           # 恢复所有类型
```

#### **strings** — 字符串提取

```bash
strings file.bin                       # ASCII 字符串
strings -n 10 file.bin                 # 最小长度 10
strings -e l file.bin                  # 16-bit LE (UTF-16)
strings -e b file.bin                  # 16-bit BE
```

#### **pngcheck** — PNG 验证

```bash
pngcheck -v image.png                  # 详细输出
pngcheck -vt image.png                 # 打印所有 chunk 内容
```

#### **imagemagick** — 图片操作

```bash
# 查看像素值
magick image.png -crop 1x1+0+0 txt:-

# 通道分离
magick image.png -channel R -separate red.png

# 图片叠加
magick composite -compose difference a.png b.png diff.png
```

#### **stegsolve** — 图形化逐位分析

```bash
java -jar StegSolve.jar
# 功能：逐位平面查看、通道滤波、图片 XOR/SUB、GIF 逐帧
```

#### **Audacity** — 音频分析

用于频谱图查看、波形分析、音频反转/减速等。

#### **Sonic Visualiser** — 音频深度分析

频谱图、波形、音高分析。

---

## 六、常见隐写识别思路

### 6.1 判断流程

```
文件 → file 命令确认类型
     → binwalk 检查嵌入文件
     → strings 查找可疑字符串
     → exiftool 检查元数据
     → 根据类型使用专用工具
```

### 6.2 图片判断

```
PNG → zsteg, pngcheck, stegsolve
JPEG → steghide, stegdetect, JPEGsnoop
GIF → stegsolve 逐帧, gifshuffle
BMP → zsteg, LSB 提取
```

### 6.3 音频判断

```
WAV → 频谱图 (Audacity), LSB, steghide
MP3 → MP3Stego, ID3 标签
```

### 6.4 杂项判断

```
未知文件 → hexdump 查看 magic bytes
       → 修复文件头
       → 检查文件尾 (trailer) 后是否有数据
       → 尝试解压/解码
```

---

## 七、高级技巧

### 7.1 图片 Alpha 通道

```bash
# 提取透明度通道
magick image.png -alpha extract alpha.png

# RGBA 中 A 通道可能包含 LSB 数据
```

### 7.2 图片异或 (XOR)

```python
from PIL import Image, ImageChops

# 两张图片 XOR
img1 = Image.open("1.png").convert("RGB")
img2 = Image.open("2.png").convert("RGB")
result = ImageChops.logical_xor(img1, img2)  # 非标准，需自行实现

# 或逐像素
pixels1 = list(img1.getdata())
pixels2 = list(img2.getdata())
xor_pixels = [(r1^r2, g1^g2, b1^b2) for (r1,g1,b1),(r2,g2,b2) in zip(pixels1, pixels2)]
```

### 7.3 盲水印

```bash
# Python 盲水印库
# pip install blind-watermark
from blind_watermark import WaterMark

bwm = WaterMark(password_img=1, password_wm=1)
bwm.extract(filename='watermarked.png', wm_shape=(128,128), out_wm_name='extracted.png')
```

### 7.4 二维码 (QR Code) 修复

```python
# 使用 qrazybox (在线) 或 Python qrcode 库
# 手动修复损坏的 QR Code

# 读取 QR Code
from PIL import Image
from pyzbar.pyzbar import decode
data = decode(Image.open('qr.png'))
```

### 7.5 文件拼接

```bash
# 多个文件拼接(PNG+ZIP 等)
# 使用 binwalk 分离
# 或手动根据文件头/尾分割

# 将文件拼接
copy /b image.jpg + secret.zip combined.jpg
# 提取：binwalk 自动分离
```