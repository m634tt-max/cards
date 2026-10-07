'use strict';
// ──── Режим изучения: карточки, переворот, свайпы, оценки ────

const NEW_PER_SESSION = 20;      // сколько новых карточек за одно занятие
const REINSERT_GAP = 3;          // через сколько карточек повторить забытую
const SWIPE_PX = 90;             // порог свайпа
const TAP_PX = 10;               // смещение, до которого жест считается нажатием
const FLY_MS = 220;              // анимация улёта карточки
const SWIPE_ROTATE_DIV = 18;     // наклон карточки при перетаскивании

const Study = {
  active: false,
  mode: 'srs',
  queue: [],
  pos: 0,
  flipped: false,
  recs: new Map(),
  stats: { good: 0, hard: 0, bad: 0 },
  deckIds: [],
  busy: false,

  // ──── Подготовка занятия ────
  async start({ deckIds, mode }) {
    this.active = true;
    this.mode = mode;
    this.deckIds = deckIds;
    this.pos = 0;
    this.stats = { good: 0, hard: 0, bad: 0 };
    const decks = await Promise.all(deckIds.map((id) => DB.get('decks', id)));
    $('#topTitle').textContent = deckIds.length === 1 && decks[0] ? decks[0].title : 'Все колоды';
    const cards = (await Promise.all(deckIds.map((id) => DB.byIndex('cards', 'deckId', id)))).flat();
    const recs = (await Promise.all(deckIds.map((id) => DB.byIndex('progress', 'profileDeck', [App.profile.id, id])))).flat();
    this.recs = new Map(recs.map((r) => [r.cardKey, r]));
    this.queue = mode === 'browse' ? this.browseQueue(cards) : this.srsQueue(cards);
    this.bindKeys();
    this.show();
  },

  srsQueue(cards) {
    const now = Date.now();
    const due = cards.filter((c) => SRS.isDue(this.recs.get(c.key), now))
      .sort((a, b) => this.recs.get(a.key).due - this.recs.get(b.key).due);
    const fresh = cards.filter((c) => SRS.status(this.recs.get(c.key)) === 'new')
      .sort((a, b) => a.deckId.localeCompare(b.deckId) || a.idx - b.idx)
      .slice(0, NEW_PER_SESSION);
    return [...shuffle(due), ...fresh];
  },

  browseQueue(cards) {
    return cards.sort((a, b) => a.deckId.localeCompare(b.deckId) || a.idx - b.idx);
  },

  stop() {
    this.active = false;
    if ('speechSynthesis' in window) speechSynthesis.cancel();
  },

  // ──── Отрисовка текущей карточки ────
  show() {
    const view = $('#view');
    if (this.pos >= this.queue.length) { this.showDone(); return; }
    this.flipped = false;
    const c = this.queue[this.pos];
    const p = App.profile;
    const url = imgUrl(c);
    const frontText = p.reverse ? c.en : c.ru;
    const pct = Math.round((this.pos / this.queue.length) * 100);
    view.innerHTML = `
      <div class="study-head">
        <div class="bar"><i style="width:${pct}%"></i></div>
        <div class="study-count">${this.pos + 1} / ${this.queue.length}</div>
      </div>
      <div class="stage" id="stage">
        <div class="swipe-tag left" id="tagL">${this.mode === 'browse' ? 'ДАЛЬШЕ' : 'НЕ ЗНАЮ'}</div>
        <div class="swipe-tag right" id="tagR">${this.mode === 'browse' ? 'НАЗАД' : 'ЗНАЮ'}</div>
        <div class="card3d" id="card">
          <div class="face front">
            <div class="pic ${url ? '' : 'noimg'}" style="background-image:url('${url}')"></div>
            <div class="caption">${esc(frontText)}</div>
            ${this.pos === 0 ? '<div class="tap-hint">нажмите, чтобы перевернуть</div>' : ''}
          </div>
          <div class="face back">
            <div class="mini ${url ? '' : 'noimg'}" style="background-image:url('${url}')"></div>
            <div class="en">${esc(c.en)}</div>
            <div class="ru">${esc(c.ru)}</div>
            <button class="speak" id="btnSpeak" aria-label="Озвучить">
              <svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9zM16 9a4 4 0 010 6M18.5 6.5a8 8 0 010 11"/></svg></button>
          </div>
        </div>
      </div>
      <div id="controls"></div>`;
    this.renderControls();
    this.bindGestures($('#card'));
    $('#btnSpeak').onclick = (e) => { e.stopPropagation(); Speech.say(c.en); };
  },

  // ──── Кнопки под карточкой ────
  renderControls() {
    const box = $('#controls');
    if (this.mode === 'browse') {
      box.innerHTML = `<div class="study-nav">
        <button class="btn" id="btnPrev" ${this.pos === 0 ? 'disabled' : ''}>← Назад</button>
        <button class="btn primary" id="btnNext">Дальше →</button></div>`;
      $('#btnPrev').onclick = () => this.step(-1);
      $('#btnNext').onclick = () => this.step(1);
      return;
    }
    if (!this.flipped) {
      box.innerHTML = '<div class="study-nav"><button class="btn primary" id="btnFlip">Показать ответ</button></div>';
      $('#btnFlip').onclick = () => this.flip();
      return;
    }
    const rec = this.recs.get(this.queue[this.pos].key) || SRS.fresh(App.profile.id, this.queue[this.pos]);
    const G = SRS.GRADE;
    const hard = App.profile.kid ? '' : `<button class="btn hard" data-g="${G.HARD}">Трудно<small>${SRS.preview(rec, G.HARD)}</small></button>`;
    box.innerHTML = `<div class="grade ${App.profile.kid ? 'two' : ''}">
      <button class="btn bad" data-g="${G.BAD}">Не знаю<small>${SRS.preview(rec, G.BAD)}</small></button>
      ${hard}
      <button class="btn good" data-g="${G.GOOD}">Знаю<small>${SRS.preview(rec, G.GOOD)}</small></button></div>`;
    box.querySelectorAll('[data-g]').forEach((b) => { b.onclick = () => this.grade(Number(b.dataset.g)); });
  },

  flip() {
    this.flipped = !this.flipped;
    $('#card').classList.toggle('flipped', this.flipped);
    if (this.flipped && App.profile.autoSpeak) Speech.say(this.queue[this.pos].en);
    if (this.mode === 'srs') this.renderControls();
  },

  // ──── Оценка ответа и переход к следующей карточке ────
  async grade(g, dir = 0) {
    if (this.busy || !this.flipped) return;
    this.busy = true;
    try {
      const c = this.queue[this.pos];
      const rec = SRS.review(this.recs.get(c.key) || SRS.fresh(App.profile.id, c), g);
      this.recs.set(c.key, rec);
      await DB.put('progress', rec);
      await touchStreak();
      const G = SRS.GRADE;
      if (g === G.BAD) {
        this.stats.bad += 1;
        this.queue.splice(Math.min(this.queue.length, this.pos + 1 + REINSERT_GAP), 0, c);
      } else if (g === G.HARD) this.stats.hard += 1;
      else this.stats.good += 1;
      await this.flyOut(dir || (g === G.BAD ? -1 : 1));
      this.pos += 1;
      this.show();
    } catch (err) { reportError('grade', err); } finally { this.busy = false; }
  },

  async step(delta) {
    if (this.busy) return;
    const next = this.pos + delta;
    if (next < 0) return;
    this.busy = true;
    await this.flyOut(delta > 0 ? -1 : 1);
    this.busy = false;
    this.pos = next;
    this.show();
  },

  flyOut(dir) {
    return new Promise((resolve) => {
      const card = $('#card');
      if (!card) { resolve(); return; }
      card.classList.remove('dragging');
      card.style.transition = `transform ${FLY_MS}ms ease-in, opacity ${FLY_MS}ms`;
      card.style.transform = `translateX(${dir * 130}%) rotate(${dir * 14}deg)${this.flipped ? ' rotateY(180deg)' : ''}`;
      card.style.opacity = '0';
      setTimeout(resolve, FLY_MS);
    });
  },

  // ──── Жесты: нажатие = переворот, свайп = оценка / листание ────
  bindGestures(card) {
    let x0 = 0, y0 = 0, dx = 0, down = false, moved = false;
    const flipT = () => (this.flipped ? ' rotateY(180deg)' : '');
    const canSwipe = () => this.mode === 'browse' || this.flipped;
    card.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.speak')) return;
      down = true; moved = false; x0 = e.clientX; y0 = e.clientY; dx = 0;
      card.setPointerCapture(e.pointerId);
    });
    card.addEventListener('pointermove', (e) => {
      if (!down) return;
      dx = e.clientX - x0;
      if (!moved && Math.abs(dx) < TAP_PX && Math.abs(e.clientY - y0) < TAP_PX) return;
      moved = true;
      if (!canSwipe()) return;
      card.classList.add('dragging');
      card.style.transform = `translateX(${dx}px) rotate(${dx / SWIPE_ROTATE_DIV}deg)${flipT()}`;
      const k = Math.min(1, Math.abs(dx) / SWIPE_PX);
      $('#tagL').style.opacity = dx < 0 ? k : 0;
      $('#tagR').style.opacity = dx > 0 ? k : 0;
    });
    const end = () => {
      if (!down) return;
      down = false;
      card.classList.remove('dragging');
      $('#tagL').style.opacity = 0; $('#tagR').style.opacity = 0;
      if (!moved) { this.flip(); return; }
      if (canSwipe() && Math.abs(dx) >= SWIPE_PX) { this.onSwipe(dx > 0 ? 1 : -1); return; }
      card.style.transform = '';  // вернуть управление классу .flipped
    };
    card.addEventListener('pointerup', end);
    card.addEventListener('pointercancel', end);
  },

  onSwipe(dir) {
    if (this.mode === 'browse') {
      if (dir < 0) this.step(1);
      else if (this.pos > 0) this.step(-1);
      else this.show();
      return;
    }
    this.grade(dir > 0 ? SRS.GRADE.GOOD : SRS.GRADE.BAD, dir);
  },

  // ──── Клавиатура (для проверки на ПК) ────
  bindKeys() {
    if (this.keysBound) return;
    this.keysBound = true;
    document.addEventListener('keydown', (e) => {
      if (!this.active || Sheet.isOpen() || !$('#card')) return;
      const k = e.key;
      if (k === ' ' || k === 'Enter') { e.preventDefault(); this.flip(); }
      else if (this.mode === 'browse' && k === 'ArrowRight') this.step(1);
      else if (this.mode === 'browse' && k === 'ArrowLeft') this.step(-1);
      else if (this.mode === 'srs' && ['1', '2', '3'].includes(k)) {
        const map = { 1: SRS.GRADE.BAD, 2: SRS.GRADE.HARD, 3: SRS.GRADE.GOOD };
        this.grade(map[k]);
      } else if (k === 's') Speech.say(this.queue[this.pos].en);
    });
  },

  // ──── Итог занятия ────
  showDone() {
    const s = this.stats;
    const empty = this.queue.length === 0;
    const browse = this.mode === 'browse';
    $('#view').innerHTML = `
      <div class="done">
        <div class="big">${empty ? '😌' : '🎉'}</div>
        <h2>${empty ? 'На сегодня всё' : browse ? 'Просмотр окончен' : 'Занятие окончено!'}</h2>
        <p class="subtitle">${empty ? 'Новых карточек и повторений нет. Загляните завтра.'
          : browse ? `Просмотрено: ${cardsWord(this.queue.length)}`
          : `✅ знаю: ${s.good} · 🟡 трудно: ${s.hard} · ❌ не знаю: ${s.bad}`}</p>
        <div class="btn-row">
          ${browse && !empty ? '<button class="btn" id="btnAgain">Ещё раз</button>' : ''}
          <button class="btn primary" id="btnFinish">Готово</button></div>
      </div>`;
    $('#btnFinish').onclick = () => history.back();
    const again = $('#btnAgain');
    if (again) again.onclick = () => { this.pos = 0; this.show(); };
  },
};

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
