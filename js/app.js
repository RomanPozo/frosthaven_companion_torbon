/**
 * app.js — Punto de entrada.
 *
 * - Cabecera: nombre de campaña editable, semana, año e insignia de estación.
 * - Navegación por pestañas (con #hash para mantener la pestaña al recargar).
 * - Carga diferida de las pestañas de escenarios y galería.
 * - Exportar / cargar backups JSON (con fotos opcionales de IndexedDB).
 *
 * Contrato de las pestañas: cada módulo exporta `init<Nombre>UI(rootEl)` y puede
 * devolver `{ onShow?(), onHide?() }`. La galería escucha el evento de ventana
 * `fh:gallery-changed` para recargar tras importar fotos, y el Narrador escucha
 * `fh:texts-changed`. Los textos del Narrador viajan siempre en el backup.
 */

import * as S from './state.js';
import { countPhotos, getAllPhotos, exportPhotos, importPhotos, exportTexts, importTexts, formatBytes } from './db.js';
import { escapeHtml, icon, refreshIcons, toast, confirmDialog, choiceDialog, downloadFile, readFileAsText } from './ui.js';
import { initOutpostUI } from './outpostUI.js';

const TABS = {
  outpost: {
    panel: 'panel-outpost',
    root: 'outpost-root',
    load: async () => initOutpostUI,
  },
  scenarios: {
    panel: 'panel-scenarios',
    root: 'flowchart-root',
    load: () => import('./flowchartUI.js').then((m) => m.initFlowchartUI),
  },
  narrator: {
    panel: 'panel-narrator',
    root: 'narrator-root',
    load: () => import('./narratorUI.js').then((m) => m.initNarratorUI),
  },
  gallery: {
    panel: 'panel-gallery',
    root: 'gallery-root',
    load: () => import('./galleryUI.js').then((m) => m.initGalleryUI),
  },
};
const TAB_ORDER = Object.keys(TABS);

const controllers = new Map();
const pending = new Map();
let activeTab = null;

const $ = (sel) => document.querySelector(sel);

/* ==========================================================================
   Cabecera
   ========================================================================== */

let renderedSeason = null;

function renderHeader(state) {
  const { currentWeek, season, year } = state.calendar;
  const info = S.SEASONS[season];

  $('#hdr-week').textContent = currentWeek;
  $('#hdr-year').textContent = year;
  $('#hdr-season-label').textContent = info.name;
  $('#hdr-season-week').textContent = `${S.getWeekInSeason(currentWeek)}/10`;

  if (renderedSeason !== season) {
    const badge = $('#hdr-season');
    badge.classList.remove('season-badge--summer', 'season-badge--winter');
    badge.classList.add(`season-badge--${season}`);
    badge.dataset.season = season;
    badge.title = `Estación: ${info.name}`;
    badge.querySelector('.season-badge__icon').innerHTML = icon(info.icon);
    renderedSeason = season;
    refreshIcons();
  }

  const input = $('#campaign-name');
  if (document.activeElement !== input) input.value = state.campaignName;
  document.title = `${state.campaignName} · Semana ${currentWeek} — Frosthaven Companion`;
}

function bindCampaignName() {
  const input = $('#campaign-name');
  const commit = () => {
    S.setCampaignName(input.value);
    input.value = S.getState().campaignName;
  };
  input.addEventListener('change', commit);
  input.addEventListener('blur', commit);
  input.addEventListener('focus', () => input.select());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      input.blur();
    } else if (e.key === 'Escape') {
      input.value = S.getState().campaignName;
      input.blur();
    }
  });
}

/* ==========================================================================
   Pestañas
   ========================================================================== */

function tabFromHash() {
  const name = location.hash.replace(/^#/, '');
  return name in TABS ? name : null;
}

function renderTabError(rootEl, name, err) {
  console.error(`[app] No se pudo cargar la pestaña "${name}":`, err);
  rootEl.innerHTML = `
    <div class="empty-state">
      ${icon('construction')}
      <p class="font-display text-lg text-slate-200">Este módulo aún no está disponible</p>
      <p class="text-sm max-w-sm">No se pudo cargar la pestaña. Si acabas de actualizar la app, recarga la página.</p>
      <button type="button" class="btn btn-ghost mt-2" data-retry-tab="${name}">${icon('rotate-cw')}Reintentar</button>
    </div>`;
  rootEl.querySelector('[data-retry-tab]').addEventListener('click', () => {
    rootEl.innerHTML = '<div class="panel-loading"><span class="spinner" aria-hidden="true"></span> Cargando…</div>';
    ensureTab(name).then((ctrl) => ctrl?.onShow?.());
  });
  refreshIcons();
}

/** Carga e inicializa una pestaña una sola vez. Devuelve su controlador o null. */
function ensureTab(name) {
  if (controllers.has(name)) return Promise.resolve(controllers.get(name));
  if (pending.has(name)) return pending.get(name);

  const tab = TABS[name];
  const rootEl = document.getElementById(tab.root);
  const promise = tab
    .load()
    .then((init) => {
      if (typeof init !== 'function') throw new Error('El módulo no exporta su función de inicio.');
      const ctrl = init(rootEl) ?? {};
      controllers.set(name, ctrl);
      refreshIcons();
      return ctrl;
    })
    .catch((err) => {
      renderTabError(rootEl, name, err);
      return null;
    })
    .finally(() => pending.delete(name));

  pending.set(name, promise);
  return promise;
}

async function activateTab(name, { focus = false, updateHash = true } = {}) {
  if (!(name in TABS)) name = 'outpost';
  const previous = activeTab;
  if (previous === name) return;
  activeTab = name;

  for (const key of TAB_ORDER) {
    const selected = key === name;
    const btn = document.querySelector(`.tab-btn[data-tab="${key}"]`);
    btn.setAttribute('aria-selected', String(selected));
    btn.tabIndex = selected ? 0 : -1;
    document.getElementById(TABS[key].panel).hidden = !selected;
  }
  if (focus) document.querySelector(`.tab-btn[data-tab="${name}"]`).focus();
  if (updateHash && location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`);

  if (previous) controllers.get(previous)?.onHide?.();
  const ctrl = await ensureTab(name);
  if (activeTab === name) ctrl?.onShow?.();
}

function bindTabs() {
  const bar = document.querySelector('.tab-bar');
  bar.addEventListener('click', (e) => {
    const btn = e.target.closest('.tab-btn');
    if (btn) activateTab(btn.dataset.tab);
  });
  bar.addEventListener('keydown', (e) => {
    const idx = TAB_ORDER.indexOf(activeTab);
    const map = { ArrowRight: idx + 1, ArrowLeft: idx - 1, Home: 0, End: TAB_ORDER.length - 1 };
    if (!(e.key in map)) return;
    e.preventDefault();
    const next = (map[e.key] + TAB_ORDER.length) % TAB_ORDER.length;
    activateTab(TAB_ORDER[next], { focus: true });
  });
  window.addEventListener('hashchange', () => {
    const name = tabFromHash();
    if (name) activateTab(name, { updateHash: false });
  });
}

/* ==========================================================================
   Backups
   ========================================================================== */

async function handleExport() {
  let photoCount = 0;
  try {
    photoCount = await countPhotos();
  } catch {
    photoCount = 0; // IndexedDB no disponible: se exporta solo la campaña.
  }

  let includePhotos = false;
  if (photoCount > 0) {
    let approx = '';
    try {
      const all = await getAllPhotos();
      // Base64 ocupa ~4/3 del binario.
      approx = formatBytes(all.reduce((sum, p) => sum + (p.size || 0), 0) * 1.37);
    } catch {
      approx = '';
    }
    const choice = await choiceDialog({
      title: 'Exportar backup',
      message: `Tenéis ${photoCount} ${photoCount === 1 ? 'foto' : 'fotos'} en el Salón de los Héroes. ¿Qué queréis incluir?`,
      choices: [
        { value: 'state', label: 'Solo la campaña', hint: 'Calendario, diario y árbol de escenarios. Archivo ligero.', variant: 'btn-primary' },
        { value: 'all', label: 'Campaña + fotos', hint: approx ? `Archivo más pesado (≈ ${approx}).` : 'Archivo más pesado.' },
      ],
    });
    if (!choice) return;
    includePhotos = choice === 'all';
  }

  const extras = {};
  try {
    const texts = await exportTexts();
    if (texts.length) extras.texts = texts;
  } catch {
    /* sin IndexedDB no hay textos que exportar */
  }
  if (includePhotos) {
    const progress = toast('Preparando fotos…', { duration: 0 });
    try {
      extras.photos = await exportPhotos((done, total) => progress.update(`Preparando fotos… ${done}/${total}`));
    } catch (err) {
      toast(`No se pudieron exportar las fotos: ${err.message}`, { type: 'error' });
      return;
    } finally {
      progress.close();
    }
  }

  const backup = S.exportBackup(extras);
  downloadFile(S.backupFilename(), JSON.stringify(backup, null, includePhotos ? 0 : 2));
  toast(includePhotos ? 'Backup con fotos descargado.' : 'Backup descargado.', { type: 'success' });
}

async function handleImportFile(file) {
  if (!file) return;

  let data;
  try {
    data = JSON.parse(await readFileAsText(file));
  } catch {
    toast('El archivo no es un JSON válido.', { type: 'error' });
    return;
  }

  const raw = data && typeof data === 'object' ? (data.state && typeof data.state === 'object' ? data.state : data) : {};
  const photos = Array.isArray(data?.photos) ? data.photos : [];
  const texts = Array.isArray(data?.texts) ? data.texts : [];
  const summary = `
    <ul class="mt-4 grid gap-1.5 text-sm">
      <li class="flex justify-between gap-3"><span class="text-slate-400">Campaña</span><strong class="text-slate-100 text-right truncate">${escapeHtml(raw.campaignName ?? '—')}</strong></li>
      <li class="flex justify-between gap-3"><span class="text-slate-400">Semana</span><strong class="text-slate-100">${escapeHtml(raw.calendar?.currentWeek ?? '—')}</strong></li>
      <li class="flex justify-between gap-3"><span class="text-slate-400">Escenarios</span><strong class="text-slate-100">${escapeHtml(Array.isArray(raw.scenarios?.nodes) ? raw.scenarios.nodes.length : Array.isArray(raw.scenarios) ? raw.scenarios.length : '—')}</strong></li>
      <li class="flex justify-between gap-3"><span class="text-slate-400">Textos del Narrador</span><strong class="text-slate-100">${texts.length}</strong></li>
      <li class="flex justify-between gap-3"><span class="text-slate-400">Fotos incluidas</span><strong class="text-slate-100">${photos.length}</strong></li>
      ${data?.exportedAt ? `<li class="flex justify-between gap-3"><span class="text-slate-400">Exportado</span><strong class="text-slate-100">${escapeHtml(new Date(data.exportedAt).toLocaleString('es-ES'))}</strong></li>` : ''}
    </ul>`;

  const ok = await confirmDialog({
    title: 'Cargar backup',
    message: 'Se reemplazará la campaña actual (calendario, diario y árbol de escenarios). Si la necesitáis, exportadla antes.',
    html: summary,
    confirmText: 'Reemplazar campaña',
    danger: true,
  });
  if (!ok) return;

  try {
    const res = S.importBackup(data);
    toast(`Campaña "${res.campaignName}" cargada (semana ${res.week}).`, { type: 'success' });
  } catch (err) {
    toast(err.message, { type: 'error' });
    return;
  }

  if (texts.length) {
    // Se fusionan: si un texto ya existe, se conserva la versión más reciente.
    try {
      const r = await importTexts(texts);
      if (r.imported) toast(`Narrador: ${r.imported} ${r.imported === 1 ? 'texto importado' : 'textos importados'}.`, { type: 'success' });
      window.dispatchEvent(new CustomEvent('fh:texts-changed'));
    } catch (err) {
      toast(`No se pudieron importar los textos: ${err.message}`, { type: 'error' });
    }
  }

  if (!photos.length) return;
  const choice = await choiceDialog({
    title: 'Fotos del Salón de los Héroes',
    message: `El backup incluye ${photos.length} ${photos.length === 1 ? 'foto' : 'fotos'}. ¿Qué hacemos con ellas?`,
    choices: [
      { value: 'merge', label: 'Añadirlas a la galería', hint: 'Se mantienen las fotos actuales; se omiten las repetidas.', variant: 'btn-primary' },
      { value: 'replace', label: 'Reemplazar la galería', hint: 'Se borran las fotos actuales de este dispositivo.' },
      { value: 'skip', label: 'No importar fotos' },
    ],
  });
  if (!choice || choice === 'skip') return;

  if (choice === 'replace') {
    const sure = await confirmDialog({
      title: '¿Reemplazar la galería?',
      message: 'Las fotos actuales de este dispositivo se borrarán definitivamente.',
      confirmText: 'Reemplazar fotos',
      danger: true,
    });
    if (!sure) return;
  }

  const progress = toast('Importando fotos…', { duration: 0 });
  try {
    const r = await importPhotos(photos, {
      replace: choice === 'replace',
      onProgress: (done, total) => progress.update(`Importando fotos… ${done}/${total}`),
    });
    const parts = [`${r.imported} importadas`];
    if (r.skipped) parts.push(`${r.skipped} ya existían`);
    if (r.failed) parts.push(`${r.failed} con error`);
    toast(`Fotos: ${parts.join(', ')}.`, { type: r.failed ? 'error' : 'success', duration: 4500 });
  } catch (err) {
    toast(`No se pudieron importar las fotos: ${err.message}`, { type: 'error' });
  } finally {
    progress.close();
    window.dispatchEvent(new CustomEvent('fh:gallery-changed'));
  }
}

function bindBackups() {
  const fileInput = $('#import-file');
  $('#btn-export').addEventListener('click', () => {
    handleExport().catch((err) => toast(`Error al exportar: ${err.message}`, { type: 'error' }));
  });
  $('#btn-import').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    fileInput.value = ''; // permite volver a elegir el mismo archivo
    handleImportFile(file).catch((err) => toast(`Error al cargar: ${err.message}`, { type: 'error' }));
  });
}

/* ==========================================================================
   Errores globales y arranque
   ========================================================================== */

let lastStorageWarning = 0;

function bindGlobalErrors() {
  window.addEventListener('unhandledrejection', (e) => {
    console.error('[app] Promesa rechazada sin capturar:', e.reason);
    const msg = e.reason?.message;
    if (msg) toast(msg, { type: 'error' });
  });
}

function boot() {
  window.__FH_BOOTED__ = true;

  bindCampaignName();
  bindTabs();
  bindBackups();
  bindGlobalErrors();

  renderHeader(S.getState());
  S.subscribe((state, { type }) => {
    if (type === 'storage:error') {
      const now = Date.now();
      if (now - lastStorageWarning > 10000) {
        lastStorageWarning = now;
        toast('No se pudo guardar en este navegador (¿modo privado o sin espacio?). Exportad un backup.', { type: 'error', duration: 6000 });
      }
      return;
    }
    renderHeader(state);
  });

  if (!S.isStorageAvailable()) {
    toast('El almacenamiento local no está disponible: los cambios no se conservarán al cerrar.', { type: 'error', duration: 6000 });
  }

  activateTab(tabFromHash() ?? 'outpost', { updateHash: false });
  refreshIcons();
}

boot();
