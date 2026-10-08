'use strict';
// ──── Раздел «Темы»: изучение любого материала карточками ────
// Тема — колода с type: "topic". Карточка = смысловой раздел текста:
//   ru (оригинальный текст), extra.title, extra.question, extra.points[], extra.terms[], extra.quiz{q, options[], answer}
// Режимы: карта темы → изучение → вопрос-ответ (интервальное повторение) → пропуски → тест → объясни сам.

const TOPIC_MODES = [
  { id: 'map', icon: '🗺', title: 'Карта темы', hint: 'Обзор всех разделов — сначала увидеть целое' },
  { id: 'learn', icon: '📖', title: 'Изучение', hint: 'Картинка → нажми → главное и оригинальный текст' },
  { id: 'recall', icon: '❓', title: 'Вопрос-ответ', hint: 'Вспомни сам, потом проверь. Повторения по расписанию' },
  { id: 'cloze', icon: '✍️', title: 'Пропуски', hint: 'Вставь ключевые термины в тезисы' },
  { id: 'quiz', icon: '🎯', title: 'Тест', hint: 'Выбор ответа, разбор ошибок' },
  { id: 'feynman', icon: '🗣', title: 'Объясни сам', hint: 'Расскажи своими словами и сверься с тезисами' },
];
const QUIZ_PASS_SHARE = 0.8;      // доля верных ответов для звёздочки
const FEYNMAN_PASS_SHARE = 0.7;   // доля упомянутых тезисов для звёздочки

const Topics = {
  deck: null,
  cards: [],
  st: {},

  ex(card) { return card.extra || {}; },
  titleOf(card, i) { return this.ex(card).title || `Раздел ${i + 1}`; },
  points(card) { return Array.isArray(this.ex(card).points) ? this.ex(card).points : []; },

  // ──── Прогресс: звёзды режимов (общее хранилище со стихами) ────
  async progress(deckId) {
    const pk = `${App.profile.id}|${deckId}`;
    return (await DB.get('poemProgress', pk)) || { pk, profileId: App.profile.id, deckId, stars: {}, reviews: 0, nextReview: 0, last: 0 };
  },

  async star(mode) {
    const pr = await this.progress(this.deck.id);
    if (!pr.stars[mode]) toast('⭐ Звёздочка получена!');
    pr.stars[mode] = true;
    pr.last = Date.now();
    await DB.put('poemProgress', pr);
    await touchStreak();
  },

  // ──── Список тем ────
  async list() {
    const all = (await DB.all('decks')).filter((d) => d.type === 'topic').sort((a, b) => b.createdAt - a.createdAt);
    const items = await Promise.all(all.map(async (d) => ({ d, pr: await this.progress(d.id), s: await deckSummary(d), cover: await deckCover(d) })));
    const tiles = items.map(({ d, pr, s, cover }) => {
      const stars = TOPIC_MODES.filter((m) => pr.stars[m.id]).length;
      return `<button class="deck-tile" data-topic="${esc(d.id)}">
        <div class="cover ${cover ? '' : 'noimg'}" style="background-image:url('${cover}')"></div>
        <div class="meta"><div class="name">${esc(d.title)}</div>
          <div class="count">${d.cardCount} ${plural(d.cardCount, 'раздел', 'раздела', 'разделов')}</div>
          <div class="poem-stars">${'⭐'.repeat(stars)}${'☆'.repeat(TOPIC_MODES.length - stars)}</div>
          ${s.due ? `<div class="poem-due">🔔 Повторить: ${s.due}</div>` : ''}</div></button>`;
    }).join('');
    $('#view').innerHTML = `
      <h2>Темы</h2><p class="subtitle">Любой материал — картинками и вопросами</p>
      <div class="grid">${tiles}
        <button class="add-tile import" id="btnAddTopic">${PLUS}<span>Добавить тему</span></button></div>
      <div class="btn-row"><button class="btn" id="btnPasteTopic">Вставить тему из буфера</button></div>`;
    $('#btnAddTopic').onclick = async () => { const d = await Importer.pickAndImport(); if (d) navigate('topic', { deckId: d.id }); };
    $('#btnPasteTopic').onclick = () => Importer.pasteDeck();
    $('#view').querySelectorAll('[data-topic]').forEach((b) => { b.onclick = () => navigate('topic', { deckId: b.dataset.topic }); });
  },

  // ──── Экран темы ────
  async screen(deckId) {
    const deck = await DB.get('decks', deckId);
    if (!deck) { switchTab('topics'); return; }
    $('#topTitle').textContent = deck.title;
    const [cards, pr, s] = await Promise.all([DB.byIndex('cards', 'deckId', deckId), this.progress(deckId), deckSummary(deck)]);
    const noImg = cards.filter((c) => !c.image).length;
    const hasQuiz = cards.some((c) => this.ex(c).quiz);
    const rows = TOPIC_MODES.filter((m) => m.id !== 'quiz' || hasQuiz).map((m) => `
      <button class="row" data-mode="${m.id}"><span class="mode-ico">${m.icon}</span>
        <span class="grow"><b>${m.title}</b>${m.id === 'recall' && (s.due || s.fresh) ? ` <span class="pill">${s.due + s.fresh}</span>` : ''}
          <div class="hint">${m.hint}</div></span>
        <span class="mode-star">${pr.stars[m.id] ? '⭐' : '☆'}</span></button>`).join('');
    $('#view').innerHTML = `
      ${noImg ? `<div class="panel img-banner"><div class="grow"><b>🖼 Без картинки: ${noImg}</b>
        <div class="hint">Сгенерируйте или выберите из галереи</div></div>
        <button class="btn import" id="btnAddImages">Добавить</button></div>` : ''}
      <p class="subtitle">${esc(deck.author || '')}${deck.author ? ' · ' : ''}${cards.length} ${plural(cards.length, 'раздел', 'раздела', 'разделов')} · выучено ${s.learned}</p>
      <button class="btn block listen-btn" id="btnListen">🎧 Слушать тему</button>
      <div class="panel">${rows}</div>
      <div class="deck-actions" style="margin-top:14px">
        <button id="btnTopicImages">🖼 Картинки</button>
        <button id="btnTopicExport">📤 Выгрузить</button>
        <button id="btnTopicDel" class="del">🗑 Удалить тему</button>
      </div>`;
    if (noImg) $('#btnAddImages').onclick = () => navigate('images', { deckId });
    $('#btnListen').onclick = () => navigate('listen', { deckId });
    $('#btnTopicImages').onclick = () => navigate('images', { deckId });
    $('#btnTopicExport').onclick = () => Importer.exportDeck(deckId).catch((e) => reportError('export', e));
    $('#btnTopicDel').onclick = () => Screens.deleteDeck(deck);
    $('#view').querySelectorAll('[data-mode]').forEach((b) => { b.onclick = () => navigate('topicMode', { deckId, mode: b.dataset.mode }); });
  },

  // ──── Запуск режима ────
  async mode({ deckId, mode }) {
    this.deck = await DB.get('decks', deckId);
    if (!this.deck) { switchTab('topics'); return; }
    this.cards = (await DB.byIndex('cards', 'deckId', deckId)).sort((a, b) => a.idx - b.idx);
    const m = TOPIC_MODES.find((x) => x.id === mode) || TOPIC_MODES[0];
    $('#topTitle').textContent = `${m.icon} ${m.title}`;
    this.st = { mode: m.id, i: 0, open: false, score: 0, answered: null, level: 1 };
    if (m.id === 'recall') await this.prepareRecall();
    if (m.id === 'quiz') this.st.items = shuffle(this.cards.filter((c) => this.ex(c).quiz));
    this.draw();
  },

  draw() {
    ({ map: this.drawMap, learn: this.drawLearn, recall: this.drawRecall, cloze: this.drawCloze,
      quiz: this.drawQuiz, feynman: this.drawFeynman })[this.st.mode].call(this);
    this.bindZoom();
    window.scrollTo(0, 0);
  },

  // ──── Общие куски разметки ────
  pic(card, cls) {
    const url = imgUrl(card);
    if (cls === 'topic-mini' && this.ex(card).drawn && url) cls = 'topic-pic drawn';
    return `<div class="${cls} ${url ? '' : 'noimg'}" data-zoom="${url ? card.key : ''}" style="background-image:url('${url}')"></div>`;
  },

  // увеличенный просмотр картинки (для схем с подписями)
  bindZoom() {
    $('#view').querySelectorAll('[data-zoom]').forEach((el) => {
      if (!el.dataset.zoom) return;
      el.addEventListener('click', (e) => {
        const card = this.cards.find((c) => c.key === el.dataset.zoom);
        const opened = el.classList.contains('drawn') || el.classList.contains('topic-mini');
        if (!card || !opened) return;           // на лицевой стороне нажатие переворачивает карточку
        e.stopPropagation();
        Sheet.open(`<img src="${imgUrl(card)}" alt="" style="width:100%;border-radius:12px;background:#fff">
          <p class="subtitle" style="text-align:center;margin-top:8px">${esc(this.ex(card).title || '')}</p>`);
      });
    });
  },

  // ключевые термины подсвечиваются в тексте
  markTerms(text, card) {
    let html = esc(text);
    (this.ex(card).terms || []).forEach((t) => {
      if (!t) return;
      const re = new RegExp(`(${String(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
      html = html.replace(re, '<mark class="term">$1</mark>');
    });
    return html.replace(/\n/g, '<br>');
  },

  detailHtml(card) {
    const pts = this.points(card);
    return `${pts.length ? `<div class="section-title" style="margin:4px 0 6px">Главное</div>
      <ul class="topic-points">${pts.map((p) => `<li>${this.markTerms(p, card)}</li>`).join('')}</ul>` : ''}
      <details class="topic-orig" ${pts.length ? '' : 'open'}><summary>Оригинальный текст</summary>
        <div class="topic-text">${this.markTerms(card.ru, card)}</div></details>`;
  },

  head(pos, total) {
    return `<div class="study-head"><div class="bar"><i style="width:${Math.round((pos / Math.max(total, 1)) * 100)}%"></i></div>
      <div class="study-count">${pos} / ${total}</div></div>`;
  },

  done(mode, text, ok = true) {
    $('#view').innerHTML = `<div class="done"><div class="big">${ok ? '⭐' : '💪'}</div><h2>${ok ? 'Отлично!' : 'Почти!'}</h2>
      <p class="subtitle">${esc(text)}</p>
      <div class="btn-row"><button class="btn primary" id="btnTopicBack">Готово</button></div></div>`;
    $('#btnTopicBack').onclick = () => history.back();
    if (ok) this.star(mode);
  },
};

// ──── Режимы ────
Object.assign(Topics, {

  // 1. Карта темы: все разделы сеткой, нажатие — подробности
  drawMap() {
    $('#view').innerHTML = `<p class="poem-task">Сначала посмотрите, из чего состоит тема. Нажмите на раздел — откроется главное.</p>
      <div class="topic-map">${this.cards.map((c, i) => `<button class="topic-tile" data-i="${i}">
        ${this.pic(c, 'poem-pic')}<span class="num">${i + 1}</span><b>${esc(this.titleOf(c, i))}</b></button>`).join('')}</div>
      <button class="btn primary block" id="btnMapDone" style="margin-top:14px">Понял структуру ✓</button>`;
    $('#view').querySelectorAll('.topic-tile').forEach((t) => {
      t.onclick = () => {
        const i = Number(t.dataset.i);
        const c = this.cards[i];
        Sheet.open(`<h3>${i + 1}. ${esc(this.titleOf(c, i))}</h3>${c.image ? `<img class="edit-img" src="${imgUrl(c)}" alt="">` : ''}
          ${this.detailHtml(c)}`);
      };
    });
    $('#btnMapDone').onclick = () => this.done('map', 'Вы видите тему целиком — дальше детали');
  },

  // 2. Изучение: картинка + заголовок → нажатие → главное и оригинал
  drawLearn() {
    const st = this.st;
    if (st.i >= this.cards.length) { this.done('learn', 'Все разделы просмотрены'); return; }
    const c = this.cards[st.i];
    $('#view').innerHTML = `${this.head(st.i + 1, this.cards.length)}
      <div class="panel topic-card" id="tcard">
        ${this.pic(c, st.open ? 'topic-mini' : 'topic-pic')}
        <div class="topic-title">${esc(this.titleOf(c, st.i))}</div>
        ${st.open ? this.detailHtml(c) : '<div class="tap-note">нажмите, чтобы открыть</div>'}
      </div>
      <div class="study-nav">
        <button class="btn" id="btnPrev" ${st.i === 0 ? 'disabled' : ''}>← Назад</button>
        <button class="btn" id="btnSpeak">🔊</button>
        <button class="btn primary" id="btnNext">Дальше →</button></div>`;
    $('#tcard').onclick = (e) => { if (e.target.closest('details')) return; st.open = !st.open; this.draw(); };
    // 🔊 — заголовок и весь исходный текст раздела; повторное нажатие — стоп
    const speakBtn = $('#btnSpeak');
    const mark = (on) => { if (speakBtn.isConnected) { speakBtn.textContent = on ? '⏹' : '🔊'; speakBtn.classList.toggle('primary', on); } };
    speakBtn.onclick = () => { if (Reader.isOn()) Reader.stop(); else Reader.read(this.deck, c, st.i, mark); };
    if (Reader.isOn()) { Reader.onState = mark; mark(true); }   // карточку перевернули во время чтения
    $('#btnPrev').onclick = () => { Reader.stop(); st.i -= 1; st.open = false; this.draw(); };
    $('#btnNext').onclick = () => { Reader.stop(); st.i += 1; st.open = false; this.draw(); };
    attachSwipe($('#tcard'), () => $('#btnNext').click(), () => { if (st.i > 0) $('#btnPrev').click(); });
  },

  // 3. Вопрос-ответ с интервальным повторением
  async prepareRecall() {
    const recs = await DB.byIndex('progress', 'profileDeck', [App.profile.id, this.deck.id]);
    this.st.recs = new Map(recs.map((r) => [r.cardKey, r]));
    const now = Date.now();
    const due = this.cards.filter((c) => SRS.isDue(this.st.recs.get(c.key), now));
    const fresh = this.cards.filter((c) => SRS.status(this.st.recs.get(c.key)) === 'new');
    this.st.queue = [...shuffle(due), ...fresh];
  },

  drawRecall() {
    const st = this.st;
    if (st.i >= st.queue.length) {
      if (!st.queue.length) { this.done('recall', 'Сегодня повторять нечего — загляните завтра', false); return; }
      this.done('recall', 'Повторение на сегодня закончено'); return;
    }
    const c = st.queue[st.i];
    const q = this.ex(c).question || `Что вы знаете о разделе «${this.titleOf(c, c.idx)}»?`;
    const G = SRS.GRADE;
    const rec = st.recs.get(c.key) || SRS.fresh(App.profile.id, c);
    $('#view').innerHTML = `${this.head(st.i + 1, st.queue.length)}
      <div class="panel topic-card">
        ${this.pic(c, st.open ? 'topic-mini' : 'topic-pic')}
        <div class="topic-q">${esc(q)}</div>
        ${st.open ? this.detailHtml(c) : '<div class="tap-note">Ответьте вслух или про себя, затем проверьте</div>'}
      </div>
      ${st.open ? `<div class="grade">
        <button class="btn bad" data-g="${G.BAD}">Не знаю<small>${SRS.preview(rec, G.BAD)}</small></button>
        <button class="btn hard" data-g="${G.HARD}">Трудно<small>${SRS.preview(rec, G.HARD)}</small></button>
        <button class="btn good" data-g="${G.GOOD}">Знаю<small>${SRS.preview(rec, G.GOOD)}</small></button></div>`
        : '<div class="study-nav"><button class="btn primary" id="btnShow">Показать ответ</button></div>'}`;
    const show = $('#btnShow');
    if (show) show.onclick = () => { st.open = true; this.draw(); };
    $('#view').querySelectorAll('[data-g]').forEach((b) => {
      b.onclick = async () => {
        const g = Number(b.dataset.g);
        const r = SRS.review(rec, g);
        st.recs.set(c.key, r);
        await DB.put('progress', r);
        await touchStreak();
        if (g === G.BAD) st.queue.splice(Math.min(st.queue.length, st.i + 1 + REINSERT_GAP), 0, c);
        st.i += 1; st.open = false; this.draw();
      };
    });
  },

  // 4. Пропуски: ключевые термины в тезисах спрятаны
  clozeHtml(text, terms) {
    let html = esc(text);
    terms.forEach((t) => {
      if (!t) return;
      const re = new RegExp(String(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      html = html.replace(re, (m) => `<span class="blank" data-w="${m}">${' '.repeat(Math.max(3, m.length))}</span>`);
    });
    return html;
  },

  drawCloze() {
    const blocks = this.cards.map((c, i) => {
      const terms = this.ex(c).terms || [];
      const pts = this.points(c).length ? this.points(c) : [c.ru];
      return `<div class="panel poem-row" style="align-items:flex-start">${this.pic(c, 'poem-thumb')}
        <div><b>${esc(this.titleOf(c, i))}</b><ul class="topic-points">${pts.map((p) => `<li>${this.clozeHtml(p, terms)}</li>`).join('')}</ul></div></div>`;
    }).join('');
    $('#view').innerHTML = `<p class="poem-task">Вспомните пропущенные термины. Нажмите на пропуск — подсмотреть.</p>${blocks}
      <button class="btn primary block" id="btnClozeDone" style="margin-top:12px">Вспомнил все термины ✓</button>`;
    $('#view').querySelectorAll('.blank').forEach((b) => { b.onclick = () => { b.textContent = b.dataset.w; b.classList.add('peek'); }; });
    $('#btnClozeDone').onclick = () => {
      const peeked = $('#view').querySelectorAll('.blank.peek').length;
      const total = $('#view').querySelectorAll('.blank').length;
      this.done('cloze', `Подсмотрено: ${peeked} из ${total}`, peeked <= total * (1 - QUIZ_PASS_SHARE));
    };
  },

  // 5. Тест с выбором ответа
  drawQuiz() {
    const st = this.st;
    const items = st.items;
    if (st.i >= items.length) {
      const ok = st.score >= items.length * QUIZ_PASS_SHARE;
      this.done('quiz', `Верно: ${st.score} из ${items.length}${ok ? '' : '. Для звёздочки нужно 80 %'}`, ok);
      return;
    }
    const c = items[st.i];
    const qz = this.ex(c).quiz;
    if (!st.order) st.order = shuffle(qz.options.map((_, k) => k));
    const ans = st.answered;
    $('#view').innerHTML = `${this.head(st.i + 1, items.length)}
      <div class="panel topic-card">${this.pic(c, 'topic-mini')}<div class="topic-q">${esc(qz.q)}</div>
        <div class="quiz-opts">${st.order.map((k) => {
          const cls = ans === null ? '' : k === qz.answer ? 'right' : k === ans ? 'wrong' : 'dim';
          return `<button class="quiz-opt ${cls}" data-k="${k}" ${ans === null ? '' : 'disabled'}>${esc(qz.options[k])}</button>`;
        }).join('')}</div>
        ${ans !== null && ans !== qz.answer ? `<div class="section-title" style="margin:12px 0 4px">Почему</div>${this.detailHtml(c)}` : ''}
      </div>
      ${ans !== null ? '<div class="study-nav"><button class="btn primary" id="btnQNext">Дальше →</button></div>' : ''}`;
    $('#view').querySelectorAll('.quiz-opt').forEach((b) => {
      b.onclick = () => { st.answered = Number(b.dataset.k); if (st.answered === qz.answer) st.score += 1; this.draw(); };
    });
    const nx = $('#btnQNext');
    if (nx) nx.onclick = () => { st.i += 1; st.answered = null; st.order = null; this.draw(); };
  },

  // 6. Объясни сам (метод Фейнмана): рассказать своими словами, отметить упомянутые тезисы
  drawFeynman() {
    const st = this.st;
    if (st.i >= this.cards.length) {
      const share = st.score / Math.max(1, st.total || 1);
      this.done('feynman', `Упомянуто тезисов: ${st.score} из ${st.total}`, share >= FEYNMAN_PASS_SHARE);
      return;
    }
    const c = this.cards[st.i];
    const pts = this.points(c);
    $('#view').innerHTML = `${this.head(st.i + 1, this.cards.length)}
      <div class="panel topic-card">${this.pic(c, 'topic-mini')}<div class="topic-title">${esc(this.titleOf(c, st.i))}</div>
        <p class="tap-note" style="margin-top:6px">Объясните этот раздел так, будто рассказываете другу. Вслух или текстом (можно голосовым вводом клавиатуры).</p>
        <textarea id="fText" rows="4" class="f-text" placeholder="Моё объяснение…"></textarea>
        ${st.open ? `<div class="section-title" style="margin:10px 0 4px">Отметьте, что вы упомянули</div>
          ${pts.map((p, k) => `<label class="f-pt"><input type="checkbox" data-k="${k}"> ${esc(p)}</label>`).join('')}` : ''}
      </div>
      <div class="study-nav">${st.open ? '<button class="btn primary" id="btnFNext">Дальше →</button>'
        : '<button class="btn primary" id="btnFCheck">Сверить с тезисами</button>'}</div>`;
    const ta = $('#fText');
    ta.value = st.draft || '';
    ta.oninput = () => { st.draft = ta.value; };
    const chk = $('#btnFCheck');
    if (chk) chk.onclick = () => { st.open = true; this.draw(); };
    const nx = $('#btnFNext');
    if (nx) nx.onclick = () => {
      st.score += $('#view').querySelectorAll('.f-pt input:checked').length;
      st.total = (st.total || 0) + pts.length;
      st.i += 1; st.open = false; st.draft = ''; this.draw();
    };
  },
});
