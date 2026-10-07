"""Picking a different part of the song keeps the clips, their order and their edits; cuts move onto the new beats."""
import os, pathlib, shutil, sys, tempfile
os.environ["CADENCE_DATA"] = tempfile.mkdtemp(prefix="cadence-")
ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import numpy as np
from engine import project as P, sample

p = sample.build()
pid = p["id"]
P.update(pid, lambda q: q["settings"].update(length="15"))
p = P.replan(pid, length="15")                      # 15s of a 36s song, auto-picked section
song = p["songs"][0]
before = [(s["media"], s["fit"], s.get("kb") and s["kb"]["dx"]) for s in p["shots"]]
before_trim = song["trim"]
# the user stretches shot 3 by a beat (taking it from a neighbour) and tweaks shot 1 by hand, then moves the section two bars earlier
from engine import cutter
mm = {m["id"]: m for m in p["media"]}
base = cutter.retime(p["shots"])
try:
  for i in range(len(base)):          # find any resize the rules allow (a tight 15s cut has little spare time)
    for d in (-1, 1):
        try:
            p["shots"] = cutter.resize_shot(base, mm, p["timeline"], i, d); raise StopIteration
        except ValueError:
            pass
except StopIteration:
  pass
assert p["shots"] is not base and [round(s["dur"], 2) for s in p["shots"]] != [round(s["dur"], 2) for s in base], "no resize was possible"
custom = [round(s["dur"], 2) for s in p["shots"]]
p["shots"][1]["fx"], p["shots"][1]["fy"] = 0.2, 0.7
P.update(pid, lambda q: q.update(shots=p["shots"]))
import engine.project as EP
EP.update(pid, lambda q: (q["songs"][0].update(start=before_trim[0] - 4.45), EP.apply_length(q)))  # two bars earlier: same length, new beats
q = P.resync(pid)
after = [(s["media"], s["fit"], s.get("kb") and s["kb"]["dx"]) for s in q["shots"]]
T = np.array(q["timeline"]["beats"])
off = max(abs(T - s["start"]).min() for s in q["shots"][1:])
print(f"trim {before_trim} -> {q['songs'][0]['trim']} | shots {len(before)} -> {len(after)} | same clips in same order: {[a[0] for a in after] == [b[0] for b in before]}")
print(f"hand edit kept: {q['shots'][1]['fx']}, {q['shots'][1]['fy']} | total {sum(s['dur'] for s in q['shots']):.3f}/{q['timeline']['duration']} | off-beat {off*1000:.0f}ms")
assert q["songs"][0]["trim"] != before_trim
assert [a[0] for a in after] == [b[0] for b in before], "clips changed or reordered"
assert (q["shots"][1]["fx"], q["shots"][1]["fy"]) == (0.2, 0.7), "per-shot edit lost"
assert abs(sum(s["dur"] for s in q["shots"]) - q["timeline"]["duration"]) < 0.01 and off < 0.002
new_durs = [round(s["dur"], 2) for s in q["shots"]]
drift = max(abs(a - b) for a, b in zip(custom, new_durs))
print(f"custom rhythm kept: max change per shot {drift:.2f}s (tempo {p['songs'][0]['analysis']['bpm']} BPM)")
assert drift < 0.08, "the edit's own shot lengths were not preserved"
EP.update(pid, lambda q: (q["songs"][0].update(start=33.0), EP.apply_length(q)))   # runs into the end of the song
r = P.resync(pid)
T2 = np.array(r["timeline"]["beats"])
assert [s["media"] for s in r["shots"]] == [s["media"] for s in q["shots"]], "clips changed when the section was clamped"
assert abs(sum(s["dur"] for s in r["shots"]) - r["timeline"]["duration"]) < 0.01 and max(abs(T2 - s["start"]).min() for s in r["shots"][1:]) < 0.002
assert min(s["dur"] for s in r["shots"]) >= 0.3
print(f"clamped section: video {q['timeline']['duration']:.1f}s -> {r['timeline']['duration']:.1f}s, {len(r['shots'])} shots, all on beats")
print("resync ok")
