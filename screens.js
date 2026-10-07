'use strict';
// ──── Экраны приложения ────

const CHEVRON = '<svg viewBox="0 0 24 24" style="color:var(--text-2)"><path d="M9 5l7 7-7 7"/></svg>';
const greeting = (p) => (p.name && p.name !== 'Я' ? `Привет, ${esc(p.name)}!` : 'Привет!');
const PLUS = '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>';

const Screens = {

  // ──── «Учить»: сводка на сегодня ────
  async today() {
    const view = $('#view');
    const decks = await loadDecks();
    const p = App.profile;
    if (decks.length === 0) {
      view.innerHTML = `
        <h2>${greeting(p)}</h2>
        <div class="empty"><div class="big">📚</div>
          <p>Пока нет ни одной колоды.<br>Импортируйте zip-файл колоды, подготовленный скриптом.</p>
          <button class="btn primary" id="btnImport">${PLUS} Импортировать колоду</button></div>`;
      $('#btnImport').onclick = async () => { if (await Importer.pickAndImport()) render(); };
      return;
    }
    const sums = await Promise.all(decks.map((d) => deckSummary(d)));
    const total = sums.reduce((a, s) => ({ due: a.due + s.due, fresh: a.fresh + s.fresh, learned: a.learned + s.learned }), { due: 0, fresh: 0, learned: 0 });
    const streak = currentStreak(p);
    const covers = await Promise.all(decks.map((d) => deckCover(d)));
    const rows = decks.map((d, i) => {
      const s = sums[i];
      const info = s.due || s.fresh ? `${s.due} к повторению · ${s.fresh} новых` : 'На сегодня всё ✓';
      return `<button class="row" data-deck="${esc(d.id)}">
        <img class="thumb" src="${covers[i]}" alt="">
        <div class="grow"><div><b>${esc(d.title)}</b></div><div class="hint">${info}</div></div>${CHEVRON}</button>`;
    }).join('');
    const todo = total.due + total.fresh;
    view.innerHTML = `
      <h2>${greeting(p)}</h2>
      <p class="subtitle">${streak > 1 ? `🔥 ${streak} ${plural(streak, 'день', 'дня', 'дней')} подряд` : 'Начнём занятие?'}</p>
      <div class="stats">
        <div class="stat"><b>${total.due}</b><small>повторить</small></div>
        <div class="stat"><b>${total.fresh}</b><small>новых</small></div>
        <div class="stat"><b>${total.learned}</b><small>выучено</small></div>
      </div>
      <button class="btn primary block" id="btnAll" ${todo ? '' : 'disabled'}>
        ${todo ? 'Учить все колоды' : 'Всё повторено — отдыхайте'}</button>
      <div class="section-title">По колодам</div>
      <div class="panel">${rows}</div>`;
    $('#btnAll').onclick = () => navigate('study', { deckIds: decks.map((d) => d.id), mode: 'srs' });
    view.querySelectorAll('[data-deck]').forEach((b) => {
      b.onclick = () => navigate('study', { deckIds: [b.dataset.deck], mode: 'srs' });
    });
  },

  // ──── «Колоды»: сетка ────
  async library() {
    const view = $('#view');
    const decks = await loadDecks();
    const sums = await Promise.all(decks.map((d) => deckSummary(d)));
    const covers = await Promise.all(decks.map((d) => deckCover(d)));
    const tiles = decks.map((d, i) => {
      const pct = d.cardCount ? Math.round((sums[i].learned / d.cardCount) * 100) : 0;
      return `<button class="deck-tile" data-deck="${esc(d.id)}">
        <div class="cover" style="background-image:url('${covers[i]}')"></div>
        <div class="meta"><div class="name">${esc(d.title)}</div>
          <div class="count">${cardsWord(d.cardCount)}</div>
          <div class="bar"><i style="width:${pct}%"></i></div></div></button>`;
    }).join('');
    view.innerHTML = `
      <h2>Колоды</h2><p class="subtitle">Мои наборы для изучения</p>
      <div class="grid">${tiles}
        <button class="add-tile" id="btnImport">${PLUS}<span>Импорт колоды</span></button></div>`;
    $('#btnImport').onclick = async () => { const d = await Importer.pickAndImport(); if (d) navigate('deck', { deckId: d.id }); };
    view.querySelectorAll('[data-deck]').forEach((b) => { b.onclick = () => navigate('deck', { deckId: b.dataset.deck }); });
  },

  // ──── Экран колоды ────
  async deck(deckId) {
    const view = $('#view');
    const deck = await DB.get('decks', deckId);
    if (!deck) { switchTab('library'); return; }
    $('#topTitle').textContent = deck.title;
    const [cards, recs, s] = await Promise.all([
      DB.byIndex('cards', 'deckId', deckId),
      DB.byIndex('progress', 'profileDeck', [App.profile.id, deckId]),
      deckSummary(deck),
    ]);
    cards.sort((a, b) => a.idx - b.idx);
    const recMap = new Map(recs.map((r) => [r.cardKey, r]));
    const dot = { new: '⚪', learning: '🟡', learned: '🟢' };
    const rows = cards.map((c) => `
      <button class="row" data-card="${esc(c.key)}">
        <img class="thumb" src="${imgUrl(c)}" alt="">
        <div class="grow"><div><b>${esc(c.en)}</b></div><div class="hint">${esc(c.ru)}</div></div>
        <span>${dot[SRS.status(recMap.get(c.key))]}</span></button>`).join('');
    const todo = s.due + s.fresh;
    view.innerHTML = `
      <div class="stats">
        <div class="stat"><b>${s.due}</b><small>повторить</small></div>
        <div class="stat"><b>${s.fresh}</b><small>новых</small></div>
        <div class="stat"><b>${s.learned}/${s.total}</b><small>выучено</small></div>
      </div>
      <div class="btn-row">
        <button class="btn primary" id="btnStudy" ${todo ? '' : 'disabled'}>Учить${todo ? ` (${todo})` : ''}</button>
        <button class="btn" id="btnBrowse">Просмотр всех</button>
      </div>
      <div class="section-title">Карточки · ⚪ новая 🟡 учу 🟢 выучена</div>
      <div class="panel">${rows}</div>
      <div class="btn-row"><button class="btn" id="btnDeckMenu">Действия с колодой…</button></div>`;
    $('#btnStudy').onclick = () => navigate('study', { deckIds: [deckId], mode: 'srs' });
    $('#btnBrowse').onclick = () => navigate('study', { deckIds: [deckId], mode: 'browse' });
    $('#btnDeckMenu').onclick = () => Screens.deckMenu(deck);
    view.querySelectorAll('[data-card]').forEach((b) => {
      b.onclick = () => Screens.editCard(cards.find((c) => c.key === b.dataset.card));
    });
  },

  // ──── Меню колоды: переименовать, выгрузить, сбросить, удалить ────
  deckMenu(deck) {
    Sheet.open(`
      <h3>${esc(deck.title)}</h3>
      <label class="field"><span>Название</span><input id="deckTitle" value="${esc(deck.title)}" maxlength="80"></label>
      <button class="btn block" id="btnRename">Сохранить название</button>
      <div class="btn-row">
        <button class="btn" id="btnExport">Выгрузить zip</button>
        <button class="btn" id="btnReset">Сбросить прогресс</button>
      </div>
      <button class="btn danger block" id="btnDel">Удалить колоду</button>`);
    $('#btnRename').onclick = async () => {
      const t = $('#deckTitle').value.trim();
      if (!t) return;
      deck.title = t;
      await DB.put('decks', deck);
      Sheet.close();
    };
    $('#btnExport').onclick = () => Importer.exportDeck(deck.id).catch((e) => reportError('export', e));
    $('#btnReset').onclick = async () => {
      if (!(await confirmSheet('Сбросить прогресс?', `Только для профиля «${App.profile.name}».`, 'Сбросить', true))) return;
      const recs = await DB.byIndex('progress', 'profileDeck', [App.profile.id, deck.id]);
      for (const r of recs) await DB.del('progress', r.pk);
      toast('Прогресс сброшен');
      render();
    };
    $('#btnDel').onclick = async () => {
      if (!(await confirmSheet('Удалить колоду?', 'Карточки и прогресс всех профилей будут удалены.', 'Удалить', true))) return;
      await DB.deleteDeck(deck.id);
      toast('Колода удалена');
      switchTab('library');
    };
  },

  // ──── Редактирование карточки ────
  editCard(card) {
    let newImage = null;
    Sheet.open(`
      <h3>Карточка</h3>
      <img class="edit-img" id="editImg" src="${imgUrl(card)}" alt="">
      <button class="btn block" id="btnImg">Заменить картинку</button>
      <label class="field" style="margin-top:12px"><span>Русский</span><textarea id="editRu" rows="2">${esc(card.ru)}</textarea></label>
      <label class="field"><span>English</span><textarea id="editEn" rows="2">${esc(card.en)}</textarea></label>
      <div class="btn-row">
        <button class="btn" id="btnSay">🔊 Озвучить</button>
        <button class="btn primary" id="btnSave">Сохранить</button>
      </div>`);
    $('#btnSay').onclick = () => Speech.say($('#editEn').value);
    $('#btnImg').onclick = async () => {
      const f = await pickFile('image/*');
      if (!f) return;
      newImage = f;
      $('#editImg').src = URL.createObjectURL(f);
    };
    $('#btnSave').onclick = async () => {
      card.ru = $('#editRu').value.trim();
      card.en = $('#editEn').value.trim();
      if (newImage) card.image = new Blob([await newImage.arrayBuffer()], { type: newImage.type || 'image/jpeg' });
      await DB.put('cards', card);
      Sheet.close();
      toast('Сохранено');
    };
  },
};
