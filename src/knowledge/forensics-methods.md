# 取证技术速查 (Forensics)

> CTF 数字取证常见技术、工具和命令速查手册

---

## 一、文件分析

### 1.1 Magic Bytes 速查表

| 文件类型 | Magic Bytes (Hex) | 扩展名 |
|----------|-------------------|--------|
| PNG | `89 50 4E 47 0D 0A 1A 0A` | .png |
| JPEG | `FF D8 FF E0` / `FF D8 FF E1` | .jpg/.jpeg |
| GIF | `47 49 46 38 37 61` / `47 49 46 38 39 61` | .gif |
| BMP | `42 4D` | .bmp |
| PDF | `25 50 44 46` | .pdf |
| ZIP | `50 4B 03 04` | .zip |
| RAR | `52 61 72 21 1A 07 00` / `52 61 72 21 1A 07 01 00` | .rar |
| 7-Zip | `37 7A BC AF 27 1C` | .7z |
| GZIP | `1F 8B 08` | .gz |
| BZ2 | `42 5A 68` | .bz2 |
| XZ | `FD 37 7A 58 5A 00` | .xz |
| TAR | `75 73 74 61 72` (offset 257) | .tar |
| WAV | `52 49 46 46` | .wav |
| MP3 | `FF FB` / `49 44 33` (ID3) | .mp3 |
| FLAC | `66 4C 61 43` | .flac |
| AVI | `52 49 46 46` | .avi |
| MP4 | `00 00 00 18 66 74 79 70` | .mp4 |
| ELF | `7F 45 4C 46` | (Linux 可执行) |
| PE | `4D 5A` | .exe/.dll |
| Mach-O | `FE ED FA CE` / `FE ED FA CF` / `CE FA ED FE` / `CF FA ED FE` | (macOS) |
| SQLite | `53 51 4C 69 74 65 20 66 6F 72 6D 61 74 20 33 00` | .db/.sqlite |
| PCAP | `A1 B2 C3 D4` / `D4 C3 B2 A1` | .pcap |
| PCAPNG | `0A 0D 0D 0A` | .pcapng |
| TrueCrypt | `54 52 55 45` | .tc |
| Veracrypt | `56 45 52 41` | .hc |
| LUKS | `4C 55 4B 53 BA BE` | (加密卷) |
| E01 (EWF) | `45 56 46 09 0D 0A FF 00` | .e01 |
| Windows.evtx | `45 6C 66 46 69 6C 65 00` | .evtx |
| OLE2 (Office) | `D0 CF 11 E0 A1 B1 1A E1` | .doc/.xls |
| Office Open XML | `50 4B 03 04` (ZIP-based) | .docx/.xlsx/.pptx |

### 1.2 文件类型识别

```bash
# 基础识别
file unknown.bin
file -i unknown.bin                      # MIME type
file --mime-type unknown.bin

# 十六进制查看
xxd unknown.bin | head -20
hexdump -C unknown.bin | head -20
od -A x -t x1z unknown.bin | head -20

# 检测嵌入文件
binwalk unknown.bin
binwalk -Me unknown.bin                  # 自动提取
binwalk -D '.*' unknown.bin             # 提取所有类型
```

### 1.3 文件修复

```bash
# 修复损坏的文件头
# 使用 hexedit 或 Python 修复

# Python: 修复 PNG 文件头
with open('broken.png', 'rb') as f:
    data = f.read()
# 替换损坏的文件头
data = b'\x89PNG\r\n\x1a\n' + data[8:]
with open('fixed.png', 'wb') as f:
    f.write(data)

# 修复 JPEG
# 确保以 FF D8 FF E0/E1 开始，FF D9 结束

# 修复 ZIP
# 确保以 50 4B 03 04 开始
```

**常见修复场景**：

```python
# 通用文件头修复
MAGIC_BYTES = {
    'png':  b'\x89PNG\r\n\x1a\n',
    'jpg':  b'\xFF\xD8\xFF\xE0',
    'gif':  b'\x47\x49\x46\x38\x39\x61',
    'pdf':  b'%PDF',
    'zip':  b'PK\x03\x04',
    '7z':   b"7z\xBC\xAF'\x1C",
    'rar':  b'Rar!\x1A\x07\x00',
    'bz2':  b'BZh',
    'gz':   b'\x1F\x8B\x08',
}

def fix_header(filepath, filetype):
    with open(filepath, 'rb') as f:
        data = f.read()
    magic = MAGIC_BYTES.get(filetype)
    if magic and not data.startswith(magic):
        data = magic + data[len(magic):]
        with open(filepath, 'wb') as f:
            f.write(data)
        print(f"[+] Fixed {filetype} header")
```

### 1.4 文件雕刻 (File Carving)

```bash
# foremost — 基于文件头/尾的文件恢复
foremost -i image.dd -o output/
foremost -t all -i image.dd -o output/
foremost -t jpg,png,pdf -i image.dd -o output/

# scalpel — 基于文件头/尾的雕刻
# 编辑 /etc/scalpel/scalpel.conf 启用文件类型
scalpel -o output/ image.dd

# photorec — 文件恢复（支持多种格式）
photorec image.dd
photorec /log

# bulk_extractor — 提取邮箱、URL、信用卡号等
bulk_extractor -o output/ image.dd
```

### 1.5 文件比较

```bash
# 二进制差异对比
diff file1 file2
vbindiff file1 file2
cmp -l file1 file2 | gawk '{printf "%08X %02X %02X\n", $1, strtonum(0$2), strtonum(0$3)}'

# Python: 逐字节 XOR
def xor_files(file1, file2, output):
    with open(file1, 'rb') as f1, open(file2, 'rb') as f2:
        d1, d2 = f1.read(), f2.read()
    result = bytes(a ^ b for a, b in zip(d1, d2))
    with open(output, 'wb') as f:
        f.write(result)

# 图片差异
magick composite -compose difference img1.png img2.png diff.png
```

---

## 二、内存取证

### 2.1 Volatility 3 常用命令

```bash
# 安装
# pip install volatility3

# 镜像信息
vol -f memory.dump windows.info
vol -f memory.dump windows.info.Info

# 进程列表
vol -f memory.dump windows.pslist
vol -f memory.dump windows.pstree
vol -f memory.dump windows.psscan          # 扫描隐藏进程

# 命令行历史
vol -f memory.dump windows.cmdline
vol -f memory.dump windows.cmdline --pid <PID>

# 进程内存 dump
vol -f memory.dump windows.memmap --pid <PID> --dump
vol -f memory.dump windows.dumpfiles --pid <PID>

# 文件扫描
vol -f memory.dump windows.filescan
vol -f memory.dump windows.dumpfiles --physaddr <OFFSET>

# 网络连接
vol -f memory.dump windows.netstat
vol -f memory.dump windows.netscan

# 注册表
vol -f memory.dump windows.registry.hivelist
vol -f memory.dump windows.registry.printkey --key "Software\Microsoft\Windows\CurrentVersion"
vol -f memory.dump windows.registry.userassist

# 用户信息
vol -f memory.dump windows.hashdump        # 提取密码哈希
vol -f memory.dump windows.lsadump         # LSA secrets

# 恶意代码检测
vol -f memory.dump windows.malfind         # 检测注入代码
vol -f memory.dump windows.dlllist         # 加载的 DLL
vol -f memory.dump windows.modules
vol -f memory.dump windows.callbacks

# 环境变量
vol -f memory.dump windows.envars

# 剪贴板
vol -f memory.dump windows.clipboard

# TrueCrypt/Veracrypt
vol -f memory.dump windows.truecrypt

# 字符串搜索
vol -f memory.dump windows.vadyarascan
# 或使用 strings 搜索
strings memory.dump | grep -i "flag"
strings -e l memory.dump | grep -i "flag"  # UTF-16LE
```

### 2.2 Volatility 2 常用命令

```bash
# 镜像识别
volatility -f memory.dump imageinfo

# 进程
volatility -f memory.dump --profile=Win7SP1x64 pslist
volatility -f memory.dump --profile=Win7SP1x64 pstree
volatility -f memory.dump --profile=Win7SP1x64 psscan
volatility -f memory.dump --profile=Win7SP1x64 cmdscan
volatility -f memory.dump --profile=Win7SP1x64 consoles

# 内存 dump
volatility -f memory.dump --profile=Win7SP1x64 memdump -p <PID> -D output/
volatility -f memory.dump --profile=Win7SP1x64 procdump -p <PID> -D output/

# 文件
volatility -f memory.dump --profile=Win7SP1x64 filescan
volatility -f memory.dump --profile=Win7SP1x64 dumpfiles -Q <OFFSET> -D output/

# 网络
volatility -f memory.dump --profile=Win7SP1x64 netscan
volatility -f memory.dump --profile=Win7SP1x64 connscan

# 注册表
volatility -f memory.dump --profile=Win7SP1x64 hivelist
volatility -f memory.dump --profile=Win7SP1x64 printkey -K "Software\Microsoft\Windows\CurrentVersion\Run"

# 密码提取
volatility -f memory.dump --profile=Win7SP1x64 hashdump
volatility -f memory.dump --profile=Win7SP1x64 lsadump

# 恶意代码
volatility -f memory.dump --profile=Win7SP1x64 malfind
volatility -f memory.dump --profile=Win7SP1x64 apihooks
volatility -f memory.dump --profile=Win7SP1x64 ldrmodules

# 时间线
volatility -f memory.dump --profile=Win7SP1x64 timeliner
```

### 2.3 内存取证工具链

```bash
# 提取字符串
strings memory.dump > strings.txt
strings -e l memory.dump > strings_wide.txt  # UTF-16LE

# 搜索特定模式
strings memory.dump | grep -E "flag\{.*\}"
strings memory.dump | grep -i "password"
strings memory.dump | grep -i "http"

# 使用 bulk_extractor
bulk_extractor -o output/ memory.dump

# 使用 foremost 恢复文件
foremost -i memory.dump -o output/

# Rekall (替代框架)
rekall -f memory.dump pslist
```

### 2.4 Linux 内存取证

```bash
# 使用 LiME 或 fmem 获取 Linux 内存镜像
# 使用 Volatility Linux profile

vol -f memory.dump linux.pslist
vol -f memory.dump linux.pstree
vol -f memory.dump linux.bash
vol -f memory.dump linux.proc_maps
vol -f memory.dump linux.elfs
vol -f memory.dump linux.lsof
vol -f memory.dump linux.netstat
vol -f memory.dump linux.check_syscall
```

---

## 三、磁盘取证

### 3.1 磁盘镜像分析

```bash
# 镜像信息
fdisk -l image.dd
mmls image.dd                            # 分区布局
fsstat -o <OFFSET> image.dd              # 文件系统信息

# 挂载磁盘镜像
# 计算偏移量: 扇区号 * 扇区大小
mount -o ro,loop,offset=$((SECTOR * 512)) image.dd /mnt/analysis

# 或使用 losetup
losetup -o $((SECTOR * 512)) /dev/loop0 image.dd
mount -o ro /dev/loop0 /mnt/analysis

# 使用 kpartx (自动分区)
kpartx -a -v image.dd
mount -o ro /dev/mapper/loop0p1 /mnt/analysis
```

### 3.2 MBR / GPT 分析

```bash
# 查看 MBR
dd if=image.dd bs=512 count=1 | xxd
dd if=image.dd bs=512 count=1 | hexdump -C

# MBR 分区表 (offset 446-509, 64 bytes)
# 每个分区条目 16 bytes:
#   byte 0: 引导标志 (0x80=可引导, 0x00=不可引导)
#   byte 1-3: CHS 起始地址
#   byte 4: 分区类型 (0x07=NTFS, 0x83=Linux, 0x82=Swap)
#   byte 5-7: CHS 结束地址
#   byte 8-11: LBA 起始扇区
#   byte 12-15: 扇区数

# 查看 GPT
gdisk -l image.dd
```

### 3.3 文件系统分析

**NTFS**：

```bash
# ntfs-3g 挂载
ntfs-3g -o ro,loop,offset=$((SECTOR*512)) image.dd /mnt/ntfs

# 分析 MFT
# fls / istat (Sleuth Kit)
fls -r -o <OFFSET> image.dd              # 列出所有文件
fls -r -m / -o <OFFSET> image.dd > bodyfile  # 生成 bodyfile
istat -o <OFFSET> image.dd <INODE>       # 文件详细信息

# 已删除文件恢复
tsk_recover -o <OFFSET> image.dd output/
fls -rd -o <OFFSET> image.dd             # 显示已删除文件

# NTFS 日志 ($LogFile)
# 解析 NTFS 日志恢复文件操作
```

**EXT2/3/4**：

```bash
# ext 文件系统工具
fsck.ext4 -n /dev/loop0                  # 检查文件系统
debugfs /dev/loop0                       # 交互式调试

# debugfs 命令
debugfs: ls -l /
debugfs: stat /etc/passwd
debugfs: dump <inode> output.txt
debugfs: lsdel                           # 列出已删除文件
debugfs: undel <inode> output.txt        # 恢复已删除文件

# extundelete
extundelete --restore-all image.dd
```

**FAT**：

```bash
# FAT 文件系统
fls -r -o <OFFSET> image.dd
fsstat -o <OFFSET> image.dd
```

### 3.4 Sleuth Kit (TSK) 常用命令

```bash
# 镜像层
mmls image.dd                            # 分区布局
mmstat image.dd                          # 卷系统类型
mmcat -o <OFFSET> image.dd               # 提取卷

# 文件系统层
fsstat -o <OFFSET> image.dd              # 文件系统信息
fls -r -o <OFFSET> image.dd              # 递归列出文件
fls -rd -o <OFFSET> image.dd             # 包括已删除文件
icat -o <OFFSET> image.dd <INODE>        # 按 inode 提取文件内容
ifind -o <OFFSET> image.dd -d <INODE>    # 查找文件名
istat -o <OFFSET> image.dd <INODE>       # inode 信息
ils -o <OFFSET> image.dd                 # 列出所有 inode

# 时间线
fls -r -m / -o <OFFSET> image.dd > bodyfile
mactime -b bodyfile -d > timeline.csv

# 文件恢复
tsk_recover -o <OFFSET> image.dd output/
```

### 3.5 已删除文件恢复

```bash
# photorec / testdisk
testdisk image.dd                        # 交互式恢复
photorec image.dd                        # 文件雕刻恢复

# ext 恢复
extundelete image.dd --restore-all
ext4magic image.dd -M -d output/

# NTFS 恢复
# ntfsundelete
ntfsundelete /dev/loop0 -s -m '*.txt'
# 恢复所有可恢复的文件
ntfsundelete /dev/loop0 -u -m '*'

# 手动恢复 (通过 MFT 记录)
# 使用 icat 提取未分配 inode 的内容
```

### 3.6 磁盘加密

```bash
# BitLocker 检测
# 特征：启动扇区包含 "-FVE-FS-"
bdeinfo /dev/loop0

# BitLocker 解密
dislocker -V /dev/loop0 -p<password> -- /mnt/decrypted
# 或使用恢复密钥
dislocker -V /dev/loop0 -f<recovery_key_file> -- /mnt/decrypted

# LUKS 检测
cryptsetup luksDump /dev/loop0

# LUKS 解密
cryptsetup luksOpen /dev/loop0 decrypted
cryptsetup luksOpen --header header.img /dev/loop0 decrypted

# TrueCrypt / VeraCrypt
veracrypt --mount image.tc /mnt/decrypted
```

---

## 四、流量分析

### 4.1 Wireshark 过滤器

**显示过滤器 (Display Filters)**：

```bash
# 基础过滤
ip.addr == 192.168.1.1
ip.src == 192.168.1.1
ip.dst == 192.168.1.100
tcp.port == 80
tcp.port == 80 or tcp.port == 443
http
dns
ftp
smtp

# HTTP 过滤
http.request.method == "POST"
http.request.uri contains "login"
http.response.code == 200
http contains "password"
http.request.uri matches "\.php"
http.host == "example.com"

# TCP 特殊过滤
tcp.flags.syn == 1
tcp.flags.syn == 1 and tcp.flags.ack == 0
tcp.analysis.retransmission
tcp.stream eq 0

# 数据内容
frame contains "flag"
tcp.payload contains "password"
data.data contains "PNG"
http.file_data contains "FLAG"

# 时间段
frame.time >= "2024-01-01 12:00:00" and frame.time <= "2024-01-01 13:00:00"

# 排除
!(arp or dns or icmp)
not arp and not bootp

# 组合示例
http.request.uri contains "upload" and ip.src == 192.168.1.100
```

**捕获过滤器 (Capture Filters)**：

```bash
host 192.168.1.1
port 80
tcp port 80
net 192.168.1.0/24
not arp
tcp port 80 or tcp port 443
```

### 4.2 TShark 命令行

```bash
# 基础使用
tshark -r capture.pcap
tshark -r capture.pcap -Y "http"                  # 显示过滤器
tshark -r capture.pcap -f "tcp port 80"           # 捕获过滤器

# 提取字段
tshark -r capture.pcap -T fields -e ip.src -e ip.dst -e tcp.port
tshark -r capture.pcap -Y "http.request" -T fields -e http.host -e http.request.uri

# 协议层级统计
tshark -r capture.pcap -z io,phs

# 会话统计
tshark -r capture.pcap -z conv,tcp
tshark -r capture.pcap -z conv,ip

# 端点统计
tshark -r capture.pcap -z endpoints,tcp

# HTTP 统计
tshark -r capture.pcap -z http,stat
tshark -r capture.pcap -z http,tree

# 导出对象
tshark -r capture.pcap --export-objects "http,output_dir"

# 跟踪 TCP 流
tshark -r capture.pcap -z follow,tcp,ascii,0

# 提取 HTTP 文件
tshark -r capture.pcap -Y "http.content_type contains \"image\"" \
  -T fields -e http.content_type -e http.file_data
```

### 4.3 协议分析

**HTTP 分析**：

```bash
# 提取所有 HTTP 对象
# Wireshark: File → Export Objects → HTTP

# 使用 tshark 提取
tshark -r capture.pcap --export-objects "http,./http_objects"

# 提取 POST 数据
tshark -r capture.pcap -Y "http.request.method == POST" -T fields -e urlencoded-form.key -e urlencoded-form.value

# 从 HTTP 流中提取文件
# Wireshark: Follow TCP Stream → 查看原始数据 → 提取文件内容
```

**DNS 分析**：

```bash
# 提取 DNS 查询
tshark -r capture.pcap -Y "dns" -T fields -e dns.qry.name

# DNS 隧道检测
# 异常长的 DNS 查询，大量 TXT/MX 查询
tshark -r capture.pcap -Y "dns.qry.name matches \".{50,}\""
```

**USB 分析**：

```bash
# USB 键盘流量分析
# 提取 HID 数据
tshark -r capture.pcap -Y "usb.capdata" -T fields -e usb.capdata

# 使用 Python 解析 HID 键盘数据
HID_KEYMAP = {
    0x04: 'a', 0x05: 'b', 0x06: 'c', 0x07: 'd', 0x08: 'e',
    0x09: 'f', 0x0a: 'g', 0x0b: 'h', 0x0c: 'i', 0x0d: 'j',
    0x0e: 'k', 0x0f: 'l', 0x10: 'm', 0x11: 'n', 0x12: 'o',
    0x13: 'p', 0x14: 'q', 0x15: 'r', 0x16: 's', 0x17: 't',
    0x18: 'u', 0x19: 'v', 0x1a: 'w', 0x1b: 'x', 0x1c: 'y',
    0x1d: 'z', 0x1e: '1', 0x1f: '2', 0x20: '3', 0x21: '4',
    0x22: '5', 0x23: '6', 0x24: '7', 0x25: '8', 0x26: '9',
    0x27: '0', 0x28: '\n', 0x2c: ' ', 0x2d: '-', 0x2e: '=',
    0x2f: '[', 0x30: ']', 0x33: ';', 0x34: "'", 0x36: ',',
    0x37: '.', 0x38: '/',
}
```

**WiFi 分析**：

```bash
# 使用 aircrack-ng 套件
# 解密 WPA/WPA2
aircrack-ng -w wordlist.txt capture.cap

# 提取握手包
aircrack-ng capture.cap -J handshake

# 使用 hashcat 加速
# 先转换格式
hcxpcapngtool -o hash.hc22000 capture.pcapng
# 再用 hashcat
hashcat -m 22000 hash.hc22000 wordlist.txt
```

**Bluetooth 分析**：

```bash
# 使用 Wireshark 或 crackle
crackle -i capture.pcap -o decrypted.pcap
```

### 4.4 数据提取技巧

```bash
# 从 TCP 流中提取原始数据
# 使用 Wireshark "Follow TCP Stream" → "Show and save data as Raw"

# 提取所有 TCP 流
tshark -r capture.pcap -T fields -e tcp.stream | sort -u

# 使用 scapy 提取
python3 << 'EOF'
from scapy.all import *
packets = rdpcap("capture.pcap")
for pkt in packets:
    if pkt.haslayer(Raw):
        data = pkt[Raw].load
        # 处理数据
EOF

# 使用 tcpflow 重建 TCP 流
tcpflow -r capture.pcap -o output_dir/

# 使用 foremost 从 pcap 提取文件
foremost -i capture.pcap -o output/
```

### 4.5 网络取证工具

| 工具 | 用途 |
|------|------|
| **Wireshark** | 图形化协议分析 |
| **tshark** | 命令行协议分析 |
| **tcpdump** | 数据包捕获 |
| **tcpflow** | TCP 会话重建 |
| **NetworkMiner** | 网络取证分析 |
| **Xplico** | 网络取证工具 |
| **ngrep** | 网络 grep |
| **capinfos** | pcap 文件信息 |
| **editcap** | 编辑 pcap 文件 |
| **mergecap** | 合并 pcap 文件 |
| **scapy** | Python 数据包操作库 |

---

## 五、日志分析

### 5.1 常见日志格式

**Apache/Nginx 访问日志**：

```
# 通用格式
192.168.1.1 - - [01/Jan/2024:12:00:00 +0000] "GET /index.html HTTP/1.1" 200 2326

# 分析
cat access.log | awk '{print $1}' | sort | uniq -c | sort -rn     # IP 统计
cat access.log | awk '{print $7}' | sort | uniq -c | sort -rn     # URL 统计
cat access.log | grep " 404 " | awk '{print $7}' | sort | uniq -c # 404 页面
cat access.log | awk '{print $4}' | cut -d: -f2,3 | sort | uniq -c # 按小时统计
```

**Syslog**：

```bash
# /var/log/syslog, /var/log/messages
# 格式: MMM DD HH:MM:SS HOSTNAME PROCESS[PID]: MESSAGE

# 搜索
grep -i "error" /var/log/syslog
grep -i "fail" /var/log/auth.log
grep "Failed password" /var/log/auth.log | awk '{print $11}' | sort | uniq -c
```

**Windows 事件日志**：

```bash
# 使用 python-evtx 解析 EVTX 文件
# pip install python-evtx
python3 -m evtx_dump Security.evtx > security.xml

# 使用 LogParser
LogParser "SELECT * FROM Security.evtx WHERE EventID=4625"

# 常见 Event ID
# 4624: 成功登录
# 4625: 失败登录
# 4672: 特殊权限分配
# 4688: 进程创建
# 5140: 网络共享访问
# 7045: 服务安装
```

### 5.2 日志分析命令

```bash
# 时间范围过滤
awk '/01\/Jan\/2024:12:00:00/,/01\/Jan\/2024:13:00:00/' access.log

# 提取特定字段
cat access.log | awk -F'"' '{print $2}' | awk '{print $2}'  # 提取 URL

# 统计 User-Agent
cat access.log | awk -F'"' '{print $6}' | sort | uniq -c | sort -rn

# 检测异常请求
grep -E "union|select|or 1=1|../../" access.log
grep -E "<script|alert\(|onerror=" access.log

# 检测扫描行为
cat access.log | awk '{print $1}' | sort | uniq -c | sort -rn | head -20
```

### 5.3 时间线重建

```bash
# 使用 Plaso / log2timeline
log2timeline.py timeline.plaso image.dd
psort.py -o l2tcsv timeline.plaso > timeline.csv

# 使用 mactime (Sleuth Kit)
fls -r -m / -o <OFFSET> image.dd > bodyfile
mactime -b bodyfile -d > timeline.csv

# 手动时间线
# 收集所有文件时间戳
find /mnt/analysis -printf "%T+ %p\n" > file_timestamps.txt
# 合并日志时间戳
```

### 5.4 日志分析工具

| 工具 | 用途 |
|------|------|
| **grep/awk/sed** | 命令行日志分析 |
| **LogParser** | Windows 日志分析 |
| **python-evtx** | EVTX 解析 |
| **Plaso/log2timeline** | 时间线生成 |
| **Zircolite** | 基于 Sigma 规则的 EVTX 分析 |
| **Chainsaw** | Windows 事件日志快速搜索 |
| **Hayabusa** | Windows 事件日志时间线 |
| **GoAccess** | 实时 Web 日志分析 |
| **lnav** | 日志文件导航器 |

---

## 六、注册表分析

### 6.1 重要注册表位置

```
# 系统信息
HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion
HKLM\SYSTEM\CurrentControlSet\Control\ComputerName

# 自启动
HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Run
HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Run
HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\RunOnce

# 用户信息
HKLM\SAM\Domains\Account\Users
HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\UserAssist

# 网络
HKLM\SYSTEM\CurrentControlSet\Services\Tcpip\Parameters\Interfaces
HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings

# USB 设备
HKLM\SYSTEM\CurrentControlSet\Enum\USB
HKLM\SYSTEM\CurrentControlSet\Enum\USBSTOR

# Shellbags (文件夹访问)
HKCU\Software\Microsoft\Windows\Shell\BagMRU
HKCU\Software\Microsoft\Windows\Shell\Bags

# 最近文件
HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\RecentDocs

# 服务
HKLM\SYSTEM\CurrentControlSet\Services

# 计划任务
HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Schedule\TaskCache
```

### 6.2 注册表分析工具

```bash
# 使用 regripper
rip.pl -r SYSTEM -p compname
rip.pl -r SOFTWARE -p networklist
rip.pl -r NTUSER.DAT -p userassist

# 使用 python-registry
# https://github.com/williballenthin/python-registry

# 使用 Registry Explorer (图形化)
# https://ericzimmerman.github.io/
```

---

## 七、快速检查清单

### 取证分析流程

```
1. 文件识别
   □ file <unknown>
   □ binwalk <file>
   □ strings <file> | grep -i flag

2. 图片/音频/视频
   □ exiftool <file>
   □ zsteg <image> (PNG)
   □ steghide info <image> (JPEG)
   □ 频谱图分析 (Audacity)

3. 内存镜像
   □ volatility imageinfo
   □ volatility pslist / pstree
   □ volatility cmdline
   □ volatility netscan
   □ strings <dump> | grep -i flag

4. 磁盘镜像
   □ fdisk -l / mmls
   □ fsstat / fls
   □ 已删除文件恢复
   □ 时间线分析

5. 流量包
   □ capinfos <pcap>
   □ Wireshark / tshark 分析
   □ 导出 HTTP 对象
   □ 跟踪可疑 TCP 流

6. 日志
   □ 认证日志分析
   □ Web 访问日志分析
   □ 时间线重建
```