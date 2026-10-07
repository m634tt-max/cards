'use strict';
// ──── Хранилище IndexedDB: колоды, карточки, профили, прогресс ────
// decks    : { id, title, cardCount, coverKey, createdAt }
// cards    : { key: "<deckId>/<cardId>", deckId, idx, ru, en, image: Blob }
// profiles : { id, name, emoji, kid, reverse, autoSpeak, createdAt }
// progress : { pk: "<profileId>|<cardKey>", profileId, deckId, cardKey, due, interval, ease, reps, lapses, last }

const DB_NAME = 'flashcards';
const DB_VERSION = 1;

const DB = (() => {
  let dbPromise = null;

  // ──── Открытие базы и создание структуры ────
  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('decks')) db.createObjectStore('decks', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('cards')) {
          const s = db.createObjectStore('cards', { keyPath: 'key' });
          s.createIndex('deckId', 'deckId');
        }
        if (!db.objectStoreNames.contains('profiles')) db.createObjectStore('profiles', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('progress')) {
          const s = db.createObjectStore('progress', { keyPath: 'pk' });
          s.createIndex('profileId', 'profileId');
          s.createIndex('profileDeck', ['profileId', 'deckId']);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  // ──── Обёртки над запросами ────
  const wrap = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

  async function store(name, mode = 'readonly') {
    const db = await open();
    return db.transaction(name, mode).objectStore(name);
  }

  async function get(name, key) { return wrap((await store(name)).get(key)); }
  async function all(name) { return wrap((await store(name)).getAll()); }
  async function put(name, value) { return wrap((await store(name, 'readwrite')).put(value)); }
  async function del(name, key) { return wrap((await store(name, 'readwrite')).delete(key)); }
  async function byIndex(name, index, value) { return wrap((await store(name)).index(index).getAll(value)); }

  // ──── Пакетная запись в одной транзакции ────
  async function putMany(name, values) {
    const db = await open();
    return new Promise((res, rej) => {
      const tx = db.transaction(name, 'readwrite');
      const s = tx.objectStore(name);
      values.forEach((v) => s.put(v));
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
      tx.onabort = () => rej(tx.error);
    });
  }

  // ──── Удаление колоды вместе с карточками и прогрессом ────
  async function deleteDeck(deckId) {
    const db = await open();
    return new Promise((res, rej) => {
      const tx = db.transaction(['decks', 'cards', 'progress'], 'readwrite');
      tx.objectStore('decks').delete(deckId);
      tx.objectStore('cards').index('deckId').openKeyCursor(IDBKeyRange.only(deckId)).onsuccess = (e) => {
        const c = e.target.result;
        if (c) { tx.objectStore('cards').delete(c.primaryKey); c.continue(); }
      };
      tx.objectStore('progress').openCursor().onsuccess = (e) => {
        const c = e.target.result;
        if (c) { if (c.value.deckId === deckId) c.delete(); c.continue(); }
      };
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  }

  // ──── Удаление профиля вместе с его прогрессом ────
  async function deleteProfile(profileId) {
    const db = await open();
    return new Promise((res, rej) => {
      const tx = db.transaction(['profiles', 'progress'], 'readwrite');
      tx.objectStore('profiles').delete(profileId);
      tx.objectStore('progress').index('profileId').openCursor(IDBKeyRange.only(profileId)).onsuccess = (e) => {
        const c = e.target.result;
        if (c) { c.delete(); c.continue(); }
      };
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  }

  // ──── Запрос постоянного хранения (браузер реже чистит данные) ────
  async function persist() {
    try { if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist(); }
    catch (e) { console.warn('persist', e); }
    return false;
  }

  return { open, get, all, put, del, byIndex, putMany, deleteDeck, deleteProfile, persist };
})();
