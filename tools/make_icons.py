"""Renders the outline-camera mark onto an accent rounded square (app icon) with PIL, 4x supersampled."""
import pathlib
from PIL import Image, ImageDraw

OUT = pathlib.Path(__file__).resolve().parent.parent / "static" / "icons"
ACCENT, PAPER = (255, 90, 54), (255, 255, 255)


def mark(d: ImageDraw.ImageDraw, ox: float, oy: float, s: float, color, sw: float):
    P = lambda x, y: (ox + x * s, oy + y * s)
    w = max(1, round(sw * s))
    d.rounded_rectangle([*P(6, 18), *P(58, 54)], radius=10 * s, outline=color, width=w)
    pts = [P(21, 18), P(24.2, 11.5), P(39.8, 11.5), P(43, 18)]
    d.line(pts, fill=color, width=w, joint="curve")
    for p in (pts[1], pts[2]):
        d.ellipse([p[0] - w / 2, p[1] - w / 2, p[0] + w / 2, p[1] + w / 2], fill=color)
    cx, cy = P(32, 36)
    for r in (11.5, 4.5):
        d.ellipse([cx - r * s, cy - r * s, cx + r * s, cy + r * s], outline=color, width=w)
    fx, fy = P(49, 26.5)
    d.ellipse([fx - 1.8 * s, fy - 1.8 * s, fx + 1.8 * s, fy + 1.8 * s], fill=color)


def icon(size: int, maskable: bool = False) -> Image.Image:
    k = 4
    S = size * k
    im = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([0, 0, S - 1, S - 1], radius=0 if maskable else S * 0.225, fill=ACCENT)
    s = S * (0.5 if maskable else 0.58) / 64
    mark(d, (S - 64 * s) / 2, (S - 64 * s) / 2 + S * 0.01, s, PAPER, 3)
    return im.resize((size, size), Image.LANCZOS)


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    for name, size, m in [("apple-touch-icon.png", 180, True), ("icon-192.png", 192, False), ("icon-512.png", 512, False),
                          ("icon-maskable-512.png", 512, True), ("favicon-32.png", 32, False)]:
        icon(size, m).save(OUT / name)
    print("icons ok")
