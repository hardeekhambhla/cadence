"""Generates the demo media in samples/: a synthesized 108 BPM track (build-up -> drop) and colourful animated
clips + photos in mixed shapes. Pure ffmpeg + numpy, deterministic, no downloads."""
import pathlib
import subprocess

import numpy as np

OUT = pathlib.Path(__file__).resolve().parent.parent / "samples"
SR, BPM, BARS = 44100, 108.0, 16
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"


def song(path: pathlib.Path) -> None:
    beat = 60 / BPM
    n = int(SR * (BARS * 4 * beat + 0.5))
    y = np.zeros(n)
    rng = np.random.RandomState(7)

    def add(t0, sig):
        i = int(t0 * SR)
        y[i:i + len(sig)] += sig[: max(0, n - i)]

    hz = lambda m: 440 * 2 ** ((m - 69) / 12)
    chords = [(57, 60, 64), (53, 57, 60), (48, 52, 55), (55, 59, 62)]  # Am F C G
    for bar in range(BARS):
        t0 = bar * 4 * beat
        notes = chords[bar % 4]
        k = np.arange(int(4 * beat * SR)) / SR
        env = np.minimum(1, k / 0.25) * np.minimum(1, (4 * beat - k) / 0.3)
        pad = sum(np.sin(2 * np.pi * hz(m) * k) + 0.4 * np.sin(2 * np.pi * hz(m) * 2 * k) + 0.2 * np.sin(2 * np.pi * hz(m + 12) * 3 * k) for m in notes)
        add(t0, pad * env * (0.05 if bar < 8 else 0.07))
        if bar >= 2:
            for b in range(4):  # bass on the beat
                kb = np.arange(int(beat * SR * 0.9)) / SR
                add(t0 + b * beat, np.sin(2 * np.pi * hz(notes[0] - 24) * kb) * np.exp(-kb * 3.2) * 0.34)
        if bar >= 4:
            for b in range(4):  # kick
                kk = np.arange(int(0.2 * SR)) / SR
                add(t0 + b * beat, np.sin(2 * np.pi * (52 + 110 * np.exp(-kk * 38)) * kk) * np.exp(-kk * 14) * (0.95 if b == 0 else 0.8))
        if bar >= 6:
            for b in (1, 3):  # snare / clap
                ks = np.arange(int(0.16 * SR)) / SR
                add(t0 + b * beat, rng.randn(len(ks)) * np.exp(-ks * 22) * 0.2 + np.sin(2 * np.pi * 190 * ks) * np.exp(-ks * 30) * 0.12)
        if bar >= 8:
            for e in range(8):  # hats
                kh = np.arange(int(0.05 * SR)) / SR
                add(t0 + e * beat / 2, rng.randn(len(kh)) * np.exp(-kh * 90) * (0.1 if e % 2 else 0.14))
            for b in range(4):  # little lead pluck
                kl = np.arange(int(beat * SR * 0.5)) / SR
                add(t0 + b * beat + beat / 2, np.sin(2 * np.pi * hz(notes[2] + 12) * kl) * np.exp(-kl * 6) * 0.1)
    y = np.tanh(y * 1.3) * 0.85
    raw = (y * 32767).astype("<i2").tobytes()
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "s16le", "-ar", str(SR), "-ac", "1", "-i", "-", "-af", "afade=t=out:st=%.2f:d=1.5" % (n / SR - 1.5), "-b:a", "160k", str(path)], input=raw, check=True)


def ff(*args):
    subprocess.run(["ffmpeg", "-y", "-v", "error", *args], check=True)


def grad_clip(path, w, h, secs, c0, c1, c2, word, speed=0.05, angle=0.0):
    txt = f"drawtext=fontfile={FONT}:text='{word}':fontsize={int(h * 0.11)}:fontcolor=white@0.92:x='w-mod(t*{w * 0.55:.0f},w+tw)':y=(h-th)/2+sin(t*2)*{h * 0.05:.0f}:shadowcolor=black@0.25:shadowx=3:shadowy=3"
    ff("-f", "lavfi", "-i", f"gradients=s={w}x{h}:d={secs}:r=30:speed={speed}:n=3:c0={c0}:c1={c1}:c2={c2}:x0=0:y0=0:x1={w}:y1={h}",
       "-vf", txt, "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-pix_fmt", "yuv420p", str(path))


def fractal_clip(path, w, h, secs, scale):
    ff("-f", "lavfi", "-i", f"mandelbrot=s={w}x{h}:r=30:end_scale={scale}:start_scale=3:maxiter=140", "-t", str(secs),
       "-vf", "hue=h=t*40,eq=saturation=1.6,format=yuv420p", "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", str(path))


def photo(path, w, h, c0, c1, word):
    ff("-f", "lavfi", "-i", f"gradients=s={w}x{h}:d=1:n=2:c0={c0}:c1={c1}:x0=0:y0=0:x1={w}:y1={h}:speed=0.00001",
       "-vf", f"drawtext=fontfile={FONT}:text='{word}':fontsize={int(min(w, h) * 0.16)}:fontcolor=white:x=(w-tw)/2:y=(h-th)/2:shadowcolor=black@0.25:shadowx=4:shadowy=4",
       "-frames:v", "1", "-q:v", "3", str(path))


def build() -> None:
    OUT.mkdir(exist_ok=True)
    song(OUT / "Sunday Drive.mp3")
    P = "#FF7A59", "#FFD166", "#06D6A0"
    grad_clip(OUT / "01-sunrise.mp4", 720, 1280, 7, *P, "SUNRISE", speed=0.06)
    grad_clip(OUT / "02-coast.mp4", 720, 1280, 6, "#00B4D8", "#90E0EF", "#CAF0F8", "COAST", speed=0.08)
    grad_clip(OUT / "03-neon.mp4", 720, 1280, 6, "#F72585", "#7209B7", "#3A0CA3", "NEON", speed=0.09)
    grad_clip(OUT / "04-dusk.mp4", 720, 1280, 5, "#FF9E00", "#FF4D6D", "#4C1D95", "DUSK", speed=0.07)
    grad_clip(OUT / "05-wide-meadow.mp4", 1280, 720, 8, "#80ED99", "#38A3A5", "#22577A", "MEADOW", speed=0.05)
    fractal_clip(OUT / "06-wide-bloom.mp4", 1280, 720, 6, 0.012)
    grad_clip(OUT / "07-square-ember.mp4", 720, 720, 6, "#FFBA08", "#E85D04", "#9D0208", "EMBER", speed=0.1)
    photo(OUT / "08-photo-golden.jpg", 1080, 1440, "#FFB703", "#FB8500", "GOLDEN")
    photo(OUT / "09-photo-wave.jpg", 1440, 1080, "#48CAE4", "#0077B6", "WAVE")
    photo(OUT / "10-photo-bloom.jpg", 1080, 1080, "#FF8FAB", "#C9184A", "BLOOM")


if __name__ == "__main__":
    build()
    print("samples ok")
