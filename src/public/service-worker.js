'use strict';

// gimd no longer uses a service worker (offline isn't useful here, and shell
// caching caused stale assets). This file is a kill-switch: browsers that still
// have an old worker registered will fetch it on their next visit, and it
// unregisters itself + clears its caches, then reloads the page cleanly.
// New visitors never register a worker, so they never load this file.

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
    await self.registration.unregister();
    const clients = await self.clients.matchAll({ type: 'window' });
    clients.forEach((client) => client.navigate(client.url));
  })());
});
