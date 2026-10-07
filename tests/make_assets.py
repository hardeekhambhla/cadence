"""Synthetic test media: a drum-ish song at a known BPM (kick on beats, accent on bar downbeat, quiet intro/loud
section) plus colour-coded clips and photos in mixed orientations. Used by the smoke tests."""
import pathlib, subprocess, sys

import numpy as np

OUT = pathlib.Path(__file__).parent / "assets"
SR = 44100


def song(path, bpm=120.0, seconds=24.0, offset=0.37):
    t = np.arange(int(SR * seconds)) / SR
    y = np.zeros_like(t)
    period = 60 / bpm
    n = 0
    tt = offset
    while tt < seconds - 0.3:
        i = int(tt * SR)
        k = np.arange(int(0.18 * SR)) / SR
        amp = (1.0 if n % 4 == 0 else 0.7) * (0.25 if tt < seconds * 0.3 else 1.0)
        kick = np.sin(2 * np.pi * (60 + 90 * np.exp(-k * 40)) * k) * np.exp(-k * 18) * amp
        y[i:i + len(kick)] += kick[: len(y) - i]
        hat_i = int((tt + period / 2) * SR)
        h = (np.random.RandomState(n).randn(int(0.04 * SR))) * np.exp(-np.arange(int(0.04 * SR)) / (0.008 * SR)) * 0.15 * amp
        if hat_i + len(h) < len(y):
            y[hat_i:hat_i + len(h)] += h
        tt += period
        n += 1
    y = np.clip(y * 0.8, -1, 1)
    raw = (y * 32767).astype("<i2").tobytes()
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "s16le", "-ar", str(SR), "-ac", "1", "-i", "-", "-b:a", "128k", str(path)],
                   input=raw, check=True)


def clip(path, w, h, seconds, color, hz=2):
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i",
                    f"testsrc2=s={w}x{h}:r=30:d={seconds},hue=h={color}", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "ultrafast", str(path)], check=True)


def photo(path, w, h, color):
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", f"color=c={color}:s={w}x{h}:d=1", "-frames:v", "1", str(path)], check=True)


if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    bpm = float(sys.argv[1]) if len(sys.argv) > 1 else 120
    song(OUT / f"song_{int(bpm)}.mp3", bpm=bpm)
    clip(OUT / "v_portrait_a.mp4", 720, 1280, 6, 0)
    clip(OUT / "v_portrait_b.mp4", 720, 1280, 4, 60)
    clip(OUT / "v_land_a.mp4", 1280, 720, 8, 120)
    clip(OUT / "v_land_b.mp4", 1280, 720, 3, 200)
    clip(OUT / "v_square.mp4", 720, 720, 5, 280)
    for i, c in enumerate(["red", "green", "blue", "orange", "purple"]):
        photo(OUT / f"p_{i}.jpg", [1080, 1440, 1440, 800, 1000][i], [1440, 1080, 1440, 1200, 1000][i], c)
    print("ok")
