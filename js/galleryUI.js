/**
 * galleryUI.js — Pestaña 3: Salón de los Héroes.
 *
 * Subida local de fotos (100% offline, sin servicios externos), compresión con
 * canvas vía db.js, vitrina en cuadrícula y lightbox a pantalla completa con
 * navegación, edición de datos y borrado.
 */

import * as S from './state.js';
import * as DB from './db.js';
import { escapeHtml, icon, refreshIcons, toast, confirmDialog, isModalOpen, formatDate } from './ui.js';

let root = null;
let photos = [];
const thumbURLs = new Map();
let previewURL = null;
let weekTouched = false;
let saving = false;
let loaded = false;
let persistAsked = false;

/* ==========================================================================
   Inicialización
   ========================================================================== */

export function initGalleryUI(el) {
  root = el;
  root.innerHTML = `
    <div class="space-y-4">
      <div class="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 class="section-title">Salón de los Héroes</h2>
          <p class="section-subtitle">Fotos de la mesa, miniaturas pintadas y victorias ajustadas. Se guardan solo en este dispositivo.</p>
        </div>
        <p class="text-xs text-slate-400" data-storage></p>
      </div>

      <section class="frost-panel p-4 sm:p-5">
        <h3 class="section-title !text-base flex items-center gap-2">${icon('image-plus', 'w-5 h-5 text-amber-400')}Inmortalizar un momento</h3>
        <form class="mt-3 grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] md:gap-5" data-form="upload" novalidate>
          <label class="dropzone flex flex-col items-center justify-center gap-2 p-4 text-center cursor-pointer min-h-[150px]" data-dropzone>
            <input type="file" name="file" accept="image/*" class="sr-only" />
            <img class="photo-preview" alt="Vista previa" hidden data-preview />
            <span class="flex flex-col items-center gap-1 text-slate-400" data-drop-hint>
              ${icon('camera', 'w-8 h-8 text-sky-400')}
              <span class="text-sm font-semibold text-slate-200">Elegir o hacer una foto</span>
              <span class="text-xs">o arrástrala aquí · se reduce a 1280px</span>
            </span>
            <span class="text-xs text-slate-400 truncate max-w-full" data-file-name></span>
          </label>

          <div class="grid gap-3 content-start">
            <div class="grid grid-cols-[1fr_5.5rem] gap-2">
              <div>
                <label class="fh-label" for="photo-title">Título</label>
                <input id="photo-title" name="title" class="fh-input" maxlength="120" placeholder="Muerte del Jefe Algox" autocomplete="off" />
              </div>
              <div>
                <label class="fh-label" for="photo-week">Semana</label>
                <input id="photo-week" name="week" type="number" min="1" max="80" inputmode="numeric" class="fh-input font-display font-bold" />
              </div>
            </div>
            <div>
              <label class="fh-label" for="photo-desc">Descripción breve</label>
              <textarea id="photo-desc" name="description" class="fh-textarea !min-h-[64px]" rows="2" maxlength="1000" placeholder="Último golpe con 1 de vida…"></textarea>
            </div>
            <p class="text-xs text-red-300 min-h-[1rem] -mt-1" data-error></p>
            <button type="submit" class="btn btn-gold">${icon('trophy')}<span data-submit-label>Guardar en el Salón</span></button>
          </div>
        </form>
      </section>

      <div data-grid>
        <div class="panel-loading"><span class="spinner" aria-hidden="true"></span> Cargando fotos…</div>
      </div>
    </div>`;

  const form = root.querySelector('[data-form="upload"]');
  form.week.value = S.getState().calendar.currentWeek;
  form.week.addEventListener('input', () => (weekTouched = true));
  form.file.addEventListener('change', () => setPreview(form.file.files?.[0]));
  form.addEventListener('submit', onSubmit);
  bindDropzone(form);

  root.querySelector('[data-grid]').addEventListener('click', (e) => {
    const card = e.target.closest('[data-photo]');
    if (card) openLightbox(card.dataset.photo);
  });

  S.subscribe((state) => {
    if (!weekTouched) form.week.value = state.calendar.currentWeek;
  }, ['calendar:*', 'campaign:import', 'campaign:reset', 'sync']);

  window.addEventListener('fh:gallery-changed', () => loadPhotos());

  refreshIcons();

  return {
    onShow() {
      if (!loaded) loadPhotos();
    },
  };
}

/* ==========================================================================
   Carga y cuadrícula
   ========================================================================== */

function revokeThumbs() {
  for (const url of thumbURLs.values()) URL.revokeObjectURL(url);
  thumbURLs.clear();
}

async function loadPhotos() {
  const grid = root.querySelector('[data-grid]');
  try {
    photos = await DB.getAllPhotos();
    loaded = true;
  } catch (err) {
    console.error('[gallery]', err);
    grid.innerHTML = `
      <div class="empty-state">
        ${icon('database-zap')}
        <p class="font-display text-lg text-slate-200">La galería no está disponible</p>
        <p class="text-sm max-w-sm">${escapeHtml(err.message)}</p>
      </div>`;
    root.querySelector('[data-form="upload"] button[type="submit"]').disabled = true;
    refreshIcons();
    return;
  }
  renderGrid();
  updateStorageInfo();
}

function renderGrid() {
  const grid = root.querySelector('[data-grid]');
  revokeThumbs();

  if (!photos.length) {
    grid.innerHTML = `
      <div class="empty-state">
        ${icon('trophy')}
        <p class="font-display text-lg text-slate-200">El Salón aún está vacío</p>
        <p class="text-sm max-w-sm">Subid la primera foto de vuestra campaña: una victoria épica, una derrota memorable o esa miniatura recién pintada.</p>
      </div>`;
    refreshIcons();
    return;
  }

  grid.innerHTML = `
    <p class="fh-label">${photos.length} ${photos.length === 1 ? 'momento épico' : 'momentos épicos'}</p>
    <div class="hero-grid">
      ${photos
        .map((p) => {
          const url = URL.createObjectURL(p.thumb ?? p.blob);
          thumbURLs.set(p.id, url);
          const season = S.SEASONS[S.getSeason(p.week)];
          return `
            <button type="button" class="hero-card" data-photo="${escapeHtml(p.id)}" aria-label="${escapeHtml(p.title)}, semana ${p.week}">
              <img class="hero-card__img" src="${url}" alt="" loading="lazy" decoding="async" />
              <span class="hero-card__overlay">
                <span class="hero-card__title">${escapeHtml(p.title)}</span>
                <span class="hero-card__meta flex items-center gap-1">${icon(season.icon, `w-3 h-3 ${season.id === 'summer' ? 'text-amber-400' : 'text-sky-400'}`)}Semana ${p.week} · Año ${S.getYear(p.week)}</span>
              </span>
            </button>`;
        })
        .join('')}
    </div>`;
  refreshIcons();
}

async function updateStorageInfo() {
  const el = root.querySelector('[data-storage]');
  const est = await DB.getStorageEstimate();
  const total = photos.reduce((sum, p) => sum + (p.size || 0) + (p.thumb?.size || 0), 0);
  el.textContent = est?.quota
    ? `Fotos: ${DB.formatBytes(total)} · Libre aprox.: ${DB.formatBytes(Math.max(0, est.quota - est.usage))}`
    : photos.length
      ? `Fotos: ${DB.formatBytes(total)}`
      : '';
}

/* ==========================================================================
   Subida
   ========================================================================== */

function setPreview(file) {
  const img = root.querySelector('[data-preview]');
  const hint = root.querySelector('[data-drop-hint]');
  const name = root.querySelector('[data-file-name]');
  if (previewURL) URL.revokeObjectURL(previewURL);
  previewURL = null;

  if (!file) {
    img.hidden = true;
    img.removeAttribute('src');
    hint.hidden = false;
    name.textContent = '';
    return;
  }
  previewURL = URL.createObjectURL(file);
  img.src = previewURL;
  img.hidden = false;
  hint.hidden = true;
  name.textContent = `${file.name || 'foto'} · ${DB.formatBytes(file.size)}`;
  root.querySelector('[data-error]').textContent = '';
}

function bindDropzone(form) {
  const zone = root.querySelector('[data-dropzone]');
  const stop = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };
  ['dragenter', 'dragover'].forEach((t) =>
    zone.addEventListener(t, (e) => {
      stop(e);
      zone.classList.add('is-dragover');
    }),
  );
  ['dragleave', 'drop'].forEach((t) =>
    zone.addEventListener(t, (e) => {
      stop(e);
      zone.classList.remove('is-dragover');
    }),
  );
  zone.addEventListener('drop', (e) => {
    const file = [...(e.dataTransfer?.files ?? [])].find((f) => f.type.startsWith('image/'));
    if (!file) {
      toast('Suelta un archivo de imagen.', { type: 'error' });
      return;
    }
    try {
      const dt = new DataTransfer();
      dt.items.add(file);
      form.file.files = dt.files;
    } catch {
      /* Safari antiguo: guardamos la referencia aparte */
      form.file._dropped = file;
    }
    setPreview(file);
  });
}

async function onSubmit(e) {
  e.preventDefault();
  if (saving) return;
  const form = e.target;
  const error = form.querySelector('[data-error]');
  const file = form.file.files?.[0] ?? form.file._dropped;
  error.textContent = '';

  if (!file) {
    error.textContent = 'Elige una foto primero.';
    return;
  }
  const title = form.elements.namedItem('title').value.trim();
  if (!title) {
    error.textContent = 'Ponle un título épico a este momento.';
    form.elements.namedItem('title').focus();
    return;
  }

  saving = true;
  const button = form.querySelector('button[type="submit"]');
  const label = form.querySelector('[data-submit-label]');
  button.disabled = true;
  label.textContent = 'Comprimiendo…';

  try {
    const record = await DB.addPhoto({
      file,
      title,
      week: Number(form.week.value) || S.getState().calendar.currentWeek,
      description: form.description.value,
    });
    toast(`"${record.title}" ya está en el Salón (${DB.formatBytes(record.size)}).`, { type: 'success' });
    form.reset();
    delete form.file._dropped;
    weekTouched = false;
    form.week.value = S.getState().calendar.currentWeek;
    setPreview(null);
    await loadPhotos();

    if (!persistAsked) {
      persistAsked = true;
      DB.requestPersistentStorage();
    }
  } catch (err) {
    console.error('[gallery]', err);
    error.textContent = err.message;
  } finally {
    saving = false;
    button.disabled = false;
    label.textContent = 'Guardar en el Salón';
  }
}

/* ==========================================================================
   Lightbox
   ========================================================================== */

let lightbox = null;

function openLightbox(id) {
  closeLightbox(true);
  let index = photos.findIndex((p) => p.id === id);
  if (index < 0) return;

  const el = document.createElement('div');
  el.className = 'lightbox';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-label', 'Foto del Salón de los Héroes');
  el.innerHTML = `
    <button type="button" class="modal-close lightbox__close" data-lb="close" aria-label="Cerrar">${icon('x')}</button>
    <div class="lightbox__stage">
      <img class="lightbox__img" alt="" data-lb-img />
    </div>
    <div class="lightbox__info">
      <div class="mx-auto max-w-3xl" data-lb-info></div>
    </div>`;

  const prevFocus = document.activeElement;
  let fullURL = null;
  let editing = false;
  let swipeStart = null;
  let swiped = false;

  const show = () => {
    const p = photos[index];
    if (!p) return close();
    if (fullURL) URL.revokeObjectURL(fullURL);
    fullURL = URL.createObjectURL(p.blob);
    const img = el.querySelector('[data-lb-img]');
    img.src = fullURL;
    img.alt = p.title;
    // Reinicia la animación de entrada.
    img.style.animation = 'none';
    void img.offsetWidth;
    img.style.animation = '';

    const season = S.SEASONS[S.getSeason(p.week)];
    const info = el.querySelector('[data-lb-info]');
    info.innerHTML = editing
      ? `
        <form class="grid gap-2" data-lb-form novalidate>
          <div class="grid grid-cols-[1fr_5.5rem] gap-2">
            <input name="title" class="fh-input" maxlength="120" value="${escapeHtml(p.title)}" aria-label="Título" />
            <input name="week" type="number" min="1" max="80" class="fh-input font-display font-bold" value="${p.week}" aria-label="Semana" />
          </div>
          <textarea name="description" class="fh-textarea !min-h-[60px]" rows="2" maxlength="1000" aria-label="Descripción">${escapeHtml(p.description)}</textarea>
          <div class="flex gap-2 justify-end">
            <button type="button" class="btn btn-ghost btn-icon-sm" data-lb="cancel-edit">Cancelar</button>
            <button type="submit" class="btn btn-gold btn-icon-sm">${icon('save')}Guardar</button>
          </div>
        </form>`
      : `
        <div class="flex items-start gap-3">
          <div class="min-w-0 flex-1">
            <h2 class="font-display text-xl font-bold text-amber-100 break-words">${escapeHtml(p.title)}</h2>
            <div class="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-400">
              <span class="pill ${season.id === 'summer' ? 'pill-gold' : 'pill-ice'}">${icon(season.icon)}Semana ${p.week} · Año ${S.getYear(p.week)}</span>
              <span>Subida el ${escapeHtml(formatDate(p.createdAt))}</span>
              <span>${index + 1} / ${photos.length}</span>
            </div>
          </div>
        </div>
        ${p.description ? `<p class="mt-3 text-sm text-slate-300 whitespace-pre-wrap break-words">${escapeHtml(p.description)}</p>` : ''}
        <div class="mt-4 flex flex-wrap items-center gap-2">
          <button type="button" class="btn btn-ghost btn-icon-only" data-lb="prev" aria-label="Foto anterior" ${photos.length < 2 ? 'disabled' : ''}>${icon('chevron-left')}</button>
          <button type="button" class="btn btn-ghost btn-icon-only" data-lb="next" aria-label="Foto siguiente" ${photos.length < 2 ? 'disabled' : ''}>${icon('chevron-right')}</button>
          <button type="button" class="btn btn-ghost btn-icon-sm ml-auto" data-lb="edit">${icon('pencil')}Editar</button>
          <button type="button" class="btn btn-ghost-danger btn-icon-sm" data-lb="delete">${icon('trash-2')}Eliminar</button>
        </div>`;
    refreshIcons();
  };

  const step = (delta) => {
    if (photos.length < 2) return;
    editing = false;
    index = (index + delta + photos.length) % photos.length;
    show();
  };

  const close = () => {
    if (!el.isConnected) return;
    document.removeEventListener('keydown', onKey);
    if (fullURL) URL.revokeObjectURL(fullURL);
    el.classList.add('is-closing');
    setTimeout(() => el.remove(), 180);
    document.body.classList.remove('lightbox-open');
    lightbox = null;
    if (prevFocus?.isConnected) prevFocus.focus({ preventScroll: true });
  };

  const onKey = (e) => {
    // Si hay un modal de confirmación encima, él gestiona las teclas.
    if (e.defaultPrevented || e.fhHandledByModal || isModalOpen()) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      if (editing) {
        editing = false;
        show();
      } else close();
    } else if (!editing && e.key === 'ArrowLeft') step(-1);
    else if (!editing && e.key === 'ArrowRight') step(1);
  };

  el.addEventListener('click', async (e) => {
    const action = e.target.closest('[data-lb]')?.dataset.lb;
    if (!action) {
      // Un deslizamiento también genera "click": no debe cerrar el visor.
      if (e.target.classList.contains('lightbox__stage') && !swiped) close();
      swiped = false;
      return;
    }
    const p = photos[index];
    if (action === 'close') close();
    else if (action === 'prev') step(-1);
    else if (action === 'next') step(1);
    else if (action === 'edit') {
      editing = true;
      show();
      el.querySelector('[data-lb-form] input')?.focus();
    } else if (action === 'cancel-edit') {
      editing = false;
      show();
    } else if (action === 'delete') {
      const ok = await confirmDialog({
        title: '¿Eliminar esta foto?',
        message: `"${p.title}" se borrará de este dispositivo. Esta acción no se puede deshacer.`,
        confirmText: 'Eliminar',
        danger: true,
      });
      if (!ok) return;
      try {
        await DB.deletePhoto(p.id);
        photos.splice(index, 1);
        toast('Foto eliminada.');
        renderGrid();
        updateStorageInfo();
        if (!photos.length) close();
        else {
          index = Math.min(index, photos.length - 1);
          show();
        }
      } catch (err) {
        toast(`No se pudo eliminar: ${err.message}`, { type: 'error' });
      }
    }
  });

  el.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const p = photos[index];
    try {
      const updated = await DB.updatePhotoMeta(p.id, {
        title: form.elements.namedItem('title').value,
        week: Number(form.week.value) || p.week,
        description: form.description.value,
      });
      if (updated) {
        photos = await DB.getAllPhotos();
        index = Math.max(0, photos.findIndex((x) => x.id === p.id));
        renderGrid();
      }
      editing = false;
      show();
      toast('Datos de la foto actualizados.', { type: 'success' });
    } catch (err) {
      toast(`No se pudo guardar: ${err.message}`, { type: 'error' });
    }
  });

  // Deslizar a izquierda/derecha para navegar en el móvil.
  const stage = el.querySelector('.lightbox__stage');
  stage.addEventListener('pointerdown', (e) => (swipeStart = { x: e.clientX, y: e.clientY }));
  stage.addEventListener('pointerup', (e) => {
    if (!swipeStart) return;
    const dx = e.clientX - swipeStart.x;
    const dy = e.clientY - swipeStart.y;
    swipeStart = null;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      swiped = true;
      step(dx < 0 ? 1 : -1);
    }
  });

  document.getElementById('modal-root').appendChild(el);
  document.body.classList.add('lightbox-open');
  document.addEventListener('keydown', onKey);
  lightbox = { close };
  show();
  el.querySelector('[data-lb="close"]').focus({ preventScroll: true });
}

function closeLightbox() {
  lightbox?.close();
}
