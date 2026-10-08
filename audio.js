'use strict';
// ──── Озвучка нейроголосом: загрузка через свой сервер, кеш, склейка в один аудиофайл ────
// Зачем один файл: браузер на Android продолжает играть обычное аудио при заблокированном
// экране, а голоса телефона (Web Speech) глушит. Поэтому фразы озвучиваются сервером
// заранее, хранятся в телефоне и перед прослушиванием склеиваются с паузами в один WAV.

const TTS_VOICES = {
  ru: [
    { id: 'ru-RU-SvetlanaNeural', label: 'Светлана' },
    { id: 'ru-RU-DmitryNeural', label: 'Дмитрий' },
  ],
  en: [
    { id: 'en-US-JennyNeural', label: 'Jenny 🇺🇸' },
    { id: 'en-US-GuyNeural', label: 'Guy 🇺🇸' },
    { id: 'en-GB-SoniaNeural', label: 'Sonia 🇬🇧' },
    { id: 'en-GB-RyanNeural', label: 'Ryan 🇬🇧' },
  ],
};
const TTS_PARALLEL = 2;              // одновременных запросов к серверу
const TTS_FAIL_LIMIT = 3;            // столько ошибок подряд без успехов — останавливаемся
const MIX_RATE = 24000;              // частота склейки, Гц (как у озвучки сервера)
const WAV_HEADER_BYTES = 44;
const PCM_MAX = 32767;

const Tts = {
  busy: false,
  cancelled: false,
  blobs: new Map(),      // ключ → Blob mp3 (текущая колода)
  decoded: new Map(),    // ключ → Float32Array PCM
  deckId: '',

  key(deckId, voice, text) { return `${deckId}|${voice}|${text}`; },

  // ──── Кеш озвучки колоды из базы ────
  async load(deckId) {
    if (this.deckId !== deckId) { this.blobs.clear(); this.decoded.clear(); this.deckId = deckId; }
    const rows = await DB.byIndex('audio', 'deckId', deckId);
    rows.forEach((r) => this.blobs.set(r.k, r.blob));
  },

  has(k) { return this.blobs.has(k); },

  // ──── Запрос к серверу ────
  async fetchOne(text, voice) {
    const c = ImageGen.cfg();
    let res;
    try {
      res = await fetch(`${c.url.replace(/\/+$/, '')}/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Token': c.token },
        body: JSON.stringify({ text, voice }),
      });
    } catch (err) {
      throw new Error(`Нет связи с сервером (${err.message}). Проверьте интернет или адрес сервера в «Ещё → ✨ Генерация».`);
    }
    if (res.status === 404) throw new Error('На сервере нет озвучки — обновите код Worker\'а (worker.js из архива, версия 4)');
    if (!res.ok) {
      let msg = `сервер ответил ${res.status}`;
      try { msg = (await res.json()).error || msg; } catch { /* не JSON */ }
      throw new Error(msg);
    }
    const blob = await res.blob();
    if (!blob.size) throw new Error('Сервер вернул пустой звук');
    return new Blob([blob], { type: 'audio/mpeg' });
  },

  // ──── Подготовка недостающей озвучки с окном прогресса ────
  // jobs: [{ k, text, voice }]; возвращает true, если всё готово
  async prepare(deckId, jobs) {
    if (this.busy || !jobs.length) return !jobs.length;
    this.busy = true;
    this.cancelled = false;
    let ok = 0, fails = 0, streak = 0, next = 0, firstError = '';
    Sheet.open(`<h3>🔊 Подготовка аудио</h3>
      <p class="subtitle" id="ttsStatus">Фраза 0 из ${jobs.length}</p>
      <div class="bar" style="height:10px"><i id="ttsBar" style="width:0%;background:var(--accent)"></i></div>
      <p class="subtitle" style="margin-top:12px;font-size:.85em">Нужен интернет. Не сворачивайте приложение, пока идёт подготовка.
        Готовая озвучка хранится в телефоне — второй раз скачивать не нужно.</p>
      <div class="btn-row"><button class="btn" id="ttsStop">Остановить</button></div>`, () => { this.cancelled = true; });
    $('#ttsStop').onclick = () => { this.cancelled = true; $('#ttsStatus').textContent = 'Останавливаю…'; };
    const worker = async () => {
      while (!this.cancelled && next < jobs.length) {
        const job = jobs[next];
        next += 1;
        try {
          const blob = await this.fetchOne(job.text, job.voice);
          await DB.put('audio', { k: job.k, deckId, blob });
          this.blobs.set(job.k, blob);
          ok += 1; streak = 0;
        } catch (err) {
          fails += 1; streak += 1;
          console.warn('tts', err);
          if (!firstError) firstError = err.message || String(err);
          if ((streak >= TTS_FAIL_LIMIT && ok === 0) || /токен|обновите|Нет связи/i.test(err.message)) this.cancelled = true;
        }
        const st = $('#ttsStatus'), bar = $('#ttsBar');
        if (st && !this.cancelled) st.textContent = `Фраза ${ok + fails} из ${jobs.length}${fails ? ` · ошибок ${fails}` : ''}`;
        if (bar) bar.style.width = `${Math.round(((ok + fails) / jobs.length) * 100)}%`;
      }
    };
    await Promise.all(Array.from({ length: TTS_PARALLEL }, worker));
    this.busy = false;
    if (fails) {
      Sheet.open(`<h3>Озвучка: готово ${ok}, ошибок ${fails}</h3>
        <p class="subtitle">Текст ошибки (пришлите его в чат):</p>
        <div class="prompt-box">${esc(firstError)}</div>
        <div class="btn-row"><button class="btn" id="ttsErrCopy">📋 Копировать</button><button class="btn primary" id="ttsErrOk">Понятно</button></div>`);
      $('#ttsErrCopy').onclick = () => ImageWizard.copy(firstError);
      $('#ttsErrOk').onclick = () => Sheet.close();
      return false;
    }
    if (Sheet.isOpen()) { Sheet.after = () => {}; Sheet.close(); }
    return ok + fails === jobs.length;
  },

  // ──── Декодирование mp3 → PCM (с пересчётом частоты) ────
  async decode(k) {
    if (this.decoded.has(k)) return this.decoded.get(k);
    const blob = this.blobs.get(k);
    if (!blob) throw new Error('Нет озвучки фразы');
    const ctx = new OfflineAudioContext(1, 1, MIX_RATE);
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
    const pcm = buf.getChannelData(0).slice();
    this.decoded.set(k, pcm);
    return pcm;
  },

  // ──── Склейка: отрезки + паузы → один WAV и разметка времени ────
  // items[i] = [{ k, pause }]; timeline = [{ i, j, start, end }] в секундах
  async mix(items) {
    const parts = [];
    const timeline = [];
    let total = 0;
    for (let i = 0; i < items.length; i += 1) {
      for (let j = 0; j < items[i].length; j += 1) {
        const pcm = await this.decode(items[i][j].k);
        const gap = Math.round((items[i][j].pause / 1000) * MIX_RATE);
        timeline.push({ i, j, start: total / MIX_RATE, end: (total + pcm.length + gap) / MIX_RATE });
        parts.push(pcm, gap);
        total += pcm.length + gap;
      }
    }
    return { blob: encodeWav(parts, total), timeline, duration: total / MIX_RATE };
  },
};

// ──── WAV 16 бит моно: части — Float32Array или число (тишина в отсчётах) ────
function encodeWav(parts, samples) {
  const buf = new ArrayBuffer(WAV_HEADER_BYTES + samples * 2);
  const v = new DataView(buf);
  const str = (at, s) => { for (let n = 0; n < s.length; n += 1) v.setUint8(at + n, s.charCodeAt(n)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + samples * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, MIX_RATE, true); v.setUint32(28, MIX_RATE * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, samples * 2, true);
  let at = WAV_HEADER_BYTES;
  parts.forEach((p) => {
    if (typeof p === 'number') { at += p * 2; return; }   // тишина: буфер уже заполнен нулями
    for (let n = 0; n < p.length; n += 1) {
      const x = Math.max(-1, Math.min(1, p[n]));
      v.setInt16(at, x * PCM_MAX, true);
      at += 2;
    }
  });
  return new Blob([buf], { type: 'audio/wav' });
}
