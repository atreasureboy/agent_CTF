#!/usr/bin/env python3
"""
Image LSB Steganography Extractor — OneShot CTF

Extracts least-significant-bit data from PNG and BMP images across
RGB planes and bit-planes.  Checks for flag patterns in the extracted
binary data.

Usage:
    python3 image_stego_lsb.py --file <path_to_image>
"""

from __future__ import annotations

import argparse
import json
import re
import struct
import sys
import zlib
from pathlib import Path
from typing import List, Optional, Tuple


FLAG_PATTERN = re.compile(
    rb"(flag\{[^}]+\}|CTF\{[^}]+\}|DASCTF\{[^}]+\}|XHLJ\{[^}]+\}|key\{[^}]+\})",
    re.IGNORECASE,
)


def read_png_pixels(filepath: str) -> Tuple[int, int, List[Tuple[int, int, int]]]:
    """Read PNG file and return (width, height, [(r,g,b), ...]) for RGB pixels."""
    with open(filepath, "rb") as f:
        # Check PNG signature
        sig = f.read(8)
        if sig != b"\x89PNG\r\n\x1a\n":
            raise ValueError("Not a valid PNG file")

        width = height = 0
        pixels: List[Tuple[int, int, int]] = []
        raw_data = b""

        while True:
            length_bytes = f.read(4)
            if len(length_bytes) < 4:
                break
            length = struct.unpack(">I", length_bytes)[0]
            chunk_type = f.read(4)
            chunk_data = f.read(length)
            crc = f.read(4)

            if chunk_type == b"IHDR":
                width = struct.unpack(">I", chunk_data[0:4])[0]
                height = struct.unpack(">I", chunk_data[4:8])[0]
                bit_depth = chunk_data[8]
                color_type = chunk_data[9]
                if color_type not in (0, 2, 6):  # grayscale, RGB, RGBA
                    raise ValueError(
                        f"Unsupported color type: {color_type}. Supported: 0 (gray), 2 (RGB), 6 (RGBA)."
                    )
                if bit_depth != 8:
                    raise ValueError(f"Unsupported bit depth: {bit_depth}. Only 8-bit supported.")
            elif chunk_type == b"IDAT":
                raw_data += chunk_data
            elif chunk_type == b"IEND":
                break

        if not raw_data:
            raise ValueError("No image data found in PNG")

        # Decompress IDAT data
        try:
            decompressed = zlib.decompress(raw_data)
        except zlib.error as e:
            raise ValueError(f"Failed to decompress PNG data: {e}")

        # Parse scanlines (filter byte + pixels). Channels depend on color type:
        #   0 → 1 channel (gray), 2 → 3 channels (RGB), 6 → 4 channels (RGBA)
        channels = 1 if color_type == 0 else 3 if color_type == 2 else 4
        bpp = channels  # bytes per pixel for 8-bit depth
        stride = width * bpp + 1  # +1 for filter byte
        pos = 0
        prev_line = bytearray(width * bpp)

        for y in range(height):
            if pos >= len(decompressed):
                break
            filter_type = decompressed[pos]
            pos += 1

            line_data = bytearray(decompressed[pos:pos + width * bpp])
            pos += width * bpp

            # Unfilter
            if filter_type == 0:  # None
                pass
            elif filter_type == 1:  # Sub
                for i in range(bpp, len(line_data)):
                    line_data[i] = (line_data[i] + line_data[i - bpp]) & 0xFF
            elif filter_type == 2:  # Up
                for i in range(len(line_data)):
                    line_data[i] = (line_data[i] + prev_line[i]) & 0xFF
            elif filter_type == 3:  # Average
                for i in range(len(line_data)):
                    a = line_data[i - bpp] if i >= bpp else 0
                    b = prev_line[i]
                    line_data[i] = (line_data[i] + ((a + b) // 2)) & 0xFF
            elif filter_type == 4:  # Paeth
                for i in range(len(line_data)):
                    a = line_data[i - bpp] if i >= bpp else 0
                    b = prev_line[i]
                    c = prev_line[i - bpp] if i >= bpp else 0
                    p = a + b - c
                    pa = abs(p - a)
                    pb = abs(p - b)
                    pc = abs(p - c)
                    pr = a if pa <= pb and pa <= pc else (b if pb <= pc else c)
                    line_data[i] = (line_data[i] + pr) & 0xFF

            prev_line = line_data[:]

            for x in range(0, len(line_data), bpp):
                # RGBA → treat alpha as part of the LSB extraction surface too
                r = line_data[x]
                g = line_data[x + 1] if channels >= 2 else 0
                b_val = line_data[x + 2] if channels >= 3 else 0
                pixels.append((r, g, b_val))

        return width, height, pixels


def read_bmp_pixels(filepath: str) -> Tuple[int, int, List[Tuple[int, int, int]]]:
    """Read BMP file and return (width, height, [(r,g,b), ...]) for 24-bit RGB."""
    with open(filepath, "rb") as f:
        header = f.read(54)
        if len(header) < 54:
            raise ValueError("Invalid BMP header")

        # BMP signature
        if header[0:2] != b"BM":
            raise ValueError("Not a valid BMP file")

        # DIB header size
        dib_size = struct.unpack("<I", header[14:18])[0]
        width = struct.unpack("<i", header[18:22])[0]
        height = struct.unpack("<i", header[22:26])[0]
        bits_per_pixel = struct.unpack("<H", header[28:30])[0]
        compression = struct.unpack("<I", header[30:34])[0]

        if bits_per_pixel != 24 or compression != 0:
            raise ValueError(f"Only uncompressed 24-bit BMP supported (got {bits_per_pixel}bpp, compression={compression})")

        # Read pixel data offset
        offset = struct.unpack("<I", header[10:14])[0]
        f.seek(offset)

        # Row size (padded to 4 bytes)
        row_size = ((width * 3 + 3) // 4) * 4
        pixels: List[Tuple[int, int, int]] = []

        abs_height = abs(height)
        for y in range(abs_height):
            row_data = f.read(row_size)
            for x in range(0, width * 3, 3):
                b_val = row_data[x]
                g = row_data[x + 1]
                r = row_data[x + 2]
                pixels.append((r, g, b_val))

        return width, abs_height, pixels


def extract_lsb_plane(pixels: List[Tuple[int, int, int]], plane: int, channel: int) -> bytes:
    """
    Extract LSB from a specific bit-plane and color channel.

    plane: 0-7 (0=LSB, 7=MSB)
    channel: 0=R, 1=G, 2=B
    """
    bits = []
    for pixel in pixels:
        value = pixel[channel]
        bit = (value >> plane) & 1
        bits.append(bit)

    # Convert bits to bytes
    byte_array = bytearray()
    for i in range(0, len(bits) - len(bits) % 8, 8):
        byte_val = 0
        for j in range(8):
            byte_val = (byte_val << 1) | bits[i + j]
        byte_array.append(byte_val)

    return bytes(byte_array)


def extract_combined_lsb(pixels: List[Tuple[int, int, int]], plane: int) -> bytes:
    """Extract LSB from all three RGB channels combined."""
    bits = []
    for pixel in pixels:
        for ch in range(3):
            bit = (pixel[ch] >> plane) & 1
            bits.append(bit)

    byte_array = bytearray()
    for i in range(0, len(bits) - len(bits) % 8, 8):
        byte_val = 0
        for j in range(8):
            byte_val = (byte_val << 1) | bits[i + j]
        byte_array.append(byte_val)

    return bytes(byte_array)


def find_flags_in_bytes(data: bytes) -> List[str]:
    """Find flag patterns in binary data."""
    found = FLAG_PATTERN.findall(data)
    return [f.decode("utf-8", errors="replace") for f in found]


def solve(file_path: str) -> dict:
    """Main solver logic."""
    path = Path(file_path)
    if not path.exists():
        return {
            "status": "failed",
            "flag": None,
            "output": f"File not found: {file_path}",
        }

    ext = path.suffix.lower()
    try:
        if ext == ".png":
            width, height, pixels = read_png_pixels(file_path)
        elif ext == ".bmp":
            width, height, pixels = read_bmp_pixels(file_path)
        else:
            return {
                "status": "failed",
                "flag": None,
                "output": f"Unsupported format: {ext}. Only PNG and BMP supported.",
            }
    except Exception as exc:
        return {
            "status": "failed",
            "flag": None,
            "output": f"Failed to parse image: {exc}",
        }

    if not pixels:
        return {
            "status": "failed",
            "flag": None,
            "output": "No pixel data extracted from image.",
        }

    all_flags: List[str] = []
    output_lines = [f"Image: {width}x{height}, {len(pixels)} pixels"]

    channels = ["R", "G", "B"]

    # Check each bit plane per channel
    for plane in range(8):
        for ch_idx, ch_name in enumerate(channels):
            data = extract_lsb_plane(pixels, plane, ch_idx)
            flags = find_flags_in_bytes(data)
            if flags:
                for f in flags:
                    desc = f"[{ch_name}-bit{plane}] {f}"
                    output_lines.append(desc)
                    all_flags.append(f)

    # Also check combined RGB
    for plane in range(8):
        data = extract_combined_lsb(pixels, plane)
        flags = find_flags_in_bytes(data)
        if flags:
            for f in flags:
                desc = f"[RGB-bit{plane}] {f}"
                output_lines.append(desc)
                all_flags.append(f)

    if all_flags:
        # Deduplicate
        unique_flags = list(dict.fromkeys(all_flags))
        return {
            "status": "solved",
            "flag": unique_flags[0],
            "output": "\n".join(output_lines),
            "all_flags": unique_flags,
        }
    else:
        return {
            "status": "failed",
            "flag": None,
            "output": (
                f"No flag patterns found in LSB planes of {width}x{height} image. "
                f"Checked all 8 bit-planes across R, G, B channels."
            ),
        }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Image LSB Steganography Extractor — OneShot CTF",
    )
    parser.add_argument("--file", required=True, help="Path to image file (PNG or BMP)")
    args = parser.parse_args()

    result = solve(args.file)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    sys.exit(0 if result["status"] == "solved" else 1)


if __name__ == "__main__":
    main()