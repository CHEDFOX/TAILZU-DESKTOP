#!/usr/bin/env python3
"""Cuts every app icon the installers carry from the one master picture.

    python3 gen-app-icon.py /path/to/icon-4096.png

The master is X0 Bot's app icon, a full-bleed square with no transparency
(4096 x 4096, RGB). It lives with the brand art, not in this repo; only what
this script writes is committed:

  assets/icon-mac.png   1024, macOS. macOS does not mask an icon, so the art
                        is laid into the Big Sur template: an 824 x 824
                        rounded square (corner radius 185) centred on a
                        transparent 1024 canvas, with a soft drop shadow
                        (the same template the previous icon used).
  assets/icon.png       1024, Linux: the square art.
  build/icon.ico        Windows (app, installer, uninstaller): the square art
                        at 16, 20, 24, 32, 40, 48, 64, 96, 128 and 256, each
                        downscaled from the master on its own (bicubic
                        under 128 px, Lanczos above), PNG frames.
  build/appx/*.png      the Microsoft Store package's tiles and logos, at the
                        sizes electron-builder reads from build/appx: the
                        square ones are the square art; the wide tile is the
                        art centred with its clay bar and ground carried out
                        to both sides.

gen-icon.js (npm run icon) makes only the tray dots and never touches these.
Needs Pillow.
"""
import io
import os
import struct
import sys

from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
LANCZOS = Image.Resampling.LANCZOS

# The Big Sur template on a 1024 canvas, and the old icon's shadow (measured
# from it): black, 35%, 10 px down, a blur of sigma 12.5.
CANVAS, SHAPE, RADIUS = 1024, 824, 185
SHADOW_ALPHA, SHADOW_DY, SHADOW_SIGMA = 0.35, 10, 12.5
ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]
APPX_SQUARE = {
    "StoreLogo.png": 50,
    "Square44x44Logo.png": 44,
    "SmallTile.png": 71,
    "Square150x150Logo.png": 150,
    "LargeTile.png": 310,
}
APPX_WIDE = {"Wide310x150Logo.png": (310, 150)}


def square(master, size):
    # Under 128 px Lanczos rings: a light halo round the dark head, which at
    # 16 or 32 px reads as a line. Bicubic stays sharp without it.
    return master.resize((size, size), LANCZOS if size >= 128 else Image.Resampling.BICUBIC)


def extend(img, left, top, right, bottom):
    """Carries the picture's outermost rows and columns out by the given margins."""
    w, h = img.size
    out = Image.new(img.mode, (w + left + right, h + top + bottom))
    out.paste(img, (left, top))
    if top:
        out.paste(img.crop((0, 0, w, 1)).resize((w, top), Image.Resampling.NEAREST), (left, 0))
    if bottom:
        out.paste(img.crop((0, h - 1, w, h)).resize((w, bottom), Image.Resampling.NEAREST), (left, top + h))
    H = out.size[1]
    if left:
        out.paste(out.crop((left, 0, left + 1, H)).resize((left, H), Image.Resampling.NEAREST), (0, 0))
    if right:
        x = left + w - 1
        out.paste(out.crop((x, 0, x + 1, H)).resize((right, H), Image.Resampling.NEAREST), (left + w, 0))
    return out


def wide(master, w, h):
    """The art at the tile's height, centred, the bar and ground carried to the sides (drawn at 4x)."""
    s = 4
    art = master.resize((h * s, h * s), LANCZOS)
    pad = (w - h) * s
    return extend(art, pad // 2, 0, pad - pad // 2, 0).resize((w, h), LANCZOS)


def mac(master):
    s = 4  # the shape is drawn at 4x and brought down, for a clean edge
    off = (CANVAS - SHAPE) // 2
    big = Image.new("L", (CANVAS * s, CANVAS * s), 0)
    ImageDraw.Draw(big).rounded_rectangle(
        [off * s, off * s, (off + SHAPE) * s - 1, (off + SHAPE) * s - 1], radius=RADIUS * s, fill=255)
    mask = big.resize((CANVAS, CANVAS), Image.Resampling.BOX)

    art = Image.new("RGB", (CANVAS, CANVAS), 0)
    art.paste(master.resize((SHAPE, SHAPE), LANCZOS), (off, off))
    art = art.convert("RGBA")
    art.putalpha(mask)

    shade = Image.new("L", (CANVAS, CANVAS), 0)
    shade.paste(mask, (0, SHADOW_DY))
    shade = shade.filter(ImageFilter.GaussianBlur(SHADOW_SIGMA)).point(lambda v: round(v * SHADOW_ALPHA))
    shadow = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    shadow.putalpha(shade)
    return Image.alpha_composite(shadow, art)


def ico(master, sizes):
    """An .ico of PNG frames, each cut from the master at its own size."""
    frames = []
    for n in sizes:
        buf = io.BytesIO()
        square(master, n).convert("RGBA").save(buf, "PNG", optimize=True)
        frames.append((n, buf.getvalue()))
    head = struct.pack("<HHH", 0, 1, len(frames))
    offset = 6 + 16 * len(frames)
    entries, blobs = b"", b""
    for n, data in frames:
        d = 0 if n >= 256 else n
        entries += struct.pack("<BBBBHHII", d, d, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
        blobs += data
    return head + entries + blobs


def save(img, rel):
    path = os.path.join(HERE, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path, "PNG", optimize=True)
    print("wrote", rel, img.size, os.path.getsize(path), "bytes")


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    master = Image.open(sys.argv[1])
    master.load()
    if master.mode != "RGB":
        master = master.convert("RGB")
    if master.size[0] != master.size[1] or master.size[0] < 1024:
        sys.exit("the master must be a square of at least 1024 px")

    save(mac(master), "assets/icon-mac.png")
    save(square(master, 1024), "assets/icon.png")
    data = ico(master, ICO_SIZES)
    with open(os.path.join(HERE, "build", "icon.ico"), "wb") as f:
        f.write(data)
    print("wrote build/icon.ico", ICO_SIZES, len(data), "bytes")
    for name, n in APPX_SQUARE.items():
        save(square(master, n), "build/appx/" + name)
    for name, (w, h) in APPX_WIDE.items():
        save(wide(master, w, h), "build/appx/" + name)


if __name__ == "__main__":
    main()
