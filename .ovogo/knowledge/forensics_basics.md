# Common Forensics CTF Techniques

## File Analysis
- `file <filename>`: identify file type by magic bytes
- `strings <filename>`: extract printable strings
- `hexdump -C <filename>`: view hex dump
- `xxd <filename>`: hex editor view
- Check for hidden data after EOF (append data)

## Image Steganography
- `exiftool image.png`: metadata, comments, GPS data
- `binwalk image.png`: embedded files, extract with `-e`
- `steghide extract -sf image.jpg`: hidden data (needs password)
- `zsteg image.png`: LSB steganography for PNG/BMP
- `stegsolve.jar`: visual analysis, bit planes
- Check LSB (Least Significant Bit) of pixel values
- Compare with original: `compare image1.png image2.png diff.png`

## Network Forensics
- Wireshark / tshark: analyze pcap files
- `tshark -r capture.pcap -Y http`: filter HTTP traffic
- Export objects: HTTP, SMB, DNS from Wireshark
- Look for credentials in cleartext protocols (FTP, HTTP, Telnet)
- Reconstruct TCP streams
- DNS tunneling: check for long subdomain queries

## Memory Forensics
- Volatility framework: analyze memory dumps
- `volatility -f memdump.raw imageinfo`: identify OS profile
- `volatility -f memdump.raw --profile=WinXPSP3x86 pslist`: list processes
- `volatility -f memdump.raw --profile=WinXPSP3x86 memdump`: extract process memory
- Look for passwords, encryption keys, running processes

## Disk Forensics
- `fdisk -l disk.img`: list partitions
- `mount -o loop disk.img /mnt`: mount image
- `testdisk`: recover lost partitions
- `photorec`: file carving (recover deleted files)
- Check for deleted files: `extundelete`, `scalpel`

## Log Analysis
- Search for suspicious patterns: `grep -i "error\|fail\|denied" logfile`
- Timeline analysis: sort by timestamp
- Look for brute force: repeated failed logins
- Web logs: check for SQLi, XSS, directory traversal attempts
- Correlate events across multiple log sources

## Common File Formats
- ZIP: `unzip`, check for password protection, `zip2john` for cracking
- PDF: `pdf-parser.py`, extract streams, check for hidden content
- Office docs: `olevba` for macros, extract embedded objects
- PCAP: Wireshark, tshark, NetworkMiner

## Tools
- binwalk, strings, exiftool, steghide, zsteg
- Wireshark, tshark, tcpdump
- Volatility (memory), Autopsy (disk)
- CyberChef for encoding/decoding
