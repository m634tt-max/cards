'use strict';
// ──── Добавление картинок в приложении: промпт → генератор → галерея → карточка ────

const IMG_MAX_SIDE = 1024;          // наибольшая сторона после сжатия, px
const IMG_QUALITY = 0.82;           // качество webp
const IMG_TYPE = 'image/webp';
const GENERATOR_URL = 'https://shedevrum.ai/';
const PROMPT_FALLBACK = 'Фотореалистичная сцена, иллюстрирующая фразу';

const ImageWizard = {
  deckId: '',
  queue: [],
  pos: 0,
  done: 0,

  // ──── Промпт карточки (если в колоде его нет — простой запасной) ────
  promptOf(card) {
    return card.prompt || `${PROMPT_FALLBACK} «${card.ru || card.en}». Естественный свет, без текста и надписей.`;
  },

  async copy(text) {
    try { await navigator.clipboard.writeText(text); toast('Промпт скопирован'); }
    catch (e) {
      // запасной способ для старых браузеров
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      const ok = document.execCommand('copy'); ta.remove();
      toast(ok ? 'Промпт скопирован' : 'Не удалось скопировать — выделите текст вручную');
    }
  },

  // ──── Сжатие картинки: не больше IMG_MAX_SIDE по большей стороне, webp ────
  async compress(file) {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, IMG_MAX_SIDE / Math.max(bmp.width, bmp.height));
    const w = Math.round(bmp.width * k), h = Math.round(bmp.height * k);
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
    bmp.close();
    const blob = await new Promise((res) => canvas.toBlob(res, IMG_TYPE, IMG_QUALITY));
    if (!blob) throw new Error('Не удалось обработать картинку');
    // если браузер не умеет webp, он вернёт png — тогда пробуем jpeg
    if (blob.type !== IMG_TYPE) return new Promise((res) => canvas.toBlob(res, 'image/jpeg', IMG_QUALITY));
    return blob;
  },

  // ──── Обложка колоды — первая карточка с картинкой ────
  async fixCover(deckId) {
    const deck = await DB.get('decks', deckId);
    const cover = deck && await DB.get('cards', deck.coverKey);
    if (!deck || (cover && cover.image)) return;
    const cards = (await DB.byIndex('cards', 'deckId', deckId)).sort((a, b) => a.idx - b.idx);
    const first = cards.find((c) => c.image);
    if (first) { deck.coverKey = first.key; await DB.put('decks', deck); }
  },

  // ──── Экран мастера ────
  async screen(deckId) {
    const deck = await DB.get('decks', deckId);
    if (!deck) { switchTab('library'); return; }
    $('#topTitle').textContent = 'Картинки';
    this.deckId = deckId;
    this.queue = (await DB.byIndex('cards', 'deckId', deckId)).filter((c) => !c.image).sort((a, b) => a.idx - b.idx);
    this.pos = 0;
    this.done = 0;
    this.show();
  },

  show(preview = null) {
    const view = $('#view');
    if (this.pos >= this.queue.length) { this.showDone(); return; }
    const c = this.queue[this.pos];
    const prompt = this.promptOf(c);
    view.innerHTML = `
      <div class="study-head">
        <div class="bar"><i style="width:${Math.round((this.pos / this.queue.length) * 100)}%"></i></div>
        <div class="study-count">${this.pos + 1} / ${this.queue.length}</div>
      </div>
      <div class="panel wiz">
        ${preview ? `<img class="edit-img" src="${URL.createObjectURL(preview)}" alt="">` : ''}
        <div class="wiz-ru">${esc(c.ru)}</div>
        <div class="wiz-en">${esc(c.en)}</div>
        <div class="section-title" style="margin:16px 0 6px">Промпт</div>
        <div class="prompt-box" id="promptBox">${esc(prompt)}</div>
        ${preview ? '' : `
        <div class="btn-row">
          <button class="btn" id="btnCopy">📋 Копировать</button>
          <a class="btn" href="${GENERATOR_URL}" target="_blank" rel="noopener">Шедеврум ↗</a>
        </div>`}
      </div>
      ${preview ? `
        <div class="btn-row">
          <button class="btn" id="btnRepick">Другая</button>
          <button class="btn primary" id="btnNext">Дальше →</button>
        </div>` : `
        <button class="btn import block" id="btnPick" style="margin-top:14px">🖼 Выбрать картинку из галереи</button>
        <div class="btn-row"><button class="btn" id="btnSkip">Пропустить</button></div>`}
      <p class="subtitle" style="font-size:.85em">Скопируйте промпт → сгенерируйте картинку в Шедевруме → сохраните в галерею → вернитесь сюда и выберите её.</p>`;
    this.bind(c, prompt);
  },

  bind(card, prompt) {
    const on = (id, fn) => { const el = $(id); if (el) el.onclick = fn; };
    on('#btnCopy', () => this.copy(prompt));
    on('#btnSkip', () => { this.pos += 1; this.show(); });
    on('#btnNext', () => { this.pos += 1; this.show(); });
    const pick = async () => {
      const f = await pickFile('image/*');
      if (!f) return;
      try {
        const blob = await this.compress(f);
        const wasEmpty = !card.image;
        card.image = blob;
        await DB.put('cards', card);
        await this.fixCover(card.deckId);
        if (wasEmpty) this.done += 1;
        this.show(blob);
      } catch (err) { reportError('image', err); }
    };
    on('#btnPick', pick);
    on('#btnRepick', pick);
  },

  showDone() {
    const left = this.queue.filter((c) => !c.image).length;
    $('#view').innerHTML = `
      <div class="done">
        <div class="big">${left ? '🖼' : '🎉'}</div>
        <h2>${left ? 'Готово частично' : 'Все картинки на месте!'}</h2>
        <p class="subtitle">Добавлено: ${this.done}${left ? ` · осталось без картинки: ${left}` : ''}</p>
        <div class="btn-row"><button class="btn primary" id="btnBackDeck">К колоде</button></div>
      </div>`;
    $('#btnBackDeck').onclick = () => history.back();
  },
};
