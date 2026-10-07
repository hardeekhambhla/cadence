"""Cadence — beat-synced video editor. Local Flask app; all heavy lifting is ffmpeg + numpy."""
import hashlib
import pathlib
import re
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor

from flask import Flask, abort, jsonify, request, send_file, send_from_directory
from werkzeug.utils import secure_filename

from engine import cutter, media as media_mod, project as P, render

app = Flask(__name__, static_folder="static", static_url_path="/static")
app.config["MAX_CONTENT_LENGTH"] = 8 * 1024 ** 3
ingest_pool = ThreadPoolExecutor(3)
export_pool = ThreadPoolExecutor(1)
jobs: dict[str, dict] = {}
ONE_YEAR = {"Cache-Control": "public, max-age=31536000, immutable"}


def project_or_404(pid: str) -> dict:
    if not re.fullmatch(r"[0-9a-f]{10}", pid) or not (P.pdir(pid) / "project.json").exists():
        abort(404)
    return P.load(pid)


@app.get("/")
def index():
    return send_from_directory("static", "index.html", max_age=0)


# ------------------------------------------------------------------ projects
@app.get("/api/projects")
def projects():
    return jsonify(P.list_projects())


@app.post("/api/projects")
def create_project():
    body = request.get_json(silent=True) or {}
    proj = P.create(body.get("name") or "Untitled")
    preset = P.PRESETS.get(body.get("preset"))
    if preset:
        proj["ratio"], proj["settings"]["length"] = preset
        proj["preset"] = body["preset"]
        P.save(proj)
    return jsonify(proj)


def view(p: dict) -> dict:
    return {**p, "suggest": P.suggest_ratio(p["media"])}


@app.get("/api/projects/<pid>")
def get_project(pid):
    return jsonify(view(project_or_404(pid)))


@app.put("/api/projects/<pid>")
def put_project(pid):
    project_or_404(pid)
    body = request.get_json(force=True)

    def apply(p):
        if "name" in body:
            p["name"] = str(body["name"])[:80] or "Untitled"
        if body.get("ratio") in cutter.RATIOS:
            p["ratio"] = body["ratio"]
        length_changed = "length" in body.get("settings", {}) and str(body["settings"]["length"]) != str(p["settings"].get("length"))
        if "settings" in body:
            for k in ("pace", "style", "filter", "order", "seed", "volume", "length"):
                if k in body["settings"]:
                    p["settings"][k] = body["settings"][k]
        if "shots" in body:
            p["shots"] = cutter.retime(body["shots"])
        if length_changed:
            P.apply_length(p)
        if "songOrder" in body:
            pos = {sid: i for i, sid in enumerate(body["songOrder"])}
            p["songs"].sort(key=lambda s: pos.get(s["id"], 99))

    p = P.update(pid, apply)
    P.ensure_audio(pid)
    return jsonify(view(P.load(pid)))


@app.delete("/api/projects/<pid>")
def delete_project(pid):
    project_or_404(pid)
    P.delete(pid)
    return jsonify(ok=True)


@app.post("/api/sample")
def sample():
    from engine import sample as demo
    return jsonify(view(demo.build()))


# ------------------------------------------------------------------ uploads
@app.post("/api/projects/<pid>/songs")
def upload_song(pid):
    project_or_404(pid)
    f = request.files["file"]
    ext = pathlib.Path(secure_filename(f.filename or "song.mp3")).suffix.lower() or ".mp3"
    sid_file = f"{uuid.uuid4().hex[:10]}{ext}"
    d = P.pdir(pid) / "songs"
    d.mkdir(exist_ok=True)
    f.save(d / sid_file)
    entry = P.add_song_entry(pid, f.filename or "Song", sid_file)
    ingest_pool.submit(P.ingest_song, pid, entry["id"])
    return jsonify(entry)


@app.delete("/api/projects/<pid>/songs/<sid>")
def delete_song(pid, sid):
    project_or_404(pid)
    def drop(p):
        p["songs"] = [s for s in p["songs"] if s["id"] != sid]
    P.update(pid, drop)
    return jsonify(view(P.load(pid)))


@app.post("/api/projects/<pid>/media")
def upload_media(pid):
    project_or_404(pid)
    f = request.files["file"]
    name = secure_filename(f.filename or "clip.mp4") or "clip.mp4"
    ext = pathlib.Path(name).suffix.lower() or ".bin"
    kind = media_mod.kind_of(name, f.mimetype or "")
    modified = request.form.get("modified", type=float)
    entry = P.add_media_entry(pid, f.filename or name, kind, f"orig{ext}", modified / 1000 if modified else None)
    d = P.pdir(pid) / "media" / entry["id"]
    d.mkdir(parents=True, exist_ok=True)
    f.save(d / f"orig{ext}")
    ingest_pool.submit(P.ingest_media, pid, entry["id"])
    return jsonify(entry)


@app.delete("/api/projects/<pid>/media/<mid>")
def delete_media(pid, mid):
    project_or_404(pid)
    def drop(p):
        p["media"] = [m for m in p["media"] if m["id"] != mid]
        p["shots"] = [s for s in p["shots"] if s["media"] != mid]
        P.cutter.retime(p["shots"])
    P.update(pid, drop)
    import shutil
    shutil.rmtree(P.pdir(pid) / "media" / mid, ignore_errors=True)
    return jsonify(view(P.load(pid)))


# ------------------------------------------------------------------ files
@app.get("/api/projects/<pid>/media/<mid>/<path:name>")
def media_file(pid, mid, name):
    project_or_404(pid)
    d = P.pdir(pid) / "media" / mid
    if name == "frame.jpg":  # on-demand video frame (timeline thumbs, trim preview)
        m = next((x for x in P.load(pid)["media"] if x["id"] == mid), None)
        if not m or m["kind"] != "video" or m["status"] != "ready":
            abort(404)
        t = max(0.0, request.args.get("t", 0, type=float))
        w = min(max(request.args.get("w", 160, type=int), 48), 720)
        cache = d / "t"
        cache.mkdir(exist_ok=True)
        out = cache / f"{int(t * 10)}_{w}.jpg"
        if not out.exists():
            media_mod.thumb_at(str(d / m["proxy"]), min(t, max(m["duration"] - 0.05, 0)), str(out), w)
        return send_file(out, max_age=31536000)
    if "/" in name or name.startswith("."):
        abort(404)
    return send_from_directory(d, name, max_age=31536000, conditional=True)


@app.get("/api/projects/<pid>/audio.m4a")
def audio_file(pid):
    project_or_404(pid)
    f = P.pdir(pid) / "audio.m4a"
    if not f.exists():
        abort(404)
    return send_file(f, mimetype="audio/mp4", conditional=True, max_age=0)


# ------------------------------------------------------------------ editing
@app.post("/api/projects/<pid>/plan")
def plan(pid):
    p = project_or_404(pid)
    if not any(s["status"] == "ready" for s in p["songs"]) or not any(m["status"] == "ready" for m in p["media"]):
        abort(400, "need at least one song and one clip")
    b = request.get_json(silent=True) or {}
    out = P.replan(pid, pace=b.get("pace"), seed=b.get("seed"), order=b.get("order"), ratio=b.get("ratio"), length=b.get("length"))
    return jsonify(view(out))


@app.post("/api/projects/<pid>/pick")
def pick(pid):
    p = project_or_404(pid)
    b = request.get_json(force=True)
    m = next((x for x in p["media"] if x["id"] == b["media"]), None)
    if not m:
        abort(404)
    size = cutter.RATIOS[p["ratio"]]
    out = {"fit": cutter._fit_for(m, *size)}
    if m["kind"] == "image":
        return jsonify({**out, "in": 0.0, "speed": 1.0, "kb": {"z0": 1.0, "z1": 1.09, "dx": 0.5, "dy": -0.35}})
    used = [(a, c) for a, c in b.get("avoid", [])]
    w = cutter.pick_window(m, float(b["dur"]), used) or cutter.pick_window(m, float(b["dur"])) or {"in": 0.0, "speed": 1.0}
    return jsonify({**out, **w})


# ------------------------------------------------------------------ export
def _run_export(jid: str, pid: str, quality: int):
    try:
        p = P.load(pid)
        slug = re.sub(r"[^a-z0-9]+", "-", p["name"].lower()).strip("-") or "cadence"
        d = P.pdir(pid) / "exports"
        d.mkdir(exist_ok=True)
        name = f"{slug}-{p['ratio'].replace(':', 'x')}-{quality}p-{int(time.time())}.mp4"
        render.export(p, P.pdir(pid), str(d / name), quality, progress=lambda v: jobs[jid].update(progress=round(v, 3)))
        jobs[jid].update(status="done", progress=1.0, file=name)
    except Exception as e:  # noqa: BLE001
        jobs[jid].update(status="error", error=str(getattr(e, "stderr", b"") or e)[-300:])


@app.post("/api/projects/<pid>/export")
def export(pid):
    p = project_or_404(pid)
    if not p["shots"]:
        abort(400, "nothing to export")
    quality = 720 if (request.get_json(silent=True) or {}).get("quality") == 720 else 1080
    jid = uuid.uuid4().hex[:10]
    jobs[jid] = {"status": "running", "progress": 0.0, "project": pid}
    export_pool.submit(_run_export, jid, pid, quality)
    return jsonify(id=jid)


@app.get("/api/jobs/<jid>")
def job(jid):
    j = jobs.get(jid)
    if not j:
        abort(404)
    return jsonify(j)


@app.get("/api/projects/<pid>/exports/<name>")
def export_file(pid, name):
    project_or_404(pid)
    return send_from_directory(P.pdir(pid) / "exports", name, as_attachment=request.args.get("dl") == "1", conditional=True)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8430, threaded=True)
