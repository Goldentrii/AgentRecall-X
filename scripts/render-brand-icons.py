"""Render assets/brand/icon-400.png and icon-512.png (pure Pillow, no external service).

The mark is the home-page gold dot (film.css `.mark`) in the site gold #F5C451, with a glow,
on the home-page background (#04060a), with a thin gold ring so it reads as a
mark at 48px. Supersampled 4x and downscaled for clean edges.
Run: python scripts/render-brand-icons.py   (needs Pillow)
"""
from PIL import Image, ImageDraw, ImageFilter
import os

BG, GOLD = (4, 6, 10), (245, 196, 81)
OUT = os.path.join(os.path.dirname(__file__), "..", "assets", "brand")

def render(size: int, ss: int = 4) -> Image.Image:
    s = size * ss
    c = s / 2
    img = Image.new("RGB", (s, s), BG)
    glow = Image.new("RGB", (s, s), BG)
    d = ImageDraw.Draw(glow)
    r = s * 0.20
    d.ellipse([c - r, c - r, c + r, c + r], fill=GOLD)
    glow = glow.filter(ImageFilter.GaussianBlur(s * 0.09))
    img = Image.blend(img, glow, 0.9)
    d = ImageDraw.Draw(img)
    ring_r, ring_w = s * 0.34, s * 0.018
    d.ellipse([c - ring_r, c - ring_r, c + ring_r, c + ring_r], outline=GOLD, width=int(ring_w))
    r = s * 0.17
    d.ellipse([c - r, c - r, c + r, c + r], fill=GOLD)
    return img.resize((size, size), Image.LANCZOS)

for n in (400, 512):
    render(n).save(os.path.join(OUT, f"icon-{n}.png"), optimize=True)
    print("wrote", n)
