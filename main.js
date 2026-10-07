'use strict';
// ──── Запуск приложения ────

// ──── Быстрая смена профиля по нажатию на значок в шапке ────
function openProfileSwitcher() {
  const rows = App.profiles.map((p) => `
    <button class="row" data-pid="${esc(p.id)}"><span style="font-size:1.6em">${esc(p.emoji)}</span>
      <span class="grow"><b>${esc(p.name)}</b></span>${p.id === App.profile.id ? '✓' : ''}</button>`).join('');
  Sheet.open(`<h3>Кто занимается?</h3><div class="panel">${rows}</div>
    <button class="btn block" id="btnManage" style="margin-top:12px">Управление профилями</button>`);
  $('#sheet').querySelectorAll('[data-pid]').forEach((b) => {
    b.onclick = () => {
      App.profile = App.profiles.find((p) => p.id === b.dataset.pid);
      applyProfile();
      Sheet.close();
    };
  });
  $('#btnManage').onclick = () => { Sheet.after = () => switchTab('more'); Sheet.close(); };
}

// ──── Обработчики постоянных элементов интерфейса ────
function bindChrome() {
  document.querySelectorAll('.tab').forEach((t) => { t.onclick = () => switchTab(t.dataset.tab); });
  $('#btnBack').onclick = () => history.back();
  $('#btnProfile').onclick = openProfileSwitcher;
  $('#sheetBackdrop').addEventListener('click', (e) => { if (e.target.id === 'sheetBackdrop') Sheet.close(); });
}

// ──── Офлайн-режим через service worker ────
function registerSW() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW', e));
}

async function boot() {
  try {
    applyTheme();
    Speech.init();
    bindChrome();
    await DB.open();
    await loadProfiles();
    // после перезагрузки не возвращаемся в занятие и в модальные окна
    const st = history.state && history.state.route;
    App.route = st && st.screen !== 'study' ? st : { screen: 'today', params: {} };
    history.replaceState({ route: App.route }, '');
    await render();
    registerSW();
  } catch (err) {
    reportError('boot', err);
    $('#view').innerHTML = `<div class="empty"><div class="big">⚠️</div><p>Не удалось открыть хранилище.<br>${esc(err.message || err)}</p></div>`;
  }
}

boot();
