'use strict';
// ──── Напоминания: push-уведомления через свой сервер (Cloudflare Worker) ────
// Настройки хранятся в телефоне (localStorage), расписание дублируется на сервер.

const LS_PUSH = 'fc.push';
const DAY_NAMES = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];   // 1 = Пн … 7 = Вс
const ALL_DAYS = [1, 2, 3, 4, 5, 6, 7];
const WORK_DAYS = [1, 2, 3, 4, 5];
const DEFAULT_TIME = '19:00';
const DEFAULT_SERVER_URL = 'https://cards-push.m634tt.workers.dev';   // свой сервер напоминаний
const MAX_REMINDERS_UI = 10;

const Reminders = {

  // ──── Настройки ────
  load() {
    let cfg = {};
    try { cfg = JSON.parse(lsGet(LS_PUSH, '{}')) || {}; } catch { cfg = {}; }
    return {
      url: cfg.url || DEFAULT_SERVER_URL,
      deviceId: cfg.deviceId || uid(),
      serverKey: cfg.serverKey || '',
      enabled: !!cfg.enabled,
      reminders: Array.isArray(cfg.reminders) ? cfg.reminders : [],
    };
  },
  save(cfg) { lsSet(LS_PUSH, JSON.stringify(cfg)); },

  summary() {
    const cfg = this.load();
    if (!cfg.enabled) return 'Выключены';
    const on = cfg.reminders.filter((r) => r.on !== false);
    if (!on.length) return 'Нет активных напоминаний';
    return on.map((r) => `${r.time} · ${this.daysLabel(r.days)}`).join('; ');
  },

  daysLabel(days) {
    const d = [...days].sort();
    if (d.length === 7) return 'каждый день';
    if (d.join() === WORK_DAYS.join()) return 'будни';
    if (d.join() === '6,7') return 'выходные';
    return d.map((x) => DAY_NAMES[x - 1]).join(', ');
  },

  supported() {
    return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  },

  // ──── Запрос к серверу ────
  async api(cfg, path, body) {
    const base = cfg.url.replace(/\/+$/, '');
    const res = await fetch(base + path, body ? {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    } : undefined);
    let data = {};
    try { data = await res.json(); } catch { /* ответ не JSON */ }
    if (!res.ok) throw new Error(data.error || `Сервер ответил ${res.status}`);
    return data;
  },

  // ──── Подписка телефона на push ────
  async subscribe(cfg) {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') throw new Error('Уведомления запрещены. Разрешите их в настройках Chrome для этого сайта.');
    const { publicKey } = await this.api(cfg, '/key');
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (sub && cfg.serverKey && cfg.serverKey !== publicKey) { await sub.unsubscribe(); sub = null; }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(publicKey) });
    cfg.serverKey = publicKey;
    await this.api(cfg, '/subscribe', {
      id: cfg.deviceId,
      subscription: sub.toJSON(),
      reminders: cfg.reminders,
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone || '',
      offsetMin: -new Date().getTimezoneOffset(),
    });
  },

  async disable(cfg) {
    if (cfg.url) await this.api(cfg, '/unsubscribe', { id: cfg.deviceId }).catch((e) => console.warn(e));
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) await sub.unsubscribe();
  },

  // ──── Экран настроек ────
  async screen() {
    $('#topTitle').textContent = 'Напоминания';
    const cfg = this.load();
    if (!cfg.reminders.length) cfg.reminders.push({ time: DEFAULT_TIME, days: [...ALL_DAYS], on: true });
    this.draw(cfg);
  },

  draw(cfg, status = '') {
    const view = $('#view');
    const warn = this.supported() ? ''
      : '<div class="panel" style="padding:14px 16px;margin-bottom:12px">⚠️ Этот браузер не поддерживает push-уведомления. Откройте приложение, установленное из Chrome.</div>';
    const items = cfg.reminders.map((r, i) => `
      <div class="panel rem" data-i="${i}">
        <div class="rem-top">
          <input type="time" class="rem-time" value="${esc(r.time)}" data-f="time">
          <label class="switch"><input type="checkbox" data-f="on" ${r.on !== false ? 'checked' : ''}><span></span></label>
          <button class="icon-btn" data-del aria-label="Удалить"><svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V5h4v2M7 7l1 13h8l1-13"/></svg></button>
        </div>
        <div class="day-chips">${DAY_NAMES.map((n, k) => `<button class="chip ${r.days.includes(k + 1) ? 'on' : ''}" data-day="${k + 1}">${n}</button>`).join('')}</div>
        <div class="day-quick"><button data-q="all">Каждый день</button><button data-q="work">Будни</button><button data-q="weekend">Выходные</button></div>
      </div>`).join('');
    view.innerHTML = `${warn}
      <p class="subtitle">Уведомление придёт в шторку в выбранное время, даже если приложение закрыто.</p>
      ${items}
      ${cfg.reminders.length < MAX_REMINDERS_UI ? `<button class="btn block" id="btnAddRem">${PLUS} Добавить время</button>` : ''}
      <div class="btn-row">
        <button class="btn primary" id="btnSaveRem">${cfg.enabled ? 'Сохранить' : 'Включить напоминания'}</button>
      </div>
      <div class="btn-row">
        <button class="btn" id="btnTestRem" ${cfg.enabled ? '' : 'disabled'}>🔔 Проверить</button>
        <button class="btn danger" id="btnOffRem" ${cfg.enabled ? '' : 'disabled'}>Выключить</button>
      </div>
      <p class="subtitle" id="remStatus">${esc(status || (cfg.enabled ? '✅ Напоминания включены' : 'Напоминания выключены'))}</p>
      <div class="section-title">Сервер</div>
      <label class="field"><span>Адрес сервера напоминаний (Cloudflare Worker)</span>
        <input id="remUrl" type="url" inputmode="url" placeholder="https://cards-push.ВАШ-ЛОГИН.workers.dev" value="${esc(cfg.url)}"></label>`;
    this.bind(cfg);
  },

  // ──── Обработчики экрана ────
  bind(cfg) {
    const view = $('#view');
    const setStatus = (t) => { $('#remStatus').textContent = t; };
    view.querySelectorAll('.rem').forEach((box) => {
      const r = cfg.reminders[Number(box.dataset.i)];
      box.querySelector('[data-f="time"]').onchange = (e) => { r.time = e.target.value || DEFAULT_TIME; };
      box.querySelector('[data-f="on"]').onchange = (e) => { r.on = e.target.checked; };
      box.querySelector('[data-del]').onclick = () => { cfg.reminders.splice(Number(box.dataset.i), 1); this.draw(cfg); };
      box.querySelectorAll('[data-day]').forEach((c) => {
        c.onclick = () => {
          const d = Number(c.dataset.day);
          r.days = r.days.includes(d) ? r.days.filter((x) => x !== d) : [...r.days, d].sort();
          c.classList.toggle('on', r.days.includes(d));
        };
      });
      box.querySelectorAll('[data-q]').forEach((q) => {
        q.onclick = () => {
          r.days = { all: [...ALL_DAYS], work: [...WORK_DAYS], weekend: [6, 7] }[q.dataset.q];
          box.querySelectorAll('[data-day]').forEach((c) => c.classList.toggle('on', r.days.includes(Number(c.dataset.day))));
        };
      });
    });
    const add = $('#btnAddRem');
    if (add) add.onclick = () => { cfg.reminders.push({ time: DEFAULT_TIME, days: [...ALL_DAYS], on: true }); this.draw(cfg); };

    $('#btnSaveRem').onclick = async () => {
      cfg.url = $('#remUrl').value.trim();
      if (!/^https:\/\//.test(cfg.url)) { setStatus('Укажите адрес сервера (начинается с https://)'); $('#remUrl').focus(); return; }
      const empty = cfg.reminders.find((r) => r.on !== false && r.days.length === 0);
      if (empty) { setStatus(`У напоминания на ${empty.time} не выбраны дни`); return; }
      setStatus('Подключаюсь…');
      try {
        await this.subscribe(cfg);
        cfg.enabled = true;
        this.save(cfg);
        this.draw(cfg, `✅ Сохранено: ${this.summary()}`);
      } catch (err) { console.error(err); setStatus(`Ошибка: ${err.message || err}`); }
    };
    $('#btnTestRem').onclick = async () => {
      setStatus('Отправляю…');
      try { await this.api(cfg, '/test', { id: cfg.deviceId }); setStatus('Отправлено — уведомление должно появиться через несколько секунд'); }
      catch (err) { setStatus(`Ошибка: ${err.message || err}`); }
    };
    $('#btnOffRem').onclick = async () => {
      try { await this.disable(cfg); } catch (err) { console.warn(err); }
      cfg.enabled = false;
      this.save(cfg);
      this.draw(cfg, 'Напоминания выключены');
    };
  },
};

// ──── base64url → байты (для ключа сервера) ────
function b64uToBytes(s) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
