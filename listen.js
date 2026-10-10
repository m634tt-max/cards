'use strict';
// ──── Режим «Слушать»: озвучка всей колоды подряд ────
// Слова: английская фраза → перевод → следующая карточка.
// Стихи и темы: весь текст по фразам, паузы зависят от знаков препинания.
// Два движка:
//   • «аудио» — нейроголос с сервера, фразы склеены в один файл (audio.js). Играет и при
//     заблокированном экране, управление — в шторке и на экране блокировки;
//   • «голос телефона» — Web Speech, пока аудио не подготовлено. Только при включённом экране.

const LS_LISTEN = 'fc.listen';
const LISTEN_SPEEDS = [0.8, 1, 1.2, 1.4];              // множитель скорости
const LISTEN_GAPS = [                                   // пауза между карточками слов
  { id: 's', label: 'короткая', ms: 1200 },
  { id: 'm', label: 'средняя', ms: 2200 },
  { id: 'l', label: 'длинная', ms: 4000 },
];
// паузы после фразы в зависимости от последнего знака, мс
const PAUSE_PROSE = { end: 650, comma: 300, semi: 450, none: 550 };
const PAUSE_VERSE = { end: 900, comma: 450, semi: 600, none: 300 };
const PAUSE_PARA = 500;        // добавка в конце абзаца
const PAUSE_TITLE = 1000;      // после заголовка
const PAUSE_EN_RU = 700;       // между английской фразой и переводом
const PAUSE_EN_TWICE = 900;    // между двумя повторами фразы
const PAUSE_THINK = 1800;      // «сначала перевод»: время вспомнить фразу
const MAX_CHUNK = 220;         // длинные фразы делим по запятым
const WATCHDOG_BASE_MS = 5000;     // голос телефона: страховка, если не пришёл конец фразы
const WATCHDOG_PER_CHAR_MS = 180;
const SPEAK_DELAY_MS = 60;         // Chrome на Android теряет фразу сразу после cancel()
const SEEK_STEP_SEC = 10;          // перемотка кнопками на экране блокировки
const APP_ICON = 'icons/icon-512.png';

const Listen = {
  active: false,
  playing: false,
  engine: 'voice',   // 'audio' | 'voice'
  deck: null,
  cards: [],
  items: [],         // items[i] = отрезки карточки i: { text, lang, voice, k, pause, view, kind, br }
  i: 0,
  j: 0,
  cfg: null,
  // голос телефона
  token: 0,
  timer: 0,
  guard: 0,
  utter: null,
  wake: null,
  // аудио
  el: null,
  url: '',
  timeline: [],
  duration: 0,
  mixGen: 0,

  // ──── Настройки ────
  loadCfg() {
    const def = {
      speed: 1, gap: 'm', enTwice: false, ruFirst: false, points: false, loop: false,
      voiceRu: TTS_VOICES.ru[0].id, voiceEn: TTS_VOICES.en[0].id,
    };
    try { this.cfg = { ...def, ...JSON.parse(lsGet(LS_LISTEN, '{}')) }; } catch { this.cfg = def; }
    // голос, которого больше нет в списке (например, Дмитрий), заменяем первым доступным
    if (!TTS_VOICES.ru.some((v) => v.id === this.cfg.voiceRu)) this.cfg.voiceRu = def.voiceRu;
    if (!TTS_VOICES.en.some((v) => v.id === this.cfg.voiceEn)) this.cfg.voiceEn = def.voiceEn;
  },
  saveCfg() { lsSet(LS_LISTEN, JSON.stringify(this.cfg)); },
  kind() { return this.deck.type === 'poem' || this.deck.type === 'topic' ? this.deck.type : 'words'; },

  // ──── Экран ────
  async screen({ deckId }) {
    this.stop();
    this.deck = await DB.get('decks', deckId);
    if (!this.deck) { switchTab('library'); return; }
    this.cards = (await DB.byIndex('cards', 'deckId', deckId)).sort((a, b) => a.idx - b.idx);
    if (!this.cards.length) { toast('В колоде нет карточек'); history.back(); return; }
    this.loadCfg();
    this.active = true;
    this.i = 0; this.j = 0;
    this.build();
    $('#topTitle').textContent = `🎧 ${this.deck.title}`;
    this.drawShell();
    this.drawCard();
    await Tts.load(deckId);
    await this.refreshEngine();
  },

  drawShell() {
    const n = this.cards.length;
    $('#view').innerHTML = `
      <div class="listen">
        <div class="ls-card" id="lsCard"></div>
        <div class="ls-status" id="lsStatus"></div>
        <div class="ls-progress">
          <input type="range" id="lsSeek" min="1" max="${n}" value="1" ${n < 2 ? 'disabled' : ''}>
          <span id="lsPos"></span>
        </div>
        <div class="ls-controls">
          <button class="ls-btn" id="lsPrev" aria-label="Предыдущая">⏮</button>
          <button class="ls-btn play" id="lsPlay" aria-label="Слушать">▶</button>
          <button class="ls-btn" id="lsNext" aria-label="Следующая">⏭</button>
        </div>
        <div class="ls-opts" id="lsOpts"></div>
        <p class="hint ls-note">Нажмите на карточку — она прозвучит заново. Свайп — следующая/предыдущая.</p>
      </div>`;
    $('#lsPlay').onclick = () => this.toggle();
    $('#lsPrev').onclick = () => this.goto(this.i - 1);
    $('#lsNext').onclick = () => this.goto(this.i + 1);
    $('#lsSeek').oninput = (e) => this.goto(Number(e.target.value) - 1);
    $('#lsCard').onclick = () => { this.goto(this.i); if (!this.playing) this.play(); };
    attachSwipe($('#lsCard'), () => this.goto(this.i + 1), () => this.goto(this.i - 1));
    this.drawOpts();
  },

  // ──── Строка состояния: каким голосом играем ────
  drawStatus(missing, mixing = false) {
    const el = $('#lsStatus');
    if (!el) return;
    if (this.engine === 'audio') {
      el.className = 'ls-status ok';
      el.innerHTML = mixing ? '⏳ Собираю аудио…' : '🔊 Нейроголос · можно заблокировать экран';
      return;
    }
    el.className = 'ls-status';
    el.innerHTML = `<div class="grow">📱 Голос телефона · экран не блокировать</div>
      <button class="btn import" id="lsPrepare">🔊 Подготовить аудио${missing ? ` (${missing})` : ''}</button>`;
    $('#lsPrepare').onclick = () => this.prepare();
  },

  // ──── Переключатели под плеером ────
  drawOpts() {
    const c = this.cfg, k = this.kind();
    const gap = LISTEN_GAPS.find((g) => g.id === c.gap) || LISTEN_GAPS[1];
    const label = (list, id) => (list.find((v) => v.id === id) || list[0]).label;
    const chip = (id, text, on = false) => `<button class="ls-chip ${on ? 'on' : ''}" data-opt="${id}">${text}</button>`;
    let html = chip('speed', `Скорость ×${c.speed}`);
    html += chip('voiceRu', `🗣 ${label(TTS_VOICES.ru, c.voiceRu)}`);
    if (k === 'words') {
      html += chip('voiceEn', `🗣 ${label(TTS_VOICES.en, c.voiceEn)}`);
      html += chip('gap', `Пауза: ${gap.label}`) + chip('enTwice', 'EN ×2', c.enTwice) + chip('ruFirst', 'Сначала перевод', c.ruFirst);
    }
    if (k === 'topic') html += chip('points', '+ Главное', c.points);
    html += chip('loop', '🔁 По кругу', c.loop);
    $('#lsOpts').innerHTML = html;
    $('#lsOpts').querySelectorAll('[data-opt]').forEach((b) => { b.onclick = () => this.setOpt(b.dataset.opt); });
  },

  async setOpt(id) {
    const c = this.cfg;
    const cycle = (list, cur) => list[(list.findIndex((x) => x.id === cur) + 1) % list.length].id;
    if (id === 'speed') c.speed = LISTEN_SPEEDS[(LISTEN_SPEEDS.indexOf(c.speed) + 1) % LISTEN_SPEEDS.length];
    else if (id === 'gap') c.gap = cycle(LISTEN_GAPS, c.gap);
    else if (id === 'voiceRu') c.voiceRu = cycle(TTS_VOICES.ru, c.voiceRu);
    else if (id === 'voiceEn') c.voiceEn = cycle(TTS_VOICES.en, c.voiceEn);
    else c[id] = !c[id];
    this.saveCfg();
    this.drawOpts();
    if (id === 'speed') { if (this.el) this.el.playbackRate = c.speed; return; }
    if (id === 'loop') { if (this.el) this.el.loop = c.loop; return; }
    // остальные настройки меняют состав фраз — пересобираем
    const wasPlaying = this.playing;
    this.pause();
    this.build();
    this.j = 0;
    this.drawCard();
    await this.refreshEngine();
    if (wasPlaying) this.play();
  },

  // ──── Сборка отрезков для озвучки ────
  build() {
    const k = this.kind();
    this.items = this.cards.map((c, idx) => {
      const segs = k === 'words' ? this.wordsItem(c) : k === 'poem' ? this.poemItem(c, idx) : this.topicItem(c, idx);
      return segs.filter((s) => s.text && isSpeakable(s.text)).map((s) => {
        const voice = s.lang === 'en' ? this.cfg.voiceEn : this.cfg.voiceRu;
        return { ...s, voice, k: Tts.key(this.deck.id, voice, s.text) };
      });
    });
  },

  wordsItem(card) {
    const c = this.cfg;
    const gap = (LISTEN_GAPS.find((g) => g.id === c.gap) || LISTEN_GAPS[1]).ms;
    const en = { text: cleanSpeech(card.en), lang: 'en', view: 'en', kind: 'en' };
    const ru = { text: cleanSpeech(card.ru), lang: 'ru', view: 'ru', kind: 'ru' };
    const segs = c.ruFirst
      ? [{ ...ru, pause: PAUSE_THINK }, { ...en, pause: PAUSE_EN_TWICE }]
      : [{ ...en, pause: PAUSE_EN_RU }, { ...ru, pause: PAUSE_EN_RU }];
    if (c.enTwice) {
      const at = segs.findIndex((s) => s.kind === 'en');
      segs[at] = { ...segs[at], pause: PAUSE_EN_TWICE };
      segs.splice(at + 1, 0, { ...en, pause: PAUSE_EN_RU });
    }
    segs[segs.length - 1].pause = gap;
    return segs;
  },

  poemItem(card, idx) {
    const segs = [];
    if (idx === 0) {
      const head = [this.deck.author, this.deck.title].filter(Boolean).join('. ');
      segs.push({ text: cleanSpeech(head), lang: 'ru', pause: PAUSE_TITLE, view: 'title', kind: 'title' });
    }
    String(card.ru || '').split('\n').map((l) => l.trim()).filter(Boolean).forEach((line) => {
      splitPhrases(line, PAUSE_VERSE).forEach((p, n, all) => {
        segs.push({ ...p, lang: 'ru', view: `s${segs.length}`, kind: 'text', br: n === all.length - 1 ? 1 : 0 });
      });
    });
    return segs;
  },

  topicItem(card, idx) {
    return topicSegments(idx === 0 ? this.deck.title : '', card, idx, this.cfg.points);
  },

  // ──── Отрисовка текущей карточки ────
  drawCard() {
    const card = this.cards[this.i];
    const segs = this.items[this.i] || [];
    const url = imgUrl(card);
    const drawn = card.extra && card.extra.drawn;
    const pic = url ? `<div class="ls-pic ${drawn ? 'drawn' : ''}" style="background-image:url('${url}')"></div>` : '';
    let body;
    if (this.kind() === 'words') {
      const pend = this.cfg.ruFirst ? 'pending' : '';
      body = `<div class="ls-en ${pend}" data-view="en">${esc(card.en)}</div><div class="ls-ru" data-view="ru">${esc(card.ru)}</div>`;
    } else {
      const seen = new Set();
      body = `<div class="ls-text ${this.kind()}">${segs.map((s) => {
        if (seen.has(s.view)) return '';
        seen.add(s.view);
        if (s.kind === 'title') return `<div class="ls-title" data-view="${s.view}">${esc(s.text)}</div>`;
        if (s.kind === 'sub') return `<div class="ls-sub" data-view="${s.view}">${esc(s.text)}</div>`;
        const br = s.br === 2 ? '<span class="ls-para"></span>' : s.br === 1 ? '<br>' : ' ';
        return `<span class="ls-seg" data-view="${s.view}">${esc(s.text)}</span>${br}`;
      }).join('')}</div>`;
    }
    $('#lsCard').innerHTML = pic + body;
    $('#lsPos').textContent = `${this.i + 1} / ${this.cards.length}`;
    $('#lsSeek').value = String(this.i + 1);
    this.highlight();
    this.updateMeta();
  },

  highlight() {
    if (!$('#lsCard')) return;
    const seg = (this.items[this.i] || [])[this.j];
    $('#lsCard').querySelectorAll('[data-view]').forEach((el) => {
      const now = this.playing && seg && el.dataset.view === seg.view;
      el.classList.toggle('now', now);
      if (now) { el.classList.remove('pending'); el.scrollIntoView({ block: 'nearest' }); }
    });
    $('#lsPlay').textContent = this.playing ? '⏸' : '▶';
    $('#lsPlay').setAttribute('aria-label', this.playing ? 'Пауза' : 'Слушать');
  },

  // ──── Выбор движка: есть ли озвучка всех фраз ────
  missingJobs() {
    const seen = new Set();
    const jobs = [];
    this.items.flat().forEach((s) => {
      if (Tts.has(s.k) || seen.has(s.k)) return;
      seen.add(s.k);
      jobs.push({ k: s.k, text: s.text, voice: s.voice });
    });
    return jobs;
  },

  async refreshEngine() {
    const missing = this.missingJobs().length;
    this.engine = missing ? 'voice' : 'audio';
    this.drawStatus(missing, !missing);
    if (this.engine === 'audio') await this.remix();
  },

  async prepare() {
    this.pause();
    const done = await Tts.prepare(this.deck.id, this.missingJobs());
    if (!this.active) return;
    await this.refreshEngine();
    if (done) {
      const n = Tts.lastSilent;
      toast(n ? `🔊 Аудио готово. Не озвучено ${n} ${plural(n, 'фраза', 'фразы', 'фраз')} — вместо них пауза`
        : '🔊 Аудио готово — можно слушать с заблокированным экраном');
    }
  },

  // ──── Аудио: склейка в один файл ────
  async remix() {
    const gen = ++this.mixGen;
    let res;
    try {
      res = await Tts.mix(this.items.map((segs) => segs.map((s) => ({ k: s.k, pause: s.pause }))));
    } catch (err) {
      reportError('mix', err);
      this.engine = 'voice';
      this.drawStatus(this.missingJobs().length);
      return;
    }
    if (gen !== this.mixGen || !this.active) return;   // уже пересобрано заново или экран закрыт
    this.ensureEl();
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = URL.createObjectURL(res.blob);
    this.timeline = res.timeline;
    this.duration = res.duration;
    this.el.src = this.url;
    this.el.loop = this.cfg.loop;
    this.el.playbackRate = this.cfg.speed;
    this.el.currentTime = this.cardStart(this.i);
    this.drawStatus(0);
  },

  ensureEl() {
    if (this.el) return;
    const el = new Audio();
    el.preload = 'auto';
    el.addEventListener('play', () => { this.playing = true; this.highlight(); this.setSession('playing'); });
    el.addEventListener('pause', () => { if (this.engine === 'audio') { this.playing = false; this.highlight(); this.setSession('paused'); } });
    el.addEventListener('timeupdate', () => this.syncTime());
    el.addEventListener('ratechange', () => this.syncTime());
    el.addEventListener('loadedmetadata', () => { el.playbackRate = this.cfg.speed; });
    el.addEventListener('ended', () => { this.playing = false; this.i = this.cards.length - 1; this.highlight(); toast('✅ Прослушано до конца'); });
    el.addEventListener('error', () => { if (el.src) reportError('audio', new Error('не удалось воспроизвести аудио')); });
    this.el = el;
  },

  cardStart(i) {
    const t = this.timeline.find((x) => x.i === i);
    return t ? t.start : 0;
  },

  // текущее время аудио → карточка и фраза
  syncTime() {
    if (this.engine !== 'audio' || !this.el || !this.timeline.length) return;
    const t = this.el.currentTime;
    let lo = 0, hi = this.timeline.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.timeline[mid].start <= t) lo = mid; else hi = mid - 1;
    }
    const cur = this.timeline[lo];
    if (cur.i !== this.i) { this.i = cur.i; this.j = cur.j; this.drawCard(); } else if (cur.j !== this.j) { this.j = cur.j; this.highlight(); }
    if ('mediaSession' in navigator && navigator.mediaSession.setPositionState && this.duration) {
      try {
        navigator.mediaSession.setPositionState({ duration: this.duration, playbackRate: this.el.playbackRate, position: Math.min(t, this.duration) });
      } catch { /* старый браузер */ }
    }
  },

  // ──── Экран блокировки и шторка (Media Session) ────
  setSession(state) {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    ms.playbackState = state;
    const on = (action, fn) => { try { ms.setActionHandler(action, fn); } catch { /* действие не поддерживается */ } };
    on('play', () => this.play());
    on('pause', () => this.pause());
    on('previoustrack', () => this.goto(this.i - 1));
    on('nexttrack', () => this.goto(this.i + 1));
    on('seekbackward', () => { if (this.el) this.el.currentTime = Math.max(0, this.el.currentTime - SEEK_STEP_SEC); });
    on('seekforward', () => { if (this.el) this.el.currentTime = Math.min(this.duration, this.el.currentTime + SEEK_STEP_SEC); });
    on('seekto', (d) => { if (this.el && d.seekTime != null) this.el.currentTime = d.seekTime; });
    this.updateMeta();
  },

  updateMeta() {
    if (!('mediaSession' in navigator) || this.engine !== 'audio' || !this.active) return;
    const card = this.cards[this.i];
    if (!card) return;
    const title = this.kind() === 'words' ? card.en : (card.extra && card.extra.title) || String(card.ru || '').split('\n')[0];
    const art = imgUrl(card);
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title, artist: this.deck.title, album: `${this.i + 1} / ${this.cards.length}`,
        artwork: [{ src: art || APP_ICON, sizes: '512x512', type: art ? (card.image.type || 'image/webp') : 'image/png' }],
      });
    } catch { /* MediaMetadata не поддерживается */ }
  },

  clearSession() {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    ['play', 'pause', 'previoustrack', 'nexttrack', 'seekbackward', 'seekforward', 'seekto'].forEach((a) => {
      try { ms.setActionHandler(a, null); } catch { /* нет такого действия */ }
    });
    ms.metadata = null;
    ms.playbackState = 'none';
  },

  // ──── Управление (общее для обоих движков) ────
  toggle() { if (this.playing) this.pause(); else this.play(); },

  play() {
    if (this.engine === 'audio' && this.el && this.el.src) {
      this.el.play().catch((err) => reportError('play', err));
      return;
    }
    if (this.i >= this.cards.length) { this.i = 0; this.j = 0; this.drawCard(); }
    this.playing = true;
    this.wakeOn();
    this.highlight();
    this.speakNow();
  },

  pause() {
    if (this.el && !this.el.paused) this.el.pause();
    this.playing = false;
    this.silence();
    this.wakeOff();
    if ($('#lsPlay')) this.highlight();
  },

  goto(i) {
    const n = this.cards.length;
    this.i = Math.max(0, Math.min(n - 1, i));
    this.j = 0;
    if (this.engine === 'audio' && this.el && this.el.src) {
      this.el.currentTime = this.cardStart(this.i);
      this.drawCard();
      return;
    }
    this.silence();
    this.drawCard();
    if (this.playing) this.speakNow();
  },

  stop() {
    if (!this.active) return;
    this.active = false;
    this.pause();
    this.mixGen += 1;
    if (this.el) { this.el.removeAttribute('src'); this.el.load(); }
    if (this.url) { URL.revokeObjectURL(this.url); this.url = ''; }
    this.timeline = [];
    this.clearSession();
  },

  // ──── Голос телефона ────
  silence() {
    this.token += 1;
    clearTimeout(this.timer);
    clearTimeout(this.guard);
    if ('speechSynthesis' in window) speechSynthesis.cancel();
  },

  speakNow() {
    if (!('speechSynthesis' in window)) { toast('Голос телефона недоступен — подготовьте аудио'); this.pause(); return; }
    this.silence();
    const tok = this.token;
    this.timer = setTimeout(() => { if (tok === this.token) this.speakSeg(tok); }, SPEAK_DELAY_MS);
  },

  speakSeg(tok) {
    const seg = this.items[this.i][this.j];
    if (!seg) { this.advance(); return; }
    this.highlight();
    const mul = this.cfg.speed;
    let finished = false;
    const done = () => {
      if (finished || tok !== this.token) return;
      finished = true;
      clearTimeout(this.guard);
      this.timer = setTimeout(() => { if (tok === this.token) this.advance(); }, seg.pause / mul);
    };
    const u = Speech.utter(seg.text, seg.lang, mul);
    u.onend = done;
    u.onerror = (e) => {
      if (tok !== this.token) return;
      if (['synthesis-unavailable', 'language-unavailable', 'voice-unavailable'].includes(e.error)) {
        toast(`Нет голоса для языка ${seg.lang === 'en' ? 'английский' : 'русский'} — см. «Ещё → Озвучка»`);
      }
      done();
    };
    this.utter = u;
    this.guard = setTimeout(done, (WATCHDOG_BASE_MS + seg.text.length * WATCHDOG_PER_CHAR_MS) / mul);
    speechSynthesis.speak(u);
  },

  advance() {
    if (!this.playing) return;
    this.j += 1;
    if (this.j < this.items[this.i].length) { this.speakNow(); return; }
    this.j = 0;
    this.i += 1;
    if (this.i >= this.cards.length) {
      if (!this.cfg.loop) { this.finish(); return; }
      this.i = 0;
    }
    this.drawCard();
    this.speakNow();
  },

  finish() {
    this.i = this.cards.length - 1;
    this.j = 0;
    this.pause();
    this.i = this.cards.length;          // следующее «▶» начнёт сначала
    toast('✅ Прослушано до конца');
  },

  // экран не гаснет, пока говорит голос телефона
  async wakeOn() {
    try {
      if ('wakeLock' in navigator && !this.wake) {
        this.wake = await navigator.wakeLock.request('screen');
        this.wake.addEventListener('release', () => { this.wake = null; });
      }
    } catch { this.wake = null; }   // не поддерживается или экран уже скрыт
  },

  wakeOff() {
    if (this.wake) { this.wake.release().catch(() => {}); this.wake = null; }
  },

  // голос телефона после возврата в приложение продолжает с текущей фразы
  onVisible() {
    if (!this.active || !this.playing || this.engine !== 'voice' || document.visibilityState !== 'visible') return;
    this.wakeOn();
    this.speakNow();
  },

  onKey(e) {
    if (!this.active || Sheet.isOpen()) return;
    if (e.key === ' ') { e.preventDefault(); this.toggle(); } else if (e.key === 'ArrowRight') this.goto(this.i + 1);
    else if (e.key === 'ArrowLeft') this.goto(this.i - 1);
  },
};

// ──── Отрезки раздела темы: [название темы], заголовок раздела, исходный текст, [тезисы] ────
function topicSegments(deckTitle, card, idx, withPoints) {
  const segs = [];
  const ex = card.extra || {};
  if (deckTitle) segs.push({ text: cleanSpeech(deckTitle), lang: 'ru', pause: PAUSE_TITLE, view: 'deck', kind: 'title' });
  segs.push({ text: cleanSpeech(ex.title || `Раздел ${idx + 1}`), lang: 'ru', pause: PAUSE_TITLE, view: 'title', kind: 'title' });
  const add = (text) => {
    String(text || '').split(/\n\s*\n/).forEach((para) => {
      para.split('\n').map((l) => l.trim()).filter(Boolean).forEach((line, li, lines) => {
        splitPhrases(line, PAUSE_PROSE).forEach((p, n, all) => {
          const last = n === all.length - 1;
          const paraEnd = last && li === lines.length - 1;
          segs.push({ ...p, pause: p.pause + (paraEnd ? PAUSE_PARA : 0), lang: 'ru', view: `s${segs.length}`, kind: 'text', br: paraEnd ? 2 : last ? 1 : 0 });
        });
      });
    });
  };
  const points = Array.isArray(ex.points) ? ex.points : [];
  add(card.ru || points.join('.\n'));
  if (withPoints && card.ru && points.length) {
    segs.push({ text: 'Главное.', lang: 'ru', pause: PAUSE_PROSE.end, view: 'mainhead', kind: 'sub' });
    add(points.map((p) => (/[.!?…]$/.test(p.trim()) ? p : `${p}.`)).join('\n'));
  }
  return segs.filter((x) => x.text && isSpeakable(x.text));
}

// ──── Отрезки кусочка стиха: строка за строкой, паузы по знакам в конце строк ────
function poemSegments(text) {
  const segs = [];
  String(text || '').split('\n').map((l) => l.trim()).filter(Boolean).forEach((line) => {
    splitPhrases(line, PAUSE_VERSE).forEach((p) => segs.push({ ...p, lang: 'ru' }));
  });
  return segs;
}

// ──── Кнопка 🔊 с паузой (Темы → Изучение, Стихи) ────
// Первое нажатие — читать, второе — пауза, третье — продолжить с того же места.
// Нейроголос, если аудио колоды подготовлено в плеере «🎧 Слушать»; иначе голос телефона.
// onState получает 'playing' | 'paused' | 'stopped'.
const Reader = {
  key: '',
  segs: [],
  n: 0,              // голос телефона: номер текущей фразы
  state: 'stopped',
  token: 0,
  el: null,
  url: '',
  mul: 1,
  onState: null,

  isOn() { return this.state !== 'stopped'; },
  is(key) { return this.key === key && this.isOn(); },

  set(state) {
    this.state = state;
    if (this.onState) this.onState(state);
  },

  // повторно привязать кнопку после перерисовки экрана
  bind(key, onState) {
    if (this.key !== key) return;
    this.onState = onState;
    onState(this.state);
  },

  async toggle(key, deckId, segs, onState) {
    if (this.key === key && this.state === 'playing') { this.pause(); return; }
    if (this.key === key && this.state === 'paused') { this.onState = onState; this.resume(); return; }
    this.stop();
    const cfg = Listen.cfg || (Listen.loadCfg(), Listen.cfg);
    this.key = key;
    this.onState = onState;
    this.mul = cfg.speed || 1;
    this.segs = segs.filter((x) => x.text).map((x) => ({ ...x, k: Tts.key(deckId, cfg.voiceRu, x.text) }));
    this.n = 0;
    const tok = ++this.token;
    this.set('playing');
    try { await Tts.load(deckId); } catch (err) { console.warn('tts load', err); }
    if (tok !== this.token) return;
    if (this.segs.length && this.segs.every((x) => Tts.has(x.k))) {
      try {
        const res = await Tts.mix([this.segs.map((x) => ({ k: x.k, pause: x.pause }))]);
        if (tok !== this.token) return;
        this.url = URL.createObjectURL(res.blob);
        this.el = new Audio(this.url);
        this.el.playbackRate = this.mul;
        this.el.onended = () => { if (tok === this.token) this.stop(); };
        await this.el.play();
        return;
      } catch (err) { console.warn('reader audio', err); this.el = null; }
    }
    if (!('speechSynthesis' in window)) { toast('Озвучка не поддерживается браузером'); this.stop(); return; }
    this.speakFrom(tok);
  },

  // старый вызов из «Тем»: заголовок и весь исходный текст раздела
  read(deck, card, idx, onState) {
    return this.toggle(`topic|${card.key}`, deck.id, topicSegments('', card, idx, false), onState);
  },

  speakFrom(tok) {
    if (tok !== this.token) return;
    if (this.n >= this.segs.length) { this.stop(); return; }
    const seg = this.segs[this.n];
    const u = Speech.utter(seg.text, 'ru', this.mul);
    let next = false;
    const go = () => {
      if (next || tok !== this.token) return;
      next = true;
      clearTimeout(guard);
      this.n += 1;
      setTimeout(() => this.speakFrom(tok), seg.pause / this.mul);
    };
    const guard = setTimeout(go, (WATCHDOG_BASE_MS + seg.text.length * WATCHDOG_PER_CHAR_MS) / this.mul);
    u.onend = go;
    u.onerror = go;
    this.utter = u;
    speechSynthesis.speak(u);
  },

  pause() {
    if (this.state !== 'playing') return;
    if (this.el) this.el.pause();
    else { this.token += 1; if ('speechSynthesis' in window) speechSynthesis.cancel(); }
    this.set('paused');
  },

  resume() {
    if (this.state !== 'paused') return;
    this.set('playing');
    if (this.el) { this.el.play().catch((err) => reportError('play', err)); return; }
    const tok = ++this.token;
    this.speakFrom(tok);
  },

  stop() {
    this.token += 1;
    if (this.el) { this.el.pause(); this.el = null; }
    if (this.url) { URL.revokeObjectURL(this.url); this.url = ''; }
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    const cb = this.onState;
    this.onState = null;
    this.key = '';
    this.state = 'stopped';
    if (cb) cb('stopped');
  },
};

// значок кнопки по состоянию: ⏸ — идёт чтение, 🔊 — остановлено или пауза
function speakIcon(btn, state) {
  if (!btn || !btn.isConnected) return;
  btn.classList.toggle('on', state === 'playing');
  btn.classList.toggle('paused', state === 'paused');
  btn.setAttribute('aria-label', state === 'playing' ? 'Пауза' : state === 'paused' ? 'Продолжить' : 'Озвучить');
  if (btn.dataset.icon === 'svg') {
    btn.innerHTML = state === 'playing' ? SVG_PAUSE : SVG_SPEAK;
  } else {
    btn.textContent = state === 'playing' ? '⏸ Пауза' : state === 'paused' ? '▶ Продолжить' : (btn.dataset.idle || '🔊');
  }
}
const SVG_SPEAK = '<svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9zM16 9a4 4 0 010 6M18.5 6.5a8 8 0 010 11"/></svg>';
const SVG_PAUSE = '<svg viewBox="0 0 24 24"><path d="M8 5v14M16 5v14" style="stroke-width:3.2"/></svg>';

// ──── Подготовка текста для синтезатора ────
// Убираем эмодзи и разметку, оставляем знаки препинания — по ним строится интонация.
function cleanSpeech(s) {
  return String(s || '')
    .replace(/\p{Extended_Pictographic}|️|‍/gu, '')
    .replace(/[*_#`>|]+/g, ' ')
    .replace(/^\s*[-•–·]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// пауза после фразы по её последнему знаку препинания
function phrasePause(text, table) {
  const ch = text.replace(/["»”')\]]+$/, '').slice(-1);
  if ('.!?…'.includes(ch)) return table.end;
  if (ch === ',') return table.comma;
  if (';:—–'.includes(ch)) return table.semi;
  return table.none;
}

// Строка → фразы по концам предложений (длинные делим по запятым).
// Граница — знак .!?… и пробел перед заглавной буквой: «т. е. датчик» не режется.
function splitPhrases(line, table) {
  const text = cleanSpeech(line);
  if (!text) return [];
  const raw = text.split(/(?<=[.!?…]["»”')]*)\s+(?=[A-ZА-ЯЁ«"(—–])/u);
  // номер пункта («1.», «2.17.3.»), инициалы («Д.И.») и обрывки без слов приклеиваем к следующей фразе
  const parts = [];
  raw.forEach((p) => {
    const prev = parts[parts.length - 1];
    if (prev !== undefined && isFragment(prev)) parts[parts.length - 1] = `${prev} ${p}`;
    else parts.push(p);
  });
  // висящий хвост («(3)» после формулы) — к предыдущей фразе
  if (parts.length > 1 && isFragment(parts[parts.length - 1])) parts.splice(-2, 2, `${parts[parts.length - 2]} ${parts[parts.length - 1]}`);
  const out = [];
  parts.forEach((p) => splitLong(p).forEach((q) => { if (isSpeakable(q)) out.push({ text: q, pause: phrasePause(q, table) }); }));
  return out;
}

// фраза без единого слова из 3+ букв или оканчивающаяся инициалом — не самостоятельное предложение
const ABBREV_RE = /(^|[\s(«])(им|г|гг|т|п|пп|ст|рис|табл|ул|см|стр|д|др|пр|гл|разд|кв|ед|тыс|млн|руб|т\.е|т\.д|т\.п|т\.к)\.$/iu;
function isFragment(t) {
  return !/[A-Za-zА-Яа-яЁё]{3,}/u.test(t) || /(^|[\s.])[A-ZА-ЯЁ]\.$/u.test(t) || ABBREV_RE.test(t);
}

// есть ли что произносить: хотя бы одна буква или цифра
function isSpeakable(t) {
  return /[A-Za-zА-Яа-яЁё0-9]/u.test(t);
}

function splitLong(text) {
  const out = [];
  let rest = text;
  while (rest.length > MAX_CHUNK) {
    const head = rest.slice(0, MAX_CHUNK);
    const cut = Math.max(head.lastIndexOf(', '), head.lastIndexOf('; '), head.lastIndexOf(': '), head.lastIndexOf(' — '));
    const at = cut > MAX_CHUNK / 3 ? cut + 1 : head.lastIndexOf(' ');
    if (at <= 0) break;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) out.push(rest);
  return out;
}

document.addEventListener('visibilitychange', () => Listen.onVisible());
document.addEventListener('keydown', (e) => Listen.onKey(e));
