"""Drives the real HTTP API with Flask's test client: create -> upload song+clips -> plan -> export."""
import os, pathlib, sys, time
data = os.environ.setdefault("CADENCE_DATA", "/tmp/cadence-ui")
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
import app as A

A_DIR = pathlib.Path(__file__).parent / "assets"
c = A.app.test_client()
pid = c.post("/api/projects", json={"name": "Untitled", "preset": "reel"}).get_json()["id"]
with open(A_DIR / "song_120.mp3", "rb") as f:
    c.post(f"/api/projects/{pid}/songs", data={"file": (f, "Sunday Drive.mp3")})
for name in sorted(x.name for x in A_DIR.iterdir() if x.name.startswith(("v_", "p_"))):
    with open(A_DIR / name, "rb") as f:
        c.post(f"/api/projects/{pid}/media", data={"file": (f, name), "modified": "1700000000000"})
for _ in range(120):
    p = c.get(f"/api/projects/{pid}").get_json()
    if all(s["status"] != "analyzing" for s in p["songs"]) and all(m["status"] != "processing" for m in p["media"]):
        break
    time.sleep(0.5)
print("songs", [s["status"] for s in p["songs"]], "media", sorted({m["status"] for m in p["media"]}), "suggest", p["suggest"])
out = c.post(f"/api/projects/{pid}/plan", json={"ratio": "9:16", "pace": 0.5, "length": "15"}).get_json()
print("shots", len(out["shots"]), "dur", out["timeline"]["duration"], "audio_v", out["audio_v"], "length", out["settings"]["length"])
j = c.post(f"/api/projects/{pid}/export", json={"quality": 720}).get_json()["id"]
for _ in range(120):
    r = c.get(f"/api/jobs/{j}").get_json()
    if r["status"] != "running": break
    time.sleep(0.5)
print("export", r)
print("PID", pid)
