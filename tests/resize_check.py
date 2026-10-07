"""Checks the resize rules on the sample project: photos ~1s, videos 1-5s, cuts stay on beats, length fixed."""
import os, random, sys, tempfile, pathlib
os.environ["CADENCE_DATA"] = tempfile.mkdtemp(prefix="cadence-")
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
import numpy as np
from engine import cutter, sample

p = sample.build()
media = {m["id"]: m for m in p["media"]}
tl = p["timeline"]
T = np.array(tl["beats"])

def report(shots, label):
    ph = [round(s["dur"], 2) for s in shots if media[s["media"]]["kind"] == "image"]
    vd = [round(s["dur"], 2) for s in shots if media[s["media"]]["kind"] == "video"]
    off = max(abs(T - s["start"]).min() for s in shots[1:])
    print(f"{label}: {len(shots)} shots | photos {min(ph, default=0)}-{max(ph, default=0)}s | videos {min(vd, default=0)}-{max(vd, default=0)}s | "
          f"total {sum(s['dur'] for s in shots):.3f}/{tl['duration']} | max cut-off-beat {off*1000:.0f}ms")
    assert abs(sum(s["dur"] for s in shots) - tl["duration"]) < 0.01 and off < 0.002

shots = p["shots"]
report(shots, "first cut")
rng = random.Random(5); ok = fail = 0; msgs = set()
for _ in range(300):
    i, d = rng.randrange(len(shots)), rng.choice([-1, 1])
    try:
        shots = cutter.resize_shot(shots, media, tl, i, d); ok += 1
    except ValueError as e:
        fail += 1; msgs.add(str(e))
report(shots, f"after {ok} resizes ({fail} refused)")
print("refusals:", sorted(msgs))
# a photo made shorter should hand its beat to a video, and a video made longer should take it from another video
i = next(k for k, s in enumerate(shots) if media[s["media"]]["kind"] == "image" and s["dur"] > 0.6)
before = [round(s["dur"], 2) for s in shots]
after = [round(s["dur"], 2) for s in cutter.resize_shot(shots, media, tl, i, -1)]
changed = [(k, before[k], after[k]) for k in range(len(shots)) if before[k] != after[k]]
print("shorten a photo ->", [(k, media[shots[k]['media']]['kind'], a, b) for k, a, b in changed])
