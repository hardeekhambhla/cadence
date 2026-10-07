// Tiny DOM + iOS-style UI kit (sheets, toasts, icons). No framework.
export function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(9)) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(kid));
  return el;
}

const P = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  play: '<path d="M8 5.5v13l11-6.5z" fill="currentColor" stroke="none"/>',
  pause: '<path d="M8 5.5v13M16 5.5v13" stroke-width="3.2"/>',
  music: '<path d="M9 17.5V6l10-2v11.5"/><circle cx="6.5" cy="17.5" r="2.5"/><circle cx="16.5" cy="15.5" r="2.5"/>',
  media: '<rect x="3.5" y="5" width="17" height="14" rx="3"/><path d="M3.5 15l4.5-4 4 3.5 3-2.5 5.5 4.5"/><circle cx="16" cy="9.5" r="1.3"/>',
  ratio: '<rect x="6" y="3.5" width="12" height="17" rx="2.5"/>',
  pace: '<path d="M4 17a8.5 8.5 0 1116 0"/><path d="M12 17l4-5.5"/>',
  style: '<path d="M12 3.5l1.8 4.7 4.7 1.8-4.7 1.8L12 16.5l-1.8-4.7L5.5 10l4.7-1.8z"/><path d="M18.5 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/>',
  trash: '<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l.8 12h9.4l.8-12M10 11v5M14 11v5"/>',
  split: '<path d="M12 3.5v17"/><path d="M6.5 8l-3 4 3 4M17.5 8l3 4-3 4"/>',
  swapL: '<path d="M10 6l-6 6 6 6M4 12h16"/>',
  swapR: '<path d="M14 6l6 6-6 6M20 12H4"/>',
  replace: '<path d="M4 9.5a8 8 0 0114-3l2 2M20 14.5a8 8 0 01-14 3l-2-2"/><path d="M18 3.5v5h-5M6 20.5v-5h5"/>',
  trim: '<path d="M7 3.5v17M17 3.5v17M7 8h-3M7 16h-3M17 8h3M17 16h3"/>',
  focus: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3"/>',
  fit: '<rect x="3.5" y="6.5" width="17" height="11" rx="2.5"/><path d="M8 12h8"/>',
  longer: '<path d="M4 12h16M15 7l5 5-5 5"/>',
  shorter: '<path d="M20 12H4M9 7l-5 5 5 5"/>',
  undo: '<path d="M9 7L4.5 11.5 9 16"/><path d="M5 11.5h8.5a5.5 5.5 0 010 11H11" transform="translate(0 -3)"/>',
  share: '<path d="M12 15V3.5M7.5 8L12 3.5 16.5 8"/><path d="M5 12v6.5a2 2 0 002 2h10a2 2 0 002-2V12"/>',
  download: '<path d="M12 3.5V15M7.5 11L12 15.5 16.5 11"/><path d="M5 19.5h14"/>',
  shuffle: '<path d="M3.5 7h3.5c5 0 5.5 10 10.5 10h3M3.5 17h3.5c1.5 0 2.7-.8 3.7-2M13.5 9c1-1.3 2.2-2 3.5-2h3.5"/><path d="M18 4l2.5 3-2.5 3M18 14l2.5 3-2.5 3"/>',
  video: '<rect x="3" y="6" width="13" height="12" rx="3"/><path d="M16 10.5l5-2.5v8l-5-2.5"/>',
  cam: '<rect x="6" y="18" width="52" height="36" rx="10" transform="scale(.375) translate(0 -2)"/>',
};
export function icon(name, size) {
  const s = h('span', { html: `<svg viewBox="0 0 24 24" width="${size || 24}" height="${size || 24}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${P[name] || ''}</svg>` });
  return s.firstChild;
}
export const logo = () => h('span', { html: '<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="18" width="52" height="36" rx="10"/><path d="M21 18l3.2-6.5h15.6L43 18"/><circle cx="32" cy="36" r="11.5"/><circle cx="32" cy="36" r="4.5"/><circle cx="49" cy="26.5" r="1.6" fill="currentColor" stroke="none"/></svg>' }).firstChild;

export const fmt = (t, dec = 1) => {
  t = Math.max(0, t || 0);
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${m}:${s.toFixed(dec).padStart(dec ? dec + 3 : 2, '0')}`;
};
export const dur = (t) => { const m = Math.floor(t / 60), s = Math.round(t % 60); return m ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`; };

export function toast(msg) {
  const t = h('div', { class: 'toast' }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 2500);
}

export function sheet({ title, body, onClose }) {
  const scrim = h('div', { class: 'scrim' });
  const el = h('div', { class: 'sheet' }, h('div', { class: 'grab' }), title ? h('h3', {}, title) : null, h('div', { class: 'body' }, body));
  const close = () => {
    scrim.classList.add('out'); el.classList.add('out');
    setTimeout(() => { scrim.remove(); el.remove(); onClose && onClose(); }, 260);
  };
  scrim.addEventListener('click', close);
  document.body.append(scrim, el);
  return { close, el };
}

export function actionSheet(title, actions) {
  let s;
  const rows = actions.map((a) => h('button', { class: 'row', style: { justifyContent: 'center', color: a.danger ? 'var(--danger)' : 'var(--accent)', fontWeight: a.bold ? 600 : 400 }, onclick: () => { s.close(); a.run && a.run(); } }, a.label));
  s = sheet({ title, body: [h('div', { class: 'group' }, rows), h('div', { class: 'group' }, h('button', { class: 'row', style: { justifyContent: 'center', color: 'var(--accent)', fontWeight: 600 }, onclick: () => s.close() }, 'Cancel'))] });
  return s;
}

export function slider({ min = 0, max = 1, step = 0.01, value = 0, oninput, onchange }) {
  const el = h('input', { type: 'range', min, max, step, value });
  const paint = () => el.style.setProperty('--p', ((el.value - min) / (max - min)) * 100 + '%');
  el.addEventListener('input', () => { paint(); oninput && oninput(+el.value); });
  el.addEventListener('change', () => onchange && onchange(+el.value));
  paint();
  el.paint = paint;
  return el;
}

export function seg(options, value, onpick) {
  const el = h('div', { class: 'seg' });
  const draw = (v) => { el.replaceChildren(...options.map(([val, label]) => h('button', { class: val === v ? 'on' : '', onclick: () => { draw(val); onpick(val); } }, label))); };
  draw(value);
  return el;
}

export function waveform(canvas, peaks, { beats = [], duration = 1, trim = null, color = '#A8A49D', hot = '#FF5A36' } = {}) {
  const dpr = devicePixelRatio || 1;
  const w = canvas.clientWidth, hgt = canvas.clientHeight;
  canvas.width = w * dpr; canvas.height = hgt * dpr;
  const c = canvas.getContext('2d');
  c.scale(dpr, dpr);
  const css = getComputedStyle(document.documentElement);
  const fill = css.getPropertyValue('--fill').trim();
  c.fillStyle = fill; c.fillRect(0, 0, w, hgt);
  const n = peaks.length, bw = w / n;
  const [t0, t1] = trim || [0, duration];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * duration;
    const inside = t >= t0 && t <= t1;
    const ph = Math.max(2, peaks[i] * (hgt - 8));
    c.fillStyle = inside ? css.getPropertyValue('--accent').trim() : css.getPropertyValue('--ink-3').trim();
    c.globalAlpha = inside ? 0.9 : 0.5;
    c.fillRect(i * bw + 0.5, (hgt - ph) / 2, Math.max(1, bw - 1), ph);
  }
  c.globalAlpha = 0.35; c.fillStyle = css.getPropertyValue('--ink').trim();
  for (const b of beats) if (b >= t0 && b <= t1) c.fillRect((b / duration) * w, hgt - 5, 1, 5);
}
