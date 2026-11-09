// Service worker : permet l'installation et un démarrage rapide.
// Réseau d'abord (pour recevoir les mises à jour), cache en secours.
const CACHE = 'ipod-v7';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'config.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(url.href, { cache: 'no-cache', credentials: 'same-origin' }).then((r) => {
      // no-cache : toujours revérifier auprès du serveur (sinon GitHub sert l'ancienne version 10 min)
      if (r.ok) { const copy = r.clone(); url.search = ''; caches.open(CACHE).then((c) => c.put(url.href, copy)); }
      return r;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('index.html')))
  );
});
