import { api, upload, thumbUrl, frameUrl, RATIOS, ratioAR, cropLoss } from './api.js';
import { h, icon, fmt, dur, seg, sheet, slider, toast, toastUndo, waveform } from './ui.js';
import { Player, FILTER_CSS } from './player.js';
import { LENGTHS, LOOKS, STYLES } from './looks.js';
import { songPicker, stopPreview } from './picker.js';

const PPS_MIN = 28, PPS_MAX = 260;
const MIN_SHOT = 0.3;
const SWAP = ['media', 'in', 'speed', 'fit', 'fx', 'fy', 'kb'];

export async function editor(screen, pid, go) {
  let p = await api.get(pid);
  if (!p.shots.length) { go(`#/new/${pid}`); return; }
  let pps = 72; // timeline pixels per second (pinch / ± to zoom)
  let sel = -1, panel = null, focusMode = false, saveT = null, destroyed = false;
  const hist = [];

  // ------------------------------------------------------------------ DOM
  const undoBtn = h('button', { class: 'nav-btn', 'aria-label': 'Undo', disabled: true, onclick: undo }, icon('undo', 24));
  const title = h('div', { class: 'title on', onclick: rename }, p.name);
  const nav = h('div', { class: 'nav' },
    h('div', { class: 'l' }, h('button', { class: 'nav-btn', 'aria-label': 'Back to videos', onclick: () => { flush(); go('#/'); } }, icon('back', 22), 'Videos')),
    title, h('div', { class: 'r' }, undoBtn, h('button', { class: 'nav-btn strong', onclick: exportSheet }, 'Export')));
  const stage = h('div', { class: 'stage paused' });
  const wrap = h('div', { class: 'stage-wrap' }, stage);
  const tap = h('div', { class: 'tap' });
  const hint = h('div', { class: 'playhint' }, h('i', {}, icon('play', 30)));
  const ring = h('div', { class: 'focus' });
  const veil = h('div', { class: 'busyveil' }, h('div', { class: 'spinner' }));
  const playBtn = h('button', { class: 'play', 'aria-label': 'Play', onclick: () => player.toggle() }, icon('play', 20));
  const timeEl = h('div', { class: 't' }, '0:00.0');
  const info = h('div', { style: { marginLeft: 'auto' } });
  const zoomBtn = (d, label, ic) => h('button', { class: 'zoom-btn', 'aria-label': label, onclick: () => setZoom(pps * d) }, ic);
  const transport = h('div', { class: 'transport' }, playBtn, timeEl, info,
    zoomBtn(1 / 1.35, 'Zoom timeline out', h('span', {}, '−')), zoomBtn(1.35, 'Zoom timeline in', h('span', {}, '+')));
  const scroller = h('div', { class: 'scroller' });
  const track = h('div', { class: 'track' });
  const tl = h('div', { class: 'tl' }, scroller, h('div', { class: 'head' }));
  scroller.append(track);
  const hintEl = h('div', { class: 'hint', style: { padding: '2px 20px 8px' } }, p.note || 'Tap a shot to edit it · drag the timeline to scrub');
  const panelHost = h('div', { class: 'panel-host' });
  const bar = h('div', { class: 'bar' });
  screen.classList.add('editor');
  screen.append(nav, wrap, transport, tl, panelHost, bar);
  stage.append(tap, hint, ring, veil);
  const player = new Player(stage);
  stage.insertBefore(tap, null);

  // ------------------------------------------------------------------ helpers
  let workers = 0;
  async function work(fn) {  // dims the controls and spins over the preview while the server does something
    workers++; stage.classList.add('busy'); screen.classList.add('working');
    try { return await fn(); } finally { if (--workers === 0) { stage.classList.remove('busy'); screen.classList.remove('working'); } }
  }
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
  const snapshotJSON = () => JSON.stringify({ shots: p.shots, ratio: p.ratio, settings: p.settings, starts: Object.fromEntries(p.songs.map((s) => [s.id, s.start ?? null])) });
  function snapshot(json) {
    hist.push(json || snapshotJSON());
    if (hist.length > 40) hist.shift();
    undoBtn.disabled = false;
  }
  async function undo() {
    if (!hist.length) return;
    const prev = JSON.parse(hist.pop());
    undoBtn.disabled = !hist.length;
    sel = -1;
    const soundtrackChanged = String(prev.settings.length) !== String(p.settings.length) || p.songs.some((s) => (s.start ?? null) !== (prev.starts[s.id] ?? null));
    if (soundtrackChanged) {  // the song section / length changed too: the server puts the soundtrack back with the shots
      try {
        const r = await work(() => api.restore(pid, { ratio: prev.ratio, settings: prev.settings, starts: prev.starts, shots: prev.shots }));
        Object.assign(p, { shots: r.shots, timeline: r.timeline, songs: r.songs, settings: r.settings, ratio: r.ratio, audio_v: r.audio_v });
        player.t = 0; refresh(false); return;
      } catch (err) { toast('Could not undo'); return; }
    }
    Object.assign(p, { shots: prev.shots, ratio: prev.ratio, settings: prev.settings });
    refresh(true);
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
    if (player.playing) scroller.scrollLeft = t * pps;
    const i = player.idxAt(t);
    if (i !== lastIdx) { lastIdx = i; markPlaying(i); }
  });
  player.onState(applyStageUI);
  player.onState((playing) => { if (playing) stopPreview(); }); // never two soundtracks at once
  let lastIdx = -1;

  // ------------------------------------------------------------------ timeline
  function drawTimeline() {
    const w = scroller.clientWidth;
    track.style.width = D() * pps + w + 'px';
    track.replaceChildren();
    const m = mediaById(), off = w / 2;
    p.shots.forEach((s, i) => {
      const mm = m[s.media];
      const cell = h('div', { class: 'cell' + (i === sel ? ' sel' : ''), style: { left: off + s.start * pps + 'px', width: Math.max(6, s.dur * pps - 3) + 'px', backgroundImage: `url(${mm.kind === 'video' ? frameUrl(pid, mm, s.in, 120) : thumbUrl(pid, mm)})` }, onclick: () => { if (!suppressClick) select(i); } },
        s.dur * pps > 34 ? h('span', { class: 'd' }, s.dur.toFixed(1)) : null);
      cell.dataset.i = i;
      track.append(cell);
    });
    const bc = h('canvas', { class: 'beats', style: { top: '66px', left: off + 'px' } });
    const wc = h('canvas', { class: 'wave', style: { top: '76px', left: off + 'px' } });
    track.append(bc, wc);
    const css = getComputedStyle(document.documentElement);
    const W = Math.ceil(D() * pps), dpr = Math.min(devicePixelRatio || 1, 30000 / W); // very long videos: stay under canvas size limits
    for (const [cv, hgt] of [[bc, 10], [wc, 14]]) { cv.width = W * dpr; cv.height = hgt * dpr; cv.style.width = W + 'px'; cv.style.height = hgt + 'px'; }
    let c = bc.getContext('2d'); c.scale(dpr, dpr);
    const down = new Set(p.timeline.down ? p.timeline.down.map((d, i) => (d ? i : -1)) : []);
    beats().forEach((t, i) => { c.fillStyle = down.has(i) ? css.getPropertyValue('--accent') : css.getPropertyValue('--ink-3'); c.fillRect(t * pps, down.has(i) ? 0 : 4, 1.5, down.has(i) ? 10 : 6); });
    c = wc.getContext('2d'); c.scale(dpr, dpr); c.fillStyle = css.getPropertyValue('--ink-3'); c.globalAlpha = 0.65;
    let offset = 0;
    for (const s of p.songs.filter((x) => x.status === 'ready' && x.trim[1] - x.trim[0] >= 0.5)) {
      const a = s.analysis, [t0, t1] = s.trim;
      for (let x = 0; x < (t1 - t0) * pps; x += 3) {
        const pk = a.peaks[Math.min(a.peaks.length - 1, Math.floor(((t0 + x / pps) / a.duration) * a.peaks.length))];
        const hh = Math.max(1.5, pk * 13);
        c.fillRect(offset * pps + x, (14 - hh) / 2, 2, hh);
      }
      offset += t1 - t0;
    }
    scroller.scrollLeft = player.t * pps;
  }
  function markPlaying(i) {
    if (!player.playing) return;
    track.querySelectorAll('.cell').forEach((c) => c.style.opacity = +c.dataset.i === i ? 1 : 0.78);
  }
  scroller.addEventListener('scroll', () => {
    if (player.playing || (drag && drag.armed) || pinch || Math.abs(scroller.scrollLeft - player.t * pps) < 1.5) return; // ignore our own scrolling
    player.seek(scroller.scrollLeft / pps);
  }, { passive: true });
  scroller.addEventListener('touchstart', () => { if (player.playing) player.pause(); track.querySelectorAll('.cell').forEach((c) => c.style.opacity = 1); }, { passive: true });
  scroller.addEventListener('wheel', (ev) => { if (!ev.ctrlKey && player.playing) player.pause(); }, { passive: true });


  // ------------------------------------------------------------------ zoom (pinch, ctrl+wheel, ± buttons)
  let zoomRaf = 0;
  function setZoom(v) {
    const next = Math.min(PPS_MAX, Math.max(PPS_MIN, v));
    if (Math.abs(next - pps) < 0.01) return;
    pps = next;
    cancelAnimationFrame(zoomRaf);
    zoomRaf = requestAnimationFrame(() => { drawTimeline(); scroller.scrollLeft = player.t * pps; });
  }
  let pinch = null;
  const gap = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  scroller.addEventListener('touchstart', (ev) => { if (ev.touches.length === 2) { pinch = { d: gap(ev.touches), pps0: pps }; scroller.style.overflowX = 'hidden'; cancelDrag(); } }, { passive: true });
  scroller.addEventListener('touchmove', (ev) => {
    if (pinch && ev.touches.length === 2) { if (ev.cancelable) ev.preventDefault(); setZoom(pinch.pps0 * (gap(ev.touches) / pinch.d)); }
    else if (drag && drag.armed && ev.cancelable) ev.preventDefault(); // long-press drag owns the gesture
  }, { passive: false });
  const endPinch = (ev) => { if (pinch && ev.touches.length < 2) { pinch = null; scroller.style.overflowX = 'scroll'; scroller.scrollLeft = player.t * pps; } };
  scroller.addEventListener('touchend', endPinch, { passive: true }); scroller.addEventListener('touchcancel', endPinch, { passive: true });
  scroller.addEventListener('wheel', (ev) => { if (ev.ctrlKey) { ev.preventDefault(); setZoom(pps * Math.exp(-ev.deltaY * 0.01)); } }, { passive: false });

  // ------------------------------------------------------------------ long-press + drag a shot to reorder it
  // Slots (their lengths and beats) stay put; the clips move between them, then the rules are re-applied.
  let drag = null, suppressClick = false;
  function cancelDrag() {
    if (!drag) return;
    clearTimeout(drag.timer); cancelAnimationFrame(drag.raf);
    if (drag.armed) { scroller.style.overflowX = 'scroll'; drag.el.classList.remove('lift'); drag.el.style.transform = ''; track.querySelectorAll('.drop').forEach((c) => c.classList.remove('drop')); }
    drag = null;
  }
  const slotCenter = (i) => scroller.clientWidth / 2 + (p.shots[i].start + p.shots[i].dur / 2) * pps;
  function dragTarget() {
    const x = drag.el.getBoundingClientRect().left - scroller.getBoundingClientRect().left + scroller.scrollLeft + drag.el.offsetWidth / 2;
    let best = 0;
    for (let i = 1; i < p.shots.length; i++) if (Math.abs(slotCenter(i) - x) < Math.abs(slotCenter(best) - x)) best = i;
    return best;
  }
  function dragFrame() {
    if (!drag || !drag.armed) return;
    const r = scroller.getBoundingClientRect();
    if (drag.cx < r.left + 40) scroller.scrollLeft -= 10; else if (drag.cx > r.right - 40) scroller.scrollLeft += 10;
    drag.el.style.transform = `translateX(${drag.cx - drag.x0 + scroller.scrollLeft - drag.s0}px) scale(1.06)`;
    const to = dragTarget();
    track.querySelectorAll('.cell').forEach((c) => c.classList.toggle('drop', +c.dataset.i === to && to !== drag.i));
    drag.raf = requestAnimationFrame(dragFrame);
  }
  scroller.addEventListener('pointerdown', (ev) => {
    const cell = ev.target.closest('.cell');
    if (!cell || player.playing || ev.button > 0 || pinch) return;
    cancelDrag();
    drag = { i: +cell.dataset.i, el: cell, x0: ev.clientX, y0: ev.clientY, cx: ev.clientX, s0: scroller.scrollLeft, armed: false, id: ev.pointerId };
    drag.timer = setTimeout(() => {
      if (!drag) return;
      drag.armed = true; drag.s0 = scroller.scrollLeft;
      scroller.style.overflowX = 'hidden'; cell.classList.add('lift');
      try { scroller.setPointerCapture(drag.id); } catch (err) { /* pointer already gone */ }
      if (navigator.vibrate) navigator.vibrate(8);
      drag.raf = requestAnimationFrame(dragFrame);
    }, 380);
  });
  scroller.addEventListener('pointermove', (ev) => {
    if (!drag || ev.pointerId !== drag.id) return;
    if (!drag.armed) { if (Math.hypot(ev.clientX - drag.x0, ev.clientY - drag.y0) > 8) cancelDrag(); return; }
    drag.cx = ev.clientX;
  });
  const dropDrag = () => {
    if (!drag) return;
    if (!drag.armed) { cancelDrag(); return; }
    const from = drag.i, to = dragTarget();
    cancelDrag();
    suppressClick = true; setTimeout(() => { suppressClick = false; }, 80);
    if (to !== from) reorder(from, to); else drawTimeline();
  };
  scroller.addEventListener('pointerup', dropDrag); scroller.addEventListener('pointercancel', dropDrag);

  async function reorder(a, b) {
    snapshot();
    const contents = p.shots.map((s) => Object.fromEntries(SWAP.filter((k) => s[k] !== undefined).map((k) => [k, s[k]])));
    contents.splice(b, 0, contents.splice(a, 1)[0]);
    p.shots.forEach((s, i) => { SWAP.forEach((k) => delete s[k]); Object.assign(s, contents[i]); refit(s); });
    sel = b; retime(); await rebalance(); refresh(true);
    player.seek(p.shots[sel].start + 0.001); scroller.scrollLeft = player.t * pps;
  }

  function select(i) {
    sel = sel === i ? -1 : i;
    exitFocus(); closePanel();
    if (sel >= 0) panelHost.replaceChildren();
    if (sel >= 0) { if (player.playing) player.pause(); player.seek(p.shots[sel].start + 0.001); scroller.scrollLeft = player.t * pps; }
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
      B('swapL', 'Earlier', () => move(-1)), B('swapR', 'Later', () => move(1)),
      B('fit', s.fit === 'blur' ? 'Fill' : 'Fit', toggleFit), B('focus', 'Focus', startFocus, focusMode ? 'on' : ''),
      B('split', 'Split', split), B('trash', 'Delete', del, 'danger'));
  }

  // ------------------------------------------------------------------ shot edits
  // one beat longer/shorter; the server finds the nearest video that can give or take the time (photos stay ~1s)
  async function resize(dir) {
    snapshot();
    try {
      const r = await work(() => api.resize(pid, p.shots, sel, dir));
      p.shots = r.shots; refresh(true);
    } catch (err) { hist.pop(); undoBtn.disabled = !hist.length; toast(err.message); }
  }
  async function rebalance() {
    try { p.shots = (await work(() => api.balance(pid, p.shots))).shots; } catch (err) { /* keep the manual result */ }
  }
  async function move(dir) {
    const j = sel + dir;
    if (j < 0 || j >= p.shots.length) return toast('Already at the edge');
    snapshot();
    const a = p.shots[sel], b = p.shots[j];
    for (const k of SWAP) { const ta = a[k], tb = b[k]; if (tb === undefined) delete a[k]; else a[k] = tb; if (ta === undefined) delete b[k]; else b[k] = ta; }
    refit(a); refit(b); sel = j; retime(); await rebalance(); refresh(true);
    player.seek(p.shots[sel].start + 0.001); scroller.scrollLeft = player.t * pps;
  }
  function toggleFit() { snapshot(); const s = p.shots[sel]; s.fit = s.fit === 'blur' ? 'fill' : 'blur'; refresh(true); }
  async function split() {
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
    refit(s); refit(copy); retime(); await rebalance(); refresh(true);
  }
  async function del() {
    if (p.shots.length < 2) return toast("Can't delete the only shot");
    snapshot();
    const s = p.shots[sel], prev = p.shots[sel - 1] || p.shots[sel + 1];
    prev.dur = +(prev.dur + s.dur).toFixed(3);
    p.shots.splice(sel, 1);
    refit(prev); sel = -1; retime(); await rebalance(); refresh(true);
    toastUndo('Shot deleted', undo);
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
        retime(); await rebalance(); refresh(true);
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
  function closePanel() { panel = null; panelHost.replaceChildren(sel < 0 ? hintEl : ''); drawBar(); requestAnimationFrame(fitStage); }
  function openPanel(k) {
    if (sel >= 0) { sel = -1; drawTimeline(); }
    panel = k; panelHost.replaceChildren(panels[k]()); drawBar(); requestAnimationFrame(fitStage);
  }
  const head = (t, ...r) => h('div', { class: 'head' }, h('span', {}, t), h('div', { class: 'row-inline' }, ...r));
  const busyRecut = async (opts) => {
    snapshot();
    const sp = h('div', { class: 'spinner' });
    const out = await work(() => api.plan(pid, opts));
    Object.assign(p, { shots: out.shots, timeline: out.timeline, settings: out.settings, songs: out.songs, audio_v: out.audio_v, unused: out.unused, ratio: out.ratio, note: out.note });
    hintEl.textContent = p.note || 'Tap a shot to edit it · drag the timeline to scrub';
    player.t = 0; refresh(false); toastUndo('Re-cut', undo); return sp;
  };
  let resyncT = 0;
  let pendingSnap = null; // taken *before* the picker changes the song section, so Undo can put the section back
  let resyncing = false, resyncAgain = false;
  const scheduleResync = () => { clearTimeout(resyncT); resyncT = setTimeout(resyncNow, 450); };
  async function resyncNow() {  // same clips and edits, cuts re-timed onto the beats of the newly chosen section
    if (resyncing) { resyncAgain = true; return; }       // one at a time; a newer pick re-runs it afterwards
    resyncing = true;
    if (pendingSnap) { snapshot(pendingSnap); pendingSnap = null; }
    try {
      await flush();                                     // the server resyncs what it has saved, so save pending edits first
      const out = await work(() => api.resync(pid));
      Object.assign(p, { shots: out.shots, timeline: out.timeline, songs: out.songs, audio_v: out.audio_v });
      sel = -1; player.t = 0; refresh(false);
      if (!resyncAgain) toastUndo('Resynced to the new section', undo);
    } catch (err) { toast('Could not resync'); }
    finally { resyncing = false; if (resyncAgain) { resyncAgain = false; scheduleResync(); } }
  }
  const panels = {
    pace() {
      const s = slider({ min: 0, max: 1, step: 0.05, value: p.settings.pace, onchange: (v) => { p.settings.pace = v; busyRecut({ pace: v }); } });
      return h('div', { class: 'panel' }, head('Pace', h('button', { class: 'btn small secondary', onclick: () => { p.settings.seed = (p.settings.seed || 1) + 1; busyRecut({ seed: p.settings.seed }); } }, icon('shuffle', 18), 'Shuffle')),
        s, h('div', { class: 'lbls' }, h('span', {}, 'Calm'), h('span', {}, 'Fast')),
        h('label', { class: 'switch-row' }, h('span', {}, h('b', {}, 'Repeat clips'), h('i', {}, 'Off: every clip once, in order. On: cut faster by cycling through them.')),
          h('input', { type: 'checkbox', class: 'switch', checked: !!p.settings.repeat, onchange: (ev) => { p.settings.repeat = ev.target.checked; busyRecut({ repeat: ev.target.checked }); } })),
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
        ready.map((s) => (s.trim[1] - s.trim[0] < s.analysis.duration - 1
          ? h('div', { style: { marginBottom: '12px' } },
              h('div', { class: 'row-inline', style: { marginBottom: '8px', fontSize: '14px', color: 'var(--ink-2)' } }, icon('music', 18), h('span', { style: { flex: 1, color: 'var(--ink)', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, s.name), `${Math.round(s.analysis.bpm)} BPM`),
              songPicker({ pid, song: s, onPlay: () => player.pause(), onChange: (proj) => { if (!pendingSnap && !resyncing) pendingSnap = snapshotJSON(); p.songs = proj.songs; scheduleResync(); } }))
          : h('div', { class: 'row-inline', style: { marginBottom: '8px', color: 'var(--ink-2)', fontSize: '14px' } }, icon('music', 18), h('span', { style: { flex: 1, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, s.name), `${Math.round(s.analysis.bpm)} BPM`))),
        ready.every((s) => s.trim[1] - s.trim[0] >= s.analysis.duration - 1) && ready.length ? h('div', { class: 'hint', style: { textAlign: 'left', padding: '0 0 8px' } }, 'Pick a length shorter than the song to choose which part plays.') : null,
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
    refresh(true); openPanel('format'); toastUndo(`Format ${r}`, undo);
  }
  async function setLength(v) {
    snapshot();
    const out = await work(() => api.plan(pid, { length: v }));
    Object.assign(p, { shots: out.shots, timeline: out.timeline, settings: out.settings, songs: out.songs, audio_v: out.audio_v, unused: out.unused, note: out.note });
    hintEl.textContent = p.note || 'Tap a shot to edit it · drag the timeline to scrub';
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
          h('video', { class: 'preview-video', src: url, controls: true, playsinline: true, preload: 'metadata' }),
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
    else if (e.key === 'ArrowRight') { player.pause(); player.seek(player.t + 0.5); scroller.scrollLeft = player.t * pps; }
    else if (e.key === 'ArrowLeft') { player.pause(); player.seek(player.t - 0.5); scroller.scrollLeft = player.t * pps; }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && sel >= 0) del();
    else if (e.key === 'Escape') { if (sel >= 0) select(sel); else closePanel(); }
  };
  addEventListener('keydown', onKey);

  // ------------------------------------------------------------------ go
  panelHost.append(hintEl);
  refresh(false);
  requestAnimationFrame(() => { fitStage(); drawTimeline(); player.showAt(0); });
  return () => { destroyed = true; clearTimeout(resyncT); stopPreview(); flush(); removeEventListener('keydown', onKey); ro.disconnect(); player.destroy(); };
}
