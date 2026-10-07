// Instagram-style "choose the part of the song": the waveform is zoomed so the chosen part fills ~60% of the
// width and scrolls under a fixed window (native momentum scrolling). Only the visible slice is drawn, on demand,
// so dragging costs a few hundred rects per frame. The selected part loops so you hear exactly what you get.
import { h, icon, fmt } from './ui.js';

let current = null;
export const stopPreview = () => { if (current) current.stop(); };

export function songPicker({ pid, song, onChange }) {
  const a = song.analysis;
  let [t0, t1] = song.trim;
  const len = t1 - t0;
  const draggable = len < a.duration - 1;
  const beats = a.beats;
  const downSet = new Set(a.downbeats);
  const nearestBeat = (t) => {
    if (!beats.length) return t;
    let lo = 0, hi = beats.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (beats[m] < t) lo = m + 1; else hi = m; }
    return lo > 0 && Math.abs(beats[lo - 1] - t) < Math.abs(beats[lo] - t) ? beats[lo - 1] : beats[lo];
  };
  const clampStart = (t) => Math.min(Math.max(0, t), Math.max(0, a.duration - len));

  const cv = h('canvas', { class: 'pk-wave' });
  const content = h('div', { class: 'pk-content' });
  const scroller = h('div', { class: 'pk-scroll' + (draggable ? '' : ' fixed') }, content);
  const ph = h('i', { class: 'ph' });
  const win = h('div', { class: 'pk-win' }, h('i', { class: 'l' }), h('i', { class: 'r' }), ph);
  const view = h('div', { class: 'pk-view' }, cv, scroller, win);
  const range = h('div', { class: 'pk-range' });
  const playBtn = h('button', { class: 'pk-play', 'aria-label': 'Preview', onclick: () => (playing ? stop() : play()) }, icon('play', 18));
  const nudge = (d) => {
    const b = h('button', { class: 'btn small secondary', 'aria-label': d < 0 ? 'Back 1 second' : 'Forward 1 second', onclick: () => move(d) }, icon('back', 16));
    if (d > 0) b.firstChild.style.transform = 'rotate(180deg)';
    return b;
  };
  const el = h('div', { class: 'picker' }, view, h('div', { class: 'pk-row' }, playBtn, range,
    draggable ? h('div', { class: 'row-inline' }, nudge(-1), nudge(1), h('button', { class: 'btn small secondary', onclick: () => commit(null, true) }, 'Best part')) : null));

  let W = 0, H = 0, pps = 1, pad = 0, winW = 0, dpr = 1;
  let audio = null, playing = false, raf = 0, drawQueued = false, settleT = 0, busy = false;
  const col = {};
  const readColors = () => {
    const css = getComputedStyle(document.documentElement);
    for (const k of ['fill', 'accent', 'ink', 'ink-3']) col[k] = css.getPropertyValue('--' + k).trim();
  };

  function layout() {
    W = view.clientWidth; H = view.clientHeight;
    if (!W) return;
    dpr = Math.min(devicePixelRatio || 1, 3);
    cv.width = W * dpr; cv.height = H * dpr;
    if (draggable) { winW = Math.round(W * 0.6); pad = Math.round((W - winW) / 2); pps = winW / len; }
    else { winW = W; pad = 0; pps = W / a.duration; }
    content.style.width = (a.duration * pps + (draggable ? W - winW : 0)) + 'px';
    win.style.left = pad + 'px'; win.style.width = winW + 'px';
    if (draggable) scroller.scrollLeft = t0 * pps;
    schedule();
  }

  // ---- draw only what is on screen
  function schedule() { if (!drawQueued) { drawQueued = true; requestAnimationFrame(draw); } }
  function draw() {
    drawQueued = false;
    if (!W) return;
    const c = cv.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.fillStyle = col.fill; c.fillRect(0, 0, W, H);
    const s = draggable ? scroller.scrollLeft : 0;
    const n = a.peaks.length, binPx = (a.duration * pps) / n;
    const step = Math.max(1, Math.round(2.5 / binPx)); // ~one bar every 2.5px, whatever the zoom
    const i0 = Math.max(0, Math.floor((s - pad) / binPx) - 1), i1 = Math.min(n - 1, Math.ceil((s - pad + W) / binPx) + 1);
    for (let i = i0; i <= i1; i += step) {
      let pk = a.peaks[i];
      for (let j = 1; j < step && i + j < n; j++) pk = Math.max(pk, a.peaks[i + j]);
      const x = pad + i * binPx - s, inside = x >= pad - 1 && x <= pad + winW;
      const bh = Math.max(2, pk * (H - 14));
      c.globalAlpha = inside ? 0.95 : 0.55;
      c.fillStyle = inside ? col.accent : col['ink-3'];
      c.fillRect(x, (H - bh) / 2, Math.max(1.5, binPx * step - 1.2), bh);
    }
    c.globalAlpha = 0.5; c.fillStyle = col.ink;
    const ta = (s - pad) / pps, tb = ta + W / pps;
    let lo = 0, hi = beats.length; // first beat >= ta
    while (lo < hi) { const m = (lo + hi) >> 1; if (beats[m] < ta) lo = m + 1; else hi = m; }
    for (let i = lo; i < beats.length && beats[i] <= tb; i++) {
      const down = downSet.has(i);
      c.fillRect(pad + beats[i] * pps - s, H - (down ? 9 : 5), 1.4, down ? 9 : 5);
    }
    c.globalAlpha = 1;
  }

  // ---- selection from scroll position (snaps to the nearest beat so the first cut lands on one)
  const startFromScroll = () => clampStart(nearestBeat(scroller.scrollLeft / pps));
  function label(start) { range.textContent = `${fmt(start, 0)} – ${fmt(start + len, 0)}`; }
  if (draggable) {
    scroller.addEventListener('scroll', () => {
      schedule();
      label(startFromScroll());
      clearTimeout(settleT);
      settleT = setTimeout(settle, 140);
    }, { passive: true });
    // mouse drag (touch uses native momentum scrolling)
    let drag = null;
    scroller.addEventListener('pointerdown', (e) => { if (e.pointerType === 'mouse') { drag = { x: e.clientX, s: scroller.scrollLeft }; scroller.setPointerCapture(e.pointerId); } });
    scroller.addEventListener('pointermove', (e) => { if (drag) scroller.scrollLeft = drag.s - (e.clientX - drag.x); });
    const end = () => { drag = null; };
    scroller.addEventListener('pointerup', end); scroller.addEventListener('pointercancel', end);
  }
  function settle() {
    const start = startFromScroll();
    scroller.scrollTo({ left: start * pps, behavior: 'smooth' });
    if (Math.abs(start - t0) > 0.01) commit(start);
  }
  // arrows step exactly one second (to the nearest beat so the cut still lands on the music)
  function move(dir) {
    let target = clampStart(nearestBeat(t0 + dir));
    if (Math.abs(target - t0) < 0.01) target = clampStart(nearestBeat(t0 + dir * 1.3));
    scroller.scrollTo({ left: target * pps, behavior: 'smooth' });
  }

  async function commit(start, fromReset) {
    if (busy) { clearTimeout(settleT); settleT = setTimeout(() => commit(start, fromReset), 200); return; }
    busy = true;
    if (start != null) { t0 = start; t1 = t0 + len; label(t0); if (playing) audio.currentTime = t0; }
    try {
      const res = await fetch(`/api/projects/${pid}/songs/${song.id}/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ start }) }).then((r) => r.json());
      const s = res.songs.find((x) => x.id === song.id);
      [t0, t1] = s.trim; label(t0);
      if (fromReset) scroller.scrollTo({ left: t0 * pps, behavior: 'smooth' });
      if (playing) audio.currentTime = t0;
      onChange && onChange(res, s);
    } finally { busy = false; }
  }

  // ---- preview
  function ensureAudio() {
    if (!audio) { audio = new Audio(`/api/projects/${pid}/songs/${song.id}/file`); audio.preload = 'auto'; }
    return audio;
  }
  function loop() {
    if (!playing) return;
    if (audio.currentTime >= t1 - 0.03 || audio.currentTime < t0 - 0.5) audio.currentTime = t0;
    ph.style.left = Math.min(100, Math.max(0, ((audio.currentTime - t0) / Math.max(t1 - t0, 0.1)) * 100)) + '%';
    raf = requestAnimationFrame(loop);
  }
  async function play() {
    stopPreview();
    ensureAudio().currentTime = t0;
    try { await audio.play(); } catch (e) { return; }
    playing = true; current = api;
    playBtn.replaceChildren(icon('pause', 18)); playBtn.classList.add('on'); win.classList.add('live');
    cancelAnimationFrame(raf); raf = requestAnimationFrame(loop);
  }
  function stop() {
    playing = false; cancelAnimationFrame(raf);
    if (audio) audio.pause();
    playBtn.replaceChildren(icon('play', 18)); playBtn.classList.remove('on'); win.classList.remove('live');
    if (current === api) current = null;
  }
  const api = { stop };
  el.addEventListener('pointerdown', () => ensureAudio(), { once: true, passive: true }); // start buffering before the first tap on play

  readColors();
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { readColors(); schedule(); });
  new ResizeObserver(layout).observe(view);
  label(t0);
  el.stop = stop;
  return el;
}
