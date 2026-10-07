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
PHOTO_MIN, PHOTO_PREF, PHOTO_MAX = 0.5, 1.0, 2.0   # photos read best around a second
VIDEO_MIN, VIDEO_MAX = 1.0, 5.0                      # videos get 1-5s depending on the beat
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
        for attempt in range(len(items) + 1):
            if not queue:
                queue.extend(items)
                for k in used:
                    used[k] = []
            # strictly in order (chronological by default): the next clip in line, skipping only exhausted videos
            m = queue[0]
            if m["kind"] == "image":
                chosen, win = m, {"in": 0.0, "speed": 1.0}
            else:
                w = pick_window(m, dur, used[m["id"]])
                if w is not None:
                    chosen, win = m, w
                else:
                    queue.popleft()  # exhausted
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



def _caps(m: dict) -> tuple[float, float]:
    """(comfortable max, stretched max) shot length for a clip. Stretching is only used to fill spare song time
    instead of repeating clips."""
    if m["kind"] == "image":
        return PHOTO_MAX, 3.0
    dv = max(m["duration"], 1.0)
    return min(VIDEO_MAX, dv), min(12.0, dv)


def _group_cost(m: dict, T: float, pace: float) -> float:
    """How well a clip suits a slot of length T. Photos like ~1s, videos 1-5s (leaning longer when calm); longer than
    that is allowed (gently penalised) up to the stretch cap so spare time is absorbed rather than clips repeated."""
    hi, stretch = _caps(m)
    if m["kind"] == "image":
        pref = 1.3 - 0.5 * pace
        c = abs(T - pref) * 0.9
        if T > 1.6:
            c += 1.0 + (T - 1.6) * 6 if T <= hi else 1.0 + (hi - 1.6) * 6 + (T - hi) * 1.5
        if T > stretch:
            c += 4 + (T - stretch) * 8
        if T < PHOTO_MIN:
            c += 2.0
        return c
    pref = 3.0 - 1.7 * pace
    if T < VIDEO_MIN:
        return (VIDEO_MIN - T) * 3.0 + 0.5
    if T > hi:
        return 0.3 + (T - hi) * 1.2 + (4 + (T - stretch) * 8 if T > stretch else 0)
    return abs(T - min(pref, hi)) * 0.2


def merge_to_fit(cuts: list[float], seq: list[dict], tl: dict, pace: float) -> list[float]:
    """Merge neighbouring slots until there is exactly one per clip, choosing the merges that best suit each clip's type
    (dynamic programming over consecutive groups). Prefers ending groups on downbeats and keeping the cut on a drop."""
    N, K = len(cuts) - 1, len(seq)
    if N <= K:
        return cuts
    down = {t for t, d in zip(tl["beats"], tl["down"]) if d}
    drops = {tl["beats"][i] for i in tl["drops"] if i < len(tl["beats"])}
    INF = float("inf")
    G = 14
    dp = [[INF] * (N + 1) for _ in range(K + 1)]
    back = [[0] * (N + 1) for _ in range(K + 1)]
    dp[0][0] = 0.0
    for k in range(1, K + 1):
        m = seq[k - 1]
        for j in range(k, N - (K - k) + 1):
            for g in range(1, min(G, j - (k - 1)) + 1):
                jp = j - g
                if dp[k - 1][jp] == INF:
                    continue
                T = cuts[j] - cuts[jp]
                c = dp[k - 1][jp] + _group_cost(m, T, pace)
                if cuts[j] in down:
                    c -= 0.12
                if cuts[jp] in drops:
                    c -= 0.4
                if c < dp[k][j]:
                    dp[k][j], back[k][j] = c, jp
    out, j = [cuts[N]], N
    for k in range(K, 0, -1):
        j = back[k][j]
        out.append(cuts[j])
    return out[::-1]


def assign_seq(cuts: list[float], seq: list[dict], size: tuple[int, int], tl: dict, seed: int) -> list[dict]:
    """One clip per slot, in the given order. A video seen again gets a different window when one is free."""
    rng = random.Random(seed + 1)
    tw, th = size
    used: dict[str, list[tuple[float, float]]] = {}
    uses: dict[str, int] = {}
    down_times = {t for t, d in zip(tl["beats"], tl["down"]) if d}
    drop_times = {tl["beats"][i] for i in tl["drops"] if i < len(tl["beats"])}
    shots = []
    for i, m in enumerate(seq):
        start, end = cuts[i], cuts[i + 1]
        dur = round(end - start, 3)
        if m["kind"] == "image":
            win = {"in": 0.0, "speed": 1.0}
        else:
            win = pick_window(m, dur, used.setdefault(m["id"], [])) or pick_window(m, dur) or {"in": 0.0, "speed": 1.0}
            used[m["id"]].append((win["in"], win["in"] + dur * win["speed"]))
        uses[m["id"]] = uses.get(m["id"], 0) + 1
        shot = {"id": uid(), "media": m["id"], "in": win["in"], "speed": win["speed"], "dur": dur, "start": round(start, 3),
                "fit": _fit_for(m, tw, th), "fx": None, "fy": None, "punch": 0.0}
        if i > 0:
            shot["punch"] = 1.2 if start in drop_times else (1.0 if start in down_times else 0.6)
        if m["kind"] == "image":
            z_in = uses[m["id"]] % 2 == 1
            shot["kb"] = {"z0": 1.0 if z_in else 1.09, "z1": 1.09 if z_in else 1.0, "dx": rng.choice([-1, 1]) * 0.5, "dy": rng.choice([-1, 1]) * 0.35}
        shots.append(shot)
    return shots


def plan_no_repeat(items: list[dict], tl: dict, ratio: str, pace: float, seed: int) -> tuple[list[dict], list[str], dict, float | None]:
    """Every clip exactly once, in order, never repeated. Spare song time is absorbed by stretching shots (photos up to
    3s, videos up to their own length). If even that cannot fill the song, `cap` reports how long the clips can run so the
    caller can end the video there. If the song is too short for all clips they are thinned evenly (never reordered)."""
    D = tl["duration"]
    cap = sum(_caps(m)[1] for m in items) * 0.98
    seq = list(items)
    cuts, work = plan_cuts(tl, pace, seed, len(seq))
    n = len(cuts) - 1
    unused: list[str] = []
    if n < len(seq):
        keep = sorted({round(i * (len(seq) - 1) / max(n - 1, 1)) for i in range(n)})[:n]
        dropped = {seq[i]["id"] for i in range(len(seq)) if i not in keep}
        seq = [seq[i] for i in keep]
        unused = sorted(dropped - {m["id"] for m in seq})
    if len(cuts) - 1 > len(seq):
        cuts = merge_to_fit(cuts, seq, work, pace)
    shots = assign_seq(cuts, seq, RATIOS[ratio], work, seed)
    return shots, unused, work, (cap if D > cap + 0.5 else None)


def order_items(media: list[dict], order: str, seed: int) -> list[dict]:
    items = [m for m in media if m.get("status") == "ready"]
    if order == "chrono":
        key = lambda im: (im[1].get("taken") or im[1].get("created") or im[1].get("modified") or 0, im[1].get("name", ""), im[0])
        return [m for _, m in sorted(enumerate(items), key=key)]
    if order == "shuffle":
        r = random.Random(seed)
        r.shuffle(items)
    return items


def plan(media: list[dict], songs: list[dict], ratio: str, pace: float, seed: int, order: str, repeat: bool = False) -> dict:
    tl = build_timeline(songs)
    items = order_items(media, order, seed)
    if not items or not tl["beats"]:
        return {"timeline": tl, "shots": [], "unused": [], "cap": None}
    if repeat:  # cut to the pace slider and cycle through the clips as often as needed
        cuts, work = plan_cuts(tl, pace, seed, len(items))
        shots, unused = assign(cuts, items, RATIOS[ratio], work, seed)
    else:
        shots, unused, work, cap = plan_no_repeat(items, tl, ratio, pace, seed)
    shots = balance(shots, {m["id"]: m for m in items}, work)
    return {"timeline": work, "shots": shots, "unused": unused, "cap": cap if not repeat else None}


def retime(shots: list[dict]) -> list[dict]:
    t = 0.0
    for s in shots:
        s["start"] = round(t, 3)
        t += s["dur"]
    return shots


# --------------------------------------------------------------------------- resize / balance
def _nearest(T: list[float], t: float) -> int:
    lo, hi = 0, len(T) - 1
    while lo < hi:
        mid = (lo + hi) >> 1
        if T[mid] < t:
            lo = mid + 1
        else:
            hi = mid
    return lo - 1 if lo > 0 and abs(T[lo - 1] - t) < abs(T[lo] - t) else lo


def _avail(m: dict, s: dict) -> float:
    return m["duration"] / max(s.get("speed", 1.0), 0.25) if m["kind"] == "video" else 1e9


def _limits(m: dict, s: dict) -> tuple[float, float]:
    """(comfortable min, comfortable max) for a shot of this clip."""
    if m["kind"] == "image":
        return PHOTO_MIN, PHOTO_MAX
    return VIDEO_MIN, min(VIDEO_MAX, _avail(m, s))


def _fix_window(s: dict, m: dict) -> None:
    if m["kind"] == "video":
        need = s["dur"] * s["speed"]
        s["in"] = round(max(0.0, min(s["in"], m["duration"] - need)), 3)


def resize_shot(shots: list[dict], media: dict[str, dict], tl: dict, i: int, direction: int, strict: bool = True) -> list[dict]:
    """Make shot i one beat longer (+1) or shorter (-1) by moving the cuts between it and the nearest shot that can
    take / give that beat: videos first (they can run 1-5s), photos only if no video can. The song length and every
    cut-on-a-beat stay intact. Raises ValueError with a human message when nothing can give."""
    n, T = len(shots), tl["beats"]
    if n < 2:
        raise ValueError("Only one shot")
    D = tl["duration"]
    me = shots[i]
    k = _nearest(T, me["start"])
    b = (T[k + 1] - T[k]) if k + 1 < len(T) else (T[k] - T[k - 1])
    lo_i, hi_i = _limits(media[me["media"]], me)
    if strict:
        if direction > 0 and me["dur"] + b > hi_i + 0.05:
            raise ValueError("Photos look best at 2s or less" if media[me["media"]]["kind"] == "image" else "That's as long as this clip goes")
        if direction < 0 and me["dur"] - b < 0.5 - 0.05:
            raise ValueError("Already as short as it goes")
    bounds = tl.get("bounds", [])
    order = sorted((j for j in range(n) if j != i), key=lambda j: (abs(j - i), j < i))

    def ok(j: int) -> bool:
        s = shots[j]
        lo, hi = _limits(media[s["media"]], s)
        if direction > 0:   # j gives a beat
            return s["dur"] - b >= lo - 0.02
        return s["dur"] + b <= hi + 0.02   # j takes a beat

    def crosses_join(j: int) -> bool:
        a, z = (i + 1, j) if j > i else (j + 1, i)
        return any(abs(shots[x]["start"] - bt) < 0.02 for x in range(a, z + 1) for bt in bounds)

    pick = None
    for want_video in (True, False):
        for j in order:
            if (media[shots[j]["media"]]["kind"] == "video") == want_video and ok(j) and not crosses_join(j):
                pick = j
                break
        if pick is not None:
            break
    if pick is None:
        raise ValueError("No room — every other shot is at its limit" if direction > 0 else "No other shot can take the time")
    j = pick
    shift = direction if j > i else -direction
    a, z = (i + 1, j) if j > i else (j + 1, i)
    starts = [x["start"] for x in shots] + [D]
    for x in range(a, z + 1):
        idx = _nearest(T, starts[x]) + shift
        if not 0 <= idx < len(T):
            raise ValueError("No more beats")
        starts[x] = T[idx]
    durs = [round(starts[x + 1] - starts[x], 3) for x in range(n)]
    if min(durs) < MIN_SHOT:
        raise ValueError("Too tight there")
    out = [dict(x) for x in shots]
    for x in range(n):
        out[x]["start"], out[x]["dur"] = round(starts[x], 3), durs[x]
        _fix_window(out[x], media[out[x]["media"]])
    return out


def balance(shots: list[dict], media: dict[str, dict], tl: dict) -> list[dict]:
    """Nudge shots toward the house rules: photos ~1s (never much over 1.6s), videos at least 1s. Time moves between
    neighbours a beat at a time, so everything stays on the beat grid."""
    cur = [dict(x) for x in shots]
    for _ in range(80):
        moved = False
        for i, s in enumerate(cur):
            kind = media[s["media"]]["kind"]
            try:
                if kind == "image" and s["dur"] > 1.6:
                    cur = resize_shot(cur, media, tl, i, -1)
                    moved = True
                elif kind == "video" and s["dur"] < VIDEO_MIN - 0.08 and s["dur"] < _avail(media[s["media"]], s) - 0.1:
                    cur = resize_shot(cur, media, tl, i, +1, strict=False)
                    moved = True
            except ValueError:
                continue
            if moved:
                break
        if not moved:
            break
    return cur


def _apply_cuts(shots: list[dict], keep: list[int], cuts: list[float], media: dict[str, dict], work: dict) -> list[dict]:
    down = {t for t, d in zip(work["beats"], work["down"]) if d}
    drops = {work["beats"][i] for i in work["drops"] if i < len(work["beats"])}
    out = []
    for slot, idx in enumerate(keep):
        s = dict(shots[idx])
        s["start"], s["dur"] = round(cuts[slot], 3), round(cuts[slot + 1] - cuts[slot], 3)
        s["punch"] = 0.0 if slot == 0 else (1.2 if s["start"] in drops else (1.0 if s["start"] in down else 0.6))
        _fix_window(s, media[s["media"]])
        out.append(s)
    return out


def _snap_cuts(shots: list[dict], tl: dict) -> list[float] | None:
    """Move each existing cut to the nearest beat of the new grid, keeping the order and the edit's own rhythm (including any
    shots the user made longer or shorter). None if the new grid can't hold every cut."""
    n, T, D = len(shots), tl["beats"], tl["duration"]
    old_D = shots[-1]["start"] + shots[-1]["dur"]
    scale = D / old_D if old_D else 1.0
    cuts, prev_t, prev_k = [0.0], 0.0, -1
    for s in shots[1:]:
        k = max(_nearest(T, s["start"] * scale), prev_k + 1)
        while k < len(T) and T[k] - prev_t < MIN_SHOT:
            k += 1
        if k >= len(T) or T[k] > D - MIN_SHOT:
            return None
        cuts.append(T[k]); prev_t, prev_k = T[k], k
    return cuts + [D]


def resync(shots: list[dict], media: dict[str, dict], tl: dict, pace: float, seed: int) -> tuple[list[dict], dict]:
    """Re-time an existing edit onto a new beat grid (e.g. after picking a different part of the song). The clips, their
    order and every per-shot edit (window, fit, focus, Ken Burns, custom lengths) are kept; the cuts move onto the new beats.
    If the new section is very different (or joins several songs) the cuts are re-planned instead, still keeping clips + order."""
    n = len(shots)
    old_D = shots[-1]["start"] + shots[-1]["dur"] if shots else 0
    cuts = None
    if n >= 2 and not tl.get("bounds") and old_D and abs(tl["duration"] / old_D - 1) <= 0.25:
        cuts = _snap_cuts(shots, tl)
    if cuts is not None:
        return _apply_cuts(shots, list(range(n)), cuts, media, tl), tl
    seq = [media[s["media"]] for s in shots]
    cuts, work = plan_cuts(tl, pace, seed, n)
    if len(cuts) - 1 > n:
        cuts = merge_to_fit(cuts, seq, work, pace)
    keep = list(range(n))
    if len(cuts) - 1 < n:  # grid too sparse for every shot: keep an even spread, in order
        m = len(cuts) - 1
        keep = sorted({round(i * (n - 1) / max(m - 1, 1)) for i in range(m)})[:m]
        cuts = cuts[: len(keep) + 1]
    return balance(_apply_cuts(shots, keep, cuts, media, work), media, work), work
