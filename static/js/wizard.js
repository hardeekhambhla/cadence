import { api, upload, thumbUrl, RATIOS, ratioAR } from './api.js';
import { h, icon, dur, seg, sheet, toast, waveform } from './ui.js';
import { PRESETS, LENGTHS, LOOKS, ENERGY, STYLES } from './looks.js';
import { FILTER_CSS } from './player.js';
import { songPicker, stopPreview } from './picker.js';

const STEPS = ['Format', 'Music', 'Clips', 'Style'];

export async function wizard(screen, pid, go) {
  let p = await api.get(pid);
  let step = 0;
  let energy = 'balanced';
  let selTile = null; // tapped clip tile (shows its remove button)
  p.preset = p.preset || (PRESETS.find((x) => x.ratio === p.ratio && x.length === p.settings.length) || PRESETS[0]).id;
  const uploads = []; // local in-flight uploads {id, name, kind, url, progress, error}
  let timer = null, dead = false;

  const put = (el, ...xs) => el.append(...xs.flat(9).filter((x) => x != null && x !== false));
  const body = h('div', { class: 'scroll' });
  const footer = h('div', { class: 'footer' });
  const nav = h('div', { class: 'nav' });
  screen.append(nav, body, footer);
  body.addEventListener('scroll', () => nav.classList.toggle('scrolled', body.scrollTop > 36), { passive: true });

  const busy = () => p.songs.some((s) => s.status === 'analyzing') || p.media.some((m) => m.status === 'processing') || uploads.some((u) => !u.error);
  async function refresh() {
    if (dead) return;
    const fresh = await api.get(pid);
    const changed = JSON.stringify(fresh.songs.map((s) => s.status)) + JSON.stringify(fresh.media.map((m) => m.status)) !== JSON.stringify(p.songs.map((s) => s.status)) + JSON.stringify(p.media.map((m) => m.status));
    p = fresh;
    if (changed) render();
    if (busy()) timer = setTimeout(refresh, 900);
  }
  const poke = () => { clearTimeout(timer); timer = setTimeout(refresh, 400); };

  // ------------------------------------------------------------------ steps
  function formatStep() {
    const rows = PRESETS.map((x) => {
      const [a, b] = x.ratio.split(':').map(Number), max = 40, ar = a / b;
      const [bw, bh] = ar >= 1 ? [max, max / ar] : [max * ar, max];
      return h('button', { class: 'row preset', onclick: async () => {
        p.preset = x.id; p.ratio = x.ratio; p.settings.length = x.length; render();
        api.save(pid, { ratio: x.ratio, settings: { length: x.length } });
      } },
        h('div', { class: 'pbox' }, h('i', { style: { width: bw + 'px', height: bh + 'px' } })),
        h('div', { class: 'grow' }, h('div', { class: 'name', style: { fontWeight: 600 } }, x.name), h('div', { class: 'meta' }, `${x.ratio} · ${x.note}`)),
        p.preset === x.id ? h('span', { style: { color: 'var(--accent)' } }, icon('check', 22)) : null);
    });
    put(body, h('div', { class: 'large-title' }, 'What are you making?'),
      h('div', { class: 'sub' }, 'Pick where it will be posted. You can change the shape later.'),
      h('div', { class: 'group' }, rows));
    put(footer, h('button', { class: 'btn block', onclick: () => { step = 1; render(); } }, 'Continue'));
  }

  function musicStep() {
    const input = h('input', { type: 'file', accept: 'audio/*,.mp3,.m4a,.wav,.aac,.flac', multiple: true, style: { display: 'none' }, onchange: async () => {
      for (const f of input.files) { await upload(`/api/projects/${pid}/songs`, f); }
      input.value = ''; p = await api.get(pid); render(); poke();
    } });
    const cards = p.songs.map((s) => {
      const a = s.analysis;
      const cv = h('canvas');
      const long = a && s.trim[1] - s.trim[0] < a.duration - 1;
      const card = h('div', { class: 'song' },
        h('div', { class: 'top' }, icon('music', 20), h('div', { class: 'nm' }, s.name),
          h('button', { class: 'x', 'aria-label': 'Remove song', onclick: async () => { p = await api.delSong(pid, s.id); render(); } }, icon('close', 14))),
        s.status === 'analyzing' ? h('div', { class: 'info', style: { padding: '14px 0' } }, h('div', { class: 'spinner' }), 'Finding the beat…') :
        s.status === 'error' ? h('div', { class: 'info', style: { color: 'var(--danger)' } }, "Couldn't read this file") : [
          long ? songPicker({ pid, song: s, onChange: (proj) => { p = proj; } }) : cv,
          h('div', { class: 'info' }, h('span', { class: 'chip' }, a.fallback ? 'No clear beat · even rhythm' : `${Math.round(a.bpm)} BPM`), s.trim[1] - s.trim[0] > 0.5 ? (long ? 'Drag to choose · ▶ to hear it' : `Using the full ${dur(a.duration)}`) : 'Not needed for this length'),
        ]);
      if (a && !long) requestAnimationFrame(() => waveform(cv, a.peaks, { beats: a.beats, duration: a.duration, trim: s.trim }));
      return card;
    });
    const ready = p.songs.filter((s) => s.status === 'ready');
    const total = ready.reduce((t, s) => t + s.analysis.duration, 0);
    const used = ready.reduce((t, s) => t + (s.trim[1] - s.trim[0]), 0);
    const lengths = LENGTHS.filter(([v]) => v === 'full' || v === 'fit' || !ready.length || +v < total - 3);
    const curLen = lengths.some(([v]) => v === String(p.settings.length)) ? String(p.settings.length) : 'full';
    put(body, 
      h('div', { class: 'large-title' }, 'Music'),
      h('div', { class: 'sub' }, p.songs.length ? 'Every cut will land on its beat.' : 'Start with the song. Every cut will land on its beat.'),
      cards,
      ready.length ? [h('div', { class: 'group-title' }, 'Video length'),
        h('div', { class: 'lengths' }, lengths.map(([v, label]) => h('button', { class: 'lenchip' + (curLen === v ? ' on' : ''), onclick: async () => {
          p.settings.length = v; render();
          p = await api.save(pid, { settings: { length: v } }); render();
        } }, label))),
        h('div', { class: 'hint', style: { margin: '2px 24px 14px' } }, p.settings.length === 'fit' ? "We'll size it to your clips once you've added them." : `Your video will run about ${dur(used)}, cut from ${ready.some((s) => s.start != null) ? 'the part you picked' : 'the best part of the song'}.`)] : null,
      p.songs.length ? null : h('div', { class: 'empty', style: { marginTop: '4vh' } }, h('div', { class: 'mark' }, icon('music', 88)),
        h('button', { class: 'btn', style: { width: '200px', margin: '0 auto' }, onclick: () => input.click() }, icon('plus', 20), 'Add a song')),
      input);
    put(footer, 
      p.songs.length ? h('button', { class: 'btn secondary block', style: { marginBottom: '10px' }, onclick: () => input.click() }, icon('plus', 20), 'Add another song') : null,
      h('button', { class: 'btn block', disabled: !p.songs.some((s) => s.status === 'ready') || p.songs.some((s) => s.status === 'analyzing'), onclick: () => { step = 2; render(); } }, 'Continue'));
  }

  function mismatch() {
    const sg = p.suggest, vertical = ['9:16', '4:5'].includes(p.ratio), wide = p.ratio === '16:9';
    let to = null;
    if (vertical && sg.horizontal > sg.vertical + sg.square) to = PRESETS.find((x) => x.id === 'landscape');
    else if (wide && sg.vertical > sg.horizontal + sg.square) to = PRESETS.find((x) => x.id === 'reel');
    if (!to) return null;
    return h('div', { class: 'banner' }, h('div', { class: 'grow' }, h('b', {}, `Most of your clips are ${to.ratio === '16:9' ? 'horizontal' : 'vertical'}.`), h('div', { class: 'meta' }, `${to.name} (${to.ratio}) would show them without cropping.`)),
      h('button', { class: 'btn small', onclick: () => { p.preset = to.id; p.ratio = to.ratio; api.save(pid, { ratio: to.ratio }); render(); } }, 'Switch'));
  }

  function mediaStep() {
    const input = h('input', { type: 'file', accept: 'image/*,video/*', multiple: true, style: { display: 'none' }, onchange: () => { addFiles([...input.files]); input.value = ''; } });
    const queue = [];
    let active = 0;
    function addFiles(files) {
      files.forEach((f) => {
        const u = { file: f, id: Math.random().toString(36).slice(2), name: f.name, kind: f.type.startsWith('image/') ? 'image' : 'video', url: f.type.startsWith('image/') ? URL.createObjectURL(f) : null, progress: 0 };
        uploads.push(u); queue.push([f, u]);
      });
      render(); pump();
    }
    function pump() {
      while (active < 2 && queue.length) {
        const [f, u] = queue.shift(); active++;
        upload(`/api/projects/${pid}/media`, f, { modified: f.lastModified }, (v) => { u.progress = v; const t = document.getElementById('u' + u.id); if (t) t.querySelector('.tprog').style.width = v * 100 + '%'; })
          .then(() => { uploads.splice(uploads.indexOf(u), 1); }).catch((e) => { u.error = e.message; })
          .finally(async () => { active--; p = await api.get(pid); render(); pump(); poke(); });
      }
    }
    const taken = (m) => m.taken || m.modified || 0;
    const shown = p.settings.order === 'chrono' ? [...p.media].sort((x, y) => taken(x) - taken(y) || x.name.localeCompare(y.name)) : p.media;
    const day = (m) => (m.taken ? new Date(m.taken * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }) : null);
    const tiles = [
      ...shown.map((m) => h('div', { class: 'tile' + (selTile === m.id ? ' sel' : ''), style: m.thumb ? { backgroundImage: `url(${thumbUrl(pid, m)})` } : {}, onclick: () => { selTile = selTile === m.id ? null : m.id; render(); } },
        m.status === 'processing' ? h('div', { class: 'veil' }, h('div', { class: 'spinner' })) : null,
        m.status === 'error' ? h('div', { class: 'veil', style: { color: '#fff', fontSize: '12px' } }, 'Unsupported') : null,
        day(m) ? h('div', { class: 'date' }, day(m)) : null,
        m.kind === 'video' && m.duration ? h('div', { class: 'badge dur' }, dur(m.duration)) : null,
        h('button', { class: 'x', 'aria-label': 'Remove clip', onclick: async (e) => { e.stopPropagation(); selTile = null; p = await api.delMedia(pid, m.id); render(); } }, icon('close', 14)))),
      ...uploads.map((u) => h('div', { class: 'tile' + (u.error ? ' failed' : ''), id: 'u' + u.id, style: u.url ? { backgroundImage: `url(${u.url})` } : {},
        onclick: u.error ? () => { u.error = null; u.progress = 0; queue.push([u.file, u]); render(); pump(); } : null },
        h('div', { class: 'veil' }, u.error ? h('span', { style: { color: '#fff', fontSize: '12px', textAlign: 'center', padding: '0 6px' } }, 'Failed · tap to retry') : h('div', { class: 'spinner' })),
        h('div', { class: 'tprog', style: { width: u.progress * 100 + '%' } }))),
    ];
    const n = p.media.length + uploads.length;
    put(body, 
      h('div', { class: 'large-title' }, 'Clips'),
      h('div', { class: 'sub' }, n ? `${uploads.some((u) => !u.error) ? `Uploading ${uploads.filter((u) => !u.error).length} more… ` : ''}${n} ${n === 1 ? 'item' : 'items'}. Cadence uses every one, once.` : 'Add the videos and photos for this edit.'),
      mismatch(),
      n ? h('div', { class: 'grid' }, tiles) : h('div', { class: 'empty', style: { marginTop: '4vh' } }, h('div', { class: 'mark' }, icon('media', 88)),
        h('button', { class: 'btn', style: { width: '240px', margin: '0 auto' }, onclick: () => input.click() }, icon('plus', 20), 'Add photos & videos')),
      n ? h('div', { class: 'group-title' }, 'Order') : null,
      n ? h('div', { style: { margin: '0 16px 16px' } }, seg([['chrono', 'By date'], ['added', 'As added'], ['shuffle', 'Shuffle']], p.settings.order, (v) => { p.settings.order = v; render(); })) : null,
      input);
    put(footer, 
      n ? h('button', { class: 'btn secondary block', style: { marginBottom: '10px' }, onclick: () => input.click() }, icon('plus', 20), 'Add more') : null,
      h('button', { class: 'btn block', disabled: busy() || !p.media.some((m) => m.status === 'ready'), onclick: () => { step = 3; render(); } }, busy() ? 'Processing…' : 'Continue'));
  }

  function styleStep() {
    const first = p.media.find((m) => m.thumb);
    const bg = first ? `url(${thumbUrl(pid, first)})` : '';
    const looks = LOOKS.map(([v, label]) => h('button', { class: 'look' + (p.settings.filter === v ? ' on' : ''), onclick: () => { p.settings.filter = v; render(); } },
      h('i', { style: { backgroundImage: bg, filter: FILTER_CSS[v] || 'none' } }, v === 'cinematic' ? h('u') : null), label));
    put(body, h('div', { class: 'large-title' }, 'Set the vibe'),
      h('div', { class: 'sub' }, 'A look for the whole video. Tweak any of it in the editor.'),
      h('div', { class: 'looks' }, looks),
      h('div', { class: 'group-title' }, 'Energy'),
      h('div', { style: { margin: '0 16px 6px' } }, seg(ENERGY.map(([v, l]) => [v, l]), energy, (v) => { energy = v; })),
      h('div', { class: 'hint', style: { margin: '2px 24px 14px' } }, 'Chill holds shots longer. Hype cuts on almost every beat.'),
      h('div', { class: 'group-title' }, 'Transitions'),
      h('div', { style: { margin: '0 16px 16px' } }, seg(STYLES, p.settings.style, (v) => { p.settings.style = v; })));
    put(footer, h('button', { class: 'btn block', onclick: create }, 'Create video'));
  }

  async function create() {
    const s = sheet({ title: 'Syncing to the beat…', body: h('div', { class: 'pad', style: { display: 'flex', gap: '12px', alignItems: 'center', padding: '8px 20px 22px' } }, h('div', { class: 'spinner' }), 'Finding the best cuts') });
    try {
      const name = p.songs[0] ? p.songs[0].name : 'Untitled';
      await api.save(pid, { name: p.name === 'Untitled' ? name : p.name, ratio: p.ratio, settings: { filter: p.settings.filter, style: p.settings.style } });
      await api.plan(pid, { ratio: p.ratio, order: p.settings.order, pace: ENERGY.find((e) => e[0] === energy)[2], seed: 1, length: p.settings.length });
      s.close();
      go(`#/edit/${pid}`);
    } catch (e) { s.close(); toast('Could not create: ' + e.message.slice(0, 60)); }
  }

  function render() {
    stopPreview();
    body.replaceChildren(); footer.replaceChildren(); nav.replaceChildren();
    put(nav, h('div', { class: 'l' }, h('button', { class: 'nav-btn', onclick: () => (step ? (step--, render()) : go('#/')) }, step ? [icon('back', 22), 'Back'] : 'Cancel')),
      h('div', { class: 'title' }, STEPS[step]), h('div', { class: 'r' }));
    put(body, h('div', { class: 'steps' }, STEPS.map((_, i) => h('i', { class: i <= step ? 'on' : '' }))));
    [formatStep, musicStep, mediaStep, styleStep][step]();
  }
  render();
  if (busy()) refresh();
  return () => { dead = true; clearTimeout(timer); stopPreview(); };
}
