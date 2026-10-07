import { h } from './ui.js';
import { home } from './home.js';
import { wizard } from './wizard.js';
import { editor } from './editor.js';

const app = document.getElementById('app');
let teardown = null;

async function route() {
  const [, page, id] = location.hash.split('/');
  if (teardown) { try { teardown(); } catch (e) { console.error(e); } teardown = null; }
  app.replaceChildren();
  const screen = h('div', { class: 'screen' });
  app.append(screen);
  const go = (hash) => { location.hash = hash; };
  const mount = page === 'new' ? wizard : page === 'edit' ? editor : home;
  teardown = (await mount(screen, id, go)) || null;
}
addEventListener('hashchange', route);
route();
