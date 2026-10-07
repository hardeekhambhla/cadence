"""Export: every shot is encoded on its own (in parallel, frame-exact), then the pieces are joined with a
lossless concat and muxed with the song audio. No re-encode of the full video, so it is quick."""
import pathlib
import subprocess
import tempfile
from concurrent.futures import ThreadPoolExecutor

from engine.cutter import RATIOS
from engine.media import HDR_CHAIN

FPS = 30
WORKERS = 4

FILTERS = {  # "looks" — CSS approximations of each live in static/js/player.js
    "none": "",
    "cinematic": "colorbalance=rs=-.06:gs=-.02:bs=.08:rh=.08:gh=.02:bh=-.06,eq=contrast=1.12:saturation=1.06:brightness=-0.02,vignette=PI/5",
    "vibrant": "eq=saturation=1.45:contrast=1.08,unsharp=3:3:0.4",
    "summer": "colorbalance=rs=.07:gs=.02:bs=-.07:rm=.06:bm=-.05,eq=saturation=1.2:brightness=0.03:contrast=1.04",
    "winter": "colorbalance=rs=-.05:bs=.07,eq=saturation=1.05:brightness=0.01",
    "moody": "eq=contrast=1.15:brightness=-0.05:saturation=0.8,colorbalance=bs=.05",
    "vintage": "curves=preset=vintage,eq=saturation=0.9",
    "noir": "hue=s=0,eq=contrast=1.2",
    "soft": "eq=saturation=0.85:contrast=0.92:brightness=0.05",
}


def out_size(ratio: str, short_edge: int) -> tuple[int, int]:
    w, h = RATIOS[ratio]
    f = short_edge / min(w, h)
    even = lambda v: max(2, int(round(v * f / 2)) * 2)
    return even(w), even(h)


def shot_frames(shots: list[dict], duration: float) -> list[int]:
    """Frame count per shot from rounded boundaries, so rounding never accumulates drift."""
    edges = [round(s["start"] * FPS) for s in shots] + [round(duration * FPS)]
    return [max(1, edges[i + 1] - edges[i]) for i in range(len(shots))]


def _zoom_expr(shot: dict, n: int, style: str) -> str | None:
    """Per-frame zoom factor as an ffmpeg expression in `t`, or None."""
    parts = []
    kb = shot.get("kb")
    if kb and kb["z0"] != kb["z1"]:
        parts.append(f"({kb['z0']}+({kb['z1']}-{kb['z0']})*t/{max(n / FPS, 0.1):.3f})")
    if style == "pulse" and shot.get("punch", 0) > 0:
        amp = min(0.09, 0.055 * shot["punch"])
        parts.append(f"(1+{amp:.3f}*pow(max(0,1-t/0.26),2))")
    return "*".join(parts) if parts else None


def shot_filter(shot: dict, m: dict, W: int, H: int, n: int, style: str, flt: str) -> str:
    chain: list[str] = []
    if m["kind"] == "video":
        if m.get("hdr"):
            chain.append(HDR_CHAIN)
        if abs(shot["speed"] - 1) > 1e-3:
            chain.append(f"setpts=PTS/{shot['speed']}")
        chain.append(f"fps={FPS}")
        chain.append("tpad=stop_mode=clone:stop_duration=3")
    fx = shot["fx"] if shot.get("fx") is not None else m["focus"][0]
    fy = shot["fy"] if shot.get("fy") is not None else m["focus"][1]
    if shot["fit"] == "blur":
        chain.append(
            "split=2[a][b];"
            f"[a]scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},"
            f"scale={max(2, W // 14) // 2 * 2}:{max(2, H // 14) // 2 * 2},boxblur=3:2,scale={W}:{H},eq=brightness=-0.07[bg];"
            f"[b]scale={W}:{H}:force_original_aspect_ratio=decrease[fg];"
            "[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1"
        )
    else:
        chain.append(f"scale={W}:{H}:force_original_aspect_ratio=increase:flags=bicubic")
        chain.append(f"crop={W}:{H}:x='(iw-{W})*{fx}':y='(ih-{H})*{fy}'")
    z = _zoom_expr(shot, n, style)
    if z:
        kb = shot.get("kb") or {}
        dx, dy = kb.get("dx", 0), kb.get("dy", 0)
        pan = (f"x='(in_w-{W})/2+{dx}*(in_w-{W})*(t/{max(n / FPS, 0.1):.3f}-0.5)':"
               f"y='(in_h-{H})/2+{dy}*(in_h-{H})*(t/{max(n / FPS, 0.1):.3f}-0.5)'") if kb else \
              f"x='(in_w-{W})/2':y='(in_h-{H})/2'"
        chain.append(f"scale=w='trunc({W}*({z})/2)*2':h='trunc({H}*({z})/2)*2':eval=frame:flags=bilinear")
        chain.append(f"crop={W}:{H}:{pan}")
    if FILTERS.get(flt):
        chain.append(FILTERS[flt])
    if style == "flash" and shot.get("punch", 0) >= 1.0:
        chain.append("fade=t=in:st=0:n=4:color=white")
    chain.append("format=yuv420p,setsar=1")
    # filtergraph pieces that contain ';' (the blur split) must stay a single comma-joined chain
    return ",".join(c for c in chain)


def _encode_shot(args: tuple) -> str:
    shot, m, mdir, W, H, n, style, flt, out = args
    src = str(mdir / m["norm"]) if m["kind"] == "image" else str(mdir / m["orig"])
    dur = n / FPS
    if m["kind"] == "image":
        inp = ["-loop", "1", "-framerate", str(FPS), "-t", f"{dur + 0.1:.3f}", "-i", src]
    else:
        inp = ["-ss", f"{shot['in']:.3f}", "-t", f"{dur * shot['speed'] + 0.25:.3f}", "-i", src]
    vf = shot_filter(shot, m, W, H, n, style, flt)
    cmd = ["ffmpeg", "-y", "-v", "error", *inp, "-an", "-vf", vf, "-frames:v", str(n), "-r", str(FPS),
           "-c:v", "libx264", "-preset", "veryfast", "-crf", "19", "-pix_fmt", "yuv420p", "-bf", "0", "-g", str(FPS * 2),
           "-threads", "2", "-video_track_timescale", "15360", out]
    subprocess.run(cmd, check=True, capture_output=True)
    return out


def build_audio(songs: list[dict], song_dir: pathlib.Path, duration: float, out: str, volume: float = 1.0,
                bitrate: str = "192k", fade_out: float = 1.2) -> None:
    inputs, parts, labels = [], [], []
    for i, s in enumerate(songs):
        a = s["analysis"]
        t0, t1 = s.get("trim") or [0.0, a["duration"]]
        inputs += ["-i", str(song_dir / s["file"])]
        parts.append(f"[{i}:a]atrim=start={t0:.3f}:end={min(t1, a['duration']):.3f},asetpts=PTS-STARTPTS,"
                     f"aresample=44100,aformat=channel_layouts=stereo[a{i}]")
        labels.append(f"[a{i}]")
    fo = max(0.0, duration - fade_out)
    graph = ";".join(parts) + f";{''.join(labels)}concat=n={len(songs)}:v=0:a=1,volume={volume:.2f},afade=t=out:st={fo:.3f}:d={fade_out}[aout]"
    subprocess.run(["ffmpeg", "-y", "-v", "error", *inputs, "-filter_complex", graph, "-map", "[aout]", "-t", f"{duration:.3f}",
                    "-c:a", "aac", "-b:a", bitrate, out], check=True, capture_output=True)


def export(project: dict, root: pathlib.Path, out_path: str, short_edge: int = 1080, progress=None) -> str:
    shots, media = project["shots"], {m["id"]: m for m in project["media"]}
    duration = project["timeline"]["duration"]
    W, H = out_size(project["ratio"], short_edge)
    style, flt = project["settings"]["style"], project["settings"]["filter"]
    counts = shot_frames(shots, duration)
    with tempfile.TemporaryDirectory(dir=root) as tmp:
        tmp = pathlib.Path(tmp)
        jobs = [(s, media[s["media"]], root / "media" / s["media"], W, H, counts[i], style, flt, str(tmp / f"s{i:04d}.mp4"))
                for i, s in enumerate(shots)]
        done = 0
        segs = []
        with ThreadPoolExecutor(WORKERS) as ex:
            for seg in ex.map(_encode_shot, jobs):
                segs.append(seg)
                done += 1
                if progress:
                    progress(done / (len(jobs) + 1))
        audio = str(tmp / "audio.m4a")
        build_audio(project["songs"], root / "songs", duration, audio, project["settings"].get("volume", 1.0))
        lst = tmp / "list.txt"
        lst.write_text("".join(f"file '{p}'\n" for p in segs))
        subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", str(lst), "-i", audio,
                        "-map", "0:v", "-map", "1:a", "-c", "copy", "-t", f"{duration:.3f}", "-movflags", "+faststart", out_path],
                       check=True, capture_output=True)
    if progress:
        progress(1.0)
    return out_path
