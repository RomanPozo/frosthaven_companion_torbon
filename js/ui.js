/**
 * ui.js — Utilidades de interfaz compartidas por todos los módulos de UI:
 * escape de HTML, iconos Lucide, toasts, modales, confirmaciones y descargas.
 * No depende del estado; así se evita importar app.js desde las pestañas.
 */

/* ==========================================================================
   HTML e iconos
   ========================================================================== */

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/** Marcador de icono Lucide; se convierte en <svg> con `refreshIcons()`. */
export function icon(name, className = '') {
  return `<i data-lucide="${escapeHtml(name)}" class="${escapeHtml(className)}" aria-hidden="true"></i>`;
}

/** Convierte los <i data-lucide> pendientes en SVG. Seguro si Lucide no cargó. */
export function refreshIcons() {
  const lib = window.lucide;
  if (!lib?.createIcons) return;
  try {
    lib.createIcons(lib.icons ? { icons: lib.icons } : undefined);
  } catch (err) {
    console.warn('[ui] No se pudieron pintar los iconos.', err);
  }
}

/** Crea un elemento a partir de una cadena HTML (primer nodo). */
export function htmlToElement(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html.trim();
  return tpl.content.firstElementChild;
}

export function debounce(fn, wait = 250) {
  let t;
  const wrapped = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
  wrapped.cancel = () => clearTimeout(t);
  return wrapped;
}

export function formatDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' });
}

/* ==========================================================================
   Toasts
   ========================================================================== */

const TOAST_ICONS = { info: 'info', success: 'circle-check', error: 'circle-alert' };

/**
 * Notificación breve. Devuelve `{ update(msg), close() }` (útil para progreso).
 * @param {string} message
 * @param {{ type?: 'info'|'success'|'error', duration?: number }} [opts] duration 0 = no se cierra sola
 */
export function toast(message, { type = 'info', duration = 3200 } = {}) {
  const root = document.getElementById('toast-root');
  if (!root) return { update() {}, close() {} };

  const el = document.createElement('div');
  el.className = `toast toast--${type}`;
  el.innerHTML = `${icon(TOAST_ICONS[type] ?? 'info')}<span class="toast__msg"></span>`;
  el.querySelector('.toast__msg').textContent = message;
  root.appendChild(el);
  refreshIcons();

  let timer;
  const close = () => {
    clearTimeout(timer);
    if (!el.isConnected || el.classList.contains('is-leaving')) return;
    el.classList.add('is-leaving');
    el.addEventListener('animationend', () => el.remove(), { once: true });
    setTimeout(() => el.remove(), 400);
  };
  if (duration > 0) timer = setTimeout(close, duration);
  el.addEventListener('click', close);

  // Máximo 4 a la vez.
  while (root.children.length > 4) root.firstElementChild.remove();

  return {
    update(msg) {
      el.querySelector('.toast__msg').textContent = msg;
    },
    close,
  };
}

/* ==========================================================================
   Modales
   ========================================================================== */

const modalStack = [];
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

document.addEventListener('keydown', (e) => {
  const top = modalStack[modalStack.length - 1];
  if (!top) return;
  if (e.key === 'Escape') {
    // Marca explícita: otras capas (lightbox) no deben cerrarse con la misma tecla,
    // aunque el evento no sea cancelable.
    e.fhHandledByModal = true;
    if (!top.dismissible) return;
    e.preventDefault();
    top.close();
  } else if (e.key === 'Tab') {
    const items = [...top.panel.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }
});

/**
 * Abre un modal (hoja inferior en móvil, diálogo centrado en escritorio).
 *
 * @param {object} opts
 * @param {string} [opts.title]
 * @param {string|Node} opts.content  HTML o nodo para el cuerpo
 * @param {string} [opts.variant]     clase extra del panel (p. ej. 'modal-panel--priority')
 * @param {boolean} [opts.wide]
 * @param {boolean} [opts.dismissible=true] cerrar con Escape, fondo y botón X
 * @param {(panel: HTMLElement, modal: object) => void} [opts.onOpen]
 * @param {() => void} [opts.onClose]
 * @returns {{ panel: HTMLElement, close: (value?: any) => void, closed: Promise<any> }}
 */
export function openModal({ title = '', content = '', variant = '', wide = false, dismissible = true, onOpen, onClose, labelledBy } = {}) {
  const root = document.getElementById('modal-root') ?? document.body;
  const previousFocus = document.activeElement;
  const titleId = labelledBy ?? `modal-title-${Math.random().toString(36).slice(2, 8)}`;

  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal-panel ${wide ? 'modal-panel--wide' : ''} ${escapeHtml(variant)}" role="dialog" aria-modal="true" ${title ? `aria-labelledby="${titleId}"` : ''}>
      <div class="modal-panel__grab" aria-hidden="true"></div>
      ${dismissible ? `<button type="button" class="modal-close" data-modal-close aria-label="Cerrar">${icon('x')}</button>` : ''}
      ${title ? `<h2 id="${titleId}" class="modal-title">${escapeHtml(title)}</h2>` : ''}
      <div class="modal-body"></div>
    </div>`;
  const panel = backdrop.querySelector('.modal-panel');
  const body = backdrop.querySelector('.modal-body');
  if (typeof content === 'string') body.innerHTML = content;
  else if (content) body.appendChild(content);

  let resolveClosed;
  const closed = new Promise((res) => (resolveClosed = res));
  let isClosed = false;

  const modal = {
    panel,
    body,
    dismissible,
    closed,
    close(value) {
      if (isClosed) return;
      isClosed = true;
      const idx = modalStack.indexOf(modal);
      if (idx >= 0) modalStack.splice(idx, 1);
      backdrop.classList.add('is-closing');
      const finish = () => {
        backdrop.remove();
        if (!modalStack.length) document.body.classList.remove('modal-open');
        if (previousFocus && typeof previousFocus.focus === 'function' && previousFocus.isConnected) {
          previousFocus.focus({ preventScroll: true });
        }
      };
      setTimeout(finish, 200);
      try {
        onClose?.(value);
      } finally {
        resolveClosed(value);
      }
    },
  };

  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop && dismissible) modal.close();
    if (e.target.closest('[data-modal-close]')) modal.close();
  });

  root.appendChild(backdrop);
  modalStack.push(modal);
  document.body.classList.add('modal-open');
  refreshIcons();
  onOpen?.(panel, modal);

  // Foco inicial: [autofocus] > primer botón de acción > panel.
  requestAnimationFrame(() => {
    const target = panel.querySelector('[autofocus]') ?? panel.querySelector('.modal-body ' + FOCUSABLE) ?? panel;
    if (target === panel) panel.setAttribute('tabindex', '-1');
    target.focus({ preventScroll: true });
  });

  return modal;
}

/** true si hay algún modal abierto. */
export function isModalOpen() {
  return modalStack.length > 0;
}

/**
 * Diálogo de confirmación. Resuelve true/false.
 * @param {{ title: string, message?: string, confirmText?: string, cancelText?: string, danger?: boolean, html?: string }} opts
 */
export function confirmDialog({ title, message = '', html = '', confirmText = 'Aceptar', cancelText = 'Cancelar', danger = false }) {
  const modal = openModal({
    title,
    content: `
      ${message ? `<p class="mt-3 text-slate-300 leading-relaxed">${escapeHtml(message)}</p>` : ''}
      ${html}
      <div class="mt-6 flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
        <button type="button" class="btn btn-ghost" data-answer="no">${escapeHtml(cancelText)}</button>
        <button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-answer="yes" autofocus>${escapeHtml(confirmText)}</button>
      </div>`,
    onOpen(panel, m) {
      panel.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-answer]');
        if (btn) m.close(btn.dataset.answer === 'yes');
      });
    },
  });
  return modal.closed.then((v) => v === true);
}

/**
 * Diálogo con varias opciones. Resuelve con el `value` elegido o null.
 * @param {{ title: string, message?: string, choices: Array<{ value: string, label: string, hint?: string, variant?: string }> }} opts
 */
export function choiceDialog({ title, message = '', choices = [] }) {
  const modal = openModal({
    title,
    content: `
      ${message ? `<p class="mt-3 text-slate-300 leading-relaxed">${escapeHtml(message)}</p>` : ''}
      <div class="mt-5 grid gap-2">
        ${choices
          .map(
            (c, i) => `
          <button type="button" class="btn ${escapeHtml(c.variant ?? 'btn-ghost')} btn-block !justify-start text-left" data-choice="${escapeHtml(c.value)}" ${i === 0 ? 'autofocus' : ''}>
            <span class="flex flex-col items-start gap-0.5">
              <span>${escapeHtml(c.label)}</span>
              ${c.hint ? `<span class="text-xs font-normal opacity-75">${escapeHtml(c.hint)}</span>` : ''}
            </span>
          </button>`,
          )
          .join('')}
      </div>`,
    onOpen(panel, m) {
      panel.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-choice]');
        if (btn) m.close(btn.dataset.choice);
      });
    },
  });
  return modal.closed.then((v) => (typeof v === 'string' ? v : null));
}

/* ==========================================================================
   Archivos
   ========================================================================== */

/** Descarga texto o Blob como archivo. */
export function downloadFile(filename, data, mime = 'application/json') {
  const blob = data instanceof Blob ? data : new Blob([data], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

/** Lee un File como texto. */
export function readFileAsText(file) {
  if (typeof file.text === 'function') return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}
