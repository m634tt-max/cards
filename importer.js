'use strict';
// ──── Импорт колод и резервное копирование ────
// Формат колоды (zip):
//   deck.json  { "format": 1, "id": "travel", "title": "Путешествия",
//                "cards": [ { "id": "01", "ru": "...", "en": "...", "image": "images/01.webp" } ] }
//   images/... картинки (webp/jpg/png)

const Importer = (() => {

  // ──── Поиск файла в архиве без учёта регистра и папки-обёртки ────
  function findEntry(zip, path) {
    if (!path) return null;
    const want = path.replace(/\\/g, '/').replace(/^\.?\//, '').toLowerCase();
    let hit = null;
    zip.forEach((rel, entry) => {
      if (hit || entry.dir) return;
      const p = rel.toLowerCase();
      if (p === want || p.endsWith('/' + want)) hit = entry;
    });
    return hit;
  }

  function mimeOf(name) {
    const ext = (name.split('.').pop() || '').toLowerCase();
    return MIME[ext] || 'application/octet-stream';
  }

  // ──── Проверка описания колоды ────
  function validateDeck(meta) {
    if (!meta || typeof meta !== 'object') throw new Error('deck.json пустой или повреждён');
    if (!Array.isArray(meta.cards) || meta.cards.length === 0) throw new Error('В deck.json нет карточек');
    if (meta.format && meta.format > DECK_FORMAT_VERSION) throw new Error('Колода сделана более новой версией скрипта');
    meta.cards.forEach((c, i) => {
      if (!c || (!c.en && !c.ru)) throw new Error(`Карточка №${i + 1}: нет текста`);
    });
  }

  // ──── Чтение колоды из уже открытого архива ────
  async function readDeck(zip, metaEntry) {
    const meta = JSON.parse(await metaEntry.async('string'));
    validateDeck(meta);
    const title = String(meta.title || 'Без названия').trim();
    const deckId = String(meta.id || slug(title));
    const missing = [];
    const cards = [];
    for (let i = 0; i < meta.cards.length; i += 1) {
      const c = meta.cards[i];
      const cardId = String(c.id ?? i + 1);
      const entry = findEntry(zip, c.image);
      let image = null;
      if (entry) {
        const buf = await entry.async('arraybuffer');
        image = new Blob([buf], { type: mimeOf(entry.name) });
      } else {
        missing.push(cardId);
      }
      cards.push({ key: `${deckId}/${cardId}`, deckId, idx: i, ru: String(c.ru || '').trim(), en: String(c.en || '').trim(), image });
    }
    return { deck: { id: deckId, title, cardCount: cards.length, coverKey: (cards.find((c) => c.image) || cards[0]).key }, cards, missing };
  }

  // ──── Сохранение колоды (с заменой старой версии, прогресс сохраняется) ────
  async function saveDeck({ deck, cards }) {
    const old = await DB.get('decks', deck.id);
    deck.createdAt = old ? old.createdAt : Date.now();
    if (old) {
      const oldCards = await DB.byIndex('cards', 'deckId', deck.id);
      const keep = new Set(cards.map((c) => c.key));
      for (const oc of oldCards) if (!keep.has(oc.key)) await DB.del('cards', oc.key);
    }
    await DB.putMany('cards', cards);
    await DB.put('decks', deck);
    return !!old;
  }

  // ──── Импорт колоды из zip-файла ────
  async function importDeckFile(file) {
    const zip = await JSZip.loadAsync(file);
    const metaEntry = findEntry(zip, 'deck.json');
    if (!metaEntry) {
      if (findEntry(zip, 'backup.json')) throw new Error('Это резервная копия — восстановите её в разделе «Ещё»');
      throw new Error('В архиве нет deck.json');
    }
    const parsed = await readDeck(zip, metaEntry);
    const exists = await DB.get('decks', parsed.deck.id);
    if (exists) {
      const ok = await confirmSheet('Колода уже есть', `«${parsed.deck.title}» будет обновлена. Прогресс по карточкам сохранится.`, 'Обновить');
      if (!ok) return null;
    }
    await saveDeck(parsed);
    return parsed;
  }

  // ──── Запуск импорта с выбором файла ────
  async function pickAndImport() {
    // без фильтра типов: Android иногда скрывает zip с «чужим» MIME-типом
    const file = await pickFile('');
    if (!file) return null;
    toast('Импорт…');
    try {
      const res = await importDeckFile(file);
      if (!res) return null;
      const miss = res.missing.length ? `. Без картинки: ${res.missing.join(', ')}` : '';
      toast(`Колода «${res.deck.title}»: ${cardsWord(res.cards.length)}${miss}`);
      DB.persist();
      return res.deck;
    } catch (err) { reportError('import', err); return null; }
  }

  // ──── Упаковка колоды в zip (для резервной копии и выгрузки) ────
  async function addDeckToZip(folder, deck) {
    const cards = (await DB.byIndex('cards', 'deckId', deck.id)).sort((a, b) => a.idx - b.idx);
    const list = [];
    for (const c of cards) {
      const cid = c.key.slice(deck.id.length + 1);
      let image = '';
      if (c.image) {
        const ext = Object.keys(MIME).find((k) => MIME[k] === c.image.type) || 'jpg';
        image = `images/${cid}.${ext}`;
        folder.file(image, c.image);
      }
      list.push({ id: cid, ru: c.ru, en: c.en, image });
    }
    folder.file('deck.json', JSON.stringify({ format: DECK_FORMAT_VERSION, id: deck.id, title: deck.title, cards: list }, null, 2));
  }

  async function exportDeck(deckId) {
    const deck = await DB.get('decks', deckId);
    const zip = new JSZip();
    await addDeckToZip(zip, deck);
    const blob = await zip.generateAsync({ type: 'blob' });
    downloadBlob(blob, `${slug(deck.title)}.zip`);
  }

  // ──── Полная резервная копия: колоды + профили + прогресс ────
  async function exportBackup() {
    toast('Готовлю копию…');
    const zip = new JSZip();
    const decks = await DB.all('decks');
    for (const d of decks) await addDeckToZip(zip.folder(`decks/${d.id}`), d);
    const data = { format: BACKUP_FORMAT_VERSION, app: APP_VERSION, created: new Date().toISOString(),
      profiles: await DB.all('profiles'), progress: await DB.all('progress') };
    zip.file('backup.json', JSON.stringify(data));
    const blob = await zip.generateAsync({ type: 'blob' });
    downloadBlob(blob, `cards-backup-${new Date().toLocaleDateString('sv')}.zip`);
    toast('Резервная копия сохранена в «Загрузки»');
  }

  async function restoreBackup() {
    const file = await pickFile('');
    if (!file) return false;
    try {
      const zip = await JSZip.loadAsync(file);
      const bEntry = findEntry(zip, 'backup.json');
      if (!bEntry) throw new Error('Это не резервная копия (нет backup.json)');
      const ok = await confirmSheet('Восстановить копию?', 'Колоды, профили и прогресс из копии заменят совпадающие данные на телефоне.', 'Восстановить');
      if (!ok) return false;
      toast('Восстанавливаю…');
      const metas = [];
      zip.forEach((rel, e) => { if (/(^|\/)decks\/[^/]+\/deck\.json$/i.test(rel)) metas.push(e); });
      for (const m of metas) {
        const sub = zip.folder(m.name.replace(/deck\.json$/i, ''));
        await saveDeck(await readDeck(sub, sub.file('deck.json')));
      }
      const data = JSON.parse(await bEntry.async('string'));
      if (Array.isArray(data.profiles)) await DB.putMany('profiles', data.profiles);
      if (Array.isArray(data.progress)) await DB.putMany('progress', data.progress);
      await loadProfiles();
      toast(`Восстановлено колод: ${metas.length}`);
      return true;
    } catch (err) { reportError('restore', err); return false; }
  }

  return { pickAndImport, importDeckFile, exportDeck, exportBackup, restoreBackup };
})();
