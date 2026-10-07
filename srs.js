'use strict';
// ──── Интервальное повторение (упрощённый SM-2) ────
// Оценки: 0 — «Не знаю», 1 — «Трудно», 2 — «Знаю»

const SRS = (() => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const RETRY_MS = 60 * 1000;          // «Не знаю» — снова через минуту
  const START_EASE = 2.5;
  const MIN_EASE = 1.3;
  const EASE_STEP_BAD = 0.2;
  const EASE_STEP_HARD = 0.15;
  const HARD_FACTOR = 1.2;
  const FIRST_GOOD_DAYS = 1;
  const SECOND_GOOD_DAYS = 3;
  const LEARNED_DAYS = 7;              // с какого интервала карточка считается выученной
  const GRADE = { BAD: 0, HARD: 1, GOOD: 2 };

  // ──── Новая запись прогресса ────
  function fresh(profileId, card) {
    return {
      pk: `${profileId}|${card.key}`, profileId, deckId: card.deckId, cardKey: card.key,
      due: 0, interval: 0, ease: START_EASE, reps: 0, lapses: 0, last: 0,
    };
  }

  // ──── Пересчёт записи после ответа ────
  function review(rec, grade, now = Date.now()) {
    const r = { ...rec, last: now };
    if (grade === GRADE.BAD) {
      r.ease = Math.max(MIN_EASE, r.ease - EASE_STEP_BAD);
      r.interval = 0;
      r.reps = 0;
      r.lapses += 1;
      r.due = now + RETRY_MS;
      return r;
    }
    if (grade === GRADE.HARD) {
      r.ease = Math.max(MIN_EASE, r.ease - EASE_STEP_HARD);
      r.interval = Math.max(FIRST_GOOD_DAYS, Math.round(r.interval * HARD_FACTOR));
    } else if (r.reps === 0) {
      r.interval = FIRST_GOOD_DAYS;
    } else if (r.reps === 1) {
      r.interval = Math.max(SECOND_GOOD_DAYS, r.interval + 1);
    } else {
      r.interval = Math.round(r.interval * r.ease);
    }
    r.reps += 1;
    r.due = now + r.interval * DAY_MS;
    return r;
  }

  // ──── Статус карточки для статистики ────
  function status(rec) {
    if (!rec || rec.last === 0) return 'new';
    return rec.interval >= LEARNED_DAYS ? 'learned' : 'learning';
  }

  function isDue(rec, now = Date.now()) { return !!rec && rec.last > 0 && rec.due <= now; }

  // ──── Подпись интервала на кнопке ────
  function preview(rec, grade) {
    const r = review(rec, grade, 0);
    if (r.interval === 0) return '1 мин';
    if (r.interval < 30) return `${r.interval} дн`;
    const months = Math.round(r.interval / 30);
    return `${months} мес`;
  }

  return { GRADE, fresh, review, status, isDue, preview };
})();
