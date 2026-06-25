/* Blade Society — service worker (PWA + notifications push) */
const CACHE = 'bs-v2';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

// Un gestionnaire fetch (même vide) est requis pour rendre l'app installable.
self.addEventListener('fetch', () => {});

// --- Phase 2 : réception d'une notification push ---
self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch (_) {}
  const title = data.title || 'Blade Society';
  const options = {
    body: data.body || 'Nouvelle réservation',
    icon: 'assets/icon-192.png',
    badge: 'assets/icon-192.png',
    vibrate: [120, 60, 120],
    data: { url: data.url || './index.html' },
  };
  e.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || './index.html#planning';
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {                      // app déjà ouverte -> on la focus + ouvre le planning
      await c.focus();
      c.postMessage({ action: 'open-planning' });
      return;
    }
    if (self.clients.openWindow) await self.clients.openWindow(url);   // sinon -> nouvelle fenêtre
  })());
});
