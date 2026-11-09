// Service worker: keeps the app working with no signal.
// Files are served from the cache straight away and refreshed in the
// background. Bump VERSION on every release: the app spots the new service
// worker, downloads the new files and reloads itself.
const VERSION = 'v5';
const CACHE = `work-mate-${VERSION}`;
const FILES = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/app.css',
  'js/app.js',
  'js/store.js',
  'js/util.js',
  'js/ui.js',
  'js/icons.js',
  'js/lib/calc.js',
  'js/components/timepicker.js',
  'js/views/assets.js',
  'js/views/hours.js',
  'js/views/vacuum.js',
  'js/views/sentry.js',
  'js/views/manage.js',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // 'reload' skips the browser's own HTTP cache (GitHub Pages lets phones
      // reuse files for 10 minutes), so a new version never caches old files.
      .then((cache) => cache.addAll(FILES.map((f) => new Request(f, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const key = req.mode === 'navigate' ? 'index.html' : req;
      const cached = await cache.match(key, { ignoreSearch: true });
      // 'no-cache' = check with the server rather than reuse a stale browser copy.
      const fresh = req.mode === 'navigate' ? new Request('index.html', { cache: 'no-cache' }) : new Request(req, { cache: 'no-cache' });
      const network = fetch(fresh)
        .then((res) => {
          if (res.ok && res.type === 'basic') cache.put(key, res.clone());
          return res;
        })
        .catch(() => cached);
      if (cached) {
        event.waitUntil(network.catch(() => {}));
        return cached;
      }
      return network;
    }),
  );
});
