'use strict';
// ──── Режим изучения: карточки, переворот, листание свайпами ────

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
  seen: new Set(),      // позиции, где карточку перевернули
  graded: new Set(),    // позиции, по которым ответ уже учтён
  again: new Set(),     // позиции, отмеченные «🔁 Повторить»
  deckIds: [],
  busy: false,

  // ──── Подготовка занятия ────
  async start({ deckIds, mode }) {
    this.active = true;
    this.mode = mode;
    this.deckIds = deckIds;
    this.pos = 0;
    this.stats = { good: 0, hard: 0, bad: 0 };
    this.seen = new Set(); this.graded = new Set(); this.again = new Set();
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
  // Управление: нажатие — перевернуть; свайп влево — следующая; свайп вправо — предыдущая.
  // В режиме «Учить» карточка, которую перевернули и пролистали дальше, засчитывается как «знаю»;
  // если на обороте нажать «🔁 Повторить» — как «не знаю» (вернётся в этом же занятии и раньше по расписанию).
  show() {
    const view = $('#view');
    if (this.pos >= this.queue.length) { this.showDone(); return; }
    this.flipped = false;
    const c = this.queue[this.pos];
    const url = imgUrl(c);
    const frontText = App.profile.reverse ? c.en : c.ru;
    const pct = Math.round((this.pos / this.queue.length) * 100);
    const srs = this.mode === 'srs';
    const again = this.again.has(this.slotKey());
    view.innerHTML = `
      <div class="study-head">
        <div class="bar"><i style="width:${pct}%"></i></div>
        <div class="study-count">${this.pos + 1} / ${this.queue.length}</div>
      </div>
      <div class="stage" id="stage">
        <div class="swipe-tag left" id="tagL">ДАЛЬШЕ</div>
        <div class="swipe-tag right" id="tagR">НАЗАД</div>
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
            <div class="back-actions">
              ${srs ? `<button class="again-btn ${again ? 'on' : ''}" id="btnAgain" aria-label="Повторить ещё раз">🔁 ${again ? 'Повторю' : 'Повторить'}</button>` : ''}
              <button class="speak" id="btnSpeak" aria-label="Озвучить">
                <svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9zM16 9a4 4 0 010 6M18.5 6.5a8 8 0 010 11"/></svg></button>
            </div>
          </div>
        </div>
      </div>
      <p class="swipe-help">← свайп — следующая · свайп → — предыдущая · нажатие — перевернуть</p>`;
    this.bindGestures($('#card'));
    $('#btnSpeak').onclick = (e) => { e.stopPropagation(); Speech.say(c.en); };
    const ag = $('#btnAgain');
    if (ag) ag.onclick = (e) => {
      e.stopPropagation();
      const k = this.slotKey();
      if (this.again.has(k)) this.again.delete(k); else this.again.add(k);
      ag.classList.toggle('on', this.again.has(k));
      ag.textContent = `🔁 ${this.again.has(k) ? 'Повторю' : 'Повторить'}`;
    };
  },

  // ключ позиции в очереди (одна и та же карточка может встретиться дважды)
  slotKey() { return `${this.pos}|${this.queue[this.pos] ? this.queue[this.pos].key : ''}`; },

  flip() {
    this.flipped = !this.flipped;
    $('#card').classList.toggle('flipped', this.flipped);
    if (this.flipped) this.seen.add(this.slotKey());
    if (this.flipped && App.profile.autoSpeak) Speech.say(this.queue[this.pos].en);
  },

  // ──── Учёт ответа при уходе с карточки вперёд ────
  async record() {
    if (this.mode !== 'srs') return;
    const k = this.slotKey();
    if (!this.seen.has(k) || this.graded.has(k)) return;
    this.graded.add(k);
    const c = this.queue[this.pos];
    const G = SRS.GRADE;
    const g = this.again.has(k) ? G.BAD : G.GOOD;
    const rec = SRS.review(this.recs.get(c.key) || SRS.fresh(App.profile.id, c), g);
    this.recs.set(c.key, rec);
    await DB.put('progress', rec);
    await touchStreak();
    if (g === G.BAD) {
      this.stats.bad += 1;
      this.queue.splice(Math.min(this.queue.length, this.pos + 1 + REINSERT_GAP), 0, c);
    } else this.stats.good += 1;
  },

  async step(delta) {
    if (this.busy) return;
    const next = this.pos + delta;
    if (next < 0) { this.bounce(); return; }
    this.busy = true;
    try {
      if (delta > 0) await this.record();
      await this.flyOut(delta > 0 ? -1 : 1);
      this.pos = next;
      this.show();
    } catch (err) { reportError('step', err); } finally { this.busy = false; }
  },

  bounce() {
    const card = $('#card');
    if (card) card.style.transform = '';
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

  // ──── Жесты: нажатие = переворот, свайп = листание ────
  bindGestures(card) {
    let x0 = 0, y0 = 0, dx = 0, down = false, moved = false;
    const flipT = () => (this.flipped ? ' rotateY(180deg)' : '');
    card.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.speak, .again-btn')) return;
      down = true; moved = false; x0 = e.clientX; y0 = e.clientY; dx = 0;
      card.setPointerCapture(e.pointerId);
    });
    card.addEventListener('pointermove', (e) => {
      if (!down) return;
      dx = e.clientX - x0;
      if (!moved && Math.abs(dx) < TAP_PX && Math.abs(e.clientY - y0) < TAP_PX) return;
      moved = true;
      card.classList.add('dragging');
      card.style.transform = `translateX(${dx}px) rotate(${dx / SWIPE_ROTATE_DIV}deg)${flipT()}`;
      const k = Math.min(1, Math.abs(dx) / SWIPE_PX);
      $('#tagL').style.opacity = dx < 0 ? k : 0;
      $('#tagR').style.opacity = dx > 0 && this.pos > 0 ? k : 0;
    });
    const end = () => {
      if (!down) return;
      down = false;
      card.classList.remove('dragging');
      $('#tagL').style.opacity = 0; $('#tagR').style.opacity = 0;
      if (!moved) { this.flip(); return; }
      if (Math.abs(dx) >= SWIPE_PX) { this.step(dx < 0 ? 1 : -1); return; }
      card.style.transform = '';  // вернуть управление классу .flipped
    };
    card.addEventListener('pointerup', end);
    card.addEventListener('pointercancel', end);
  },

  // ──── Клавиатура (для проверки на ПК) ────
  bindKeys() {
    if (this.keysBound) return;
    this.keysBound = true;
    document.addEventListener('keydown', (e) => {
      if (!this.active || Sheet.isOpen() || !$('#card')) return;
      const k = e.key;
      if (k === ' ' || k === 'Enter') { e.preventDefault(); this.flip(); }
      else if (k === 'ArrowRight') this.step(1);
      else if (k === 'ArrowLeft') this.step(-1);
      else if (k === 's') Speech.say(this.queue[this.pos].en);
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
          : `✅ запомнил: ${s.good} · 🔁 на повтор: ${s.bad}`}</p>
        <div class="btn-row">
          ${!empty ? '<button class="btn" id="btnBackCards">← К карточкам</button>' : ''}
          <button class="btn primary" id="btnFinish">Готово</button></div>
      </div>`;
    $('#btnFinish').onclick = () => history.back();
    const back = $('#btnBackCards');
    if (back) back.onclick = () => { this.pos = this.queue.length - 1; this.show(); };
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
