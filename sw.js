'use strict';
// ──── Service worker: офлайн-кеш оболочки приложения ────
// При изменении файлов приложения увеличьте номер версии — телефон скачает обновление.
const CACHE = 'cards-v1.0.0';
const SHELL = [
  './', 'index.html', 'app.css', 'db.js', 'srs.js', 'app.js', 'importer.js', 'screens.js',
  'more.js', 'study.js', 'main.js', 'vendor/jszip.min.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Сначала кеш, затем сеть; новые ответы своего сайта докладываются в кеш
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
    return res;
  }).catch(() => caches.match('index.html'))));
});
