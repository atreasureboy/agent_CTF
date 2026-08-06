#!/usr/bin/env python3
"""
Image LSB Steganography Extractor — extracts LSB-hidden data from PNG/BMP images.
Checks all RGB channels, bit-planes, and common LSB patterns.
"""
import sys
import re
import argparse
import struct
from typing import Optional, List

FLAG_PATTERN = re.compile(r'(flag\{[^}]+\}|CTF\{[^}]+\}|DASCTF\{[^}]+\}|XHLJ\{[^}]+\}|key\{[^}]+\})', re.I)


def extract_lsb_png(filepath: str) -> List[str]:
    """Extract LSB data from a PNG image using basic pixel manipulation."""
    try:
        from PIL import Image
    except ImportError:
        print("Pillow not installed. Install with: pip install Pillow", file=sys.stderr)
        return []

    results = []

    try:
        img = Image.open(filepath)
        img = img.convert('RGB')
        pixels = list(img.getdata())
        width, height = img.size
    except Exception as e:
        print(f"Error opening image: {e}", file=sys.stderr)
        return []

    # LSB extraction per plane
    for plane in range(3):  # R, G, B
        for bit in range(8):  # bit 0-7
            bits = []
            for pixel in pixels[:50000]:  # Cap at 50k pixels for performance
                bits.append(str((pixel[plane] >> bit) & 1))

            # Convert bits to bytes
            bytes_data = bytearray()
            for i in range(0, len(bits) - 7, 8):
                byte = 0
                for j in range(8):
                    byte = (byte << 1) | int(bits[i + j])
                bytes_data.append(byte)

            # Try to decode as text
            try:
                text = bytes_data.decode('utf-8', errors='replace')
                # Only keep printable ASCII
                cleaned = ''.join(c for c in text if 32 <= ord(c) < 127 or c in '\n\r\t')
                if len(cleaned) > 4:
                    flags = FLAG_PATTERN.findall(cleaned)
                    if flags:
                        results.append(f'LSB-RGB[{plane}][bit{bit}]: {flags[0]}')
                    elif any(kw in cleaned.lower() for kw in ['flag', 'ctf', 'pico', 'key']):
                        results.append(f'LSB-RGB[{plane}][bit{bit}]: {cleaned[:200]}')
            except Exception:
                pass

    # Interleaved LSB (R=bit0, G=bit0, B=bit0 for each pixel)
    for bit in range(4):
        bits = []
        for pixel in pixels[:50000]:
            for plane in range(3):
                bits.append(str((pixel[plane] >> bit) & 1))
        bytes_data = bytearray()
        for i in range(0, len(bits) - 7, 8):
            byte = 0
            for j in range(8):
                byte = (byte << 1) | int(bits[i + j])
            bytes_data.append(byte)
        try:
            text = bytes_data.decode('utf-8', errors='replace')
            flags = FLAG_PATTERN.findall(text)
            if flags:
                results.append(f'Interleaved-LSB[bit{bit}]: {flags[0]}')
        except Exception:
            pass

    return results


def extract_lsb_bmp(filepath: str) -> List[str]:
    """Extract LSB data from a BMP file by parsing raw pixel data."""
    results = []
    try:
        with open(filepath, 'rb') as f:
            header = f.read(54)  # BMP header is 54 bytes
            if header[:2] != b'BM':
                print("Not a valid BMP file", file=sys.stderr)
                return []

            # Parse header to get dimensions and offset
            offset = struct.unpack('<I', header[10:14])[0]
            width = struct.unpack('<i', header[18:22])[0]
            height = abs(struct.unpack('<i', header[22:26])[0])
            bpp = struct.unpack('<H', header[28:30])[0]

            if bpp != 24 and bpp != 32:
                print(f"BMP depth {bpp}bpp not supported for LSB", file=sys.stderr)
                return []

            f.seek(offset)
            row_size = ((bpp * width + 31) // 32) * 4
            pixel_data = f.read(row_size * height)

            for bit in range(8):
                bits = []
                for i in range(0, min(len(pixel_data), row_size * height - 3), bpp // 8):
                    bits.append(str((pixel_data[i] >> bit) & 1))

                bytes_data = bytearray()
                for i in range(0, len(bits) - 7, 8):
                    byte = 0
                    for j in range(8):
                        byte = (byte << 1) | int(bits[i + j])
                    bytes_data.append(byte)

                try:
                    text = bytes_data.decode('utf-8', errors='replace')
                    flags = FLAG_PATTERN.findall(text)
                    if flags:
                        results.append(f'BMP-LSB[bit{bit}]: {flags[0]}')
                except Exception:
                    pass
    except Exception as e:
        print(f"BMP parsing error: {e}", file=sys.stderr)

    return results


def main():
    parser = argparse.ArgumentParser(description='Image LSB Steganography Extractor')
    parser.add_argument('--file', '-f', required=True, help='Path to image file')
    args = parser.parse_args()

    filepath = args.file.lower()

    results = []
    if filepath.endswith('.png'):
        results = extract_lsb_png(args.file)
    elif filepath.endswith('.bmp'):
        results = extract_lsb_bmp(args.file)
    else:
        print(f"Unsupported image format: {args.file}", file=sys.stderr)
        sys.exit(1)

    if results:
        for r in results:
            print(r)
    else:
        print("No hidden data found via LSB analysis.")


if __name__ == '__main__':
    main()
