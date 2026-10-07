'use strict';
// ──── Service worker: офлайн-кеш и push-напоминания ────
// При изменении файлов приложения увеличьте номер версии — телефон скачает обновление.
const CACHE = 'cards-v1.5.0';
const SHELL = [
  './', 'index.html', 'app.css', 'db.js', 'srs.js', 'app.js', 'importer.js', 'screens.js',
  'more.js', 'study.js', 'reminders.js', 'images.js', 'poems.js', 'topics.js', 'main.js', 'vendor/jszip.min.js',
  'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png',
];
const DB_NAME = 'flashcards';
const NOTIFY_TAG = 'cards-reminder';
const NEW_PER_SESSION = 20;

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

// ──── Чтение базы приложения для текста уведомления ────
function readAll(db, store) {
  return new Promise((res, rej) => {
    const r = db.transaction(store).objectStore(store).getAll();
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}

function openDb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME);
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    r.onupgradeneeded = () => { r.transaction.abort(); rej(new Error('База ещё не создана')); };
  });
}

// Сколько карточек ждёт каждого профиля: «Я: 5 · Маша: 3»
async function buildBody() {
  try {
    const db = await openDb();
    const [profiles, progress, decks] = await Promise.all([readAll(db, 'profiles'), readAll(db, 'progress'), readAll(db, 'decks')]);
    db.close();
    const now = Date.now();
    const totalCards = decks.filter((d) => !['poem', 'topic'].includes(d.type)).reduce((a, d) => a + (d.cardCount || 0), 0);
    const parts = profiles.map((p) => {
      const mine = progress.filter((r) => r.profileId === p.id);
      const due = mine.filter((r) => r.last > 0 && r.due <= now).length;
      const fresh = Math.min(NEW_PER_SESSION, Math.max(0, totalCards - mine.filter((r) => r.last > 0).length));
      const n = due + fresh;
      return n ? `${p.emoji || ''} ${p.name}: ${n}` : '';
    }).filter(Boolean);
    return parts.length ? `Ждут карточки — ${parts.join(' · ')}` : 'Загляните на пару минут — закрепим выученное';
  } catch (e) {
    return 'Пора повторить английские фразы';
  }
}

self.addEventListener('push', (e) => {
  e.waitUntil(buildBody().then((body) => self.registration.showNotification('Пора повторить слова 📚', {
    body, tag: NOTIFY_TAG, renotify: true, icon: 'icons/icon-192.png',
    data: { url: self.registration.scope },
  })));
});

// ──── Нажатие на уведомление открывает приложение ────
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    const win = list.find((c) => c.url.startsWith(self.registration.scope));
    if (win) return win.focus();
    return self.clients.openWindow(self.registration.scope);
  }));
});
