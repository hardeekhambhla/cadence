"""Media ingest: probe, preview proxies, thumbnails, per-second "interest" scores and crop focus."""
import datetime
import json
import pathlib
import subprocess

import numpy as np
from PIL import Image, ImageOps

try:  # iPhone HEIC photos, if the optional dep is installed
    import pillow_heif
    pillow_heif.register_heif_opener()
except Exception:
    pass

SCORE_HZ = 3
PROXY_LONG_EDGE = 720
HDR_CHAIN = ("zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,"
             "zscale=t=bt709:m=bt709:r=tv,format=yuv420p")  # iPhone HLG/HDR clips -> SDR, else they look washed out
IMAGE_EXT = {".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif", ".gif", ".bmp"}


def kind_of(name: str, mime: str = "") -> str:
    ext = pathlib.Path(name).suffix.lower()
    if mime.startswith("image/") or ext in IMAGE_EXT:
        return "image"
    return "video"


def _run(cmd: list[str]) -> None:
    subprocess.run(cmd, check=True, capture_output=True)


def probe_video(path: str) -> dict:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_streams", "-show_format", "-of", "json", path],
        capture_output=True, text=True, check=True,
    ).stdout
    j = json.loads(out)
    s = j["streams"][0]
    w, h = int(s["width"]), int(s["height"])
    rot = 0
    for sd in s.get("side_data_list", []):
        if "rotation" in sd:
            rot = int(float(sd["rotation"]))
    rot = rot or int(s.get("tags", {}).get("rotate", 0) or 0)
    if abs(rot) % 180 == 90:
        w, h = h, w
    num, _, den = s.get("avg_frame_rate", "30/1").partition("/")
    fps = float(num) / float(den or 1) if float(den or 1) else 30.0
    dur = float(s.get("duration") or j["format"].get("duration") or 0)
    created = j["format"].get("tags", {}).get("creation_time") or s.get("tags", {}).get("creation_time")
    ts = None
    if created:
        try:
            ts = datetime.datetime.fromisoformat(created.replace("Z", "+00:00")).timestamp()
        except ValueError:
            pass
    hdr = s.get("color_transfer") in ("arib-std-b67", "smpte2084")
    return {"w": w, "h": h, "duration": dur, "fps": fps, "created": ts, "hdr": hdr}


def _zn(x: np.ndarray) -> np.ndarray:
    return (x - x.mean()) / (x.std() + 1e-6)


def _edge_focus(gray: np.ndarray) -> tuple[float, float]:
    """Centroid of edge energy, pulled toward centre so crops never drift to a corner."""
    gx = np.abs(np.diff(gray.astype(np.float32), axis=-1))[..., :-1, :]
    gy = np.abs(np.diff(gray.astype(np.float32), axis=-2))[..., :, :-1]
    e = (gx + gy)
    if e.ndim == 3:
        e = e.mean(0)
    tot = e.sum()
    if tot < 1e-6:
        return 0.5, 0.5
    h, w = e.shape
    cx = float((e.sum(0) * np.arange(w)).sum() / tot) / max(w - 1, 1)
    cy = float((e.sum(1) * np.arange(h)).sum() / tot) / max(h - 1, 1)
    clamp = lambda v: round(0.5 + 0.55 * (min(max(v, 0.2), 0.8) - 0.5), 3)
    return clamp(cx), clamp(cy)


def _video_scores(proxy: str) -> tuple[list[float], tuple[float, float]]:
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", proxy, "-an", "-vf", f"fps={SCORE_HZ},scale=96:96,format=gray", "-f", "rawvideo", "-"],
        capture_output=True, check=True,
    ).stdout
    n = len(raw) // (96 * 96)
    if n < 2:
        return [0.5] * max(n, 1), (0.5, 0.5)
    f = np.frombuffer(raw[: n * 96 * 96], dtype=np.uint8).reshape(n, 96, 96).astype(np.float32)
    motion = np.r_[0.0, np.abs(f[1:] - f[:-1]).mean((1, 2))]
    motion[0] = motion[1]
    sharp = (np.abs(np.diff(f, axis=2)).mean((1, 2)) + np.abs(np.diff(f, axis=1)).mean((1, 2)))
    bright = f.mean((1, 2))
    score = 0.55 * _zn(motion) + 0.45 * _zn(sharp) - 1.2 * (bright < 28) - 0.8 * (bright > 240)
    score = np.convolve(np.pad(score, 1, mode="edge"), [0.25, 0.5, 0.25], mode="valid")
    lo, hi = score.min(), score.max()
    score = (score - lo) / (hi - lo + 1e-6)
    return [round(float(s), 2) for s in score], _edge_focus(f)


def thumb_at(proxy: str, t: float, out: str, width: int = 320) -> None:
    _run(["ffmpeg", "-y", "-v", "error", "-ss", f"{max(t, 0):.3f}", "-i", proxy, "-frames:v", "1",
          "-vf", f"scale={width}:-2", "-q:v", "4", out])


def ingest_video(src: str, mdir: pathlib.Path) -> dict:
    info = probe_video(src)
    proxy = mdir / "proxy.mp4"
    scale = ((HDR_CHAIN + "," if info["hdr"] else "") + f"scale=w='if(gt(iw,ih),min({PROXY_LONG_EDGE},iw),-2)':h='if(gt(iw,ih),-2,min({PROXY_LONG_EDGE},ih))',fps=30")
    _run(["ffmpeg", "-y", "-v", "error", "-i", src, "-an", "-vf", scale, "-c:v", "libx264", "-preset", "veryfast",
          "-crf", "27", "-g", "10", "-keyint_min", "10", "-sc_threshold", "0", "-pix_fmt", "yuv420p", "-threads", "3",
          "-movflags", "+faststart", str(proxy)])
    scores, focus = _video_scores(str(proxy))
    info["duration"] = info["duration"] or len(scores) / SCORE_HZ
    thumb_at(str(proxy), min(0.8, info["duration"] / 2), str(mdir / "thumb.jpg"))
    return {**info, "scores": scores, "focus": list(focus), "proxy": "proxy.mp4", "thumb": "thumb.jpg"}


def ingest_image(src: str, mdir: pathlib.Path) -> dict:
    im = ImageOps.exif_transpose(Image.open(src)).convert("RGB")
    w, h = im.size
    full = im.copy()
    full.thumbnail((2160, 2160))
    full.save(mdir / "norm.jpg", quality=92)
    prev = im.copy()
    prev.thumbnail((1080, 1080))
    prev.save(mdir / "preview.jpg", quality=84)
    th = im.copy()
    th.thumbnail((360, 360))
    th.save(mdir / "thumb.jpg", quality=80)
    gray = np.asarray(im.convert("L").resize((96, 96)))
    return {"w": w, "h": h, "duration": 0, "fps": 0, "created": None, "scores": [], "focus": list(_edge_focus(gray)),
            "proxy": "preview.jpg", "norm": "norm.jpg", "thumb": "thumb.jpg"}


def ingest(src: str, mdir: pathlib.Path, kind: str) -> dict:
    mdir.mkdir(parents=True, exist_ok=True)
    return ingest_image(src, mdir) if kind == "image" else ingest_video(src, mdir)
