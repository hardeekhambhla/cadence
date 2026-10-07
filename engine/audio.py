"""Beat/onset analysis — pure numpy, about a second for a 3-minute song.

Pipeline (Ellis 2007 style): ffmpeg decode -> STFT -> mel spectral flux (onset envelope) ->
autocorrelation tempo -> dynamic-programming beat tracker -> downbeats (bass accents) ->
per-beat energy + drop detection + waveform peaks.
"""
import subprocess

import numpy as np

SR = 22050
NFFT = 1024
HOP = 256
FPS = SR / HOP  # onset-envelope frames per second (~86)
# STFT frames are centred, but flux peaks a hair after the true attack; calibrated on click tracks.
LATENCY = -0.0085


def probe_duration(path: str) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path],
        capture_output=True, text=True, check=True,
    ).stdout.strip()
    return float(out)


def decode_mono(path: str, sr: int = SR) -> np.ndarray:
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-vn", "-ac", "1", "-ar", str(sr), "-f", "f32le", "-"],
        capture_output=True, check=True,
    ).stdout
    return np.frombuffer(raw, dtype=np.float32)


def _mel_filterbank(n_mels: int = 40, fmin: float = 30.0, fmax: float = 8000.0) -> tuple[np.ndarray, np.ndarray]:
    hz2mel = lambda f: 2595 * np.log10(1 + f / 700)
    mel2hz = lambda m: 700 * (10 ** (m / 2595) - 1)
    freqs = np.linspace(0, SR / 2, NFFT // 2 + 1)
    pts = mel2hz(np.linspace(hz2mel(fmin), hz2mel(fmax), n_mels + 2))
    fb = np.zeros((n_mels, len(freqs)))
    for i in range(n_mels):
        lo, c, hi = pts[i:i + 3]
        fb[i] = np.maximum(0, np.minimum((freqs - lo) / (c - lo), (hi - freqs) / (hi - c)))
    fb /= np.maximum(fb.sum(1, keepdims=True), 1e-9)
    return fb, pts[1:-1]


def _stft_mag(y: np.ndarray) -> np.ndarray:
    pad = NFFT // 2
    y = np.pad(y, (pad, pad), mode="reflect")
    n_frames = 1 + (len(y) - NFFT) // HOP
    win = np.hanning(NFFT).astype(np.float32)
    out = np.empty((n_frames, NFFT // 2 + 1), dtype=np.float32)
    step = 2048
    for s in range(0, n_frames, step):
        e = min(n_frames, s + step)
        idx = np.arange(NFFT)[None, :] + HOP * np.arange(s, e)[:, None]
        out[s:e] = np.abs(np.fft.rfft(y[idx] * win, axis=1))
    return out


def _moving_avg(x: np.ndarray, n: int) -> np.ndarray:
    n = max(1, int(n))
    k = np.ones(n) / n
    return np.convolve(np.pad(x, (n // 2, n - 1 - n // 2), mode="edge"), k, mode="valid")


def onset_envelopes(y: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """(full-band onset strength, bass-only onset strength), both ~0..1, FPS frames/sec."""
    mag = _stft_mag(y)
    fb, centres = _mel_filterbank()
    mel = mag @ fb.T
    ref = np.percentile(mel, 99.5) + 1e-9
    S = np.log1p(30.0 * mel / ref)
    flux = np.maximum(0, S[1:] - S[:-1])
    flux = np.vstack([np.zeros((1, flux.shape[1])), flux])
    full = flux.sum(1)
    bass = flux[:, centres < 220].sum(1)
    out = []
    for e in (full, bass):
        e = np.maximum(0, e - _moving_avg(e, FPS))
        out.append(e / (np.percentile(e, 99) + 1e-9))
    return out[0], out[1]


def estimate_period(o: np.ndarray, lo: float = 65, hi: float = 170) -> float:
    """Beat period in (fractional) onset frames."""
    n = len(o)
    x = o - o.mean()
    f = np.fft.rfft(x, 2 * n)
    ac = np.fft.irfft(f * np.conj(f))[:n]
    ac = ac / (ac[0] + 1e-9) / np.maximum((n - np.arange(n)) / n, 0.2)
    lags = np.arange(int(FPS * 60 / hi), int(FPS * 60 / lo) + 1)
    bpms = 60 * FPS / lags
    prior = np.exp(-0.5 * (np.log2(bpms / 112) / 0.9) ** 2)
    pick = lambda m: ac[np.minimum(lags * m, n - 1)]
    score = (ac[lags] + 0.5 * pick(2) + 0.25 * pick(4)) * prior
    best = int(np.argmax(score))
    lag = float(lags[best])
    if 0 < lags[best] < n - 1:  # parabolic refinement
        a, b, c = ac[lags[best] - 1], ac[lags[best]], ac[lags[best] + 1]
        d = a - 2 * b + c
        if d != 0:
            lag += 0.5 * (a - c) / d
    return lag


def track_beats(o: np.ndarray, period: float, tightness: float = 100.0) -> np.ndarray:
    """Ellis dynamic-programming beat tracker; returns beat frame indices."""
    n = len(o)
    sd = FPS / 32
    w = int(round(4 * sd))
    local = np.convolve(o, np.exp(-0.5 * (np.arange(-w, w + 1) / sd) ** 2), mode="same")
    window = np.arange(-int(round(2 * period)), -int(round(period / 2)) + 1)
    txcost = -tightness * np.log(-window / period) ** 2
    C = np.zeros(n)
    back = np.full(n, -1, dtype=int)
    for i in range(n):
        idx = i + window
        valid = idx >= 0
        cand = np.where(valid, C[np.maximum(idx, 0)], 0.0) + txcost
        j = int(np.argmax(cand))
        C[i] = local[i] + cand[j]
        back[i] = idx[j] if valid[j] else -1
    peaks = np.where((C[1:-1] > C[:-2]) & (C[1:-1] >= C[2:]))[0] + 1
    if len(peaks) == 0:
        return np.array([], dtype=int)
    thresh = 0.5 * np.median(C[peaks])
    end = int(peaks[peaks >= 0][np.where(C[peaks] >= thresh)[0][-1]])
    beats = [end]
    while back[beats[-1]] >= 0:
        beats.append(int(back[beats[-1]]))
    return np.array(beats[::-1], dtype=int)


def _extend(beats: np.ndarray, duration: float) -> np.ndarray:
    """Fill the intro before the first tracked beat and the tail after the last at the local tempo."""
    if len(beats) < 3:
        return beats
    head = float(np.median(np.diff(beats[:9])))
    tail = float(np.median(np.diff(beats[-9:])))
    pre = []
    t = beats[0] - head
    while t > 0.05:
        pre.append(t)
        t -= head
    post = []
    t = beats[-1] + tail
    while t < duration - 0.05:
        post.append(t)
        t += tail
    return np.concatenate([pre[::-1], beats, post])


def _downbeat_phase(beat_frames: np.ndarray, o: np.ndarray, bass: np.ndarray) -> int:
    n = len(o)
    fr = np.clip(beat_frames, 0, n - 1)
    def local_max(x):
        return np.array([x[max(0, f - 2):f + 3].max() for f in fr])
    s = 0.65 * local_max(bass) + 0.35 * local_max(o)
    if len(s) < 8:
        return 0
    means = np.array([s[p::4].mean() for p in range(4)])
    return int(np.argmax(means))


def _beat_energy(y: np.ndarray, beats: np.ndarray, duration: float) -> np.ndarray:
    edges = np.append(beats, min(duration, beats[-1] + (beats[-1] - beats[-2]) if len(beats) > 1 else duration))
    rms = np.empty(len(beats))
    for i in range(len(beats)):
        a, b = int(edges[i] * SR), max(int(edges[i + 1] * SR), int(edges[i] * SR) + 64)
        seg = y[a:b]
        rms[i] = np.sqrt(np.mean(seg ** 2)) if len(seg) else 0.0
    db = 20 * np.log10(rms + 1e-5)
    lo, hi = np.percentile(db, 10), np.percentile(db, 95)
    e = np.clip((db - lo) / max(hi - lo, 1e-6), 0, 1)
    return np.convolve(np.pad(e, 1, mode="edge"), [0.25, 0.5, 0.25], mode="valid")


def _drops(energy: np.ndarray, down_idx: list[int]) -> list[int]:
    out: list[int] = []
    for i in down_idx:
        if i < 8 or i + 8 > len(energy):
            continue
        before, after = energy[i - 8:i].mean(), energy[i:i + 8].mean()
        if after - before > 0.28 and before < 0.6 and (not out or i - out[-1] > 16):
            out.append(i)
    return out


def analyze(path: str) -> dict:
    duration = probe_duration(path)
    y = decode_mono(path)
    if len(y) < SR:  # under a second — nothing to track
        return {"duration": duration, "bpm": 0, "beats": [], "downbeats": [], "energy": [], "drops": [],
                "peaks": [0.0] * 8}
    o, bass = onset_envelopes(y)
    period = estimate_period(o)
    frames = track_beats(o, period)
    beats = frames * HOP / SR - LATENCY
    beats = _extend(beats, duration) if len(beats) >= 3 else beats
    beats = beats[(beats >= 0) & (beats < duration)]
    fallback = len(beats) < 8 and duration > 4
    if fallback:  # no usable pulse (silence, ambient): cut on an even 100 BPM grid instead of nothing
        beats = np.arange(0.3, duration - 0.3, 0.6)
    bpm = 60.0 / float(np.median(np.diff(beats))) if len(beats) > 2 else 60 * FPS / period
    frames_for_phase = np.round((beats + LATENCY) * SR / HOP).astype(int)
    phase = _downbeat_phase(frames_for_phase, o, bass)
    down = list(range(phase, len(beats), 4))
    energy = _beat_energy(y, beats, duration) if len(beats) > 1 else np.zeros(len(beats))
    bins = 1000
    chunk = max(1, len(y) // bins)
    peaks = np.abs(y[: chunk * bins]).reshape(bins, chunk).max(1)
    peaks = np.clip(peaks / (np.percentile(peaks, 99.5) + 1e-9), 0, 1)
    return {
        "duration": round(duration, 3),
        "bpm": round(bpm, 1),
        "beats": [round(float(b), 3) for b in beats],
        "downbeats": down,
        "energy": [round(float(e), 2) for e in energy],
        "drops": _drops(energy, down),
        "fallback": fallback,
        "peaks": [round(float(p), 2) for p in peaks],
    }


def best_window(a: dict, length: float) -> tuple[float, float]:
    """Highest-energy stretch of ~`length` seconds, starting and ending on downbeats."""
    dur = a["duration"]
    if dur <= length * 1.15 or len(a["downbeats"]) < 2:
        return 0.0, dur
    beats, energy, down = a["beats"], a["energy"], a["downbeats"]
    best, best_score = (0.0, dur), -1.0
    for di in down:
        t0 = beats[di]
        if t0 + length > dur:
            break
        end = min((beats[j] for j in down if beats[j] >= t0 + length * 0.9), key=lambda t: abs(t - (t0 + length)), default=None)
        if end is None or end > dur:
            continue
        idx = [i for i, b in enumerate(beats) if t0 <= b < end]
        score = float(np.mean([energy[i] for i in idx])) if idx else 0
        if score > best_score:
            best, best_score = (t0, end), score
    return best


def window_at(a: dict, start: float, length: float) -> tuple[float, float]:
    """A `length`-second window starting near `start`, both ends snapped to beats and kept inside the song."""
    dur = a["duration"]
    start = min(max(0.0, start), max(0.0, dur - length))
    beats = a["beats"]
    if not beats:
        return start, min(dur, start + length)
    t0 = min(beats, key=lambda t: abs(t - start))
    t0 = min(t0, max(0.0, dur - length * 0.9))
    cands = [t for t in beats if t <= dur and t - t0 >= length * 0.9]
    end = min(cands, key=lambda t: abs(t - (t0 + length))) if cands else min(dur, t0 + length)
    return t0, end
