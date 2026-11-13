/* ---------------------------------------------------------------
   sw.js — lets the team portal install as an app and open offline.

   Pages and site files: network first (so every deploy shows up
   straight away), falling back to the last saved copy when offline.
   Supabase (data, chat, sign-in) and other sites: never cached.
--------------------------------------------------------------- */
const CACHE = 'ivy-team-v1';
const SHELL = [
  'team.html', 'team.webmanifest',
  'assets/css/ivy.css', 'assets/css/team.css',
  'assets/js/config.js', 'assets/js/app.js', 'assets/js/league.js', 'assets/js/preload.js',
  'assets/js/team-api.js', 'assets/js/team.js',
  'assets/img/logo.png', 'assets/img/app/icon-192.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;            // Supabase, CDNs, fonts: straight to the network
  e.respondWith(
    fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }))
  );
});
