"""First-cut planner: turns a beat grid + a pile of media into a beat-synced shot list.

1. build_timeline  — stitch the songs' (trimmed) beat grids into one timeline.
2. plan_cuts       — walk the beats choosing cut points: stride 1/2/4/8 beats driven by local energy and the
                     pace slider, snapped to downbeats, forced onto drops and song joins. Retries denser
                     until every clip can be used at least once.
3. assign          — give each slot a clip: round-robin in the chosen order, long clips are split into
                     several best-scoring windows, photos get a Ken-Burns drift, off-ratio clips get
                     blurred-background "fit" instead of a heavy crop.
"""
import random
import uuid
from collections import deque

import numpy as np

RATIOS = {
    "9:16": (1080, 1920),
    "4:5": (1080, 1350),
    "1:1": (1080, 1080),
    "16:9": (1920, 1080),
}
MIN_SHOT = 0.32
EDGE = 0.35  # no cut closer than this to either end
BLUR_FIT_LOSS = 0.45  # crop loss above which a clip is letterboxed over a blurred copy of itself
SCORE_HZ = 3


def uid() -> str:
    return uuid.uuid4().hex[:8]


# --------------------------------------------------------------------------- timeline
def build_timeline(songs: list[dict]) -> dict:
    """songs: [{analysis, trim:[s,e]}] in play order -> one merged beat grid."""
    T, down, energy, drops, bounds = [], [], [], [], []
    offset = 0.0
    for si, song in enumerate(songs):
        a = song["analysis"]
        s, e = song.get("trim") or [0.0, a["duration"]]
        e = min(e, a["duration"])
        if e - s < 0.5:
            continue
        if offset > 0:
            bounds.append(round(offset, 3))
            if T and offset - T[-1] < 0.15:  # drop a beat crowding the join
                for arr in (T, down, energy):
                    arr.pop()
            T.append(offset)
            down.append(True)
            energy.append(a["energy"][0] if a["energy"] else 0.5)
        dset = set(a["drops"])
        dn = set(a["downbeats"])
        for i, b in enumerate(a["beats"]):
            if b < s - 1e-6 or b >= e - 1e-6:
                continue
            t = offset + b - s
            if si > 0 and t - offset < 0.15:
                continue
            if i in dset:
                drops.append(len(T))
            T.append(round(t, 3))
            down.append(i in dn)
            energy.append(a["energy"][i])
        offset += e - s
    return {"duration": round(offset, 3), "beats": T, "down": down, "energy": energy, "drops": drops,
            "bounds": bounds}


def _subdivide(tl: dict) -> dict:
    T, dn, en, drops = tl["beats"], tl["down"], tl["energy"], set(tl["drops"])
    nT, nd, ne, ndr = [], [], [], []
    for i, t in enumerate(T):
        if i in drops:
            ndr.append(len(nT))
        nT.append(t)
        nd.append(dn[i])
        ne.append(en[i])
        if i + 1 < len(T) and T[i + 1] - t > 0.3 and (t + T[i + 1]) / 2 not in tl["bounds"]:
            nT.append(round((t + T[i + 1]) / 2, 3))
            nd.append(False)
            ne.append(en[i])
    return {**tl, "beats": nT, "down": nd, "energy": ne, "drops": ndr}


# --------------------------------------------------------------------------- cut planning
def _walk(tl: dict, pace: float, scale: float, rng: random.Random) -> list[int]:
    """Returns beat indices of the cuts (excluding the implicit cut at 0 and the end)."""
    T, dn, en = tl["beats"], tl["down"], tl["energy"]
    D = tl["duration"]
    drops, bounds = set(tl["drops"]), set(i for i, t in enumerate(T) if t in tl["bounds"])
    n = len(T)
    if n < 2:
        return []
    lt = (3.4 - 2.9 * pace ** 0.85) * scale
    cuts: list[int] = []
    # first cut: a downbeat close to the start if there is one, else the first beat past EDGE
    first = next((i for i, t in enumerate(T) if t >= 0.6), None)  # skip a count-in blip before the first beat
    if first is None:
        return []
    d0 = next((i for i in range(first, n) if dn[i] and T[i] <= max(1.6 * lt, 1.2)), None)
    c = d0 if d0 is not None else first
    if T[c] > D - EDGE:
        return []
    cuts.append(c)
    while True:
        period = (T[min(c + 4, n - 1)] - T[c]) / max(min(c + 4, n - 1) - c, 1)
        if period <= 0.05:
            break
        e = en[c]
        k_des = max(lt * (1.45 - 0.9 * e) / period, 1.0)
        k = min((1, 2, 4, 8), key=lambda v: abs(np.log2(v) - np.log2(k_des)))
        if k >= 2 and rng.random() < 0.18:
            k //= 2
        while k * period < MIN_SHOT and k < 16:
            k *= 2
        j = c + k
        if j >= n:
            break
        if k >= 2 and not dn[j]:
            alt = [x for x in (j - 1, j + 1) if c < x < n and dn[x] and x - c >= 1]
            if alt:
                j = alt[0]
        for d in sorted(drops):
            if c < d <= j and d - c >= 1:
                j = d
                break
        b = next((x for x in sorted(bounds) if c < x <= j), None)
        if b is not None:
            j = b
        if T[j] > D - EDGE:
            break
        cuts.append(j)
        c = j
    return cuts


def plan_cuts(tl: dict, pace: float, seed: int, min_shots: int) -> tuple[list[float], dict]:
    rng = random.Random(seed)
    work = tl
    scale = 1.0
    best: list[int] = []
    for phase in range(2):
        for _ in range(16):
            cuts = _walk(work, pace, scale, random.Random(rng.random()))
            best = cuts
            if len(cuts) + 1 >= min_shots:
                break
            scale *= 0.8
        if len(best) + 1 >= min_shots or phase == 1:
            break
        work, scale = _subdivide(work), 1.0  # last resort: cut on the half-beat as well
    times = [0.0] + [work["beats"][i] for i in best] + [tl["duration"]]
    return times, work


# --------------------------------------------------------------------------- clip assignment
def crop_loss(mw: int, mh: int, tw: int, th: int) -> float:
    am, at = mw / mh, tw / th
    vis = at / am if am > at else am / at
    return 1.0 - vis


def pick_window(m: dict, dur: float, used: list[tuple[float, float]] | None = None) -> dict | None:
    """Best-scoring [in, in+dur) window of a video that doesn't overlap `used`. None if exhausted."""
    dv = m["duration"]
    if dv <= dur + 0.05:
        speed = max(0.5, min(1.0, dv / max(dur, 0.01)))
        return {"in": 0.0, "speed": round(speed, 3)}
    sc = np.array(m.get("scores") or [0.5] * int(dv * SCORE_HZ + 1))
    cs = np.r_[0, np.cumsum(sc)]
    w = max(1, int(round(dur * SCORE_HZ)))
    margin = min(0.4, (dv - dur) / 2)
    first, last = int(np.ceil(margin * SCORE_HZ)), int(np.floor((dv - dur - margin) * SCORE_HZ))
    last = min(last, len(sc) - w)
    if last < first:
        first = last = max(0, min(first, len(sc) - w))
    best, best_s = None, -1.0
    for s in range(first, last + 1):
        t0 = s / SCORE_HZ
        if used and any(t0 < b and t0 + dur > a + 0.25 * dur and min(t0 + dur, b) - max(t0, a) > 0.3 * dur for a, b in used):
            continue
        score = (cs[s + w] - cs[s]) / w
        if score > best_s:
            best, best_s = t0, score
    if best is None:
        return None
    return {"in": round(best, 3), "speed": 1.0}


def _fit_for(m: dict, tw: int, th: int) -> str:
    return "blur" if crop_loss(m["w"], m["h"], tw, th) > BLUR_FIT_LOSS else "fill"


def assign(cuts: list[float], items: list[dict], size: tuple[int, int], tl: dict, seed: int) -> tuple[list[dict], list[str]]:
    rng = random.Random(seed + 1)
    tw, th = size
    queue = deque(items)
    used: dict[str, list[tuple[float, float]]] = {m["id"]: [] for m in items}
    uses: dict[str, int] = {m["id"]: 0 for m in items}
    shots: list[dict] = []
    down_times = {t for t, d in zip(tl["beats"], tl["down"]) if d}
    drop_times = {tl["beats"][i] for i in tl["drops"] if i < len(tl["beats"])}
    for i in range(len(cuts) - 1):
        start, end = cuts[i], cuts[i + 1]
        dur = round(end - start, 3)
        chosen, win = None, None
        for attempt in range(2):
            if not queue:
                queue.extend(items)
                for k in used:
                    used[k] = []
            # look a few clips ahead for one that's long enough, otherwise take the head
            order = list(queue)[:4]
            fits = [m for m in order if m["kind"] == "image" or m["duration"] >= dur * 0.9]
            for m in (fits or order):
                if m["kind"] == "image":
                    chosen, win = m, {"in": 0.0, "speed": 1.0}
                    break
                w = pick_window(m, dur, used[m["id"]])
                if w is not None:
                    chosen, win = m, w
                    break
                queue.remove(m)  # exhausted
            if chosen:
                break
        if chosen is None:  # everything exhausted twice over — reuse freely
            chosen = items[i % len(items)]
            win = {"in": 0.0, "speed": 1.0} if chosen["kind"] == "image" else (pick_window(chosen, dur) or {"in": 0.0, "speed": 1.0})
        queue.remove(chosen) if chosen in queue else None
        queue.append(chosen)
        uses[chosen["id"]] += 1
        if chosen["kind"] == "video":
            used[chosen["id"]].append((win["in"], win["in"] + dur * win["speed"]))
        shot = {
            "id": uid(), "media": chosen["id"], "in": win["in"], "speed": win["speed"], "dur": dur,
            "start": round(start, 3), "fit": _fit_for(chosen, tw, th), "fx": None, "fy": None,
            "punch": 0.0,
        }
        if i > 0:
            shot["punch"] = 1.2 if start in drop_times else (1.0 if start in down_times else 0.6)
        if chosen["kind"] == "image":
            z_in = uses[chosen["id"]] % 2 == 1
            shot["kb"] = {"z0": 1.0 if z_in else 1.09, "z1": 1.09 if z_in else 1.0,
                          "dx": rng.choice([-1, 1]) * 0.5, "dy": rng.choice([-1, 1]) * 0.35}
        shots.append(shot)
    unused = [m["id"] for m in items if uses[m["id"]] == 0]
    return shots, unused


def order_items(media: list[dict], order: str, seed: int) -> list[dict]:
    items = [m for m in media if m.get("status") == "ready"]
    if order == "chrono":
        key = lambda im: (im[1].get("created") or im[1].get("modified") or 0, im[0])
        return [m for _, m in sorted(enumerate(items), key=key)]
    if order == "shuffle":
        r = random.Random(seed)
        r.shuffle(items)
    return items


def plan(media: list[dict], songs: list[dict], ratio: str, pace: float, seed: int, order: str) -> dict:
    tl = build_timeline(songs)
    items = order_items(media, order, seed)
    if not items or not tl["beats"]:
        return {"timeline": tl, "shots": [], "unused": []}
    cuts, work = plan_cuts(tl, pace, seed, len(items))
    shots, unused = assign(cuts, items, RATIOS[ratio], work, seed)
    return {"timeline": tl, "shots": shots, "unused": unused}


def retime(shots: list[dict]) -> list[dict]:
    t = 0.0
    for s in shots:
        s["start"] = round(t, 3)
        t += s["dur"]
    return shots
