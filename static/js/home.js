import { api } from './api.js';
import { h, icon, logo, dur, toast } from './ui.js';

const ago = (t) => { const s = Date.now() / 1000 - t; if (s < 90) return 'just now'; if (s < 3600) return `${Math.round(s / 60)} min ago`; if (s < 86400) return `${Math.round(s / 3600)} h ago`; return `${Math.round(s / 86400)} d ago`; };

export async function home(screen, _id, go) {
  const list = h('div', { class: 'scroll' });
  const put = (...xs) => list.append(...xs.flat(9).filter((x) => x != null && x !== false));
  const nav = h('div', { class: 'nav' }, h('div', { class: 'l' }), h('div', { class: 'title' }, 'Cadence'),
    h('div', { class: 'r' }, h('button', { class: 'nav-btn strong', onclick: newProject, 'aria-label': 'New project' }, icon('plus', 26))));
  screen.append(nav, list);
  list.addEventListener('scroll', () => nav.classList.toggle('scrolled', list.scrollTop > 36), { passive: true });

  async function trySample(e) {
    const b = e.currentTarget; b.disabled = true; b.textContent = 'Building sample…';
    const p = await fetch('/api/sample', { method: 'POST' }).then((r) => r.json());
    go(`#/edit/${p.id}`);
  }

  async function newProject() {
    const p = await api.create('Untitled');
    go(`#/new/${p.id}`);
  }

  const projects = await api.projects();
  put(h('div', { class: 'large-title' }, logo(), 'Cadence'), h('div', { class: 'sub' }, 'Videos that cut to the beat.'));
  if (!projects.length) {
    put(h('div', { class: 'empty' },
      h('div', { class: 'mark' }, logo()),
      h('h2', {}, 'Make your first video'),
      h('p', {}, 'Pick a song, drop in your clips and photos. Cadence cuts them to the beat — you polish.'),
      h('button', { class: 'btn', style: { margin: '0 auto', width: '200px' }, onclick: newProject }, 'New Video'),
      h('button', { class: 'btn ghost', style: { margin: '8px auto 0', width: '200px' }, onclick: trySample }, 'Try a sample')));
    return;
  }
  put(h('div', { class: 'group' }, projects.map((p) => h('div', { class: 'row proj' },
    h('button', { class: 'proj-main', onclick: () => go(p.shots ? `#/edit/${p.id}` : `#/new/${p.id}`) },
      h('div', { class: 'th', style: p.thumb ? { backgroundImage: `url(${p.thumb})` } : {} }, p.thumb ? null : icon('video')),
      h('div', { class: 'grow' }, h('div', { class: 'name' }, p.name), h('div', { class: 'meta' }, (p.shots ? `${dur(p.duration)} · ${p.ratio} · ${p.shots} cuts` : 'Draft') + ` · ${ago(p.updated)}`))),
    del(p)))),
    projects.some((p) => p.sample) ? null : h('button', { class: 'btn ghost block', style: { width: 'auto', margin: '0 16px' }, onclick: trySample }, 'Add a sample video'));
  // two-tap delete in the row itself: no overlay to mis-hit on touch screens
  function del(p) {
    let timer;
    const b = h('button', { class: 'del', 'aria-label': `Delete ${p.name}` }, icon('trash', 18));
    const reset = () => { b.classList.remove('armed'); b.replaceChildren(icon('trash', 18)); };
    b.addEventListener('click', async () => {
      if (!b.classList.contains('armed')) {
        b.classList.add('armed'); b.replaceChildren('Delete');
        clearTimeout(timer); timer = setTimeout(reset, 3500);
        return;
      }
      clearTimeout(timer); b.disabled = true;
      try { await api.remove(p.id); } catch (e) { b.disabled = false; reset(); toast('Could not delete'); return; }
      location.reload();
    });
    return b;
  }
}
