/* Blade Society — service worker (PWA + notifications push) */
const CACHE = 'bs-v1';

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
  const url = (e.notification.data && e.notification.data.url) || './index.html';
  e.waitUntil(self.clients.openWindow(url));
});
