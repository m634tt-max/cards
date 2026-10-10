'use strict';
// ──── Константы ────
const APP_VERSION = '1.8.0';
const DECK_FORMAT_VERSION = 1;
const BACKUP_FORMAT_VERSION = 1;
const TOAST_MS = 2600;
const LS_PROFILE = 'fc.profile';
const LS_THEME = 'fc.theme';
const LS_VOICE = 'fc.voice';
const LS_RATE = 'fc.rate';
const DEFAULT_RATE = 0.9;
const IMAGE_EXT = /\.(webp|jpe?g|png|gif|avif)$/i;
const PROFILE_EMOJI = ['🧑', '👨', '👩', '👦', '👧', '🧒', '🐻', '🦊', '🐱', '🐼', '🚀', '⭐'];
const MIME = { webp: 'image/webp', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', avif: 'image/avif' };

// ──── Общее состояние приложения ────
const App = {
  profile: null,
  profiles: [],
  route: { screen: 'today', params: {} },
  imgUrls: new Map(),
};

// ──── Утилиты ────
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const plural = (n, one, few, many) => {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
};
const cardsWord = (n) => `${n} ${plural(n, 'карточка', 'карточки', 'карточек')}`;

function lsGet(key, fallback) { try { const v = localStorage.getItem(key); return v === null ? fallback : v; } catch { return fallback; } }
function lsSet(key, value) { try { localStorage.setItem(key, value); } catch { /* хранилище недоступно */ } }

function slug(s) {
  const t = String(s).toLowerCase().trim().replace(/[^a-zа-яё0-9]+/gi, '-').replace(/^-+|-+$/g, '');
  return t || uid();
}

// ──── Картинки: Blob → адрес для <img> (с кешем) ────
function imgUrl(card) {
  if (!card || !card.image) return '';
  const cached = App.imgUrls.get(card.key);
  if (cached && cached.blob === card.image) return cached.url;
  if (cached) URL.revokeObjectURL(cached.url);
  const url = URL.createObjectURL(card.image);
  App.imgUrls.set(card.key, { blob: card.image, url });
  return url;
}

// ──── Всплывающее сообщение ────
let toastTimer = 0;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, TOAST_MS);
}

function reportError(where, err) {
  console.error(where, err);
  toast(`Ошибка: ${err && err.message ? err.message : err}`);
}

// ──── Модальное окно (закрывается кнопкой «Назад» Android) ────
const Sheet = {
  onClose: null,
  after: null,
  open(html, onClose = null) {
    const wasOpen = this.isOpen();
    $('#toast').hidden = true;   // всплывающее сообщение не должно закрывать окно
    $('#sheet').onclick = null;
    $('#sheet').innerHTML = html;
    $('#sheet').scrollTop = 0;
    $('#sheetBackdrop').hidden = false;
    this.onClose = onClose;
    // повторное открытие поверх открытого окна не добавляет запись в историю
    if (!wasOpen) history.pushState({ sheet: true, route: App.route }, '');
  },
  close(fromPop = false) {
    if ($('#sheetBackdrop').hidden) return;
    $('#sheetBackdrop').hidden = true;
    $('#sheet').innerHTML = '';
    const cb = this.onClose;
    this.onClose = null;
    if (!fromPop) history.back();
    if (cb) cb();
  },
  isOpen() { return !$('#sheetBackdrop').hidden; },
};

function confirmSheet(title, text, okLabel, danger = false) {
  return new Promise((resolve) => {
    let result = false;
    Sheet.open(`
      <h3>${esc(title)}</h3><p class="subtitle">${esc(text)}</p>
      <div class="btn-row">
        <button class="btn" data-act="no">Отмена</button>
        <button class="btn ${danger ? 'danger' : 'primary'}" data-act="yes">${esc(okLabel)}</button>
      </div>`, () => resolve(result));
    $('#sheet').onclick = (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (!act) return;
      result = act === 'yes';
      Sheet.close();
    };
  });
}

// ──── Выбор файла ────
function pickFile(accept) {
  return new Promise((resolve) => {
    const input = $('#fileInput');
    input.value = '';
    input.accept = accept;
    input.onchange = () => resolve(input.files[0] || null);
    input.click();
  });
}

// ──── Скачивание файла ────
function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

// ──── Тема ────
function applyTheme() {
  const t = lsGet(LS_THEME, 'auto');
  if (t === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
}

// ──── Озвучка английского ────
const Speech = {
  voices: [],
  ruVoices: [],
  init() {
    if (!('speechSynthesis' in window)) return;
    const load = () => {
      const all = speechSynthesis.getVoices();
      this.voices = all.filter((v) => /^en[-_]/i.test(v.lang));
      this.ruVoices = all.filter((v) => /^ru[-_]/i.test(v.lang));
    };
    load();
    speechSynthesis.addEventListener('voiceschanged', load);
  },
  pick() {
    const saved = lsGet(LS_VOICE, '');
    return this.voices.find((v) => v.voiceURI === saved)
      || this.voices.find((v) => /en[-_]US/i.test(v.lang) && /google/i.test(v.name))
      || this.voices.find((v) => /en[-_](US|GB)/i.test(v.lang))
      || this.voices[0] || null;
  },
  pickRu() { return this.ruVoices.find((x) => /google/i.test(x.name)) || this.ruVoices[0] || null; },
  // фраза с нужным голосом: lang 'en' или 'ru', rateMul — множитель к скорости из «Ещё»
  utter(text, lang = 'en', rateMul = 1) {
    const u = new SpeechSynthesisUtterance(text);
    const v = lang === 'ru' ? this.pickRu() : this.pick();
    if (v) u.voice = v;
    u.lang = v ? v.lang : (lang === 'ru' ? 'ru-RU' : 'en-US');
    u.rate = (Number(lsGet(LS_RATE, DEFAULT_RATE)) || DEFAULT_RATE) * rateMul;
    return u;
  },
  say(text) {
    if (!('speechSynthesis' in window)) { toast('Озвучка не поддерживается браузером'); return; }
    speechSynthesis.cancel();
    speechSynthesis.speak(this.utter(text, 'en'));
  },
  // ──── Русская речь (для стихов и тем) ────
  sayRu(text) {
    if (!('speechSynthesis' in window)) { toast('Озвучка не поддерживается браузером'); return; }
    speechSynthesis.cancel();
    speechSynthesis.speak(this.utter(text, 'ru'));
  },
};

// ──── Профили ────
async function loadProfiles() {
  App.profiles = (await DB.all('profiles')).sort((a, b) => a.createdAt - b.createdAt);
  if (App.profiles.length === 0) {
    const p = { id: uid(), name: 'Я', emoji: '🧑', kid: false, reverse: false, autoSpeak: false, streak: 0, lastDay: '', createdAt: Date.now() };
    await DB.put('profiles', p);
    App.profiles = [p];
  }
  const savedId = lsGet(LS_PROFILE, '');
  App.profile = App.profiles.find((p) => p.id === savedId) || App.profiles[0];
  applyProfile();
}

function applyProfile() {
  lsSet(LS_PROFILE, App.profile.id);
  document.body.classList.toggle('kid', !!App.profile.kid);
  $('#btnProfile').innerHTML = `<span class="emo">${esc(App.profile.emoji)}</span>${esc(App.profile.name)}`;
}

async function saveProfile(p) {
  await DB.put('profiles', p);
  await loadProfiles();
}

// ──── Отметка о занятии сегодня (серия дней) ────
async function touchStreak() {
  const p = App.profile;
  const today = new Date().toLocaleDateString('sv');
  if (p.lastDay === today) return;
  const y = new Date(Date.now() - 864e5).toLocaleDateString('sv');
  p.streak = p.lastDay === y ? (p.streak || 0) + 1 : 1;
  p.lastDay = today;
  await DB.put('profiles', p);
}

function currentStreak(p) {
  const today = new Date().toLocaleDateString('sv');
  const y = new Date(Date.now() - 864e5).toLocaleDateString('sv');
  return p.lastDay === today || p.lastDay === y ? p.streak || 0 : 0;
}

// ──── Сводка по колоде для текущего профиля ────
async function deckSummary(deck) {
  const recs = await DB.byIndex('progress', 'profileDeck', [App.profile.id, deck.id]);
  const now = Date.now();
  let due = 0, learned = 0, seen = 0;
  recs.forEach((r) => {
    if (r.last > 0) seen += 1;
    if (SRS.isDue(r, now)) due += 1;
    if (SRS.status(r) === 'learned') learned += 1;
  });
  return { due, learned, fresh: Math.max(0, deck.cardCount - seen), total: deck.cardCount };
}

// Колоды слов (стихи хранятся там же, но показываются в своём разделе)
async function loadDecks() {
  return (await DB.all('decks')).filter((d) => !['poem', 'topic'].includes(d.type)).sort((a, b) => b.createdAt - a.createdAt);
}

async function loadPoems() {
  return (await DB.all('decks')).filter((d) => d.type === 'poem').sort((a, b) => b.createdAt - a.createdAt);
}

async function deckCover(deck) {
  const card = deck.coverKey ? await DB.get('cards', deck.coverKey) : null;
  return imgUrl(card);
}

// ──── Навигация ────
const TAB_TITLES = { today: 'Учить', library: 'Колоды', topics: 'Темы', poems: 'Стихи', more: 'Ещё' };

function navigate(screen, params = {}, push = true) {
  App.route = { screen, params };
  if (push) history.pushState({ route: App.route }, '');
  render();
}

function switchTab(tab) {
  App.route = { screen: tab, params: {} };
  history.replaceState({ route: App.route }, '');
  render();
}

window.addEventListener('popstate', (e) => {
  if (Sheet.isOpen()) { Sheet.close(true); return; }
  if (typeof Study !== 'undefined' && Study.active) Study.stop();
  const route = e.state && e.state.route ? e.state.route : { screen: 'today', params: {} };
  App.route = route;
  // действие, запланированное на момент закрытия окна (например, переход на вкладку)
  if (Sheet.after) { const fn = Sheet.after; Sheet.after = null; fn(); return; }
  render();
});

// ──── Хранилище занято старой копией приложения ────
function showDbBlocked() {
  App.dbBlocked = true;
  $('#view').innerHTML = `<div class="empty"><div class="big">⏳</div>
    <p><b>Обновляю хранилище до новой версии</b></p>
    <p class="subtitle">Мешает другая открытая копия приложения. Закройте её:<br>
      • смахните «Карточки» из списка недавних приложений;<br>
      • закройте вкладки Chrome с адресом приложения.<br>
      Затем откройте приложение снова. Колоды и прогресс не пострадают.</p></div>`;
}

async function render() {
  const { screen, params } = App.route;
  // пока не загружен профиль (хранилище открывается или занято), экраны не рисуем
  if (!App.profile) {
    if (!App.dbBlocked) $('#view').innerHTML = '<div class="empty"><div class="big">⏳</div><p>Загрузка…</p></div>';
    return;
  }
  const isTab = screen in TAB_TITLES;
  if (typeof Listen !== 'undefined' && Listen.active && screen !== 'listen') Listen.stop();
  if (typeof Reader !== 'undefined' && Reader.isOn()) Reader.stop();
  document.body.classList.toggle('studying', ['study', 'poemMode', 'topicMode', 'listen'].includes(screen));
  $('#btnBack').hidden = isTab;
  $('#btnProfile').hidden = screen === 'study';
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === screen));
  $('#topTitle').textContent = isTab ? TAB_TITLES[screen] : '';
  window.scrollTo(0, 0);
  try {
    if (screen === 'today') await Screens.today();
    else if (screen === 'library') await Screens.library();
    else if (screen === 'more') await Screens.more();
    else if (screen === 'deck') await Screens.deck(params.deckId);
    else if (screen === 'study') await Study.start(params);
    else if (screen === 'reminders') await Reminders.screen();
    else if (screen === 'images') await ImageWizard.screen(params.deckId);
    else if (screen === 'poems') await Poems.list();
    else if (screen === 'poem') await Poems.screen(params.deckId);
    else if (screen === 'poemMode') await Poems.mode(params);
    else if (screen === 'topics') await Topics.list();
    else if (screen === 'topic') await Topics.screen(params.deckId);
    else if (screen === 'topicMode') await Topics.mode(params);
    else if (screen === 'listen') await Listen.screen(params);
  } catch (err) { reportError('render', err); }
}

// ──── Универсальный горизонтальный свайп (для стихов и тем) ────
const SWIPE_MIN_PX = 70;
const SWIPE_MAX_SLOPE = 0.6;   // свайп должен быть скорее горизонтальным
function attachSwipe(el, onNext, onPrev) {
  let x0 = 0, y0 = 0, active = false;
  el.addEventListener('touchstart', (e) => { const t = e.touches[0]; x0 = t.clientX; y0 = t.clientY; active = true; }, { passive: true });
  el.addEventListener('touchend', (e) => {
    if (!active) return;
    active = false;
    const t = e.changedTouches[0];
    const dx = t.clientX - x0, dy = t.clientY - y0;
    if (Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dy) > Math.abs(dx) * SWIPE_MAX_SLOPE) return;
    if (dx < 0) onNext(); else onPrev();
  }, { passive: true });
}
