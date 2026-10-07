"""Project storage + the operations the app (and tests) run on a project. One folder per project:

  projects/<id>/project.json   state (songs, media, shots, settings)
                songs/<sid>.<ext>   uploaded audio
                media/<mid>/        orig.*, proxy.mp4 | preview.jpg, norm.jpg, thumb.jpg, t/ (thumb cache)
                audio.m4a           preview soundtrack (trimmed + joined songs)
                exports/            rendered videos
"""
import hashlib
import json
import os
import pathlib
import shutil
import threading
import time
import uuid

from engine import audio, cutter, media as media_mod, render

ROOT = pathlib.Path(os.environ.get("CADENCE_DATA", pathlib.Path(__file__).resolve().parent.parent / "projects"))
DEFAULT_SETTINGS = {"pace": 0.5, "style": "pulse", "filter": "none", "order": "chrono", "seed": 1, "volume": 1.0, "length": "30"}
PRESETS = {"reel": ("9:16", "30"), "story": ("9:16", "15"), "post": ("4:5", "30"), "square": ("1:1", "30"), "landscape": ("16:9", "60")}
_locks: dict[str, threading.RLock] = {}


def _lock(pid: str) -> threading.RLock:
    return _locks.setdefault(pid, threading.RLock())


def pdir(pid: str) -> pathlib.Path:
    return ROOT / pid


def new_id() -> str:
    return uuid.uuid4().hex[:10]


def create(name: str = "Untitled") -> dict:
    pid = new_id()
    p = {"id": pid, "name": name or "Untitled", "created": time.time(), "updated": time.time(), "ratio": "9:16",
         "settings": dict(DEFAULT_SETTINGS), "songs": [], "media": [], "shots": [], "timeline": None, "audio_v": "",
         "planned": False}
    pdir(pid).mkdir(parents=True, exist_ok=True)
    save(p)
    return p


def load(pid: str) -> dict:
    with _lock(pid):
        return json.loads((pdir(pid) / "project.json").read_text())


def save(p: dict) -> None:
    with _lock(p["id"]):
        p["updated"] = time.time()
        tmp = pdir(p["id"]) / "project.json.tmp"
        tmp.write_text(json.dumps(p))
        tmp.replace(pdir(p["id"]) / "project.json")


def update(pid: str, fn) -> dict:
    """Read-modify-write under the project lock (ingest threads and the editor both write)."""
    with _lock(pid):
        p = load(pid)
        fn(p)
        save(p)
        return p


def delete(pid: str) -> None:
    shutil.rmtree(pdir(pid), ignore_errors=True)


def list_projects() -> list[dict]:
    out = []
    if ROOT.exists():
        for d in ROOT.iterdir():
            f = d / "project.json"
            if f.exists():
                try:
                    p = json.loads(f.read_text())
                except ValueError:
                    continue
                first = next((m for m in p["media"] if m.get("thumb")), None)
                out.append({"id": p["id"], "sample": bool(p.get("sample")), "name": p["name"], "ratio": p["ratio"], "updated": p["updated"],
                            "duration": (p.get("timeline") or {}).get("duration", 0), "shots": len(p["shots"]),
                            "thumb": f"/api/projects/{p['id']}/media/{first['id']}/thumb.jpg" if first else None})
    return sorted(out, key=lambda x: -x["updated"])


# ----------------------------------------------------------------------------- songs
def add_song_entry(pid: str, name: str, file: str) -> dict:
    sid = new_id()
    entry = {"id": sid, "name": pathlib.Path(name).stem, "file": file, "status": "analyzing", "analysis": None,
             "trim": None, "mode": "full"}
    update(pid, lambda p: p["songs"].append(entry))
    return entry


def fit_length(media: list[dict]) -> float:
    """How long a video should run to show every clip comfortably (~1.8s per photo, up to 5s per video)."""
    total = sum(1.8 if m["kind"] == "image" else min(m.get("duration") or 3, 5.0) for m in media if m.get("status") == "ready")
    return min(max(total, 10.0), 180.0)


def apply_length(p: dict) -> None:
    """Set each song's trim so the soundtrack matches settings.length (15/30/45/60, full, or fit-my-clips)."""
    songs = [s for s in p["songs"] if s.get("analysis")]
    mode = str(p["settings"].get("length", "30"))
    total = sum(s["analysis"]["duration"] for s in songs)
    target = None if mode == "full" else (fit_length(p["media"]) if mode == "fit" else float(mode))
    remaining = target if target is not None else total
    for s in songs:
        a = s["analysis"]
        take = min(a["duration"], remaining)
        if take < 0.5:
            s["trim"] = [0.0, 0.0]
        elif take >= a["duration"] - 1.0:
            s["trim"] = [0.0, a["duration"]]
        else:
            s["trim"] = list(audio.best_window(a, take))
        remaining -= (s["trim"][1] - s["trim"][0])


def ingest_song(pid: str, sid: str) -> None:
    p = load(pid)
    s = next(x for x in p["songs"] if x["id"] == sid)
    try:
        a = audio.analyze(str(pdir(pid) / "songs" / s["file"]))
        def done(p):
            t = next(x for x in p["songs"] if x["id"] == sid)
            t["analysis"], t["status"] = a, "ready"
            apply_length(p)
        update(pid, done)
    except Exception as e:  # noqa: BLE001 — surfaced to the UI as a per-song error
        update(pid, lambda p: next(x for x in p["songs"] if x["id"] == sid).update(status="error", error=str(e)[:200]))


# ----------------------------------------------------------------------------- media
def add_media_entry(pid: str, name: str, kind: str, orig: str, modified: float | None) -> dict:
    mid = new_id()
    entry = {"id": mid, "name": name, "kind": kind, "status": "processing", "orig": orig, "modified": modified}
    update(pid, lambda p: p["media"].append(entry))
    return entry


def ingest_media(pid: str, mid: str) -> None:
    p = load(pid)
    m = next(x for x in p["media"] if x["id"] == mid)
    mdir = pdir(pid) / "media" / mid
    try:
        info = media_mod.ingest(str(mdir / m["orig"]), mdir, m["kind"])
        update(pid, lambda p: next(x for x in p["media"] if x["id"] == mid).update(info, status="ready"))
    except Exception as e:  # noqa: BLE001
        update(pid, lambda p: next(x for x in p["media"] if x["id"] == mid).update(status="error", error=str(e)[-200:]))


def suggest_ratio(media: list[dict]) -> dict:
    ready = [m for m in media if m.get("status") == "ready"]
    v = sum(1 for m in ready if m["h"] > m["w"] * 1.05)
    h = sum(1 for m in ready if m["w"] > m["h"] * 1.05)
    sq = len(ready) - v - h
    pick = "16:9" if h > v + sq else ("9:16" if v >= h else "1:1")
    return {"ratio": pick, "vertical": v, "horizontal": h, "square": sq}


# ----------------------------------------------------------------------------- planning
def ensure_audio(pid: str) -> None:
    p = load(pid)
    ready = [s for s in p["songs"] if s["status"] == "ready" and s["trim"][1] - s["trim"][0] >= 0.5]
    if not ready:
        return
    tl = cutter.build_timeline(ready)
    key = hashlib.md5(json.dumps([[s["id"], s["trim"]] for s in ready] + [p["settings"]["volume"]]).encode()).hexdigest()[:8]
    out = pdir(pid) / "audio.m4a"
    if p["audio_v"] != key or not out.exists():
        render.build_audio(ready, pdir(pid) / "songs", tl["duration"], str(out), p["settings"]["volume"], bitrate="128k")
        update(pid, lambda q: q.update(audio_v=key))


def replan(pid: str, pace: float | None = None, seed: int | None = None, order: str | None = None,
           ratio: str | None = None, length: str | None = None) -> dict:
    p = load(pid)
    st = p["settings"]
    if length:
        st["length"] = str(length)
    apply_length(p)
    if pace is not None:
        st["pace"] = pace
    if seed is not None:
        st["seed"] = seed
    if order:
        st["order"] = order
    if ratio:
        p["ratio"] = ratio
    songs = [s for s in p["songs"] if s["status"] == "ready" and s["trim"][1] - s["trim"][0] >= 0.5]
    result = cutter.plan(p["media"], songs, p["ratio"], st["pace"], st["seed"], st["order"])
    def apply(q):
        q["settings"], q["ratio"] = st, p["ratio"]
        for qs in q["songs"]:
            ps = next((x for x in p["songs"] if x["id"] == qs["id"]), None)
            if ps:
                qs["trim"] = ps["trim"]
        q["shots"], q["timeline"], q["planned"] = result["shots"], result["timeline"], True
        q["unused"] = result["unused"]
    update(pid, apply)
    ensure_audio(pid)
    return load(pid)
