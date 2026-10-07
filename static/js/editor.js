import { api, upload, thumbUrl, frameUrl, RATIOS, ratioAR, cropLoss } from './api.js';
import { h, icon, fmt, dur, seg, sheet, slider, toast, waveform } from './ui.js';
import { Player, FILTER_CSS } from './player.js';
import { LENGTHS, LOOKS, STYLES } from './looks.js';

const PPS = 72; // timeline pixels per second
const MIN_SHOT = 0.3;
const SWAP = ['media', 'in', 'speed', 'fit', 'fx', 'fy', 'kb'];

export async function editor(screen, pid, go) {
  let p = await api.get(pid);
  if (!p.shots.length) { go(`#/new/${pid}`); return; }
  let sel = -1, panel = null, focusMode = false, saveT = null, destroyed = false;
  const hist = [];

  // ------------------------------------------------------------------ DOM
  const undoBtn = h('button', { class: 'nav-btn', 'aria-label': 'Undo', disabled: true, onclick: undo }, icon('undo', 24));
  const title = h('div', { class: 'title on', onclick: rename }, p.name);
  const nav = h('div', { class: 'nav' },
    h('div', { class: 'l' }, h('button', { class: 'nav-btn', onclick: () => { flush(); go('#/'); } }, icon('back', 22), 'Videos')),
    title, h('div', { class: 'r' }, undoBtn, h('button', { class: 'nav-btn strong', onclick: exportSheet }, 'Export')));
  const stage = h('div', { class: 'stage paused' });
  const wrap = h('div', { class: 'stage-wrap' }, stage);
  const tap = h('div', { class: 'tap' });
  const hint = h('div', { class: 'playhint' }, h('i', {}, icon('play', 30)));
  const ring = h('div', { class: 'focus' });
  const playBtn = h('button', { class: 'play', 'aria-label': 'Play', onclick: () => player.toggle() }, icon('play', 20));
  const timeEl = h('div', { class: 't' }, '0:00.0');
  const info = h('div', { style: { marginLeft: 'auto' } });
  const transport = h('div', { class: 'transport' }, playBtn, timeEl, info);
  const scroller = h('div', { class: 'scroller' });
  const track = h('div', { class: 'track' });
  const tl = h('div', { class: 'tl' }, scroller, h('div', { class: 'head' }));
  scroller.append(track);
  const panelHost = h('div');
  const bar = h('div', { class: 'bar' });
  screen.classList.add('editor');
  screen.append(nav, wrap, transport, tl, panelHost, bar);
  stage.append(tap, hint, ring);
  const player = new Player(stage);
  stage.insertBefore(tap, null);

  // ------------------------------------------------------------------ helpers
  const mediaById = () => Object.fromEntries(p.media.map((m) => [m.id, m]));
  const D = () => p.timeline.duration;
  const retime = () => { let t = 0; for (const s of p.shots) { s.start = +t.toFixed(3); t += s.dur; } };
  const beats = () => p.timeline.beats;
  function nearestBeat(t) {
    const b = beats(); let lo = 0, hi = b.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (b[mid] < t) lo = mid + 1; else hi = mid; }
    return lo > 0 && Math.abs(b[lo - 1] - t) < Math.abs(b[lo] - t) ? lo - 1 : lo;
  }
  function refit(s) {
    const m = mediaById()[s.media];
    if (m.kind !== 'video') return;
    if (m.duration < s.dur * s.speed) s.speed = Math.max(0.5, +(m.duration / s.dur).toFixed(3));
    const need = s.dur * s.speed;
    s.in = +Math.max(0, Math.min(s.in, m.duration - need)).toFixed(3);
  }
  function snapshot() {
    hist.push(JSON.stringify({ shots: p.shots, ratio: p.ratio, settings: p.settings }));
    if (hist.length > 40) hist.shift();
    undoBtn.disabled = false;
  }
  async function undo() {
    if (!hist.length) return;
    Object.assign(p, JSON.parse(hist.pop()));
    undoBtn.disabled = !hist.length;
    sel = -1; refresh(true);
  }
  function persist() {
    clearTimeout(saveT);
    saveT = setTimeout(flush, 500);
  }
  function flush() {
    clearTimeout(saveT); saveT = null;
    const { length, ...settings } = p.settings; // length changes go through setLength (recomputes the soundtrack)
    return api.save(pid, { ratio: p.ratio, settings, shots: p.shots, name: p.name }).then((r) => { p.audio_v = r.audio_v; }).catch(() => toast('Could not save'));
  }
  function refresh(save) {
    retime();
    drawTimeline(); drawBar(); fitStage(); player.ratio = p.ratio;
    player.load(p); applyStageUI();
    info.textContent = `${p.shots.length} cuts · ${p.ratio}`;
    timeEl.textContent = `${fmt(player.t)} / ${fmt(D())}`;
    if (save) persist();
  }
  function applyStageUI() {
    stage.classList.toggle('paused', !player.playing);
    playBtn.replaceChildren(icon(player.playing ? 'pause' : 'play', 20));
    hint.firstChild.replaceChildren(icon('play', 30));
  }

  // ------------------------------------------------------------------ stage
  function fitStage() {
    const r = wrap.getBoundingClientRect(), ar = ratioAR(p.ratio);
    const aw = r.width - 32, ah = r.height - 12;
    const w = Math.max(80, Math.min(aw, ah * ar));
    stage.style.width = w + 'px'; stage.style.height = w / ar + 'px';
  }
  const ro = new ResizeObserver(() => { fitStage(); drawTimeline(true); });
  ro.observe(wrap);
  tap.addEventListener('pointerdown', (e) => {
    if (focusMode) return setFocus(e);
    player.toggle();
  });
  tap.addEventListener('pointermove', (e) => { if (focusMode && e.buttons) setFocus(e); });
  function setFocus(e) {
    const r = stage.getBoundingClientRect();
    const fx = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), fy = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    const s = p.shots[sel];
    if (!s) return;
    if (s.fit === 'blur') { s.fit = 'fill'; toast('Switched to Fill'); }
    s.fx = +fx.toFixed(3); s.fy = +fy.toFixed(3);
    ring.style.left = fx * 100 + '%'; ring.style.top = fy * 100 + '%';
    player.load(p); persist();
  }
  player.on((t) => {
    timeEl.textContent = `${fmt(t)} / ${fmt(D())}`;
    if (player.playing) { programmatic = true; scroller.scrollLeft = t * PPS; }
    const i = player.idxAt(t);
    if (i !== lastIdx) { lastIdx = i; markPlaying(i); }
  });
  player.onState(applyStageUI);
  let lastIdx = -1, programmatic = false;

  // ------------------------------------------------------------------ timeline
  function drawTimeline() {
    const w = scroller.clientWidth;
    track.style.width = D() * PPS + w + 'px';
    track.replaceChildren();
    const m = mediaById(), off = w / 2;
    p.shots.forEach((s, i) => {
      const mm = m[s.media];
      const cell = h('div', { class: 'cell' + (i === sel ? ' sel' : ''), style: { left: off + s.start * PPS + 'px', width: Math.max(6, s.dur * PPS - 3) + 'px', backgroundImage: `url(${mm.kind === 'video' ? frameUrl(pid, mm, s.in, 120) : thumbUrl(pid, mm)})` }, onclick: () => select(i) },
        s.dur * PPS > 34 ? h('span', { class: 'd' }, s.dur.toFixed(1)) : null);
      cell.dataset.i = i;
      track.append(cell);
    });
    const bc = h('canvas', { class: 'beats', style: { top: '66px', left: off + 'px' } });
    const wc = h('canvas', { class: 'wave', style: { top: '76px', left: off + 'px' } });
    track.append(bc, wc);
    const css = getComputedStyle(document.documentElement);
    const dpr = devicePixelRatio || 1, W = Math.ceil(D() * PPS);
    for (const [cv, hgt] of [[bc, 10], [wc, 14]]) { cv.width = W * dpr; cv.height = hgt * dpr; cv.style.width = W + 'px'; cv.style.height = hgt + 'px'; }
    let c = bc.getContext('2d'); c.scale(dpr, dpr);
    const down = new Set(p.timeline.down ? p.timeline.down.map((d, i) => (d ? i : -1)) : []);
    beats().forEach((t, i) => { c.fillStyle = down.has(i) ? css.getPropertyValue('--accent') : css.getPropertyValue('--ink-3'); c.fillRect(t * PPS, down.has(i) ? 0 : 4, 1.5, down.has(i) ? 10 : 6); });
    c = wc.getContext('2d'); c.scale(dpr, dpr); c.fillStyle = css.getPropertyValue('--ink-3'); c.globalAlpha = 0.65;
    let offset = 0;
    for (const s of p.songs.filter((x) => x.status === 'ready' && x.trim[1] - x.trim[0] >= 0.5)) {
      const a = s.analysis, [t0, t1] = s.trim;
      for (let x = 0; x < (t1 - t0) * PPS; x += 3) {
        const pk = a.peaks[Math.min(a.peaks.length - 1, Math.floor(((t0 + x / PPS) / a.duration) * a.peaks.length))];
        const hh = Math.max(1.5, pk * 13);
        c.fillRect(offset * PPS + x, (14 - hh) / 2, 2, hh);
      }
      offset += t1 - t0;
    }
    programmatic = true; scroller.scrollLeft = player.t * PPS;
  }
  function markPlaying(i) {
    if (!player.playing) return;
    track.querySelectorAll('.cell').forEach((c) => c.style.opacity = +c.dataset.i === i ? 1 : 0.78);
  }
  scroller.addEventListener('scroll', () => {
    if (programmatic) { programmatic = false; return; }
    if (player.playing) return;
    player.seek(scroller.scrollLeft / PPS);
  }, { passive: true });
  scroller.addEventListener('touchstart', () => { if (player.playing) player.pause(); track.querySelectorAll('.cell').forEach((c) => c.style.opacity = 1); }, { passive: true });
  scroller.addEventListener('wheel', () => { if (player.playing) player.pause(); }, { passive: true });

  function select(i) {
    sel = sel === i ? -1 : i;
    exitFocus(); closePanel();
    if (sel >= 0) { if (player.playing) player.pause(); programmatic = true; player.seek(p.shots[sel].start + 0.001); scroller.scrollTo({ left: p.shots[sel].start * PPS + 1, behavior: 'smooth' }); }
    drawTimeline(); drawBar();
  }

  // ------------------------------------------------------------------ bottom bar
  const B = (ic, label, onclick, cls = '') => h('button', { class: cls, onclick }, icon(ic, 24), label);
  function drawBar() {
    bar.replaceChildren();
    const put = (...xs) => bar.append(...xs.filter(Boolean));
    bar.classList.toggle('scroll-x', sel >= 0);
    if (sel < 0) {
      put(B('pace', 'Pace', () => togglePanel('pace'), panel === 'pace' ? 'on' : ''), B('style', 'Look', () => togglePanel('look'), panel === 'look' ? 'on' : ''),
        B('music', 'Music', () => togglePanel('music'), panel === 'music' ? 'on' : ''), B('ratio', 'Format', () => togglePanel('format'), panel === 'format' ? 'on' : ''),
        B('media', 'Clips', () => togglePanel('clips'), panel === 'clips' ? 'on' : ''));
      return;
    }
    const s = p.shots[sel], m = mediaById()[s.media];
    put(B('check', 'Done', () => select(sel), 'on'), B('replace', 'Replace', replaceShot),
      m.kind === 'video' ? B('trim', 'Trim', trimSheet) : null,
      B('shorter', 'Shorter', () => resize(-1)), B('longer', 'Longer', () => resize(1)),
      B('swapL', 'Move', () => move(-1)), B('swapR', 'Move', () => move(1)),
      B('fit', s.fit === 'blur' ? 'Fill' : 'Fit', toggleFit), B('focus', 'Focus', startFocus, focusMode ? 'on' : ''),
      B('split', 'Split', split), B('trash', 'Delete', del, 'danger'));
  }

  // ------------------------------------------------------------------ shot edits
  function resize(dir) {
    const i = sel, n = p.shots.length;
    if (n < 2) return toast('Only one shot');
    const [a, b, d] = i < n - 1 ? [i, i + 1, dir] : [i - 1, i, -dir]; // last shot moves its start edge
    const A = p.shots[a], Bs = p.shots[b];
    const bi = nearestBeat(Bs.start) + d, t = beats()[bi];
    if (t == null) return toast('No more beats');
    const end = Bs.start + Bs.dur;
    if (t - A.start < MIN_SHOT || end - t < MIN_SHOT) return toast(dir > 0 ? 'No room — the next shot is too short' : 'Too short');
    snapshot();
    A.dur = +(t - A.start).toFixed(3); Bs.dur = +(end - t).toFixed(3);
    refit(A); refit(Bs); refresh(true);
  }
  function move(dir) {
    const j = sel + dir;
    if (j < 0 || j >= p.shots.length) return toast('Already at the edge');
    snapshot();
    const a = p.shots[sel], b = p.shots[j];
    for (const k of SWAP) { const ta = a[k], tb = b[k]; if (tb === undefined) delete a[k]; else a[k] = tb; if (ta === undefined) delete b[k]; else b[k] = ta; }
    refit(a); refit(b); sel = j; refresh(true);
    programmatic = true; player.seek(p.shots[sel].start + 0.001);
  }
  function toggleFit() { snapshot(); const s = p.shots[sel]; s.fit = s.fit === 'blur' ? 'fill' : 'blur'; refresh(true); }
  function split() {
    const s = p.shots[sel], mid = s.start + s.dur / 2, bi = nearestBeat(mid), t = beats()[bi];
    if (t == null || t - s.start < MIN_SHOT || s.start + s.dur - t < MIN_SHOT) return toast('Too short to split');
    snapshot();
    const d1 = +(t - s.start).toFixed(3), d2 = +(s.dur - d1).toFixed(3);
    const copy = JSON.parse(JSON.stringify(s));
    copy.id = Math.random().toString(16).slice(2, 10); copy.punch = 0.6;
    copy.in = +(s.in + d1 * s.speed).toFixed(3); copy.dur = d2;
    if (copy.kb) [copy.kb.z0, copy.kb.z1] = [copy.kb.z1, copy.kb.z0];
    s.dur = d1;
    p.shots.splice(sel + 1, 0, copy);
    refit(s); refit(copy); refresh(true);
  }
  function del() {
    if (p.shots.length < 2) return toast("Can't delete the only shot");
    snapshot();
    const s = p.shots[sel], prev = p.shots[sel - 1] || p.shots[sel + 1];
    prev.dur = +(prev.dur + s.dur).toFixed(3);
    p.shots.splice(sel, 1);
    refit(prev); sel = -1; refresh(true);
  }
  function startFocus() {
    focusMode = !focusMode;
    stage.classList.toggle('focusing', focusMode);
    if (focusMode) {
      const s = p.shots[sel], m = mediaById()[s.media];
      ring.style.left = (s.fx ?? m.focus[0]) * 100 + '%'; ring.style.top = (s.fy ?? m.focus[1]) * 100 + '%';
      toast('Drag on the preview to choose the focus');
    }
    drawBar();
  }
  function exitFocus() { focusMode = false; stage.classList.remove('focusing'); }

  async function replaceShot() {
    const s = p.shots[sel];
    const sh = sheet({ title: 'Replace with…', body: h('div', { class: 'pick' }, p.media.filter((m) => m.status === 'ready').map((m) =>
      h('div', { class: 'tile' + (m.id === s.media ? ' cur' : ''), style: { backgroundImage: `url(${thumbUrl(pid, m)})` }, onclick: async () => {
        sh.close();
        const avoid = p.shots.filter((x) => x.media === m.id && x !== s).map((x) => [x.in, x.in + x.dur * x.speed]);
        const w = await api.pick(pid, m.id, s.dur, avoid);
        snapshot();
        for (const k of SWAP) delete s[k];
        Object.assign(s, { media: m.id, in: w.in, speed: w.speed, fit: w.fit, fx: null, fy: null });
        if (w.kb) s.kb = w.kb;
        refresh(true);
      } }, m.kind === 'video' ? h('div', { class: 'badge' }, dur(m.duration)) : null))) });
  }

  function trimSheet() {
    const s = p.shots[sel], m = mediaById()[s.media];
    const t0 = s.in, sp0 = s.speed;
    snapshot();
    const img = h('div', { style: { height: '170px', margin: '0 20px 14px', borderRadius: '12px', background: 'var(--fill) center/contain no-repeat' } });
    const lab = h('div', { style: { textAlign: 'center', color: 'var(--ink-2)', fontVariantNumeric: 'tabular-nums', marginBottom: '8px' } });
    const range = () => Math.max(0, m.duration - s.dur * s.speed);
    const sl = slider({ min: 0, max: Math.max(range(), 0.1), step: 0.1, value: s.in, oninput: (v) => { s.in = +v.toFixed(2); show(); player.load(p); } });
    const show = () => { img.style.backgroundImage = `url(${frameUrl(pid, m, s.in, 480)})`; lab.textContent = `Starts at ${fmt(s.in)} · plays ${fmt(s.dur * s.speed)} of ${fmt(m.duration)}`; sl.max = Math.max(range(), 0.1); sl.value = s.in; sl.paint(); };
    show();
    const speed = seg([[0.5, '0.5×'], [1, '1×'], [2, '2×']], [0.5, 1, 2].includes(s.speed) ? s.speed : 1, (v) => { s.speed = v; refit(s); show(); player.load(p); });
    sheet({ title: 'Trim', body: [img, lab, h('div', { class: 'pad' }, sl), h('div', { class: 'group-title', style: { marginTop: '10px' } }, 'Speed'), h('div', { style: { margin: '0 20px 14px' } }, speed)], onClose: () => { if (s.in !== t0 || s.speed !== sp0) { retime(); refresh(true); } else hist.pop(); } });
  }

  // ------------------------------------------------------------------ panels
  function togglePanel(k) { panel === k ? closePanel() : openPanel(k); }
  function closePanel() { panel = null; panelHost.replaceChildren(); drawBar(); requestAnimationFrame(fitStage); }
  function openPanel(k) {
    if (sel >= 0) { sel = -1; drawTimeline(); }
    panel = k; panelHost.replaceChildren(panels[k]()); drawBar(); requestAnimationFrame(fitStage);
  }
  const head = (t, ...r) => h('div', { class: 'head' }, h('span', {}, t), h('div', { class: 'row-inline' }, ...r));
  const busyRecut = async (opts) => {
    snapshot();
    const sp = h('div', { class: 'spinner' });
    toast('Re-cutting…');
    const out = await api.plan(pid, opts);
    Object.assign(p, { shots: out.shots, timeline: out.timeline, settings: out.settings, songs: out.songs, audio_v: out.audio_v, unused: out.unused, ratio: out.ratio });
    player.t = 0; refresh(false); return sp;
  };
  const panels = {
    pace() {
      const s = slider({ min: 0, max: 1, step: 0.05, value: p.settings.pace, onchange: (v) => { p.settings.pace = v; busyRecut({ pace: v }); } });
      return h('div', { class: 'panel' }, head('Pace', h('button', { class: 'btn small secondary', onclick: () => { p.settings.seed = (p.settings.seed || 1) + 1; busyRecut({ seed: p.settings.seed }); } }, icon('shuffle', 18), 'Shuffle')),
        s, h('div', { class: 'lbls' }, h('span', {}, 'Calm'), h('span', {}, 'Fast')),
        h('div', { class: 'hint', style: { marginTop: '10px' } }, 'Re-cuts everything from scratch. Undo brings your edits back.'));
    },
    look() {
      const first = p.media.find((m) => m.thumb);
      const filters = h('div', { class: 'filters' }, LOOKS.map(([v, label]) => h('button', { class: p.settings.filter === v ? 'on' : '', onclick: () => { snapshot(); p.settings.filter = v; player.filter = v; player.applyLook(); persist(); openPanel('look'); } },
        h('i', { style: { backgroundImage: first ? `url(${thumbUrl(pid, first)})` : '', filter: FILTER_CSS[v] || 'none' } }), label)));
      return h('div', { class: 'panel' }, head('Look'), filters, h('div', { class: 'head', style: { marginTop: '12px' } }, h('span', {}, 'Transitions')),
        seg(STYLES, p.settings.style, (v) => { snapshot(); p.settings.style = v; player.style = v; persist(); }));
    },
    music() {
      const vol = slider({ min: 0, max: 1, step: 0.05, value: Math.min(1, p.settings.volume ?? 1), onchange: (v) => { p.settings.volume = v; persist(); flush().then(() => player.load(p)); }, oninput: (v) => { player.audio.volume = v; } });
      const ready = p.songs.filter((s) => s.status === 'ready'), total = ready.reduce((t, s) => t + s.analysis.duration, 0);
      const lens = LENGTHS.filter(([v]) => v === 'full' || v === 'fit' || +v < total - 3);
      const curLen = lens.some(([v]) => v === String(p.settings.length)) ? String(p.settings.length) : 'full';
      const input = h('input', { type: 'file', accept: 'audio/*', style: { display: 'none' }, onchange: async () => {
        const f = input.files[0]; if (!f) return; toast('Adding song…');
        const e = await upload(`/api/projects/${pid}/songs`, f);
        const wait = async () => { const q = await api.get(pid); if (q.songs.find((x) => x.id === e.id).status === 'analyzing') return setTimeout(wait, 800); p.songs = q.songs; setLength(p.settings.length); };
        wait();
      } });
      return h('div', { class: 'panel' }, head('Music', h('button', { class: 'btn small secondary', onclick: () => input.click() }, icon('plus', 18), 'Add song')),
        ready.map((s) => h('div', { class: 'row-inline', style: { marginBottom: '8px', color: 'var(--ink-2)', fontSize: '14px' } }, icon('music', 18), h('span', { style: { flex: 1, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, s.name), `${Math.round(s.analysis.bpm)} BPM`)),
        h('div', { class: 'group-title', style: { margin: '10px 0 8px' } }, 'Length'),
        h('div', { class: 'lengths', style: { margin: '0 0 12px' } }, lens.map(([v, l]) => h('button', { class: 'lenchip' + (curLen === v ? ' on' : ''), onclick: () => setLength(v) }, l))),
        h('div', { class: 'group-title', style: { margin: '4px 0 0' } }, 'Volume'), vol, input);
    },
    format() {
      return h('div', { class: 'panel' }, head('Format'), h('div', { class: 'ratios', style: { margin: 0, gridTemplateColumns: 'repeat(4,1fr)', gap: '8px' } }, Object.entries(RATIOS).map(([r, v]) => {
        const max = 34, ar = v.w / v.h, [bw, bh] = ar >= 1 ? [max, max / ar] : [max * ar, max];
        return h('button', { class: 'ratio' + (p.ratio === r ? ' on' : ''), style: { padding: '12px 4px 8px', gap: '6px' }, onclick: () => setRatio(r) },
          h('div', { class: 'box', style: { height: '38px' } }, h('i', { style: { width: bw + 'px', height: bh + 'px', borderWidth: '2px', borderRadius: '5px' } })), h('b', { style: { fontSize: '14px' } }, r));
      })), h('div', { class: 'hint', style: { marginTop: '10px' } }, 'Clips that don’t match the shape are fitted over a blur. Tap Fill on any shot to crop instead.'));
    },
    clips() {
      const counts = {}; p.shots.forEach((s) => { counts[s.media] = (counts[s.media] || 0) + 1; });
      const input = h('input', { type: 'file', accept: 'image/*,video/*', multiple: true, style: { display: 'none' }, onchange: async () => {
        const files = [...input.files]; toast(`Uploading ${files.length}…`);
        for (const f of files) await upload(`/api/projects/${pid}/media`, f, { modified: f.lastModified });
        const wait = async () => { const q = await api.get(pid); if (q.media.some((m) => m.status === 'processing')) return setTimeout(wait, 900); p.media = q.media; openPanel('clips'); toast('Added — tap Re-cut to include them'); };
        wait();
      } });
      return h('div', { class: 'panel' }, head('Clips', h('button', { class: 'btn small secondary', onclick: () => input.click() }, icon('plus', 18), 'Add'), p.media.length > Object.keys(counts).length ? h('button', { class: 'btn small', onclick: () => busyRecut({}) }, 'Re-cut') : null),
        h('div', { class: 'pick', style: { padding: 0, gridTemplateColumns: 'repeat(5,1fr)' } }, p.media.filter((m) => m.status === 'ready').map((m) =>
          h('div', { class: 'tile', style: { backgroundImage: `url(${thumbUrl(pid, m)})`, opacity: counts[m.id] ? 1 : 0.5 } }, h('div', { class: 'badge' }, counts[m.id] ? `×${counts[m.id]}` : 'unused')))), input);
    },
  };

  async function setRatio(r) {
    snapshot(); p.ratio = r;
    const m = mediaById();
    for (const s of p.shots) s.fit = cropLoss(m[s.media], r) > 0.45 ? 'blur' : 'fill', s.fx = s.fy = null;
    refresh(true); openPanel('format');
  }
  async function setLength(v) {
    snapshot(); toast('Re-cutting to the new length…');
    const out = await api.plan(pid, { length: v });
    Object.assign(p, { shots: out.shots, timeline: out.timeline, settings: out.settings, songs: out.songs, audio_v: out.audio_v, unused: out.unused });
    player.t = 0; refresh(false); openPanel('music');
  }

  // ------------------------------------------------------------------ rename / export
  function rename() {
    const input = h('input', { value: p.name, style: { width: '100%', height: '44px', borderRadius: '12px', border: 0, background: 'var(--surface)', padding: '0 14px', fontSize: '17px', outline: 'none' } });
    const s = sheet({ title: 'Name', body: h('div', { class: 'pad', style: { paddingBottom: '12px' } }, input, h('button', { class: 'btn block', style: { marginTop: '12px' }, onclick: () => { p.name = input.value.trim() || 'Untitled'; title.textContent = p.name; persist(); s.close(); } }, 'Save')) });
    setTimeout(() => input.select(), 300);
  }

  async function exportSheet() {
    if (player.playing) player.pause();
    await flush();
    let quality = 1080, job = null;
    const prog = h('i'), status = h('div', { class: 'hint', style: { textAlign: 'left', padding: 0 } }, `${D().toFixed(0)}s video · ${p.shots.length} cuts`);
    const actions = h('div');
    const draw = () => { actions.replaceChildren(h('div', { class: 'pad' }, h('div', { class: 'group-title', style: { margin: '0 0 8px' } }, 'Quality'), seg([[720, '720p · fast'], [1080, '1080p · best']], quality, (v) => { quality = v; }), h('button', { class: 'btn block', style: { marginTop: '18px' }, onclick: start }, 'Render video'))); };
    const sh = sheet({ title: 'Export', body: [h('div', { class: 'pad' }, h('div', { class: 'prog' }, prog), status), actions] });
    draw();
    async function start() {
      actions.replaceChildren(); status.textContent = 'Rendering…';
      const { id } = await api.exportVideo(pid, quality);
      const poll = async () => {
        const j = await api.job(id);
        prog.style.width = j.progress * 100 + '%';
        if (j.status === 'error') { status.textContent = 'Render failed'; draw(); return; }
        if (j.status !== 'done') return setTimeout(poll, 450);
        status.textContent = 'Done';
        const url = `/api/projects/${pid}/exports/${j.file}`;
        actions.replaceChildren(h('div', { class: 'pad', style: { display: 'grid', gap: '10px' } },
          h('button', { class: 'btn block', onclick: () => shareFile(url, j.file) }, icon('share', 20), 'Save or share'),
          h('a', { class: 'btn secondary block', href: url + '?dl=1', download: j.file }, icon('download', 20), 'Download'),
          h('a', { class: 'btn ghost block', href: url, target: '_blank' }, 'Open')));
      };
      poll();
    }
  }
  async function shareFile(url, name) {
    try {
      const blob = await (await fetch(url)).blob();
      const file = new File([blob], name, { type: 'video/mp4' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) await navigator.share({ files: [file] });
      else { const a = h('a', { href: url + '?dl=1', download: name }); document.body.append(a); a.click(); a.remove(); }
    } catch (e) { if (e.name !== 'AbortError') toast('Sharing failed'); }
  }

  // ------------------------------------------------------------------ keyboard
  const onKey = (e) => {
    if (/INPUT|TEXTAREA/.test(e.target.tagName)) return;
    if (e.code === 'Space') { e.preventDefault(); player.toggle(); }
    else if ((e.metaKey || e.ctrlKey) && e.key === 'z') { e.preventDefault(); undo(); }
    else if (e.key === 'ArrowRight') { player.pause(); player.seek(player.t + 0.5); scroller.scrollLeft = player.t * PPS; }
    else if (e.key === 'ArrowLeft') { player.pause(); player.seek(player.t - 0.5); scroller.scrollLeft = player.t * PPS; }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && sel >= 0) del();
    else if (e.key === 'Escape') { if (sel >= 0) select(sel); else closePanel(); }
  };
  addEventListener('keydown', onKey);

  // ------------------------------------------------------------------ go
  refresh(false);
  requestAnimationFrame(() => { fitStage(); drawTimeline(); player.showAt(0); });
  return () => { destroyed = true; flush(); removeEventListener('keydown', onKey); ro.disconnect(); player.destroy(); };
}
