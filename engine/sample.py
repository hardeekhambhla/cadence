"""One-tap demo project built from samples/ (generated on first use by tools/make_sample.py)."""
import pathlib
import shutil
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor

from engine import media as media_mod, project as P, render

SAMPLES = pathlib.Path(__file__).resolve().parent.parent / "samples"


def existing() -> dict | None:
    """The sample project if one is already there (never build a second copy)."""
    return next((P.load(x["id"]) for x in P.list_projects() if x.get("sample")), None)


def build() -> dict:
    if (found := existing()):
        return found
    song = SAMPLES / "Sunday Drive.mp3"
    if not song.exists():
        subprocess.run([sys.executable, str(SAMPLES.parent / "tools" / "make_sample.py")], check=True)
    p = P.create("Sunday Drive (sample)")
    pid = p["id"]
    P.update(pid, lambda q: q.update(preset="reel", ratio="9:16", sample=True))
    sd = P.pdir(pid) / "songs"
    sd.mkdir(exist_ok=True)
    shutil.copy(song, sd / "song.mp3")
    s = P.add_song_entry(pid, song.name, "song.mp3")
    entries = []
    for f in sorted(x for x in SAMPLES.iterdir() if x.suffix in (".mp4", ".jpg") and x.name[:2].isdigit()):
        kind = media_mod.kind_of(f.name)
        e = P.add_media_entry(pid, f.name, kind, f"orig{f.suffix}", f.stat().st_mtime)
        d = P.pdir(pid) / "media" / e["id"]
        d.mkdir(parents=True)
        shutil.copy(f, d / f"orig{f.suffix}")
        entries.append(e)
    with ThreadPoolExecutor(4) as ex:
        list(ex.map(lambda f: f(), [lambda: P.ingest_song(pid, s["id"])] + [(lambda e=e: P.ingest_media(pid, e["id"])) for e in entries]))
    P.update(pid, lambda q: q["settings"].update(filter="summer", style="pulse", order="added", length="full"))
    return P.replan(pid, pace=0.55, seed=3, order="added", length="full")


if __name__ == "__main__":  # python -m engine.sample -> also renders samples/sample.mp4
    proj = build()
    out = SAMPLES / "sample.mp4"
    render.export(proj, P.pdir(proj["id"]), str(out), 720)
    print("sample project", proj["id"], "->", out, f"({len(proj['shots'])} cuts, {proj['timeline']['duration']:.1f}s)")
