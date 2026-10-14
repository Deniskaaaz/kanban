self.addEventListener('install', event => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', event => {
  // Явный обработчик fetch — Chrome на Android требует его для установки PWA.
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});
