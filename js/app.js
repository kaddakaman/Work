// App shell: bottom tab navigation, hash routing, live timers, offline support.
import * as store from './store.js';
import { fmtClock, todayStr } from './util.js';
import { icon } from './icons.js';
import { toast } from './ui.js';
import * as assets from './views/assets.js';
import * as hours from './views/hours.js';
import * as vacuum from './views/vacuum.js';
import * as sentry from './views/sentry.js';
import * as manage from './views/manage.js';

const ROUTES = {
  assets: { title: 'Asset readings', tab: 'Assets', icon: 'gauge', view: assets },
  hours: { title: 'Hours worked', tab: 'Hours', icon: 'clock', view: hours },
  vacuum: { title: 'Vacuum', tab: 'Vacuum', icon: 'wind', view: vacuum },
  sentry: { title: 'Sentry log', tab: 'Sentry', icon: 'shield', view: sentry },
  manage: { title: 'Manage', tab: 'Manage', icon: 'sliders', view: manage },
};
const LAST_TAB = 'workmate:lastTab';

const main = document.getElementById('view');
const title = document.getElementById('page-title');
const tabbar = document.getElementById('tabbar');

tabbar.innerHTML = Object.entries(ROUTES)
  .map(([key, r]) => `<a href="#/${key}" data-tab="${key}">${icon(r.icon)}<span>${r.tab}</span></a>`)
  .join('');

let currentKey = null;
let renderedDay = todayStr();

function parseHash() {
  const [name = '', ...rest] = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  return { name, rest };
}

function route() {
  const { name, rest } = parseHash();
  if (!ROUTES[name]) {
    let last = 'assets';
    try {
      last = localStorage.getItem(LAST_TAB) || 'assets';
    } catch {
      /* ignore */
    }
    location.replace(`#/${ROUTES[last] ? last : 'assets'}`);
    return;
  }
  const r = ROUTES[name];
  const tabChanged = name !== currentKey;
  currentKey = name;
  renderedDay = todayStr();
  try {
    localStorage.setItem(LAST_TAB, name);
  } catch {
    /* ignore */
  }
  title.textContent = r.title;
  document.title = `${r.title} · Work Mate`;
  tabbar.querySelectorAll('a').forEach((a) => {
    const active = a.dataset.tab === name;
    a.classList.toggle('active', active);
    if (active) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  main.innerHTML = '';
  r.view.render(main, rest);
  if (tabChanged) window.scrollTo(0, 0);
  tick();
}

// Live "running for" clocks: any element with data-since="<timestamp>".
function tick() {
  const now = Date.now();
  document.querySelectorAll('[data-since]').forEach((el) => {
    el.textContent = fmtClock(now - Number(el.dataset.since));
  });
}
setInterval(tick, 1000);

window.addEventListener('hashchange', route);
store.onExternalChange(route);

// Coming back to the app on a new day: refresh so dates default to today.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    if (renderedDay !== todayStr() && !document.querySelector('dialog[open]')) route();
    else tick();
  }
});

if (!store.storageWorking()) {
  toast('This browser is blocking storage, so nothing will be saved. Turn off private browsing.', { kind: 'error', timeout: 10000 });
}

// Offline support + "install app" prompt (Android).
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  window.__installPrompt = e;
});
navigator.storage?.persist?.().catch(() => {});

route();
