'use strict';
// ──── Раздел «Стихи»: заучивание по мнемотаблице ────
// Стих — колода с type: "poem"; карточка = смысловой кусок (1–3 строки) + картинка.
// Режимы: знакомство → снежный ком → первые буквы → исчезающие слова → мнемотаблица.

const POEM_MODES = [
  { id: 'intro', icon: '👀', title: 'Знакомство', hint: 'Картинка → нажми → строчки. Слушай и повторяй' },
  { id: 'ball', icon: '⛄', title: 'Снежный ком', hint: 'Рассказывай с начала, каждый раз на кусочек больше' },
  { id: 'letters', icon: '🔤', title: 'Первые буквы', hint: 'Вспомни строки по первым буквам слов' },
  { id: 'fade', icon: '🫥', title: 'Исчезающие слова', hint: 'С каждым уровнем слов всё меньше' },
  { id: 'table', icon: '🖼', title: 'Мнемотаблица', hint: 'Все картинки сразу — расскажи весь стих' },
];
const FADE_LEVELS = 4;                       // 25 % → 50 % → 75 % → 100 % скрытых слов
const REVIEW_DAYS = [1, 3, 7, 14, 30];       // повторения после выученного стиха
const DAY_MS_POEM = 24 * 60 * 60 * 1000;
const WORD_RE = /[A-Za-zА-Яа-яЁё]+(?:[-'][A-Za-zА-Яа-яЁё]+)*/g;

const Poems = {
  deck: null,
  cards: [],
  state: {},

  // ──── Прогресс текущего профиля по стиху ────
  async progress(deckId) {
    const pk = `${App.profile.id}|${deckId}`;
    return (await DB.get('poemProgress', pk)) || { pk, profileId: App.profile.id, deckId, stars: {}, reviews: 0, nextReview: 0, last: 0 };
  },

  async markStar(mode) {
    const pr = await this.progress(this.deck.id);
    const isNew = !pr.stars[mode];
    pr.stars[mode] = true;
    pr.last = Date.now();
    if (mode === 'table') {
      const step = REVIEW_DAYS[Math.min(pr.reviews, REVIEW_DAYS.length - 1)];
      pr.reviews += 1;
      pr.nextReview = Date.now() + step * DAY_MS_POEM;
    }
    await DB.put('poemProgress', pr);
    await touchStreak();
    if (isNew) toast('⭐ Звёздочка получена!');
    return pr;
  },

  reviewLabel(pr) {
    if (!pr.nextReview) return '';
    const days = Math.ceil((pr.nextReview - Date.now()) / DAY_MS_POEM);
    if (days <= 0) return '🔔 Пора повторить';
    return `Повторить через ${days} ${plural(days, 'день', 'дня', 'дней')}`;
  },

  // ──── Список стихов ────
  async list() {
    const view = $('#view');
    const poems = await loadPoems();
    const items = await Promise.all(poems.map(async (d) => ({ d, pr: await this.progress(d.id), cover: await deckCover(d) })));
    const tiles = items.map(({ d, pr, cover }) => {
      const stars = POEM_MODES.filter((m) => pr.stars[m.id]).length;
      const due = pr.nextReview && pr.nextReview <= Date.now();
      return `<button class="deck-tile" data-poem="${esc(d.id)}">
        <div class="cover ${cover ? '' : 'noimg'}" style="background-image:url('${cover}')"></div>
        <div class="meta"><div class="name">${esc(d.title)}</div>
          <div class="count">${esc(d.author || '')}</div>
          <div class="poem-stars">${'⭐'.repeat(stars)}${'☆'.repeat(POEM_MODES.length - stars)}</div>
          ${due ? '<div class="poem-due">🔔 Повторить</div>' : ''}</div></button>`;
    }).join('');
    view.innerHTML = `
      <h2>Стихи</h2><p class="subtitle">Учим наизусть по картинкам</p>
      <div class="grid">${tiles}
        <button class="add-tile import" id="btnAddPoem">${PLUS}<span>Добавить стих</span></button></div>
      <div class="btn-row"><button class="btn" id="btnPastePoem">Вставить стих из буфера</button></div>`;
    $('#btnAddPoem').onclick = async () => { const d = await Importer.pickAndImport(); if (d) navigate('poem', { deckId: d.id }); };
    $('#btnPastePoem').onclick = () => Importer.pasteDeck();
    view.querySelectorAll('[data-poem]').forEach((b) => { b.onclick = () => navigate('poem', { deckId: b.dataset.poem }); });
  },

  // ──── Экран стиха: режимы и звёзды ────
  async screen(deckId) {
    const deck = await DB.get('decks', deckId);
    if (!deck) { switchTab('poems'); return; }
    $('#topTitle').textContent = deck.title;
    const cards = await DB.byIndex('cards', 'deckId', deckId);
    const pr = await this.progress(deckId);
    const noImg = cards.filter((c) => !c.image).length;
    const rows = POEM_MODES.map((m, i) => `
      <button class="row" data-mode="${m.id}">
        <span class="mode-ico">${m.icon}</span>
        <span class="grow"><b>${i + 1}. ${m.title}</b><div class="hint">${m.hint}</div></span>
        <span class="mode-star">${pr.stars[m.id] ? '⭐' : '☆'}</span></button>`).join('');
    $('#view').innerHTML = `
      ${noImg ? `<div class="panel img-banner"><div class="grow"><b>🖼 Без картинки: ${noImg}</b>
        <div class="hint">Сначала нарисуйте картинки по промптам</div></div>
        <button class="btn import" id="btnAddImages">Добавить</button></div>` : ''}
      <p class="subtitle">${esc(deck.author || '')}${deck.author ? ' · ' : ''}${cards.length} ${plural(cards.length, 'кусочек', 'кусочка', 'кусочков')}
        ${this.reviewLabel(pr) ? `<br><b>${this.reviewLabel(pr)}</b>` : ''}</p>
      <button class="btn block listen-btn" id="btnListen">🎧 Слушать стих</button>
      <div class="panel">${rows}</div>
      <div class="deck-actions" style="margin-top:14px">
        <button id="btnPoemText">📜 Весь текст</button>
        <button id="btnPoemImages">🖼 Картинки</button>
        <button id="btnPoemEdit">✏️ Кусочки</button>
        <button id="btnPoemDel" class="del">🗑 Удалить стих</button>
      </div>`;
    if (noImg) $('#btnAddImages').onclick = () => navigate('images', { deckId });
    $('#view').querySelectorAll('[data-mode]').forEach((b) => { b.onclick = () => navigate('poemMode', { deckId, mode: b.dataset.mode }); });
    $('#btnListen').onclick = () => navigate('listen', { deckId });
    $('#btnPoemText').onclick = () => this.showText(deck, cards);
    $('#btnPoemEdit').onclick = () => this.editList(cards);
    $('#btnPoemImages').onclick = () => navigate('images', { deckId });
    $('#btnPoemDel').onclick = () => Screens.deleteDeck(deck);
  },

  // ──── Правка кусочков: текст, промпт, картинка ────
  editList(cards) {
    const rows = cards.sort((a, b) => a.idx - b.idx).map((c, i) => `
      <button class="row" data-ck="${esc(c.key)}">
        ${c.image ? `<img class="thumb" src="${imgUrl(c)}" alt="">` : '<div class="thumb thumb-empty">🖼</div>'}
        <span class="grow"><b>${i + 1}.</b> ${esc(c.ru).replace(/\n/g, ' / ')}</span></button>`).join('');
    Sheet.open(`<h3>Кусочки стиха</h3><div class="panel">${rows}</div>`);
    $('#sheet').querySelectorAll('[data-ck]').forEach((b) => {
      b.onclick = () => Screens.editCard(cards.find((c) => c.key === b.dataset.ck));
    });
  },

  showText(deck, cards) {
    const text = cards.sort((a, b) => a.idx - b.idx).map((c) => esc(c.ru)).join('\n');
    Sheet.open(`<h3>${esc(deck.title)}</h3><div class="poem-full">${text}</div>
      <div class="btn-row"><button class="btn" id="btnSayAll">🎧 Слушать</button></div>`);
    // после закрытия окна открываем плеер (переход запускается из обработчика «Назад»)
    $('#btnSayAll').onclick = () => { Sheet.after = () => navigate('listen', { deckId: deck.id }); Sheet.close(); };
  },

  // ──── Запуск режима ────
  async mode({ deckId, mode }) {
    this.deck = await DB.get('decks', deckId);
    if (!this.deck) { switchTab('poems'); return; }
    this.cards = (await DB.byIndex('cards', 'deckId', deckId)).sort((a, b) => a.idx - b.idx);
    const m = POEM_MODES.find((x) => x.id === mode) || POEM_MODES[0];
    $('#topTitle').textContent = `${m.icon} ${m.title}`;
    this.state = { mode: m.id, i: 0, k: 1, level: 1, shown: false };
    this.draw();
  },

  draw() {
    const fn = { intro: 'drawIntro', ball: 'drawBall', letters: 'drawLetters', fade: 'drawFade', table: 'drawTable' }[this.state.mode];
    this[fn]();
  },

  // ──── Оформление строк ────
  lines(text) { return String(text).split('\n'); },

  // последнее слово строки подсвечиваем — это рифма
  rhymeHtml(text) {
    return this.lines(text).map((line) => {
      const words = [...line.matchAll(WORD_RE)];
      if (!words.length) return esc(line);
      const last = words[words.length - 1];
      return esc(line.slice(0, last.index)) + `<mark class="rhyme">${esc(last[0])}</mark>` + esc(line.slice(last.index + last[0].length));
    }).join('<br>');
  },

  lettersHtml(text) {
    return this.lines(text).map((line) => esc(line.replace(WORD_RE, (w) => w[0]))).join('<br>');
  },

  fadeHtml(text, level, seed) {
    let n = 0;
    return this.lines(text).map((line) => {
      let out = '', pos = 0;
      for (const m of line.matchAll(WORD_RE)) {
        out += esc(line.slice(pos, m.index));
        // слово скрыто, если его «номер» попадает в долю текущего уровня
        const hide = ((n * 7 + seed * 3) % FADE_LEVELS) < level;
        out += hide ? `<span class="blank" data-w="${esc(m[0])}">${' '.repeat(m[0].length)}</span>` : esc(m[0]);
        pos = m.index + m[0].length;
        n += 1;
      }
      return out + esc(line.slice(pos));
    }).join('<br>');
  },

  pic(card, cls = 'poem-pic') {
    const url = imgUrl(card);
    return `<div class="${cls} ${url ? '' : 'noimg'}" style="background-image:url('${url}')"></div>`;
  },

  head(pos, total) {
    return `<div class="study-head"><div class="bar"><i style="width:${Math.round((pos / total) * 100)}%"></i></div>
      <div class="study-count">${pos} / ${total}</div></div>`;
  },

  done(mode, text) {
    $('#view').innerHTML = `<div class="done"><div class="big">⭐</div><h2>Молодец!</h2>
      <p class="subtitle">${esc(text)}</p>
      <div class="btn-row"><button class="btn primary" id="btnPoemBack">Дальше</button></div></div>`;
    $('#btnPoemBack').onclick = () => history.back();
    this.markStar(mode);
  },
};

// ──── Режимы заучивания ────
Object.assign(Poems, {

  // 1. Знакомство: картинка → нажатие → строки (как карточка)
  drawIntro() {
    const st = this.state;
    if (st.i >= this.cards.length) { this.done('intro', 'Ты познакомился со всем стихом'); return; }
    const c = this.cards[st.i];
    $('#view').innerHTML = `${this.head(st.i + 1, this.cards.length)}
      <div class="stage"><div class="card3d poem-card" id="card">
        <div class="face front">${this.pic(c, 'pic')}<div class="caption">№ ${st.i + 1}</div>
          ${st.i === 0 ? '<div class="tap-hint">нажми на картинку</div>' : ''}</div>
        <div class="face back">${this.pic(c, 'mini')}
          <div class="poem-lines">${this.rhymeHtml(c.ru)}</div>
          <button class="speak" id="btnSpeak" aria-label="Озвучить">
            <svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9zM16 9a4 4 0 010 6M18.5 6.5a8 8 0 010 11"/></svg></button></div>
      </div></div>
      <div class="study-nav">
        <button class="btn" id="btnPrev" ${st.i === 0 ? 'disabled' : ''}>← Назад</button>
        <button class="btn primary" id="btnNext">Дальше →</button></div>`;
    const card = $('#card');
    card.onclick = (e) => {
      if (e.target.closest('.speak')) return;
      card.classList.toggle('flipped');
      if (card.classList.contains('flipped')) Speech.sayRu(c.ru);
    };
    $('#btnSpeak').onclick = (e) => { e.stopPropagation(); Speech.sayRu(c.ru); };
    $('#btnPrev').onclick = () => { st.i -= 1; this.draw(); };
    $('#btnNext').onclick = () => { st.i += 1; this.draw(); };
    attachSwipe($('#card'), () => $('#btnNext').click(), () => { if (st.i > 0) $('#btnPrev').click(); });
  },

  // 2. Снежный ком: картинки 1..k, рассказать с начала
  drawBall() {
    const st = this.state;
    const n = this.cards.length;
    const part = this.cards.slice(0, st.k);
    $('#view').innerHTML = `${this.head(st.k, n)}
      <p class="poem-task">Расскажи с самого начала до картинки <b>№ ${st.k}</b></p>
      <div class="poem-strip">${part.map((c, i) => `<div class="poem-cell">${this.pic(c)}<span>${i + 1}</span>
        ${st.shown ? `<div class="poem-lines small">${this.rhymeHtml(c.ru)}</div>` : ''}</div>`).join('')}</div>
      <div class="btn-row"><button class="btn" id="btnShow">${st.shown ? 'Скрыть текст' : '👀 Проверить себя'}</button>
        <button class="btn" id="btnSayPart">🔊</button></div>
      <div class="grade two">
        <button class="btn bad" id="btnAgain">Ещё раз<small>сначала</small></button>
        <button class="btn good" id="btnOk">Получилось<small>${st.k < n ? '+ кусочек' : 'весь стих!'}</small></button></div>`;
    $('#btnShow').onclick = () => { st.shown = !st.shown; this.draw(); };
    $('#btnSayPart').onclick = () => Speech.sayRu(part.map((c) => c.ru).join('\n'));
    $('#btnAgain').onclick = () => { st.shown = false; this.draw(); };
    $('#btnOk').onclick = () => {
      if (st.k >= n) { this.done('ball', 'Ты рассказал весь стих снежным комом'); return; }
      st.k += 1; st.shown = false; this.draw();
    };
  },

  // 3. Первые буквы: нажми на кусочек — откроется полностью
  drawLetters() {
    $('#view').innerHTML = `<p class="poem-task">Вспомни строки по первым буквам. Нажми на кусочек, чтобы проверить.</p>
      ${this.cards.map((c, i) => `<button class="panel poem-row" data-i="${i}">${this.pic(c, 'poem-thumb')}
        <div class="poem-lines letters" data-full="0">${this.lettersHtml(c.ru)}</div></button>`).join('')}
      <button class="btn primary block" id="btnDone" style="margin-top:12px">Рассказал без подсказок ✓</button>`;
    $('#view').querySelectorAll('.poem-row').forEach((row) => {
      row.onclick = () => {
        const box = row.querySelector('.poem-lines');
        const c = this.cards[Number(row.dataset.i)];
        const full = box.dataset.full === '1';
        box.innerHTML = full ? this.lettersHtml(c.ru) : this.rhymeHtml(c.ru);
        box.dataset.full = full ? '0' : '1';
        box.classList.toggle('letters', full);
      };
    });
    $('#btnDone').onclick = () => this.done('letters', 'Первые буквы больше не нужны');
  },

  // 4. Исчезающие слова: уровни 1..FADE_LEVELS
  drawFade() {
    const st = this.state;
    $('#view').innerHTML = `${this.head(st.level, FADE_LEVELS)}
      <p class="poem-task">Прочитай вслух, вставляя пропущенные слова. Нажми на пропуск — подсмотреть.</p>
      ${this.cards.map((c, i) => `<div class="panel poem-row">${this.pic(c, 'poem-thumb')}
        <div class="poem-lines">${this.fadeHtml(c.ru, st.level, i)}</div></div>`).join('')}
      <button class="btn primary block" id="btnLevel" style="margin-top:12px">
        ${st.level < FADE_LEVELS ? 'Получилось → спрятать больше' : 'Рассказал без слов ✓'}</button>`;
    $('#view').querySelectorAll('.blank').forEach((b) => {
      b.onclick = () => { b.textContent = b.dataset.w; b.classList.add('peek'); };
    });
    $('#btnLevel').onclick = () => {
      if (st.level >= FADE_LEVELS) { this.done('fade', 'Слова больше не нужны — только картинки'); return; }
      st.level += 1; this.draw(); window.scrollTo(0, 0);
    };
  },

  // 5. Мнемотаблица: все картинки сеткой, печать
  drawTable() {
    const st = this.state;
    $('#view').innerHTML = `
      <p class="poem-task">Расскажи весь стих, глядя на картинки. Нажми на картинку — подсказка.</p>
      <div class="poem-table">${this.cards.map((c, i) => `<button class="poem-cell" data-i="${i}">${this.pic(c)}<span>${i + 1}</span>
        <div class="poem-lines small" ${st.shown ? '' : 'hidden'}>${this.rhymeHtml(c.ru)}</div></button>`).join('')}</div>
      <div class="btn-row"><button class="btn" id="btnAllText">${st.shown ? 'Скрыть текст' : 'Показать текст'}</button>
        <button class="btn" id="btnPrint">🖨 Печать</button></div>
      <button class="btn primary block" id="btnDone">Рассказал весь стих ✓</button>`;
    $('#view').querySelectorAll('.poem-cell').forEach((cell) => {
      cell.onclick = () => { const t = cell.querySelector('.poem-lines'); t.hidden = !t.hidden; };
    });
    $('#btnAllText').onclick = () => { st.shown = !st.shown; this.draw(); };
    $('#btnPrint').onclick = () => this.print();
    $('#btnDone').onclick = () => this.done('table', 'Стих выучен! Приложение напомнит повторить');
  },

  // ──── Печать мнемотаблицы на лист А4 ────
  print() {
    const cells = this.cards.map((c, i) => {
      const url = imgUrl(c);
      return `<div class="cell">${url ? `<img src="${url}">` : '<div class="ph"></div>'}<b>${i + 1}</b></div>`;
    }).join('');
    const w = window.open('', '_blank');
    if (!w) { toast('Разрешите всплывающие окна для печати'); return; }
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(this.deck.title)}</title>
      <style>body{font-family:sans-serif;margin:12mm}h1{font-size:20pt;margin:0 0 8mm}
      .g{display:grid;grid-template-columns:repeat(3,1fr);gap:6mm}.cell{position:relative}
      img,.ph{width:100%;aspect-ratio:1;object-fit:cover;border-radius:4mm;background:#eee}
      b{position:absolute;top:2mm;left:2mm;background:#fff;border-radius:50%;width:9mm;height:9mm;
      display:grid;place-items:center;font-size:12pt}</style></head>
      <body><h1>${esc(this.deck.title)}</h1><div class="g">${cells}</div>
      <script>window.onload=()=>setTimeout(()=>print(),300)<\/script></body></html>`);
    w.document.close();
  },
});
