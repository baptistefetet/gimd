'use strict';

// Caches only the app shell (HTML/CSS/JS/icons) for installability and fast loads.
// Notes are NEVER cached — every read/write goes to the network (the server proxies GitHub).

const CACHE = 'gimd-shell-v2';
const SHELL = ['/', '/index.html', '/style.css', '/app.js', '/manifest.json', '/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Bypass the cache entirely for API and auth: those must always hit the network.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) return;
  if (event.request.method !== 'GET') return;

  // Cache-first for the shell; fall back to the cached index when offline.
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request).catch(() => caches.match('/index.html')))
  );
});
