"""No clip is ever repeated (unless the user turns repeats on): spare time stretches shots, and if even that
isn't enough the video ends early; too many clips for the song are thinned evenly, never reordered."""
import collections, os, pathlib, shutil, sys, tempfile
os.environ["CADENCE_DATA"] = tempfile.mkdtemp(prefix="cadence-")
ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import numpy as np
from engine import media as media_mod, project as P

SAMPLES = ROOT / "samples"
song = SAMPLES / "Sunday Drive.mp3"


def build(files, length, repeat=False):
    p = P.create("t"); pid = p["id"]
    (P.pdir(pid) / "songs").mkdir(); shutil.copy(song, P.pdir(pid) / "songs" / "s.mp3")
    s = P.add_song_entry(pid, song.name, "s.mp3"); P.ingest_song(pid, s["id"])
    for f in files:
        e = P.add_media_entry(pid, f.name, media_mod.kind_of(f.name), "orig" + f.suffix, 1e9)
        d = P.pdir(pid) / "media" / e["id"]; d.mkdir(parents=True); shutil.copy(f, d / ("orig" + f.suffix)); P.ingest_media(pid, e["id"])
    return P.replan(pid, pace=0.5, length=length, order="chrono", repeat=repeat)


def check(out, label, expect_repeats=False):
    cnt = collections.Counter(s["media"] for s in out["shots"])
    rep = sum(1 for v in cnt.values() if v > 1)
    T = np.array(out["timeline"]["beats"])
    off = max(abs(T - s["start"]).min() for s in out["shots"][1:])
    D = out["timeline"]["duration"]
    print(f"{label}: {len(out['shots'])} shots / {len(out['media'])} clips | repeated {rep} | unused {len(out['unused'])} | video {D:.1f}s "
          f"| longest shot {max(s['dur'] for s in out['shots']):.1f}s | off-beat {off*1000:.0f}ms" + (f" | note: {out['note'][:48]}…" if out.get("note") else ""))
    assert abs(sum(s["dur"] for s in out["shots"]) - D) < 0.01 and off < 0.002
    if not expect_repeats:
        assert rep == 0, "a clip was repeated"
    return out

all10 = sorted(f for f in SAMPLES.iterdir() if f.name[:2].isdigit() and f.suffix in (".mp4", ".jpg"))
check(build(all10, "full"), "10 clips, 36s song, full")
few = [f for f in all10 if f.name.startswith(("01", "02", "08", "09"))]
o = check(build(few, "full"), "4 clips, 36s song, full  (ends early, no repeats)")
assert o["timeline"]["duration"] < 30 and o["note"]
check(build(few, "15"), "4 clips, 15s")
assets = pathlib.Path(__file__).parent / "assets"
many = all10 + sorted(assets.glob("v_*.mp4")) + sorted(assets.glob("p_*.jpg"))
o = check(build(many, "15"), "20 clips, 15s  (thinned evenly)")
o = check(build(few, "full", repeat=True), "4 clips, repeats ON", expect_repeats=True)
print("no-repeat ok")
