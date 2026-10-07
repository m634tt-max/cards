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

  // ──── Экран мастера: все карточки, начинаем с первой без картинки ────
  async screen(deckId) {
    const deck = await DB.get('decks', deckId);
    if (!deck) { switchTab('library'); return; }
    $('#topTitle').textContent = 'Картинки';
    this.deckId = deckId;
    this.queue = (await DB.byIndex('cards', 'deckId', deckId)).sort((a, b) => a.idx - b.idx);
    const firstEmpty = this.queue.findIndex((c) => !c.image);
    this.pos = firstEmpty >= 0 ? firstEmpty : 0;
    this.done = 0;
    this.show();
  },

  // лента миниатюр: видно, где картинки нет, можно перейти к любой карточке
  strip() {
    return `<div class="wiz-strip" id="wizStrip">${this.queue.map((c, i) => `
      <button class="wiz-dot ${i === this.pos ? 'cur' : ''} ${c.image ? '' : 'empty'}" data-go="${i}"
        style="${c.image ? `background-image:url('${imgUrl(c)}')` : ''}">${c.image ? '' : i + 1}</button>`).join('')}</div>`;
  },

  show() {
    const view = $('#view');
    const c = this.queue[this.pos];
    const prompt = this.promptOf(c);
    const left = this.queue.filter((x) => !x.image).length;
    const isLast = this.pos >= this.queue.length - 1;
    view.innerHTML = `
      ${this.strip()}
      <p class="subtitle" style="margin:6px 2px 10px">Карточка ${this.pos + 1} из ${this.queue.length} · без картинки: ${left}</p>
      <div class="panel wiz">
        ${c.image ? `<img class="edit-img" src="${imgUrl(c)}" alt="">` : ''}
        <div class="wiz-ru">${c.extra && c.extra.title ? esc(c.extra.title) : esc(c.ru).replace(/\n/g, '<br>')}</div>
        <div class="wiz-en">${esc(c.en)}</div>
        <div class="section-title" style="margin:16px 0 6px">Промпт</div>
        <div class="prompt-box" id="promptBox">${esc(prompt)}</div>
        <div class="btn-row">
          <button class="btn" id="btnCopy">📋 Копировать</button>
          <a class="btn" href="${GENERATOR_URL}" target="_blank" rel="noopener">Шедеврум ↗</a>
        </div>
      </div>
      <div class="btn-row" style="margin-top:14px">
        <button class="btn primary" id="btnGenOne">✨ ${c.image ? 'Перерисовать' : 'Нарисовать'}</button>
        <button class="btn import" id="btnPick">🖼 Из галереи</button>
      </div>
      ${left ? `<button class="btn block" id="btnGenAll">✨ Сгенерировать все без картинки (${left})</button>` : ''}
      <div class="study-nav">
        <button class="btn" id="btnPrev" ${this.pos === 0 ? 'disabled' : ''}>← Назад</button>
        <button class="btn primary" id="btnNext">${isLast ? 'Готово' : 'Дальше →'}</button>
      </div>
      <p class="subtitle" style="font-size:.85em">Скопируйте промпт → сгенерируйте картинку → сохраните в галерею → вернитесь и выберите её. Лента сверху — переход к любой карточке.</p>`;
    const cur = view.querySelector('.wiz-dot.cur');
    if (cur) cur.scrollIntoView({ inline: 'center', block: 'nearest' });
    this.bind(c, prompt);
  },

  go(i) {
    if (i >= this.queue.length) { this.showDone(); return; }
    this.pos = Math.max(0, i);
    this.show();
    window.scrollTo(0, 0);
  },

  bind(card, prompt) {
    const on = (id, fn) => { const el = $(id); if (el) el.onclick = fn; };
    on('#btnCopy', () => this.copy(prompt));
    on('#btnPrev', () => this.go(this.pos - 1));
    on('#btnNext', () => this.go(this.pos + 1));
    $('#wizStrip').querySelectorAll('[data-go]').forEach((b) => { b.onclick = () => this.go(Number(b.dataset.go)); });
    on('#btnGenOne', async () => {
      const btn = $('#btnGenOne');
      btn.disabled = true; btn.textContent = '✨ Рисую…';
      try { if (!card.image) this.done += 1; await ImageGen.generate(card); this.show(); toast('Картинка готова'); }
      catch (err) { reportError('gen', err); btn.disabled = false; btn.textContent = '✨ Нарисовать'; }
    });
    on('#btnGenAll', () => ImageGen.generateMany(this.queue.filter((x) => !x.image), () => this.show()));
    on('#btnPick', async () => {
      const f = await pickFile('image/*');
      if (!f) return;
      try {
        const blob = await this.compress(f);
        if (!card.image) this.done += 1;
        card.image = blob;
        await DB.put('cards', card);
        await this.fixCover(card.deckId);
        this.show();
        toast('Картинка сохранена');
      } catch (err) { reportError('image', err); }
    });
  },

  showDone() {
    const left = this.queue.filter((c) => !c.image).length;
    $('#view').innerHTML = `
      <div class="done">
        <div class="big">${left ? '🖼' : '🎉'}</div>
        <h2>${left ? 'Готово частично' : 'Все картинки на месте!'}</h2>
        <p class="subtitle">Добавлено: ${this.done}${left ? ` · осталось без картинки: ${left}` : ''}</p>
        <div class="btn-row"><button class="btn" id="btnWizBack">← К карточкам</button>
          <button class="btn primary" id="btnBackDeck">К колоде</button></div>
      </div>`;
    $('#btnBackDeck').onclick = () => history.back();
    $('#btnWizBack').onclick = () => this.go(this.queue.length - 1);
  },
};

// ──── Генерация картинок через свой сервер (Cloudflare Workers AI) ────
const LS_GEN = 'fc.gen';

const ImageGen = {
  busy: false,
  cancelled: false,

  cfg() {
    let c = {};
    try { c = JSON.parse(lsGet(LS_GEN, '{}')) || {}; } catch { c = {}; }
    return { url: c.url || DEFAULT_SERVER_URL, token: c.token || '' };
  },
  saveCfg(c) { lsSet(LS_GEN, JSON.stringify(c)); },

  // английский промпт лучше подходит модели FLUX; русский сервер переведёт сам
  promptFor(card) { return card.promptEn || ImageWizard.promptOf(card); },

  async generate(card) {
    const c = this.cfg();
    let res;
    try {
      res = await fetch(`${c.url.replace(/\/+$/, '')}/image`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Token': c.token },
      body: JSON.stringify({ prompt: this.promptFor(card) }),
      });
    } catch (err) {
      throw new Error(`Нет связи с сервером (${err.message}). Проверьте интернет или адрес сервера.`);
    }
    if (!res.ok) {
      let msg = `сервер ответил ${res.status}`;
      try { msg = (await res.json()).error || msg; } catch { /* не JSON */ }
      throw new Error(msg);
    }
    const blob = await ImageWizard.compress(await res.blob());
    card.image = blob;
    await DB.put('cards', card);
    await ImageWizard.fixCover(card.deckId);
    return blob;
  },

  // ──── Пакетная генерация с окном прогресса ────
  async generateMany(cards, onDone) {
    if (this.busy || !cards.length) return;
    this.busy = true;
    this.cancelled = false;
    let ok = 0;
    const failed = [];
    let firstError = '';
    Sheet.open(`<h3>✨ Генерация картинок</h3>
      <p class="subtitle" id="genStatus">Подготовка…</p>
      <div class="bar" style="height:10px"><i id="genBar" style="width:0%;background:var(--accent)"></i></div>
      <p class="subtitle" style="margin-top:12px;font-size:.85em">Не сворачивайте приложение — иначе телефон может приостановить генерацию.</p>
      <div class="btn-row"><button class="btn" id="genStop">Остановить</button></div>`, () => { this.cancelled = true; });
    $('#genStop').onclick = () => { this.cancelled = true; $('#genStatus').textContent = 'Останавливаю после текущей…'; };
    for (let i = 0; i < cards.length && !this.cancelled; i += 1) {
      const st = $('#genStatus');
      if (st) st.textContent = `Картинка ${i + 1} из ${cards.length}: ${cards[i].ru.split('\n')[0].slice(0, 40)}`;
      try { await this.generate(cards[i]); ok += 1; }
      catch (err) {
        failed.push(i + 1);
        console.warn(err);
        if (!firstError) firstError = err.message || String(err);
        // одна и та же ошибка три раза подряд — дальше смысла нет
        if (failed.length >= 3 && ok === 0) { this.cancelled = true; }
        if (/токен|token|подключена|501|403/i.test(err.message)) { toast(`Ошибка: ${err.message}`); break; }
      }
      const bar = $('#genBar');
      if (bar) bar.style.width = `${Math.round(((i + 1) / cards.length) * 100)}%`;
    }
    this.busy = false;
    // при ошибках окно не закрываем, а заменяем его содержимое (иначе закрытие и открытие гоняются в истории)
    if (!failed.length && Sheet.isOpen()) { Sheet.after = () => {}; Sheet.close(); }
    if (failed.length) {
      Sheet.open(`<h3>Генерация: ${ok} готово, ошибок ${failed.length}</h3>
        <p class="subtitle">Текст ошибки (пришлите его в чат):</p>
        <div class="prompt-box">${esc(firstError)}</div>
        <div class="btn-row"><button class="btn" id="genErrCopy">📋 Копировать</button><button class="btn primary" id="genErrOk">Понятно</button></div>`);
      $('#genErrCopy').onclick = () => ImageWizard.copy(firstError);
      $('#genErrOk').onclick = () => Sheet.close();
    } else toast(`Готово: ${ok}`);
    if (onDone) onDone();
  },

  // ──── Настройки генерации ────
  settings() {
    const c = this.cfg();
    Sheet.open(`<h3>✨ Генерация картинок</h3>
      <p class="subtitle">Картинки рисует ваш сервер Cloudflare (модель FLUX, бесплатно — около сотни картинок в день).</p>
      <label class="field"><span>Адрес сервера</span><input id="genUrl" value="${esc(c.url)}"></label>
      <label class="field"><span>Токен генерации (если задан на сервере)</span><input id="genToken" value="${esc(c.token)}"></label>
      <p class="subtitle" id="genCheck"></p>
      <div class="btn-row"><button class="btn" id="genTest">Проверить</button><button class="btn primary" id="genSave">Сохранить</button></div>`);
    const read = () => ({ url: $('#genUrl').value.trim() || DEFAULT_SERVER_URL, token: $('#genToken').value.trim() });
    $('#genTest').onclick = async () => {
      const out = $('#genCheck');
      out.textContent = 'Проверяю…';
      try {
        const r = await (await fetch(`${read().url.replace(/\/+$/, '')}/image/check`)).json();
        out.textContent = r.ai ? `✅ Генерация подключена${r.tokenRequired ? ' (нужен токен)' : ''}` : '⚠️ На сервере не подключён Workers AI';
      } catch (err) { out.textContent = `Ошибка: ${err.message} — обновите код сервера (см. инструкцию)`; }
    };
    $('#genSave').onclick = () => { this.saveCfg(read()); Sheet.close(); toast('Сохранено'); };
  },
};
