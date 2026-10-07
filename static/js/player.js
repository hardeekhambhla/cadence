// Live preview: the song's audio element is the master clock; a small pool of <video>/<img> layers is
// pre-seeked one or two shots ahead so each cut is a z-index flip, like a real editor's preview.
import { mediaUrl, thumbUrl } from './api.js';

export const FILTER_CSS = {  // mirrors FILTERS in engine/render.py
  none: '', cinematic: 'contrast(1.12) saturate(1.06) brightness(.97) hue-rotate(-4deg)', vibrant: 'saturate(1.45) contrast(1.08)',
  summer: 'sepia(.18) saturate(1.3) brightness(1.04) hue-rotate(-6deg)', winter: 'hue-rotate(-10deg) saturate(1.05) brightness(1.02)',
  moody: 'contrast(1.15) brightness(.93) saturate(.8)', vintage: 'sepia(.35) contrast(.95) saturate(.9)',
  noir: 'grayscale(1) contrast(1.2)', soft: 'saturate(.85) contrast(.92) brightness(1.05)',
};
const POOL = 5;
const el = (tag, cls) => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };

function seekTo(v, t) {
  return new Promise((res) => {
    const finish = () => { v.removeEventListener('seeked', finish); res(); };
    const go = () => {
      if (Math.abs(v.currentTime - t) < 0.04) return res();
      v.addEventListener('seeked', finish);
      v.currentTime = t;
      setTimeout(res, 700);
    };
    if (v.readyState >= 1) go();
    else { v.addEventListener('loadedmetadata', go, { once: true }); setTimeout(res, 1500); }
  });
}

export class Player {
  constructor(stage) {
    this.stage = stage;
    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.audio.addEventListener('ended', () => this.pause());
    this.layers = Array.from({ length: POOL }, () => {
      const root = el('div', 'layer');
      const v = el('video'); v.muted = true; v.playsInline = true; v.preload = 'auto'; v.disablePictureInPicture = true;
      v.setAttribute('playsinline', ''); v.setAttribute('webkit-playsinline', '');
      const bg = el('img', 'bg'), img = el('img', 'main');
      bg.draggable = img.draggable = false;
      root.append(bg, v, img);
      stage.append(root);
      return { root, v, bg, img, shotId: null, sig: '', ready: false, last: 0 };
    });
    this.flash = el('div'); this.flash.style.cssText = 'position:absolute;inset:0;background:#fff;opacity:0;z-index:3;pointer-events:none';
    this.vig = el('div'); this.vig.style.cssText = 'position:absolute;inset:0;z-index:2;pointer-events:none;background:radial-gradient(ellipse at center,transparent 52%,rgba(0,0,0,.5));display:none';
    stage.append(this.flash, this.vig);
    Object.assign(this, { shots: [], media: {}, D: 0, t: 0, playing: false, cur: -1, curLayer: null, pid: null, style: 'pulse', filter: 'none', cbs: [], stateCbs: [], audioSrc: '', seekToken: 0 });
    this.loop = this.loop.bind(this);
  }

  on(cb) { this.cbs.push(cb); }
  onState(cb) { this.stateCbs.push(cb); }

  load(p) {
    this.pid = p.id;
    this.media = Object.fromEntries(p.media.map((m) => [m.id, m]));
    this.shots = p.shots;
    this.D = p.timeline ? p.timeline.duration : 0;
    this.style = p.settings.style; this.filter = p.settings.filter;
    const src = `/api/projects/${p.id}/audio.m4a?v=${p.audio_v}`;
    if (src !== this.audioSrc) { this.audioSrc = src; this.audio.src = src; this.audio.volume = 1; }
    this.audio.volume = Math.min(1, p.settings.volume ?? 1);
    this.applyLook();
    this.cur = -1;
    this.t = Math.min(this.t, this.D);
    if (!this.playing) this.showAt(this.t);
  }

  applyLook() {
    for (const L of this.layers) L.root.style.filter = FILTER_CSS[this.filter] || '';
    this.vig.style.display = this.filter === 'cinematic' ? 'block' : 'none';
  }

  idxAt(t) {
    const s = this.shots;
    let lo = 0, hi = s.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (s[mid].start <= t + 1e-4) lo = mid; else hi = mid - 1; }
    return lo;
  }

  sig(s) { return `${s.media}|${s.in}|${s.speed}|${s.fit}|${s.fx}|${s.fy}`; }

  layerFor(idx) {
    const s = this.shots[idx];
    if (!s) return null;
    let L = this.layers.find((l) => l.shotId === s.id);
    if (!L) {
      const keep = new Set([0, 1, 2].map((k) => this.shots[this.cur + k] && this.shots[this.cur + k].id));
      const pool = this.layers.filter((l) => !keep.has(l.shotId));
      L = (pool.length ? pool : this.layers).sort((a, b) => a.last - b.last)[0];
      L.shotId = s.id; L.sig = '';
    }
    L.last = performance.now();
    const sg = this.sig(s);
    if (L.sig !== sg) {
      L.sig = sg; L.ready = false;
      const m = this.media[s.media];
      L.root.className = `layer ${s.fit === 'blur' ? 'blur' : 'fill'} ${m.kind === 'video' ? 'is-video' : 'is-image'}`;
      const fx = s.fx ?? m.focus[0], fy = s.fy ?? m.focus[1];
      L.v.style.objectPosition = L.img.style.objectPosition = `${fx * 100}% ${fy * 100}%`;
      L.bg.src = thumbUrl(this.pid, m);
      if (m.kind === 'video') {
        const url = mediaUrl(this.pid, m, m.proxy);
        if (L.v.dataset.src !== url) { L.v.dataset.src = url; L.v.src = url; }
        L.v.playbackRate = Math.max(0.25, s.speed);
        seekTo(L.v, s.in).then(() => { if (L.sig === sg) L.ready = true; });
      } else {
        L.img.src = mediaUrl(this.pid, m, m.proxy);
        L.ready = true;
      }
    }
    return L;
  }

  srcTime(s, t) { return s.in + Math.max(0, t - s.start) * s.speed; }

  show(L) {
    for (const l of this.layers) if (l !== L) l.root.classList.remove('on');
    if (L) L.root.classList.add('on');
  }

  showAt(t) {
    if (!this.shots.length) return;
    const idx = this.idxAt(t);
    const s = this.shots[idx], L = this.layerFor(idx);
    this.cur = idx; this.curLayer = L;
    for (const l of this.layers) if (l !== L) l.v.pause();
    this.show(L);
    const m = this.media[s.media];
    if (m.kind === 'video') {
      const want = this.srcTime(s, t), token = ++this.seekToken;
      L.v.pause();
      seekTo(L.v, want).then(() => { if (token !== this.seekToken) return; });
    }
    this.drive(t);
    this.layerFor(idx + 1);
  }

  drive(t) {
    const s = this.shots[this.cur], L = this.curLayer;
    if (!s || !L) return;
    const local = t - s.start, f = Math.min(1, local / Math.max(s.dur, 0.05));
    let z = 1, tx = 0, ty = 0;
    if (s.kb) {
      z = s.kb.z0 + (s.kb.z1 - s.kb.z0) * f;
      tx = -s.kb.dx * (z - 1) * (f - 0.5) * 100; ty = -s.kb.dy * (z - 1) * (f - 0.5) * 100;
    }
    if (this.style === 'pulse' && s.punch > 0) z *= 1 + Math.min(0.09, 0.055 * s.punch) * Math.pow(Math.max(0, 1 - local / 0.26), 2);
    L.root.style.transform = z === 1 && !tx && !ty ? '' : `translate(${tx}%, ${ty}%) scale(${z})`;
    this.flash.style.opacity = this.style === 'flash' && s.punch >= 1 ? Math.max(0, 1 - local / 0.13) * 0.9 : 0;
    const m = this.media[s.media];
    if (this.playing && m.kind === 'video' && L.ready) {
      const want = this.srcTime(s, t);
      if (Math.abs(L.v.currentTime - want) > 0.28) L.v.currentTime = want;
    }
  }

  enter(idx, t) {
    const prev = this.curLayer;
    this.cur = idx;
    const s = this.shots[idx], L = this.layerFor(idx);
    this.curLayer = L;
    this.show(L);
    if (this.media[s.media].kind === 'video') {
      const want = this.srcTime(s, t);
      if (Math.abs(L.v.currentTime - want) > 0.06) L.v.currentTime = want;
      L.v.playbackRate = Math.max(0.25, s.speed);
      L.v.play().catch(() => {});
    }
    if (prev && prev !== L) prev.v.pause();
    this.layerFor(idx + 1); this.layerFor(idx + 2);
  }

  clock() {
    return this.audio.paused || !this.audio.readyState ? this.base + (performance.now() - this.t0) / 1000 : this.audio.currentTime;
  }

  loop() {
    if (!this.playing) return;
    const t = this.clock();
    if (t >= this.D - 0.01) { this.t = this.D; this.pause(); this.emit(); return; }
    this.t = t;
    const idx = this.idxAt(t);
    if (idx !== this.cur) this.enter(idx, t);
    this.drive(t);
    this.emit();
    requestAnimationFrame(this.loop);
  }

  emit() { for (const cb of this.cbs) cb(this.t); }

  async play() {
    if (this.playing || !this.D) return;
    if (this.t >= this.D - 0.05) this.t = 0;
    this.playing = true;
    this.base = this.t; this.t0 = performance.now();
    this.audio.currentTime = this.t;
    this.cur = -1;
    try { await this.audio.play(); } catch (e) { /* no audio yet — fall back to wall clock */ }
    this.t0 = performance.now(); this.base = this.audio.paused ? this.t : this.audio.currentTime;
    this.stateCbs.forEach((cb) => cb(true));
    requestAnimationFrame(this.loop);
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    this.audio.pause();
    for (const l of this.layers) l.v.pause();
    this.stateCbs.forEach((cb) => cb(false));
    this.showAt(this.t);
  }

  seek(t) {
    t = Math.max(0, Math.min(this.D, t));
    this.t = t;
    if (this.playing) { this.audio.currentTime = t; this.base = t; this.t0 = performance.now(); this.cur = -1; }
    else this.showAt(t);
    this.emit();
  }

  toggle() { return this.playing ? this.pause() : this.play(); }
  destroy() { this.playing = false; this.audio.pause(); this.audio.removeAttribute('src'); for (const l of this.layers) { l.v.pause(); l.v.removeAttribute('src'); } }
}
