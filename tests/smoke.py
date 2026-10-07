"""End-to-end engine check on synthetic media: ingest -> plan -> render -> verify cuts land on beats."""
import json, os, pathlib, shutil, subprocess, sys, tempfile, time
os.environ["CADENCE_DATA"] = tempfile.mkdtemp(prefix="cadence-")
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
import numpy as np
from engine import project as P

A = pathlib.Path(__file__).parent / "assets"
if not A.exists():
    subprocess.run([sys.executable, str(A.parent / "make_assets.py")], check=True)
ratio = sys.argv[1] if len(sys.argv) > 1 else "9:16"
pace = float(sys.argv[2]) if len(sys.argv) > 2 else 0.5
p = P.create("smoke")
pid = p["id"]
(P.pdir(pid) / "songs").mkdir()
shutil.copy(A / "song_120.mp3", P.pdir(pid) / "songs" / "a.mp3")
s = P.add_song_entry(pid, "song_120.mp3", "a.mp3")
t = time.time(); P.ingest_song(pid, s["id"]); print("song analysis %.2fs" % (time.time() - t))
files = sorted(f for f in A.iterdir() if f.name.startswith(("v_", "p_")))
t = time.time()
for f in files:
    kind = "image" if f.suffix == ".jpg" else "video"
    e = P.add_media_entry(pid, f.name, kind, "orig" + f.suffix, f.stat().st_mtime)
    d = P.pdir(pid) / "media" / e["id"]; d.mkdir(parents=True); shutil.copy(f, d / ("orig" + f.suffix))
    P.ingest_media(pid, e["id"])
print("ingest %d files %.2fs" % (len(files), time.time() - t))
t = time.time(); proj = P.replan(pid, pace=pace, ratio=ratio, length=(sys.argv[3] if len(sys.argv) > 3 else None)); print("plan+audio %.2fs" % (time.time() - t))
shots = proj["shots"]; tl = proj["timeline"]
print("shots", len(shots), "dur", tl["duration"], "unused", proj["unused"])
beats = np.array(tl["beats"])
off = [abs(beats - s_["start"]).min() * 1000 for s_ in shots[1:]]
print("cut->nearest beat ms: max %.0f" % max(off), "| durations:", sorted({round(s_["dur"], 2) for s_ in shots})[:8])
used = {s_["media"] for s_ in shots}; print("media used", len(used), "/", len(proj["media"]), "| fit modes", {s_["fit"] for s_ in shots})
out = str(P.pdir(pid) / "out.mp4")
from engine import render
t = time.time(); render.export(proj, P.pdir(pid), out, short_edge=540, progress=None); print("export %.2fs" % (time.time() - t))
r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,width,height,nb_frames,duration", "-of", "json", out], capture_output=True, text=True).stdout
print(json.dumps(json.loads(r)["streams"]))
print("OUT", out)
