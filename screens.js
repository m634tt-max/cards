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
          <p>Пока нет ни одной колоды.<br>Импортируйте файл колоды (zip или deck.json) или вставьте её текст в разделе «Ещё».</p>
          <button class="btn import" id="btnImport">${PLUS} Импортировать колоду</button></div>`;
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
        <div class="cover ${covers[i] ? '' : 'noimg'}" style="background-image:url('${covers[i]}')"></div>
        <div class="meta"><div class="name">${esc(d.title)}</div>
          <div class="count">${cardsWord(d.cardCount)}</div>
          <div class="bar"><i style="width:${pct}%"></i></div></div></button>`;
    }).join('');
    view.innerHTML = `
      <h2>Колоды</h2><p class="subtitle">Мои наборы для изучения</p>
      <div class="grid">${tiles}
        <button class="add-tile import" id="btnImport">${PLUS}<span>Импорт колоды</span></button></div>`;
    $('#btnImport').onclick = async () => { const d = await Importer.pickAndImport(); if (d) navigate('deck', { deckId: d.id }); };
    view.querySelectorAll('[data-deck]').forEach((b) => { b.onclick = () => navigate('deck', { deckId: b.dataset.deck }); });
  },

  // ──── Экран колоды ────
  async deck(deckId) {
    const view = $('#view');
    const deck = await DB.get('decks', deckId);
    if (!deck) { switchTab('library'); return; }
    if (deck.type === 'poem' || deck.type === 'topic') {
      App.route = { screen: deck.type, params: { deckId } };
      history.replaceState({ route: App.route }, '');
      await (deck.type === 'poem' ? Poems.screen(deckId) : Topics.screen(deckId));
      return;
    }
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
        ${c.image ? `<img class="thumb" src="${imgUrl(c)}" alt="">` : '<div class="thumb thumb-empty">🖼</div>'}
        <div class="grow"><div><b>${esc(c.en)}</b></div><div class="hint">${esc(c.ru)}</div></div>
        <span>${dot[SRS.status(recMap.get(c.key))]}</span></button>`).join('');
    const todo = s.due + s.fresh;
    const noImg = cards.filter((c) => !c.image).length;
    const imgBanner = noImg ? `
      <div class="panel img-banner"><div class="grow"><b>🖼 Без картинки: ${noImg}</b>
        <div class="hint">Сгенерируйте по готовым промптам и выберите из галереи</div></div>
        <button class="btn import" id="btnAddImages">Добавить</button></div>` : '';
    view.innerHTML = `${imgBanner}
      <div class="stats">
        <div class="stat"><b>${s.due}</b><small>повторить</small></div>
        <div class="stat"><b>${s.fresh}</b><small>новых</small></div>
        <div class="stat"><b>${s.learned}/${s.total}</b><small>выучено</small></div>
      </div>
      <div class="btn-row">
        <button class="btn primary" id="btnStudy" ${todo ? '' : 'disabled'}>Учить${todo ? ` (${todo})` : ''}</button>
        <button class="btn" id="btnBrowse">Просмотр всех</button>
      </div>
      <button class="btn block listen-btn" id="btnListen">🎧 Слушать колоду</button>
      <div class="deck-actions">
        <button id="btnDeckImages">🖼 Картинки</button>
        <button id="btnDeckMenu">✏️ Изменить</button>
        <button id="btnDeckExport">📤 Выгрузить</button>
        <button id="btnDeckDelete" class="del">🗑 Удалить колоду</button>
      </div>
      <div class="section-title">Карточки · ⚪ новая 🟡 учу 🟢 выучена</div>
      <div class="panel">${rows}</div>`;
    $('#btnStudy').onclick = () => navigate('study', { deckIds: [deckId], mode: 'srs' });
    $('#btnBrowse').onclick = () => navigate('study', { deckIds: [deckId], mode: 'browse' });
    $('#btnListen').onclick = () => navigate('listen', { deckId });
    $('#btnDeckMenu').onclick = () => Screens.deckMenu(deck);
    $('#btnDeckImages').onclick = () => navigate('images', { deckId });
    $('#btnDeckExport').onclick = () => Importer.exportDeck(deck.id).catch((e) => reportError('export', e));
    $('#btnDeckDelete').onclick = () => Screens.deleteDeck(deck);
    if (noImg) $('#btnAddImages').onclick = () => navigate('images', { deckId });
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
    $('#btnDel').onclick = () => Screens.deleteDeck(deck);
  },

  // ──── Удаление колоды с подтверждением ────
  async deleteDeck(deck) {
    const ok = await confirmSheet(`Удалить «${deck.title}»?`,
      `${cardsWord(deck.cardCount)}, картинки и прогресс всех профилей будут удалены. Отменить нельзя.`, 'Удалить', true);
    if (!ok) return;
    await DB.deleteDeck(deck.id);
    toast({ poem: 'Стих удалён', topic: 'Тема удалена' }[deck.type] || 'Колода удалена');
    switchTab({ poem: 'poems', topic: 'topics' }[deck.type] || 'library');
  },

  // ──── Редактирование карточки ────
  editCard(card) {
    let newImage = null;
    const prompt = ImageWizard.promptOf(card);
    Sheet.open(`
      <h3>Карточка</h3>
      ${card.image ? `<img class="edit-img" id="editImg" src="${imgUrl(card)}" alt="">` : '<img class="edit-img" id="editImg" alt="">'}
      <button class="btn block" id="btnImg">${card.image ? 'Заменить картинку' : 'Выбрать картинку'}</button>
      <label class="field" style="margin-top:12px"><span>Русский</span><textarea id="editRu" rows="2">${esc(card.ru)}</textarea></label>
      <label class="field"><span>English</span><textarea id="editEn" rows="2">${esc(card.en)}</textarea></label>
      <label class="field"><span>Промпт для картинки</span><textarea id="editPrompt" rows="3">${esc(prompt)}</textarea></label>
      <div class="btn-row">
        <button class="btn" id="btnCopyPrompt">📋 Промпт</button>
        <button class="btn" id="btnSay">🔊 Озвучить</button>
      </div>
      <button class="btn primary block" id="btnSave">Сохранить</button>`);
    $('#btnSay').onclick = () => Speech.say($('#editEn').value);
    $('#btnCopyPrompt').onclick = () => ImageWizard.copy($('#editPrompt').value);
    $('#btnImg').onclick = async () => {
      const f = await pickFile('image/*');
      if (!f) return;
      try {
        newImage = await ImageWizard.compress(f);
        $('#editImg').src = URL.createObjectURL(newImage);
      } catch (err) { reportError('image', err); }
    };
    $('#btnSave').onclick = async () => {
      card.ru = $('#editRu').value.trim();
      card.en = $('#editEn').value.trim();
      card.prompt = $('#editPrompt').value.trim();
      if (newImage) card.image = newImage;
      await DB.put('cards', card);
      if (newImage) await ImageWizard.fixCover(card.deckId);
      Sheet.close();
      toast('Сохранено');
    };
  },
};
