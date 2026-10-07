'use strict';
// ──── Экран «Ещё»: профили, настройки, данные ────

Object.assign(Screens, {

  async more() {
    const view = $('#view');
    const p = App.profile;
    const profRows = App.profiles.map((x) => `
      <div class="row">
        <button class="grow" style="text-align:left;display:flex;gap:12px;align-items:center" data-switch="${esc(x.id)}">
          <span style="font-size:1.6em">${esc(x.emoji)}</span><b>${esc(x.name)}</b>
          ${x.id === p.id ? '<span class="hint">· текущий</span>' : ''}</button>
        <button class="icon-btn" data-edit="${esc(x.id)}" aria-label="Изменить">
          <svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16zM14 6l4 4"/></svg></button>
      </div>`).join('');
    const voices = Speech.voices.map((v) => `<option value="${esc(v.voiceURI)}" ${Speech.pick() === v ? 'selected' : ''}>${esc(v.name)} (${esc(v.lang)})</option>`).join('');
    const theme = lsGet(LS_THEME, 'auto');
    const rate = Number(lsGet(LS_RATE, DEFAULT_RATE));
    view.innerHTML = `
      <div class="section-title">Профили</div>
      <div class="panel">${profRows}
        <button class="row" id="btnAddProfile">${PLUS}<span class="grow">Добавить профиль</span></button></div>

      <div class="section-title">Настройки профиля «${esc(p.name)}»</div>
      <div class="panel">
        ${Screens.toggleRow('kid', 'Детский режим', 'Крупный шрифт, две кнопки оценки', p.kid)}
        ${Screens.toggleRow('reverse', 'Обратный режим', 'Сначала английский, вспомнить русский', p.reverse)}
        ${Screens.toggleRow('autoSpeak', 'Автоозвучка', 'Произносить фразу при перевороте', p.autoSpeak)}
      </div>

      <div class="section-title">Озвучка и вид</div>
      <div class="panel" style="padding:14px 16px">
        <label class="field"><span>Голос</span><select id="selVoice">${voices || '<option>Английские голоса не найдены</option>'}</select></label>
        <label class="field"><span>Скорость речи: <b id="rateVal">${rate.toFixed(1)}</b></span>
          <input type="range" id="rate" min="0.5" max="1.3" step="0.1" value="${rate}" style="padding:0;border:0;background:none"></label>
        <div class="btn-row" style="margin:0 0 12px"><button class="btn" id="btnTestVoice">🔊 Проверить голос</button></div>
        <label class="field" style="margin:0"><span>Тема</span><select id="selTheme">
          <option value="auto" ${theme === 'auto' ? 'selected' : ''}>Как в системе</option>
          <option value="light" ${theme === 'light' ? 'selected' : ''}>Светлая</option>
          <option value="dark" ${theme === 'dark' ? 'selected' : ''}>Тёмная</option></select></label>
      </div>

      <div class="section-title">Данные</div>
      <div class="panel">
        <button class="row" id="btnImport"><span class="grow">Импортировать колоду (zip)</span>${CHEVRON}</button>
        <button class="row" id="btnBackup"><span class="grow">Сохранить резервную копию<div class="hint">Колоды, профили и прогресс в один zip</div></span>${CHEVRON}</button>
        <button class="row" id="btnRestore"><span class="grow">Восстановить из копии</span>${CHEVRON}</button>
      </div>
      <p class="subtitle" id="storageInfo" style="margin:12px 4px">Версия ${APP_VERSION}</p>`;
    Screens.bindMore(view);
    Screens.showStorage();
  },

  toggleRow(key, title, hint, on) {
    return `<label class="row"><div class="grow"><div>${esc(title)}</div><div class="hint">${esc(hint)}</div></div>
      <span class="switch"><input type="checkbox" data-toggle="${key}" ${on ? 'checked' : ''}><span></span></span></label>`;
  },

  // ──── Обработчики экрана «Ещё» ────
  bindMore(view) {
    view.querySelectorAll('[data-switch]').forEach((b) => {
      b.onclick = () => {
        App.profile = App.profiles.find((x) => x.id === b.dataset.switch);
        applyProfile();
        toast(`Профиль: ${App.profile.name}`);
        render();
      };
    });
    view.querySelectorAll('[data-edit]').forEach((b) => {
      b.onclick = () => Screens.editProfile(App.profiles.find((x) => x.id === b.dataset.edit));
    });
    $('#btnAddProfile').onclick = () => Screens.editProfile(null);
    view.querySelectorAll('[data-toggle]').forEach((c) => {
      c.onchange = async () => {
        App.profile[c.dataset.toggle] = c.checked;
        await saveProfile(App.profile);
      };
    });
    $('#selVoice').onchange = (e) => lsSet(LS_VOICE, e.target.value);
    $('#rate').oninput = (e) => { lsSet(LS_RATE, e.target.value); $('#rateVal').textContent = Number(e.target.value).toFixed(1); };
    $('#btnTestVoice').onclick = () => Speech.say('Hello! Nice to meet you.');
    $('#selTheme').onchange = (e) => { lsSet(LS_THEME, e.target.value); applyTheme(); };
    $('#btnImport').onclick = async () => { const d = await Importer.pickAndImport(); if (d) navigate('deck', { deckId: d.id }); };
    $('#btnBackup').onclick = () => Importer.exportBackup().catch((e) => reportError('backup', e));
    $('#btnRestore').onclick = async () => { if (await Importer.restoreBackup()) render(); };
  },

  async showStorage() {
    try {
      if (!navigator.storage || !navigator.storage.estimate) return;
      const { usage } = await navigator.storage.estimate();
      const persisted = navigator.storage.persisted ? await navigator.storage.persisted() : false;
      const mb = (usage / 1048576).toFixed(1);
      const el = $('#storageInfo');
      if (el) el.textContent = `Версия ${APP_VERSION} · занято ${mb} МБ · ${persisted ? 'хранение защищено' : 'хранение не защищено — делайте копии'}`;
    } catch (e) { console.warn(e); }
  },

  // ──── Создание и правка профиля ────
  editProfile(prof) {
    const isNew = !prof;
    const p = prof ? { ...prof } : { id: uid(), name: '', emoji: PROFILE_EMOJI[4], kid: false, reverse: false, autoSpeak: false, streak: 0, lastDay: '', createdAt: Date.now() };
    const emo = PROFILE_EMOJI.map((e) => `<button data-emo="${e}" class="${e === p.emoji ? 'sel' : ''}">${e}</button>`).join('');
    Sheet.open(`
      <h3>${isNew ? 'Новый профиль' : 'Профиль'}</h3>
      <label class="field"><span>Имя</span><input id="profName" value="${esc(p.name)}" maxlength="20" placeholder="Например, Маша"></label>
      <div class="emoji-pick">${emo}</div>
      ${isNew ? Screens.toggleRow('kidNew', 'Детский режим', 'Крупный шрифт, две кнопки', false) : ''}
      <button class="btn primary block" id="btnSaveProf" style="margin-top:12px">Сохранить</button>
      ${!isNew && App.profiles.length > 1 ? '<button class="btn danger block" id="btnDelProf" style="margin-top:10px">Удалить профиль</button>' : ''}`);
    $('#sheet').querySelectorAll('[data-emo]').forEach((b) => {
      b.onclick = () => {
        p.emoji = b.dataset.emo;
        $('#sheet').querySelectorAll('[data-emo]').forEach((x) => x.classList.toggle('sel', x === b));
      };
    });
    $('#btnSaveProf').onclick = async () => {
      p.name = $('#profName').value.trim() || 'Без имени';
      const kidBox = $('#sheet [data-toggle="kidNew"]');
      if (kidBox) p.kid = kidBox.checked;
      await DB.put('profiles', p);
      if (isNew) lsSet(LS_PROFILE, p.id);
      await loadProfiles();
      Sheet.close();
    };
    const del = $('#btnDelProf');
    if (del) {
      del.onclick = async () => {
        if (!(await confirmSheet('Удалить профиль?', `Прогресс профиля «${p.name}» будет удалён.`, 'Удалить', true))) return;
        await DB.deleteProfile(p.id);
        await loadProfiles();
        render();
      };
    }
  },
});
