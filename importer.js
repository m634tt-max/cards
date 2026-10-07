'use strict';
// ──── Импорт колод и резервное копирование ────
// Формат колоды (zip):
//   deck.json  { "format": 1, "id": "travel", "title": "Путешествия",
//                "cards": [ { "id": "01", "ru": "...", "en": "...", "prompt": "...", "image": "images/01.webp" } ] }
//   Можно импортировать и сам deck.json (без картинок) — картинки добавляются в приложении.
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

  // ──── Разбор описания колоды; getImage(path) возвращает Blob или null ────
  async function readDeckMeta(meta, getImage) {
    validateDeck(meta);
    const title = String(meta.title || 'Без названия').trim();
    const deckId = String(meta.id || slug(title));
    const missing = [];
    const cards = [];
    for (let i = 0; i < meta.cards.length; i += 1) {
      const c = meta.cards[i];
      const cardId = String(c.id ?? i + 1);
      const image = c.image ? await getImage(c.image) : null;
      if (!image) missing.push(cardId);
      cards.push({
        key: `${deckId}/${cardId}`, deckId, idx: i, image,
        ru: String(c.ru || '').trim(), en: String(c.en || '').trim(), prompt: String(c.prompt || '').trim(),
      });
    }
    return { deck: { id: deckId, title, cardCount: cards.length, coverKey: (cards.find((c) => c.image) || cards[0]).key }, cards, missing };
  }

  // ──── Чтение колоды из уже открытого архива ────
  async function readDeck(zip, metaEntry) {
    const meta = JSON.parse(await metaEntry.async('string'));
    return readDeckMeta(meta, async (path) => {
      const entry = findEntry(zip, path);
      if (!entry) return null;
      return new Blob([await entry.async('arraybuffer')], { type: mimeOf(entry.name) });
    });
  }

  // ──── Сохранение колоды (с заменой старой версии, прогресс и картинки сохраняются) ────
  async function saveDeck({ deck, cards }) {
    const old = await DB.get('decks', deck.id);
    deck.createdAt = old ? old.createdAt : Date.now();
    if (old) {
      const oldCards = await DB.byIndex('cards', 'deckId', deck.id);
      const oldMap = new Map(oldCards.map((c) => [c.key, c]));
      const keep = new Set(cards.map((c) => c.key));
      for (const oc of oldCards) if (!keep.has(oc.key)) await DB.del('cards', oc.key);
      // в новой версии нет картинки, а в старой была — оставляем старую
      cards.forEach((c) => {
        const oc = oldMap.get(c.key);
        if (!c.image && oc && oc.image) c.image = oc.image;
        if (!c.prompt && oc && oc.prompt) c.prompt = oc.prompt;
      });
      const withImg = cards.find((c) => c.image);
      if (withImg) deck.coverKey = withImg.key;
    }
    await DB.putMany('cards', cards);
    await DB.put('decks', deck);
    return !!old;
  }

  // ──── Текст JSON: убираем ```-обёртку из чата ────
  function parseJsonText(text) {
    const t = String(text).trim().replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim();
    try { return JSON.parse(t); } catch (e) { throw new Error('Текст не похож на колоду (ошибка JSON)'); }
  }

  async function confirmAndSave(parsed) {
    const exists = await DB.get('decks', parsed.deck.id);
    if (exists) {
      const ok = await confirmSheet('Колода уже есть', `«${parsed.deck.title}» будет обновлена. Прогресс и картинки сохранятся.`, 'Обновить');
      if (!ok) return null;
    }
    await saveDeck(parsed);
    parsed.missing = parsed.cards.filter((c) => !c.image).map((c) => c.key.slice(parsed.deck.id.length + 1));
    return parsed;
  }

  // ──── Импорт колоды из файла: zip с картинками или deck.json без них ────
  async function importDeckFile(file) {
    const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
    const isZip = head[0] === 0x50 && head[1] === 0x4b;   // сигнатура "PK"
    if (!isZip) {
      const meta = parseJsonText(await file.text());
      return confirmAndSave(await readDeckMeta(meta, async () => null));
    }
    const zip = await JSZip.loadAsync(file);
    const metaEntry = findEntry(zip, 'deck.json');
    if (!metaEntry) {
      if (findEntry(zip, 'backup.json')) throw new Error('Это резервная копия — восстановите её в разделе «Ещё»');
      throw new Error('В архиве нет deck.json');
    }
    return confirmAndSave(await readDeck(zip, metaEntry));
  }

  function importedToast(res) {
    const miss = res.missing.length ? ` · без картинки: ${res.missing.length}` : '';
    toast(`Колода «${res.deck.title}»: ${cardsWord(res.cards.length)}${miss}`);
    DB.persist();
  }

  // ──── Вставка колоды из буфера обмена ────
  function pasteDeck() {
    Sheet.open(`
      <h3>Вставить колоду</h3>
      <p class="subtitle">Скопируйте в чате текст колоды (начинается с «{») и вставьте сюда.</p>
      <label class="field"><textarea id="pasteText" rows="8" placeholder='{"title": "...", "cards": [...]}'></textarea></label>
      <div class="btn-row">
        <button class="btn" id="btnClip">Из буфера</button>
        <button class="btn primary" id="btnPasteOk">Создать колоду</button>
      </div>`);
    $('#btnClip').onclick = async () => {
      try { $('#pasteText').value = await navigator.clipboard.readText(); } catch (e) { toast('Нет доступа к буферу — вставьте вручную долгим нажатием'); }
    };
    $('#btnPasteOk').onclick = async () => {
      try {
        const parsed = await readDeckMeta(parseJsonText($('#pasteText').value), async () => null);
        Sheet.after = async () => {
          const res = await confirmAndSave(parsed).catch((e) => { reportError('paste', e); return null; });
          if (!res) { render(); return; }
          importedToast(res);
          navigate('deck', { deckId: res.deck.id });
        };
        Sheet.close();
      } catch (err) { reportError('paste', err); }
    };
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
      importedToast(res);
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
      list.push({ id: cid, ru: c.ru, en: c.en, prompt: c.prompt || '', image });
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

  return { pickAndImport, importDeckFile, pasteDeck, exportDeck, exportBackup, restoreBackup };
})();
