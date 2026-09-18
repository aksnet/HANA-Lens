#!/usr/bin/env python3
"""
Generate minimal placeholder icons for the HANA-Lens Tauri app.
No external dependencies — only stdlib (struct, zlib, os).
Produces:  src-tauri/icons/{32x32.png, 128x128.png, 128x128@2x.png, icon.ico, icon.icns}
"""

import os
import struct
import zlib

# SAP Fiori blue
R, G, B = 0, 112, 195


def make_png(width, height):
    """Return a solid-colour PNG as bytes."""
    def chunk(tag, data):
        crc = zlib.crc32(tag + data) & 0xFFFFFFFF
        return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', crc)

    ihdr = struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)
    row  = bytes([R, G, B] * width)
    raw  = b''.join(b'\x00' + row for _ in range(height))
    return (
        b'\x89PNG\r\n\x1a\n'
        + chunk(b'IHDR', ihdr)
        + chunk(b'IDAT', zlib.compress(raw, 9))
        + chunk(b'IEND', b'')
    )


def make_ico(png256):
    """Wrap a 256×256 PNG into an ICO container."""
    # ICO header (6 bytes) + one ICONDIRENTRY (16 bytes) + image data
    data_offset = 6 + 16
    header = struct.pack('<HHH', 0, 1, 1)           # reserved, type=ICO, count=1
    entry  = struct.pack('<BBBBHHII',
                         0, 0,           # width=256, height=256 (0 = 256 in ICO)
                         0, 0,           # colorCount, reserved
                         1, 32,          # planes, bitCount
                         len(png256), data_offset)
    return header + entry + png256


def make_icns(png256):
    """Create a minimal ICNS file with a single ic08 (256×256) entry."""
    entry_type   = b'ic08'
    entry_length = 8 + len(png256)          # type(4) + length(4) + data
    entry        = entry_type + struct.pack('>I', entry_length) + png256
    file_length  = 8 + len(entry)           # magic(4) + length(4) + entries
    return b'icns' + struct.pack('>I', file_length) + entry


def main():
    out = os.path.join('src-tauri', 'icons')
    os.makedirs(out, exist_ok=True)

    png32  = make_png(32,  32)
    png128 = make_png(128, 128)
    png256 = make_png(256, 256)

    files = {
        '32x32.png':       png32,
        '128x128.png':     png128,
        '128x128@2x.png':  png256,
        'icon.ico':        make_ico(png256),
        'icon.icns':       make_icns(png256),
    }

    for name, data in files.items():
        path = os.path.join(out, name)
        with open(path, 'wb') as f:
            f.write(data)
        print(f'  {path}  ({len(data):,} bytes)')

    print('Icons generated.')


if __name__ == '__main__':
    main()
