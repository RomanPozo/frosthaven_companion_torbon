/**
 * narratorUI.js — Pestaña "Narrador".
 *
 * Lee en voz alta las secciones del Libro de Secciones y las introducciones de
 * los escenarios. Los textos NO vienen con la app (tienen copyright): cada
 * grupo los transcribe desde su propio libro, fotografiando la página. El OCR
 * (Tesseract.js) corre dentro del navegador y solo se guarda el texto, en
 * IndexedDB, en este dispositivo.
 *
 * Exporta también `openTextEditor` y `readStoredText` para que otras pestañas
 * (alerta de secciones, árbol de escenarios) puedan leer o añadir textos.
 */

import * as S from './state.js';
import * as DB from './db.js';
import * as Speech from './speech.js';
import { escapeHtml, icon, refreshIcons, toast, openModal, confirmDialog } from './ui.js';

const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
const OCR_LANG = 'spa';
const OCR_MAX_SIDE = 2600;
const OCR_MIN_SIDE = 1400;
export const TEXTS_CHANGED = 'fh:texts-changed';

const KIND_LABEL = {
  section: { one: 'Sección', title: 'Sección del Libro', placeholder: '183.3', icon: 'book-open' },
  scenario: { one: 'Escenario', title: 'Introducción de escenario', placeholder: '23', icon: 'map' },
};

let root = null;
let kind = 'section';
let current = null; // { kind, number, record|null }
let library = [];
let filter = '';

/* ==========================================================================
   API para otras pestañas
   ========================================================================== */

export function textLabel(k, number) {
  return k === 'section' ? `Sección ${number}` : `Escenario #${number}`;
}

/** Busca un texto guardado y lo lee. Devuelve true si existía. */
export async function readStoredText(k, number) {
  const record = await DB.getText(k, number);
  if (!record) return false;
  Speech.speak({ id: record.id, title: recordTitle(record), text: record.text });
  return true;
}

function recordTitle(r) {
  return `${textLabel(r.kind, r.number)}${r.title ? ` · ${r.title}` : ''}`;
}

function notifyTextsChanged(record) {
  window.dispatchEvent(new CustomEvent(TEXTS_CHANGED, { detail: record ?? null }));
}

/* ==========================================================================
   Inicialización de la pestaña
   ========================================================================== */

export function initNarratorUI(el) {
  root = el;
  root.innerHTML = `
    <div class="space-y-4">
      <div>
        <h2 class="section-title">Narrador</h2>
        <p class="section-subtitle">Elige una sección o la introducción de un escenario y la app la lee en voz alta.</p>
      </div>

      ${
        Speech.isSpeechSupported()
          ? ''
          : `<div class="rule-card rule-card--blood !p-4 text-sm text-red-200">${icon('volume-x', 'inline w-4 h-4 -mt-0.5')} Este navegador no permite la lectura en voz alta. Prueba con Chrome, Edge o Safari actualizados.</div>`
      }

      <section class="frost-panel p-4 sm:p-5">
        <form class="grid gap-3" data-form="lookup" novalidate>
          <div class="seg" role="radiogroup" aria-label="Qué leer">
            ${['section', 'scenario']
              .map(
                (k) => `
              <label class="seg__opt">
                <input type="radio" name="kind" value="${k}" class="sr-only" ${k === kind ? 'checked' : ''} />
                <span>${icon(KIND_LABEL[k].icon)}${KIND_LABEL[k].title}</span>
              </label>`,
              )
              .join('')}
          </div>
          <div class="flex gap-2">
            <label class="sr-only" for="narr-number">Número</label>
            <input id="narr-number" name="number" class="fh-input font-display font-bold !text-2xl text-center flex-1 min-w-0"
              inputmode="decimal" autocomplete="off" placeholder="${KIND_LABEL[kind].placeholder}" />
            <button type="submit" class="btn btn-primary btn-lg shrink-0">${icon('volume-2')}Leer</button>
          </div>
          <div class="flex flex-wrap gap-1.5" data-chips></div>
        </form>
      </section>

      <div data-result></div>

      <section class="frost-panel p-4 sm:p-5" data-voice-panel></section>

      <section class="frost-panel p-4 sm:p-5">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <h3 class="section-title !text-base flex items-center gap-2">${icon('library', 'w-5 h-5 text-sky-400')}Biblioteca <span class="text-slate-400 font-sans text-sm" data-lib-count></span></h3>
          <button type="button" class="btn btn-gold btn-icon-sm" data-action="add">${icon('camera')}Añadir texto</button>
        </div>
        <input type="search" class="fh-input mt-3" placeholder="Filtrar por número o palabra…" data-filter aria-label="Filtrar biblioteca" />
        <div class="mt-3 space-y-4" data-library></div>
      </section>
    </div>`;

  root.addEventListener('submit', onLookup);
  root.addEventListener('click', onClick);
  root.addEventListener('change', (e) => {
    if (e.target.name === 'kind') {
      kind = e.target.value;
      const input = root.querySelector('#narr-number');
      input.placeholder = KIND_LABEL[kind].placeholder;
      input.inputMode = kind === 'section' ? 'decimal' : 'numeric';
      renderChips();
    }
  });
  root.querySelector('[data-filter]').addEventListener('input', (e) => {
    filter = e.target.value.trim().toLowerCase();
    renderLibrary();
  });

  Speech.onSpeechChange(() => {
    highlightReader();
    renderVoicePanelOnce();
  });
  S.subscribe(() => renderChips(), ['calendar:*', 'scenario:*', 'campaign:import', 'campaign:reset', 'sync']);
  window.addEventListener(TEXTS_CHANGED, async () => {
    await loadLibrary();
    if (current) await showResult(current.kind, current.number, { autoplay: false });
  });

  renderChips();
  renderVoicePanel();
  loadLibrary();
  refreshIcons();

  return {};
}

/* ==========================================================================
   Búsqueda y lectura
   ========================================================================== */

function renderChips() {
  if (!root) return;
  const el = root.querySelector('[data-chips]');
  const state = S.getState();
  let chips = [];
  if (kind === 'section') {
    const week = state.calendar.currentWeek;
    chips = S.getUpcomingSections(week, 6).map((u) => ({
      number: u.section,
      label: `${u.section}${u.week === week ? ' · esta semana' : ` · sem. ${u.week}`}`,
      hot: u.week === week,
    }));
  } else {
    chips = state.scenarios.nodes
      .filter((n) => n.status === 'unlocked' && S.normalizeScenarioNumber(n.number))
      .sort((a, b) => (parseFloat(a.number) || 0) - (parseFloat(b.number) || 0))
      .slice(0, 10)
      .map((n) => ({ number: n.number, label: `#${n.number} ${n.name}`, hot: false }));
  }
  el.innerHTML = chips.length
    ? `<span class="text-xs text-slate-400 self-center mr-1">${kind === 'section' ? 'Agendadas:' : 'Disponibles:'}</span>` +
      chips
        .map(
          (c) =>
            `<button type="button" class="pill ${c.hot ? 'pill-blood' : kind === 'section' ? 'pill-muted' : 'pill-ice'}" data-chip="${escapeHtml(c.number)}">${escapeHtml(c.label)}</button>`,
        )
        .join('')
    : '';
}

async function onLookup(e) {
  const form = e.target.closest('[data-form="lookup"]');
  if (!form) return;
  e.preventDefault();
  const number = form.elements.namedItem('number').value;
  if (!DB.normalizeTextNumber(kind, number)) {
    toast(kind === 'section' ? 'Escribe un número de sección, p. ej. 183.3' : 'Escribe un número de escenario, p. ej. 23', { type: 'error' });
    return;
  }
  await showResult(kind, number, { autoplay: true });
}

async function showResult(k, number, { autoplay = false } = {}) {
  const n = DB.normalizeTextNumber(k, number);
  let record = null;
  try {
    record = await DB.getText(k, n);
  } catch (err) {
    toast(err.message, { type: 'error' });
  }
  current = { kind: k, number: n, record };
  renderResult();
  if (record && autoplay) Speech.speak({ id: record.id, title: recordTitle(record), text: record.text });
  root.querySelector('[data-result]').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function renderResult() {
  const el = root.querySelector('[data-result]');
  if (!current) {
    el.innerHTML = '';
    return;
  }
  const { kind: k, number, record } = current;

  if (!record) {
    el.innerHTML = `
      <div class="empty-state">
        ${icon('book-dashed')}
        <p class="font-display text-lg text-slate-200">Aún no tienes el texto de ${escapeHtml(textLabel(k, number).toLowerCase())}</p>
        <p class="text-sm max-w-sm">Hazle una foto a la página del libro: la app reconocerá el texto y lo guardará en este dispositivo para leerlo cuando queráis.</p>
        <button type="button" class="btn btn-gold mt-2" data-action="add-current">${icon('camera')}Añadir con foto</button>
      </div>`;
    refreshIcons();
    return;
  }

  const chunks = Speech.splitIntoChunks(record.text);
  let html = '';
  let para = -1;
  chunks.forEach((c, i) => {
    if (c.paragraph !== para) {
      if (para !== -1) html += '</p>';
      html += '<p>';
      para = c.paragraph;
    }
    html += `<span class="reader-chunk" data-chunk="${i}">${escapeHtml(c.text)}</span> `;
  });
  if (para !== -1) html += '</p>';

  el.innerHTML = `
    <article class="rule-card rule-card--gold">
      <div class="flex items-start gap-3">
        <div class="min-w-0 flex-1">
          <p class="text-[0.7rem] uppercase tracking-[0.14em] font-semibold text-amber-300/80">${escapeHtml(KIND_LABEL[record.kind].title)}</p>
          <h3 class="font-display text-xl font-bold text-amber-100 break-words">${escapeHtml(recordTitle(record))}</h3>
        </div>
        <button type="button" class="btn btn-ghost btn-icon-only" data-action="edit" data-id="${escapeHtml(record.id)}" aria-label="Editar texto">${icon('pencil')}</button>
      </div>
      <div class="mt-3 flex flex-wrap gap-2" data-reader-controls></div>
      <div class="reader-text mt-4" data-reader>${html}</div>
      <p class="mt-3 text-xs text-slate-500">Toca una frase para leer desde ahí.</p>
    </article>`;
  highlightReader();
}

function highlightReader() {
  if (!root || !current?.record) return;
  const st = Speech.getSpeechState();
  const mine = st.id === current.record.id && st.status !== 'idle';
  root.querySelectorAll('.reader-chunk.is-current').forEach((s) => s.classList.remove('is-current'));
  if (mine) {
    const span = root.querySelector(`.reader-chunk[data-chunk="${st.index}"]`);
    span?.classList.add('is-current');
    if (span && st.status === 'playing') span.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  const controls = root.querySelector('[data-reader-controls]');
  if (!controls) return;
  controls.innerHTML = mine
    ? `<button type="button" class="btn btn-primary" data-action="toggle">${icon(st.status === 'playing' ? 'pause' : 'play')}${st.status === 'playing' ? 'Pausar' : 'Continuar'}</button>
       <button type="button" class="btn btn-ghost" data-action="stop">${icon('square')}Detener</button>`
    : `<button type="button" class="btn btn-primary" data-action="play">${icon('volume-2')}Leer en voz alta</button>`;
  refreshIcons();
}

/* ==========================================================================
   Voz
   ========================================================================== */

let voiceCountRendered = -1;

function renderVoicePanelOnce() {
  // Las voces llegan de forma asíncrona: repintamos solo si cambia la lista.
  if (Speech.getVoices().length !== voiceCountRendered) renderVoicePanel();
}

function renderVoicePanel() {
  const el = root?.querySelector('[data-voice-panel]');
  if (!el) return;
  const voices = Speech.getVoices();
  voiceCountRendered = voices.length;
  const selected = Speech.getSelectedVoice();
  const rate = Speech.getRate();
  const spanish = voices.filter((v) => /^es/i.test(v.lang));

  el.innerHTML = `
    <h3 class="section-title !text-base flex items-center gap-2">${icon('mic-vocal', 'w-5 h-5 text-sky-400')}Voz del narrador</h3>
    ${
      voices.length && !spanish.length
        ? '<p class="mt-1 text-xs text-amber-300">No hay voces en español instaladas: instala una en los ajustes de voz/accesibilidad del sistema.</p>'
        : ''
    }
    <div class="mt-3 grid gap-3 sm:grid-cols-[1fr_14rem]">
      <div>
        <label class="fh-label" for="narr-voice">Voz</label>
        <select id="narr-voice" class="fh-select" data-voice ${voices.length ? '' : 'disabled'}>
          ${
            voices.length
              ? voices
                  .map(
                    (v) =>
                      `<option value="${escapeHtml(v.voiceURI)}" ${v === selected ? 'selected' : ''}>${escapeHtml(v.name)} (${escapeHtml(v.lang)})</option>`,
                  )
                  .join('')
              : '<option>Cargando voces…</option>'
          }
        </select>
      </div>
      <div>
        <label class="fh-label" for="narr-rate">Velocidad: <span data-rate-label>${rate.toFixed(1)}×</span></label>
        <input id="narr-rate" type="range" min="0.6" max="1.6" step="0.1" value="${rate}" class="w-full accent-sky-400 mt-2" data-rate />
      </div>
    </div>
    <button type="button" class="btn btn-ghost btn-icon-sm mt-3" data-action="test-voice">${icon('play')}Probar voz</button>`;

  el.querySelector('[data-voice]').addEventListener('change', (e) => Speech.setVoice(e.target.value));
  const range = el.querySelector('[data-rate]');
  range.addEventListener('input', () => (el.querySelector('[data-rate-label]').textContent = `${Number(range.value).toFixed(1)}×`));
  range.addEventListener('change', () => Speech.setRate(range.value));
  refreshIcons();
}

/* ==========================================================================
   Biblioteca
   ========================================================================== */

async function loadLibrary() {
  try {
    library = await DB.getAllTexts();
  } catch (err) {
    library = [];
    root.querySelector('[data-library]').innerHTML = `<p class="text-sm text-red-300">${escapeHtml(err.message)}</p>`;
    return;
  }
  renderLibrary();
}

function renderLibrary() {
  const el = root.querySelector('[data-library]');
  root.querySelector('[data-lib-count]').textContent = library.length ? `(${library.length})` : '';
  const items = filter
    ? library.filter((t) => `${t.number} ${t.title} ${t.text}`.toLowerCase().includes(filter))
    : library;

  if (!library.length) {
    el.innerHTML = `<p class="text-sm text-slate-500">Todavía no hay textos. Consejo: la primera vez que salga una sección, fotografiadla y quedará guardada para siempre.</p>`;
    return;
  }
  if (!items.length) {
    el.innerHTML = '<p class="text-sm text-slate-500">Nada coincide con el filtro.</p>';
    return;
  }

  el.innerHTML = ['section', 'scenario']
    .map((k) => {
      const group = items.filter((t) => t.kind === k);
      if (!group.length) return '';
      return `
        <div>
          <p class="fh-label">${k === 'section' ? 'Secciones' : 'Introducciones de escenario'} (${group.length})</p>
          <ul class="grid gap-2">
            ${group
              .map(
                (t) => `
              <li class="flex items-center gap-2 p-2 pl-3 rounded-xl bg-slate-950/50 border border-slate-700/50">
                <button type="button" class="flex-1 min-w-0 text-left" data-open="${escapeHtml(t.id)}">
                  <span class="font-display font-bold ${k === 'section' ? 'text-red-200' : 'text-sky-200'}">${k === 'section' ? '' : '#'}${escapeHtml(t.number)}</span>
                  ${t.title ? `<span class="text-sm text-slate-200"> · ${escapeHtml(t.title)}</span>` : ''}
                  <span class="block text-xs text-slate-500 truncate">${escapeHtml(t.text.slice(0, 110))}</span>
                </button>
                <button type="button" class="btn btn-ghost btn-icon-only" data-read="${escapeHtml(t.id)}" aria-label="Leer ${escapeHtml(recordTitle(t))}">${icon('volume-2')}</button>
                <button type="button" class="btn btn-ghost-danger btn-icon-only" data-delete="${escapeHtml(t.id)}" aria-label="Borrar ${escapeHtml(recordTitle(t))}">${icon('trash-2')}</button>
              </li>`,
              )
              .join('')}
          </ul>
        </div>`;
    })
    .join('');
  refreshIcons();
}

/* ==========================================================================
   Eventos de la pestaña
   ========================================================================== */

function setLookup(k, number) {
  kind = k;
  root.querySelector(`input[name="kind"][value="${k}"]`).checked = true;
  root.querySelector('#narr-number').value = number;
  renderChips();
}

async function onClick(e) {
  const t = e.target;
  const chip = t.closest('[data-chip]');
  if (chip) {
    setLookup(kind, chip.dataset.chip);
    await showResult(kind, chip.dataset.chip, { autoplay: true });
    return;
  }
  const chunk = t.closest('.reader-chunk');
  if (chunk && current?.record) {
    const i = Number(chunk.dataset.chunk);
    const st = Speech.getSpeechState();
    if (st.id === current.record.id && st.status !== 'idle') Speech.seek(i);
    else Speech.speak({ id: current.record.id, title: recordTitle(current.record), text: current.record.text, startAt: i });
    return;
  }
  const open = t.closest('[data-open]') ?? t.closest('[data-read]');
  if (open) {
    const rec = library.find((x) => x.id === (open.dataset.open ?? open.dataset.read));
    if (!rec) return;
    setLookup(rec.kind, rec.number);
    await showResult(rec.kind, rec.number, { autoplay: !!open.dataset.read });
    return;
  }
  const del = t.closest('[data-delete]');
  if (del) {
    const rec = library.find((x) => x.id === del.dataset.delete);
    const ok = await confirmDialog({
      title: `¿Borrar ${rec ? recordTitle(rec) : 'este texto'}?`,
      message: 'Se eliminará el texto transcrito de este dispositivo.',
      confirmText: 'Borrar',
      danger: true,
    });
    if (!ok) return;
    if (Speech.getSpeechState().id === del.dataset.delete) Speech.stop();
    await DB.deleteText(del.dataset.delete);
    if (current?.record?.id === del.dataset.delete) current = null;
    notifyTextsChanged(null);
    renderResult();
    toast('Texto eliminado.');
    return;
  }

  const action = t.closest('[data-action]')?.dataset.action;
  if (!action) return;
  if (action === 'add') openTextEditor({ kind, number: root.querySelector('#narr-number').value });
  else if (action === 'add-current') openTextEditor({ kind: current.kind, number: current.number });
  else if (action === 'edit' && current?.record) openTextEditor({ kind: current.record.kind, number: current.record.number, record: current.record });
  else if (action === 'play' && current?.record) Speech.speak({ id: current.record.id, title: recordTitle(current.record), text: current.record.text });
  else if (action === 'toggle') Speech.togglePause();
  else if (action === 'stop') Speech.stop();
  else if (action === 'test-voice') Speech.speak({ id: 'test', title: 'Prueba de voz', text: 'Los vientos helados soplan sobre Frosthaven. Preparaos, mercenarios: la aventura os espera.' });
}

/* ==========================================================================
   OCR (Tesseract.js, cargado bajo demanda)
   ========================================================================== */

let tesseractPromise = null;
let workerPromise = null;
let ocrLogger = null;

function loadTesseract() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  if (tesseractPromise) return tesseractPromise;
  tesseractPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = TESSERACT_URL;
    script.async = true;
    script.onload = () => (window.Tesseract ? resolve(window.Tesseract) : reject(new Error('Tesseract no se inicializó.')));
    script.onerror = () => {
      script.remove();
      reject(new Error('No se pudo descargar el motor de OCR. Comprueba la conexión (solo hace falta la primera vez).'));
    };
    document.head.appendChild(script);
  });
  tesseractPromise.catch(() => (tesseractPromise = null));
  return tesseractPromise;
}

function getWorker() {
  if (!workerPromise) {
    workerPromise = loadTesseract()
      .then((T) => T.createWorker(OCR_LANG, 1, { logger: (m) => ocrLogger?.(m) }))
      .catch((err) => {
        workerPromise = null;
        throw err;
      });
  }
  return workerPromise;
}

const OCR_STATUS = {
  'loading tesseract core': 'Cargando el motor de OCR…',
  'initializing tesseract': 'Iniciando el OCR…',
  'loading language traineddata': 'Descargando el idioma español (solo la primera vez)…',
  'loading language traineddata (from cache)': 'Cargando el idioma español…',
  'initializing api': 'Preparando…',
  'recognizing text': 'Reconociendo texto…',
};

/** Prepara la foto: orientación EXIF, tamaño adecuado, gris y algo de contraste. */
async function prepareForOcr(file) {
  let source;
  let release = () => {};
  try {
    source = await createImageBitmap(file, { imageOrientation: 'from-image' });
    release = () => source.close?.();
  } catch {
    const url = URL.createObjectURL(file);
    source = new Image();
    source.src = url;
    await source.decode();
    release = () => URL.revokeObjectURL(url);
  }
  try {
    const w0 = source.width ?? source.naturalWidth;
    const h0 = source.height ?? source.naturalHeight;
    const long = Math.max(w0, h0);
    const scale = long > OCR_MAX_SIDE ? OCR_MAX_SIDE / long : long < OCR_MIN_SIDE ? OCR_MIN_SIDE / long : 1;
    const w = Math.round(w0 * scale);
    const h = Math.round(h0 * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, w, h);

    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    const contrast = 1.35;
    for (let i = 0; i < d.length; i += 4) {
      const y = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      const v = Math.max(0, Math.min(255, (y - 128) * contrast + 128));
      d[i] = d[i + 1] = d[i + 2] = v;
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  } finally {
    release();
  }
}

/** Limpia el texto del OCR: une guiones de fin de línea y líneas de un mismo párrafo. */
export function cleanOcrText(raw) {
  return String(raw ?? '')
    .replace(/\r/g, '')
    .replace(/[|]/g, 'I')
    .replace(/(\p{L})[-‐‑]\n\s*(\p{Ll})/gu, '$1$2')
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s*\n\s*/g, ' ').replace(/[ \t]{2,}/g, ' ').trim())
    .filter((p) => p && !/^\d{1,3}$/.test(p)) // quita números de página sueltos
    .join('\n\n');
}

async function recognize(file, onProgress) {
  ocrLogger = (m) => {
    const label = OCR_STATUS[m.status] ?? 'Procesando…';
    onProgress(label, m.status === 'recognizing text' ? m.progress : null);
  };
  try {
    onProgress('Preparando la foto…', null);
    const [canvas, worker] = await Promise.all([prepareForOcr(file), getWorker()]);
    const { data } = await worker.recognize(canvas);
    canvas.width = canvas.height = 0;
    return { text: cleanOcrText(data.text), confidence: data.confidence };
  } finally {
    ocrLogger = null;
  }
}

/* ==========================================================================
   Editor de textos (modal)
   ========================================================================== */

/**
 * Abre el editor para añadir/editar un texto, con OCR por foto.
 * @param {{ kind?: 'section'|'scenario', number?: string, record?: object }} [opts]
 */
export async function openTextEditor({ kind: k = 'section', number = '', record = null } = {}) {
  if (!record && DB.normalizeTextNumber(k, number)) {
    try {
      record = await DB.getText(k, number);
    } catch {
      record = null;
    }
  }
  const scenarioName = (num) => S.findScenarioByNumber(num)?.name ?? '';
  const initialTitle = record?.title ?? (k === 'scenario' ? scenarioName(number) : '');
  let busy = false;

  openModal({
    title: record ? `Editar ${textLabel(record.kind, record.number).toLowerCase()}` : 'Añadir texto para el narrador',
    wide: true,
    content: `
      <form class="mt-4 grid gap-3" data-form="text" novalidate>
        <div class="seg" role="radiogroup" aria-label="Tipo de texto">
          ${['section', 'scenario']
            .map(
              (x) => `
            <label class="seg__opt">
              <input type="radio" name="kind" value="${x}" class="sr-only" ${x === k ? 'checked' : ''} />
              <span>${icon(KIND_LABEL[x].icon)}${KIND_LABEL[x].title}</span>
            </label>`,
            )
            .join('')}
        </div>
        <div class="grid grid-cols-[7rem_1fr] gap-2">
          <div>
            <label class="fh-label" for="txt-number">Número</label>
            <input id="txt-number" name="number" class="fh-input font-display font-bold" autocomplete="off"
              value="${escapeHtml(record?.number ?? number ?? '')}" placeholder="${KIND_LABEL[k].placeholder}" inputmode="decimal" />
          </div>
          <div>
            <label class="fh-label" for="txt-title">Título (opcional)</label>
            <input id="txt-title" name="title" class="fh-input" maxlength="120" autocomplete="off" value="${escapeHtml(initialTitle)}" placeholder="Mercader visitante" />
          </div>
        </div>

        <div class="dropzone p-3">
          <p class="text-sm text-slate-300 font-semibold flex items-center gap-2">${icon('scan-text', 'w-4 h-4 text-amber-400')}Reconocer texto desde una foto</p>
          <p class="text-xs text-slate-400 mt-1">Encuadra solo esta sección, con buena luz y la página lo más plana posible. Si el texto sigue en otra columna o página, añade otra foto: se añadirá al final.</p>
          <div class="mt-3 flex flex-wrap gap-2">
            <label class="btn btn-gold btn-icon-sm cursor-pointer">${icon('camera')}Hacer foto
              <input type="file" accept="image/*" capture="environment" class="sr-only" data-ocr-input />
            </label>
            <label class="btn btn-ghost btn-icon-sm cursor-pointer">${icon('image')}Elegir imagen
              <input type="file" accept="image/*" class="sr-only" data-ocr-input />
            </label>
          </div>
          <div class="mt-3" data-ocr-status hidden>
            <p class="text-xs text-slate-300 flex items-center gap-2"><span class="spinner !w-3.5 !h-3.5"></span><span data-ocr-label>Preparando…</span></p>
            <div class="ocr-progress mt-2"><div class="ocr-progress__bar" data-ocr-bar></div></div>
          </div>
        </div>

        <div>
          <div class="flex items-end justify-between gap-2">
            <label class="fh-label" for="txt-text">Texto (revisa y corrige los errores del OCR)</label>
            <span class="text-[0.7rem] text-slate-500 mb-1.5" data-count></span>
          </div>
          <textarea id="txt-text" name="text" class="fh-textarea !min-h-[220px] text-[15px]" maxlength="20000"
            placeholder="Haz una foto o escribe/pega aquí el texto…">${escapeHtml(record?.text ?? '')}</textarea>
          <p class="text-xs text-slate-500 mt-1">Deja una línea en blanco entre párrafos para que la voz haga pausa.</p>
        </div>

        <p class="text-xs text-red-300 min-h-[1rem]" data-error></p>
        <div class="flex flex-col-reverse sm:flex-row gap-2 sm:justify-end">
          <button type="button" class="btn btn-ghost" data-action="preview">${icon('volume-2')}Escuchar</button>
          <button type="submit" class="btn btn-primary">${icon('save')}Guardar texto</button>
        </div>
      </form>`,
    onOpen(panel, modal) {
      const form = panel.querySelector('[data-form="text"]');
      const field = (n) => form.elements.namedItem(n);
      const textarea = field('text');
      const error = panel.querySelector('[data-error]');
      const count = panel.querySelector('[data-count]');
      const status = panel.querySelector('[data-ocr-status]');
      const updateCount = () => (count.textContent = `${textarea.value.length} caracteres`);
      updateCount();
      textarea.addEventListener('input', updateCount);

      form.addEventListener('change', (e) => {
        if (e.target.name === 'kind') {
          const kk = e.target.value;
          field('number').placeholder = KIND_LABEL[kk].placeholder;
          if (kk === 'scenario' && !field('title').value) field('title').value = scenarioName(field('number').value);
        }
      });
      field('number').addEventListener('change', () => {
        if (field('kind').value === 'scenario' && !field('title').value) field('title').value = scenarioName(field('number').value);
      });

      panel.querySelectorAll('[data-ocr-input]').forEach((input) =>
        input.addEventListener('change', async () => {
          const file = input.files?.[0];
          input.value = '';
          if (!file || busy) return;
          busy = true;
          error.textContent = '';
          status.hidden = false;
          const bar = panel.querySelector('[data-ocr-bar]');
          const label = panel.querySelector('[data-ocr-label]');
          form.querySelectorAll('button, [data-ocr-input]').forEach((b) => (b.disabled = true));
          try {
            const { text, confidence } = await recognize(file, (msg, progress) => {
              label.textContent = progress == null ? msg : `${msg} ${Math.round(progress * 100)}%`;
              bar.style.width = progress == null ? '15%' : `${Math.round(progress * 100)}%`;
            });
            if (!text) throw new Error('No se ha detectado texto. Prueba con más luz o acercando la cámara.');
            textarea.value = textarea.value.trim() ? `${textarea.value.trim()}\n\n${text}` : text;
            updateCount();
            textarea.focus();
            toast(
              confidence < 60
                ? 'Texto reconocido, pero con baja confianza: revísalo con cuidado.'
                : 'Texto reconocido. Revisa que no haya errores antes de guardar.',
              { type: confidence < 60 ? 'error' : 'success', duration: 4500 },
            );
          } catch (err) {
            console.error('[narrator] OCR:', err);
            error.textContent = err.message || 'No se pudo reconocer el texto.';
          } finally {
            busy = false;
            status.hidden = true;
            form.querySelectorAll('button, [data-ocr-input]').forEach((b) => (b.disabled = false));
          }
        }),
      );

      panel.addEventListener('click', (e) => {
        if (e.target.closest('[data-action="preview"]')) {
          if (!textarea.value.trim()) return;
          Speech.speak({ id: 'preview', title: 'Vista previa', text: textarea.value });
        }
      });

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (busy) return;
        error.textContent = '';
        const kk = field('kind').value;
        const num = field('number').value;
        try {
          if (record && (record.kind !== kk || record.number !== DB.normalizeTextNumber(kk, num))) {
            // Cambio de número/tipo: evitar pisar otro texto sin avisar.
            const clash = await DB.getText(kk, num);
            if (clash) throw new Error(`Ya existe un texto para ${textLabel(kk, clash.number).toLowerCase()}.`);
          } else if (!record) {
            const clash = await DB.getText(kk, num).catch(() => null);
            if (clash) {
              const ok = await confirmDialog({
                title: 'Ya existe ese texto',
                message: `Ya tienes guardado el texto de ${textLabel(kk, clash.number).toLowerCase()}. ¿Quieres reemplazarlo?`,
                confirmText: 'Reemplazar',
                danger: true,
              });
              if (!ok) return;
            }
          }
          const saved = await DB.saveText({ kind: kk, number: num, title: field('title').value, text: textarea.value });
          if (record && record.id !== saved.id) await DB.deleteText(record.id);
          if (Speech.getSpeechState().id === 'preview') Speech.stop();
          notifyTextsChanged(saved);
          toast(`Texto de ${textLabel(saved.kind, saved.number).toLowerCase()} guardado para el narrador.`, { type: 'success' });
          modal.close(saved);
        } catch (err) {
          error.textContent = err.message;
        }
      });
    },
  });
}
