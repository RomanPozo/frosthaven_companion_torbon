/**
 * outpostUI.js — Pestaña 1: Fase de Puesto Avanzado.
 *
 * Asistente de 5 subfases:
 *   1. Paso del Tiempo (calendario interactivo de 80 semanas + alertas)
 *   2. Evento de Puesto Avanzado (mazo de la estación, diario y reglas de ataque)
 *   3. Operaciones de Edificios
 *   4. Tiempo Libre (con calculadora de prosperidad)
 *   5. Construcción
 */

import * as S from './state.js';
import * as DB from './db.js';
import { escapeHtml, icon, refreshIcons, toast, openModal, confirmDialog } from './ui.js';
import { readStoredText, openTextEditor, TEXTS_CHANGED } from './narratorUI.js';

const STEP_KEY = 'fh_outpost_step';
const PROSPERITY_KEY = 'fh_prosperity_hint';

const STEPS = [
  { id: 'time', short: 'Tiempo', title: 'Paso del Tiempo', icon: 'hourglass' },
  { id: 'event', short: 'Evento', title: 'Evento de Puesto Avanzado', icon: 'scroll-text' },
  { id: 'operations', short: 'Operaciones', title: 'Operaciones de Edificios', icon: 'cog' },
  { id: 'downtime', short: 'Tiempo Libre', title: 'Tiempo Libre', icon: 'coffee' },
  { id: 'construction', short: 'Construcción', title: 'Construcción', icon: 'hammer' },
];

/* Preferencias locales del dispositivo (no forman parte de la campaña). */
function readPref(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}
function writePref(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* sin almacenamiento: no pasa nada */
  }
}

let root = null;
let activeStep = Math.min(STEPS.length - 1, Math.max(0, Number(readPref(STEP_KEY, 0)) || 0));
let prosperity = Math.min(9, Math.max(1, Number(readPref(PROSPERITY_KEY, 1)) || 1));
let showAllLogs = false;
let advancing = false;

/* ==========================================================================
   Inicialización
   ========================================================================== */

export function initOutpostUI(el) {
  root = el;
  root.addEventListener('click', onClick);
  root.addEventListener('submit', onSubmit);
  root.addEventListener('keydown', onStepperKeydown);
  render();

  S.subscribe((state, { type }) => {
    // El árbol de escenarios y el nombre no afectan a esta pestaña.
    if (type.startsWith('scenario:') || type === 'campaign:rename' || type === 'storage:error') return;
    renderStepBody();
  });

  return {
    onShow() {
      const btn = root.querySelector('.stepper-btn[aria-selected="true"]');
      btn?.scrollIntoView({ block: 'nearest', inline: 'center' });
    },
  };
}

function render() {
  root.innerHTML = `
    <div class="space-y-4">
      <div>
        <h2 class="section-title">Fase de Puesto Avanzado</h2>
        <p class="section-subtitle">Seguid las 5 subfases en orden. Los recursos, la moral y los edificios se llevan en la mesa.</p>
      </div>
      <div class="stepper" role="tablist" aria-label="Subfases del Puesto Avanzado" id="outpost-stepper"></div>
      <div id="outpost-step" class="space-y-4" role="tabpanel" aria-live="polite"></div>
    </div>`;
  renderStepBody();
}

function renderStepper() {
  const el = root.querySelector('#outpost-stepper');
  el.innerHTML = STEPS.map(
    (step, i) => `
    <button type="button" role="tab" class="stepper-btn ${i < activeStep ? 'is-done' : ''}"
      data-action="step" data-step="${i}" aria-selected="${i === activeStep}" tabindex="${i === activeStep ? 0 : -1}"
      title="${escapeHtml(step.title)}">
      <span class="stepper-btn__num">${i < activeStep ? icon('check', 'w-3.5 h-3.5') : i + 1}</span>
      <span>${escapeHtml(step.short)}</span>
    </button>`,
  ).join('');
}

function renderStepBody() {
  if (!root) return;
  renderStepper();
  const state = S.getState();
  const step = STEPS[activeStep];
  const body = root.querySelector('#outpost-step');

  const renderers = [renderTimeStep, renderEventStep, renderOperationsStep, renderDowntimeStep, renderConstructionStep];
  body.innerHTML = `
    <div class="flex items-center gap-3">
      <span class="rule-item__icon !w-10 !h-10 !rounded-xl">${icon(step.icon)}</span>
      <div class="min-w-0">
        <p class="text-[0.7rem] uppercase tracking-[0.14em] font-semibold text-slate-400">Paso ${activeStep + 1} de ${STEPS.length}</p>
        <h3 class="font-display text-lg sm:text-xl font-bold text-slate-50 leading-tight">${escapeHtml(step.title)}</h3>
      </div>
    </div>
    ${renderers[activeStep](state)}
    ${renderStepNav()}`;
  refreshIcons();
}

function renderStepNav() {
  const prev = STEPS[activeStep - 1];
  const next = STEPS[activeStep + 1];
  return `
    <div class="flex items-center justify-between gap-2 pt-2">
      ${
        prev
          ? `<button type="button" class="btn btn-ghost" data-action="prev">${icon('chevron-left')}<span class="hidden sm:inline">${escapeHtml(prev.short)}</span><span class="sm:hidden">Anterior</span></button>`
          : '<span></span>'
      }
      ${
        next
          ? `<button type="button" class="btn btn-primary" data-action="next">Siguiente: ${escapeHtml(next.short)}${icon('chevron-right')}</button>`
          : `<button type="button" class="btn btn-gold" data-action="finish">${icon('flag')}Terminar la fase</button>`
      }
    </div>`;
}

function goToStep(index, { focus = false } = {}) {
  activeStep = Math.min(STEPS.length - 1, Math.max(0, index));
  writePref(STEP_KEY, activeStep);
  renderStepBody();
  const btn = root.querySelector(`.stepper-btn[data-step="${activeStep}"]`);
  btn?.scrollIntoView({ block: 'nearest', inline: 'center' });
  if (focus) btn?.focus();
  const top = root.getBoundingClientRect().top + window.scrollY - (document.getElementById('app-header')?.offsetHeight ?? 0) - 12;
  if (window.scrollY > top) window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
}

/* ==========================================================================
   Helpers de maquetación de reglas
   ========================================================================== */

function ruleItem(iconName, heading, html, tone = '') {
  return `
    <div class="rule-item">
      <span class="rule-item__icon ${tone ? `rule-item__icon--${tone}` : ''}">${icon(iconName)}</span>
      <div><span class="rule-item__heading">${heading}</span>${html}</div>
    </div>`;
}

function ruleCard({ title, iconName, ref = '', tone = '', items }) {
  return `
    <article class="rule-card ${tone ? `rule-card--${tone}` : ''}">
      <h4 class="rule-card__title">${icon(iconName)}<span>${title}</span>${ref ? `<span class="rule-card__ref">${escapeHtml(ref)}</span>` : ''}</h4>
      <div class="rule-list">${items.join('')}</div>
    </article>`;
}

/* ==========================================================================
   Paso 1: Paso del Tiempo
   ========================================================================== */

function renderTimeStep(state) {
  const { currentWeek: week, season, year } = state.calendar;
  const info = S.SEASONS[season];
  const weekInSeason = S.getWeekInSeason(week);
  const thisWeek = S.getScheduledSections(week);
  const upcoming = S.getUpcomingSections(week + 1, 4);
  const remaining = S.WEEKS_PER_SEASON - weekInSeason + 1;
  const nextSeason = S.SEASONS[season === 'summer' ? 'winter' : 'summer'];
  const atEnd = week >= S.MAX_WEEK;

  return `
    <section class="frost-panel p-4 sm:p-5">
      <div class="flex flex-col sm:flex-row sm:items-center gap-4 sm:justify-between">
        <div>
          <p class="fh-label">Semana actual</p>
          <p class="font-display text-4xl font-bold text-white leading-none">Semana ${week}</p>
          <p class="mt-2 text-sm text-slate-400">
            Año ${year} · <span class="${season === 'summer' ? 'hl-gold' : 'hl-ice'}">${info.name}</span> · semana ${weekInSeason} de 10 de la estación
          </p>
          ${
            atEnd
              ? '<p class="mt-1 text-xs text-slate-400">Última semana del calendario de campaña.</p>'
              : `<p class="mt-1 text-xs text-slate-400">${
                  remaining === 1
                    ? `Al avanzar comenzará el <strong class="text-slate-200">${nextSeason.name}</strong>.`
                    : `Faltan ${remaining} semanas para el ${nextSeason.name}.`
                }</p>`
          }
        </div>
        <div class="flex flex-col gap-2 sm:w-64">
          <button type="button" class="btn btn-primary btn-lg btn-block" data-action="advance" ${atEnd ? 'disabled' : ''}>
            ${icon('fast-forward')}Avanzar 1 Semana
          </button>
          <button type="button" class="btn btn-ghost btn-icon-sm self-center" data-action="rewind" ${week <= S.MIN_WEEK ? 'disabled' : ''}>
            ${icon('undo-2')}-1 Semana
          </button>
        </div>
      </div>

      ${
        thisWeek.length
          ? `<div class="mt-4 space-y-2">
              <p class="fh-label !text-red-300">${icon('book-open', 'inline w-3.5 h-3.5 -mt-0.5')} Lecturas de esta semana</p>
              ${thisWeek.map((e) => sectionRow(e)).join('')}
            </div>`
          : ''
      }

      ${
        upcoming.length
          ? `<div class="mt-4">
              <p class="fh-label">Próximas lecturas agendadas</p>
              <ul class="flex flex-wrap gap-2">
                ${upcoming
                  .map(
                    (u) => `<li><button type="button" class="pill pill-blood" data-action="open-week" data-week="${u.week}"
                      title="${escapeHtml(u.note)}">Sem. ${u.week} · ${escapeHtml(u.section)}</button></li>`,
                  )
                  .join('')}
              </ul>
            </div>`
          : ''
      }
    </section>

    <section class="frost-panel p-4 sm:p-5">
      <div class="flex flex-wrap items-end justify-between gap-2 mb-3">
        <div>
          <h4 class="section-title !text-base">Calendario de campaña</h4>
          <p class="section-subtitle">Toca una semana para agendar secciones del Libro de Secciones.</p>
        </div>
        <div class="cal-legend">
          <span><span class="cal-legend__swatch" style="background:#0f172a;border:1px solid #334155"></span>Pasada</span>
          <span><span class="cal-legend__swatch" style="background:#38bdf8"></span>Actual</span>
          <span><span class="cal-legend__swatch" style="background:#ef4444;border-radius:999px;width:8px;height:8px"></span>Sección agendada</span>
        </div>
      </div>
      <div class="grid gap-3 lg:grid-cols-2">
        ${S.getCalendarLayout().map((y) => renderYear(y, state)).join('')}
      </div>
    </section>`;
}

function renderYear({ year, summer, winter }, state) {
  const current = state.calendar.currentWeek;
  const isCurrent = S.getYear(current) === year;
  const row = (weeks, season) => `
    <p class="cal-season-label cal-season-label--${season}">${icon(S.SEASONS[season].icon)}${S.SEASONS[season].name}</p>
    <div class="cal-row">${weeks.map((w) => renderCell(w, season, state)).join('')}</div>`;
  return `
    <div class="cal-year ${isCurrent ? 'is-current' : ''}">
      <p class="cal-year__title">Año ${year}</p>
      ${row(summer, 'summer')}
      ${row(winter, 'winter')}
    </div>`;
}

function renderCell(week, season, state) {
  const current = state.calendar.currentWeek;
  const count = (state.calendar.scheduledSections[week] ?? []).length;
  const status = week < current ? 'past' : week === current ? 'current' : 'future';
  const classes = ['cal-cell', `cal-cell--${season}`, `cal-cell--${status}`, count ? 'cal-cell--has-sections' : ''].join(' ');
  const label = `Semana ${week}, ${S.SEASONS[season].name}${status === 'current' ? ', semana actual' : status === 'past' ? ', pasada' : ''}${
    count ? `, ${count} ${count === 1 ? 'sección agendada' : 'secciones agendadas'}` : ''
  }`;
  return `<button type="button" class="${classes}" data-action="open-week" data-week="${week}" aria-label="${label}"
    ${status === 'current' ? 'aria-current="date"' : ''}>${week}${count > 1 ? `<span class="cal-cell__count">${count}</span>` : ''}</button>`;
}

function sectionRow(entry, { week = null, removable = false } = {}) {
  return `
    <div class="section-entry">
      <span class="section-entry__num">${escapeHtml(entry.section)}</span>
      <span class="flex-1 min-w-0 text-sm text-slate-300 break-words">${entry.note ? escapeHtml(entry.note) : '<span class="text-slate-500">Sin nota</span>'}</span>
      ${
        removable
          ? `<button type="button" class="btn btn-ghost-danger btn-icon-only" data-action="remove-section" data-week="${week}" data-id="${escapeHtml(entry.id)}" aria-label="Borrar sección ${escapeHtml(entry.section)}">${icon('trash-2')}</button>`
          : ''
      }
    </div>`;
}

/* ---------- Modal de una semana: agendar secciones ---------- */

function openWeekModal(week) {
  const season = S.getSeason(week);
  const info = S.SEASONS[season];

  const renderList = (panel) => {
    const entries = S.getScheduledSections(week);
    const current = S.getState().calendar.currentWeek;
    panel.querySelector('[data-week-list]').innerHTML = entries.length
      ? entries.map((e) => sectionRow(e, { week, removable: true })).join('')
      : '<p class="text-sm text-slate-500 py-2">No hay secciones agendadas para esta semana.</p>';
    const setBtn = panel.querySelector('[data-action="set-week"]');
    if (setBtn) setBtn.hidden = current === week;
    panel.querySelector('[data-week-status]').innerHTML =
      week === current
        ? '<span class="pill pill-ice">Semana actual</span>'
        : week < current
          ? '<span class="pill pill-muted">Pasada</span>'
          : `<span class="pill pill-muted">Dentro de ${week - current} ${week - current === 1 ? 'semana' : 'semanas'}</span>`;
    refreshIcons();
  };

  let unsubscribe = () => {};
  const modal = openModal({
    title: `Semana ${week}`,
    content: `
      <div class="mt-2 flex flex-wrap items-center gap-2">
        <span class="pill ${season === 'summer' ? 'pill-gold' : 'pill-ice'}">${icon(info.icon)}${info.name} · Año ${S.getYear(week)}</span>
        <span data-week-status></span>
      </div>

      <div class="mt-4">
        <p class="fh-label">Libro de Secciones</p>
        <div class="space-y-2" data-week-list></div>
      </div>

      <form class="mt-5 grid gap-3" data-form="section" novalidate>
        <div class="grid grid-cols-[7.5rem_1fr] gap-2">
          <div>
            <label class="fh-label" for="sec-number">Sección</label>
            <input id="sec-number" name="section" class="fh-input font-display font-bold" inputmode="decimal"
              placeholder="183.3" autocomplete="off" required autofocus />
          </div>
          <div>
            <label class="fh-label" for="sec-note">Nota (opcional)</label>
            <input id="sec-note" name="note" class="fh-input" maxlength="200" placeholder="Mercader visitante" autocomplete="off" />
          </div>
        </div>
        <p class="text-xs text-red-300 min-h-[1rem]" data-error></p>
        <button type="submit" class="btn btn-primary btn-block">${icon('plus')}Agendar sección</button>
      </form>

      <div class="mt-4 pt-4 border-t border-slate-700/60 flex flex-wrap gap-2 justify-between">
        <button type="button" class="btn btn-ghost btn-icon-sm" data-action="set-week">${icon('calendar-check')}Fijar como semana actual</button>
        <button type="button" class="btn btn-ghost btn-icon-sm ml-auto" data-modal-close>Cerrar</button>
      </div>`,
    onOpen(panel) {
      renderList(panel);
      unsubscribe = S.subscribe(() => renderList(panel), ['calendar:*', 'campaign:import', 'campaign:reset', 'sync']);

      const form = panel.querySelector('[data-form="section"]');
      const error = panel.querySelector('[data-error]');
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        error.textContent = '';
        try {
          const entry = S.addScheduledSection(week, form.section.value, form.note.value);
          form.reset();
          form.section.focus();
          toast(`Sección ${entry.section} agendada en la semana ${week}.`, { type: 'success' });
        } catch (err) {
          error.textContent = err.message;
          form.section.focus();
        }
      });

      panel.addEventListener('click', async (e) => {
        const remove = e.target.closest('[data-action="remove-section"]');
        if (remove) {
          S.removeScheduledSection(week, remove.dataset.id);
          toast('Sección eliminada.');
          return;
        }
        if (e.target.closest('[data-action="set-week"]')) {
          const ok = await confirmDialog({
            title: `¿Saltar a la semana ${week}?`,
            message:
              'Úsalo solo para corregir el calendario. Al saltar no se lanzan las alertas de lecturas ni de cambio de estación de las semanas intermedias.',
            confirmText: 'Fijar semana',
          });
          if (ok) {
            S.setCurrentWeek(week);
            toast(`Semana actual: ${week}.`, { type: 'success' });
          }
        }
      });
    },
    onClose: () => unsubscribe(),
  });
  return modal;
}

/* ---------- Avanzar / retroceder ---------- */

async function doAdvance() {
  if (advancing) return;
  advancing = true;
  try {
    const result = S.advanceWeek();
    if (!result.changed) {
      toast('Habéis llegado a la semana 80: fin del calendario de campaña.', { type: 'error' });
      return;
    }
    // Si hay alertas, el modal ya informa; el toast solo estorbaría.
    if (!result.sections.length && !result.seasonChanged) {
      toast(`Semana ${result.to} · Año ${result.year} · ${result.seasonName}`, { type: 'success' });
    }
    if (result.sections.length) await showSectionAlert(result);
    if (result.seasonChanged) await showSeasonAlert(result);
  } finally {
    advancing = false;
  }
}

function doRewind() {
  const result = S.rewindWeek();
  if (!result.changed) return;
  toast(
    result.seasonChanged
      ? `Vuelta a la semana ${result.to}: de nuevo ${result.seasonName}. Recordad cambiar los mazos.`
      : `Vuelta a la semana ${result.to}.`,
  );
}

function joinList(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} y ${items[items.length - 1]}`;
}

function showSectionAlert({ to, sections }) {
  const numbers = sections.map((s) => `<strong class="text-red-200">${escapeHtml(s.section)}</strong>`);
  const modal = openModal({
    title: '¡Lectura del Libro de Secciones!',
    variant: 'modal-panel--priority',
    dismissible: false,
    content: `
      <p class="mt-3 text-slate-200 leading-relaxed">
        Antes de continuar, leed inmediatamente ${sections.length > 1 ? 'las secciones' : 'la sección'}
        ${joinList(numbers)} en el Libro de Secciones.
      </p>
      <div class="mt-4 grid gap-3">
        ${sections
          .map(
            (s) => `
          <div class="flex items-center gap-4 p-3 rounded-xl bg-slate-950/50 border border-red-500/30">
            ${icon('book-open', 'w-7 h-7 text-red-400 shrink-0')}
            <div class="min-w-0 flex-1">
              <p class="priority-section-number">${escapeHtml(s.section)}</p>
              ${s.note ? `<p class="mt-1 text-sm text-slate-300 break-words">${escapeHtml(s.note)}</p>` : ''}
              <div class="mt-2" data-tts="${escapeHtml(s.section)}"></div>
            </div>
          </div>`,
          )
          .join('')}
      </div>
      <p class="mt-3 text-xs text-slate-400">Agendada para la semana ${to}.</p>
      <button type="button" class="btn btn-danger btn-lg btn-block mt-5" data-modal-close autofocus>
        ${icon('check')}${sections.length > 1 ? 'Leídas' : 'Leída'}, continuar
      </button>`,
    onOpen(panel) {
      bindNarratorButtons(panel);
    },
  });
  return modal.closed;
}

/**
 * Rellena los huecos [data-tts] de una alerta con "Leer en voz alta" (si el
 * texto está en el Narrador) o "Añadir texto" (abre el editor con OCR).
 */
function bindNarratorButtons(panel) {
  const refresh = async () => {
    if (!panel.isConnected) {
      window.removeEventListener(TEXTS_CHANGED, refresh);
      return;
    }
    for (const slot of panel.querySelectorAll('[data-tts]')) {
      const record = await DB.getText('section', slot.dataset.tts).catch(() => null);
      slot.innerHTML = record
        ? `<button type="button" class="btn btn-gold btn-icon-sm" data-tts-read="${escapeHtml(slot.dataset.tts)}">${icon('volume-2')}Leer en voz alta</button>`
        : `<button type="button" class="btn btn-ghost btn-icon-sm" data-tts-add="${escapeHtml(slot.dataset.tts)}">${icon('camera')}Añadir texto al Narrador</button>`;
    }
    refreshIcons();
  };
  panel.addEventListener('click', (e) => {
    const read = e.target.closest('[data-tts-read]');
    if (read) readStoredText('section', read.dataset.ttsRead);
    const add = e.target.closest('[data-tts-add]');
    if (add) openTextEditor({ kind: 'section', number: add.dataset.ttsAdd });
  });
  window.addEventListener(TEXTS_CHANGED, refresh);
  refresh();
}

function showSeasonAlert({ season }) {
  const info = S.SEASONS[season];
  const modal = openModal({
    title: '¡Cambio de Estación!',
    variant: `modal-panel--season-${season}`,
    dismissible: false,
    content: `
      <div class="season-hero-icon season-hero-icon--${season}">${icon(info.icon)}</div>
      <p class="text-center font-display text-2xl font-bold ${season === 'summer' ? 'text-amber-300' : 'text-sky-200'}">
        Comienza el ${info.name}
      </p>
      <p class="mt-3 text-center text-slate-200 leading-relaxed">
        A partir de ahora usad los mazos de <strong>Eventos de Camino</strong> y de
        <strong>Puesto Avanzado</strong> de <span class="${season === 'summer' ? 'hl-gold' : 'hl-ice'}">${info.name}</span>.
      </p>
      <button type="button" class="btn ${season === 'summer' ? 'btn-gold' : 'btn-primary'} btn-lg btn-block mt-6" data-modal-close autofocus>
        ${icon('layers')}Mazos cambiados
      </button>`,
  });
  return modal.closed;
}

/* ==========================================================================
   Paso 2: Evento de Puesto Avanzado
   ========================================================================== */

function renderEventStep(state) {
  const { currentWeek: week, season } = state.calendar;
  const info = S.SEASONS[season];
  const logs = showAllLogs ? S.getEventLogs() : S.getEventLogs(week);
  const total = state.eventLogs.length;

  return `
    <div class="deck-banner deck-banner--${season}">
      ${icon(info.icon)}
      <div>
        <p class="text-xs uppercase tracking-[0.14em] font-semibold opacity-80">Hoy toca robar del</p>
        <p class="font-display text-lg sm:text-xl font-bold text-white">Mazo de Puesto Avanzado de ${info.name}</p>
        <p class="text-xs mt-0.5 opacity-80">Semana ${week} · Año ${state.calendar.year}</p>
      </div>
    </div>

    <section class="frost-panel p-4 sm:p-5">
      <h4 class="section-title !text-base flex items-center gap-2">${icon('notebook-pen', 'w-5 h-5 text-sky-400')}Diario de la semana ${week}</h4>
      <p class="section-subtitle">Opcional: apuntad la carta jugada y qué pasó.</p>
      <form class="mt-3 grid gap-3" data-form="log" novalidate>
        <div class="grid grid-cols-[8rem_1fr] gap-2 items-start">
          <div>
            <label class="fh-label" for="log-card">Nº carta</label>
            <input id="log-card" name="cardNumber" class="fh-input font-display font-bold" maxlength="20" placeholder="${season === 'summer' ? 'SO-05' : 'WO-12'}" autocomplete="off" />
          </div>
          <div>
            <label class="fh-label" for="log-notes">Resumen</label>
            <textarea id="log-notes" name="notes" class="fh-textarea !min-h-[44px]" rows="2" maxlength="4000" placeholder="Atacaron los Algox; el Aserradero quedó dañado…"></textarea>
          </div>
        </div>
        <p class="text-xs text-red-300 min-h-[1rem] -mt-1" data-error></p>
        <button type="submit" class="btn btn-primary sm:self-end">${icon('save')}Guardar en el diario</button>
      </form>

      <div class="mt-4 flex items-center justify-between gap-2">
        <p class="fh-label !mb-0">${showAllLogs ? `Diario completo (${total})` : 'Entradas de esta semana'}</p>
        ${
          total
            ? `<button type="button" class="btn btn-ghost btn-icon-sm" data-action="toggle-logs">${
                showAllLogs ? `${icon('filter')}Solo esta semana` : `${icon('list')}Ver todo (${total})`
              }</button>`
            : ''
        }
      </div>
      <div class="mt-2 space-y-2">
        ${logs.length ? logs.map(renderLog).join('') : '<p class="text-sm text-slate-500 py-2">Todavía no hay entradas.</p>'}
      </div>
    </section>

    ${ruleCard({
      title: 'Resolución de Ataques',
      iconName: 'swords',
      ref: 'Manual p. 60-61',
      tone: 'blood',
      items: [
        ruleItem(
          'crosshair',
          'Prioridad y objetivos',
          `Mirad el <strong>valor de Ataque</strong>, el <strong>número de Objetivos</strong> y el <strong>orden de prioridad</strong> de la carta. Haced un <em>chequeo de defensa independiente</em> por cada edificio atacado.`,
          'blood',
        ),
        ruleItem(
          'shield-half',
          'Uso de Soldados',
          `Si el <strong>Barracón</strong> no está en ruinas, <em>antes de robar carta</em> podéis gastar Soldados para ganar <span class="hl-gold">Ventaja</span> en el chequeo y reducir el valor del ataque (según el nivel del Barracón). Si el Barracón está <span class="hl-blood">en ruinas</span>, tenéis <span class="hl-blood">Desventaja</span>.`,
        ),
        ruleItem(
          'shield',
          'Chequeo de Defensa',
          `Sumad <span class="formula">Defensa total + Modificador del evento + Carta de la Guardia</span>. Si <strong>iguala o supera</strong> el valor de ataque, el edificio <span class="hl-gold">se defiende</span>.`,
          'gold',
        ),
        ruleItem(
          'flame',
          'Dañado vs. En Ruinas',
          `Si falla, el edificio queda <strong>Dañado</strong>: pagad al momento su coste de reparación en materiales de cualquier suministro <em>o</em> perded <span class="hl-blood">1 de Moral</span>. Si el evento o la carta indica <span class="hl-blood">En Ruinas</span>, voltead la carta del edificio a su lado destruido.<br><span class="text-slate-400 text-[0.85em]">No resolváis daños ni ruinas hasta terminar todo el ataque, y barajad el mazo de la Guardia al acabar.</span>`,
          'blood',
        ),
      ],
    })}`;
}

function renderLog(log) {
  const info = S.SEASONS[log.season];
  return `
    <article class="p-3 rounded-xl bg-slate-950/50 border border-slate-700/50">
      <div class="flex items-center gap-2 flex-wrap">
        <span class="pill ${log.season === 'summer' ? 'pill-gold' : 'pill-ice'}">${icon(info.icon)}Sem. ${log.week}</span>
        ${log.cardNumber ? `<span class="font-display font-bold text-slate-100">Carta ${escapeHtml(log.cardNumber)}</span>` : ''}
        <button type="button" class="btn btn-ghost-danger btn-icon-only ml-auto !p-1.5" data-action="delete-log" data-id="${escapeHtml(log.id)}" aria-label="Borrar entrada del diario">${icon('trash-2', 'w-4 h-4')}</button>
      </div>
      ${log.notes ? `<p class="mt-2 text-sm text-slate-300 whitespace-pre-wrap break-words">${escapeHtml(log.notes)}</p>` : ''}
    </article>`;
}

/* ==========================================================================
   Paso 3: Operaciones de Edificios
   ========================================================================== */

function renderOperationsStep() {
  return ruleCard({
    title: 'Operaciones de Edificios',
    iconName: 'cog',
    ref: 'Manual p. 62',
    items: [
      ruleItem(
        'arrow-down-1-0',
        'Orden estricto',
        `Recorred vuestro mazo físico de edificios construidos en <strong>orden numérico ascendente</strong> según su número de referencia, <em>uno por uno</em>.`,
      ),
      ruleItem(
        'triangle-alert',
        'Efectos normales y en ruinas',
        `Resolved el efecto superior de cada carta (icono de <strong>engranaje</strong>). <span class="hl-blood">¡Importante!</span> Cualquier edificio que haya quedado <span class="hl-blood">En Ruinas</span> durante el ataque del Paso 2 resuelve <strong>ahora</strong> su efecto negativo de ruina, antes de poder reconstruirlo en el Paso 5.`,
        'blood',
      ),
      ruleItem(
        'coins',
        'Pagos y ganancias',
        `El oro o los recursos ganados o perdidos pueden sumarse o restarse del <strong>Suministro de Frosthaven</strong> o de los <strong>suministros personales</strong> de los héroes, en cualquier combinación.`,
        'gold',
      ),
    ],
  });
}

/* ==========================================================================
   Paso 4: Tiempo Libre
   ========================================================================== */

function renderDowntimeStep() {
  const maxLevel = Math.ceil(prosperity / 2);
  const startGold = 10 * prosperity + 20;

  return `
    <section class="frost-panel p-4 sm:p-5">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h4 class="section-title !text-base flex items-center gap-2">${icon('calculator', 'w-5 h-5 text-sky-400')}Calculadora rápida</h4>
          <p class="section-subtitle">Indica el Nivel de Prosperidad actual (solo se usa aquí).</p>
        </div>
        <div class="flex items-center gap-2" role="group" aria-label="Nivel de Prosperidad">
          <button type="button" class="btn btn-ghost btn-icon-only" data-action="prosperity" data-delta="-1" aria-label="Bajar prosperidad" ${prosperity <= 1 ? 'disabled' : ''}>${icon('minus')}</button>
          <span class="font-display text-2xl font-bold w-10 text-center text-white" aria-live="polite">${prosperity}</span>
          <button type="button" class="btn btn-ghost btn-icon-only" data-action="prosperity" data-delta="1" aria-label="Subir prosperidad" ${prosperity >= 9 ? 'disabled' : ''}>${icon('plus')}</button>
        </div>
      </div>
      <div class="mt-4 grid grid-cols-2 gap-2">
        <div class="stat-chip !py-3">
          <span class="stat-chip__label">Nivel gratuito máx.</span>
          <span class="stat-chip__value !text-2xl text-sky-300">${maxLevel}</span>
          <span class="text-[0.7rem] text-slate-400">⌈${prosperity} / 2⌉</span>
        </div>
        <div class="stat-chip !py-3">
          <span class="stat-chip__label">Oro personaje nuevo</span>
          <span class="stat-chip__value !text-2xl text-amber-300">${startGold}</span>
          <span class="text-[0.7rem] text-slate-400">10 × ${prosperity} + 20</span>
        </div>
      </div>
    </section>

    ${ruleCard({
      title: 'Tiempo Libre',
      iconName: 'coffee',
      ref: 'En cualquier orden',
      tone: 'gold',
      items: [
        `<p class="text-sm text-slate-400 -mb-1">${icon('ban', 'inline w-4 h-4 -mt-0.5 text-red-400')} Si el edificio asociado a una acción está <span class="hl-blood">En Ruinas</span>, no se puede interactuar con él.</p>`,
        ruleItem(
          'trending-up',
          'Subir de nivel',
          `<strong>Obligatorio</strong> si alcanzas la XP requerida. Opcionalmente puedes subir gratis hasta el nivel <span class="formula">⌈Prosperidad / 2⌉</span> (redondeado hacia arriba), ajustando tu XP al mínimo de ese nuevo nivel.`,
        ),
        ruleItem(
          'user-minus',
          'Retirar un personaje',
          `Si cumples tu Misión Personal, <strong>debes</strong> retirarte. El grupo gana <span class="hl-gold">+2 de Prosperidad</span> y abre el sobre indicado. <span class="text-slate-400">(Opcional: gastar <strong>15 de Inspiración</strong> una vez para completar al instante una segunda Misión Personal.)</span> Tus recursos pasan al Suministro de Frosthaven, tus objetos vuelven al suministro disponible y <span class="hl-blood">tu oro se pierde</span>.`,
          'gold',
        ),
        ruleItem(
          'user-plus',
          'Crear un nuevo personaje',
          `Empieza en <strong>nivel 1</strong> (puede subir al instante hasta <span class="formula">⌈Prosperidad / 2⌉</span>), gana <strong>1 Pericia</strong> por cada personaje que ese jugador haya retirado antes y recibe <span class="formula">10 × Prosperidad + 20</span> de oro para gastar <em>inmediatamente</em> en objetos comprables (el sobrante se pierde).`,
        ),
        ruleItem(
          'hammer',
          'Elaborar objetos (Artesano)',
          `Los <strong>Materiales</strong> (Madera, Metal, Piel) <span class="hl-blood">DEBEN</span> pagarse del suministro personal del héroe, no del de Frosthaven. Las <strong>Hierbas</strong> sí pueden salir del suministro personal o del de Frosthaven.`,
        ),
        ruleItem(
          'flask-conical',
          'Pociones (Alquimista)',
          `Gasta <strong>2 hierbas</strong> cualesquiera (<strong>3</strong> en Nivel 3) de cualquier suministro para revelar la casilla de la tabla de alquimia. En <strong>Nivel 2+</strong> puedes <em>destilar</em> una poción ya descubierta devolviéndola para recuperar 1 hierba de su receta.`,
        ),
        ruleItem(
          'hand-coins',
          'Vender objetos',
          `Los objetos con coste en oro se venden por <span class="formula">⌊coste / 2⌋</span> (redondeado hacia abajo). Los objetos <em>elaborados</em> se venden por <span class="formula">2 oro × recurso u objeto</span> de su receta.`,
          'gold',
        ),
      ],
    })}`;
}

/* ==========================================================================
   Paso 5: Construcción
   ========================================================================== */

function renderConstructionStep() {
  return ruleCard({
    title: 'Construcción',
    iconName: 'building-2',
    ref: 'Manual p. 68',
    items: [
      ruleItem(
        'hammer',
        '1. Construir o mejorar (máximo 1 por fase)',
        `Construid un edificio nuevo desbloqueado (pegatina <strong>L0</strong>) o mejorad uno existente pagando sus materiales desde el <strong>Suministro de Frosthaven</strong>. Podéis gastar <span class="hl-ice">Inspiración</span> como comodín: <span class="formula">1 Inspiración = 1 Material</span>.`,
      ),
      ruleItem(
        'heart-crack',
        'Construcción extra',
        `Podéis perder <span class="hl-blood">2 de Moral</span> para hacer una <strong>segunda</strong> construcción o mejora en la misma fase.`,
        'blood',
      ),
      ruleItem(
        'octagon-alert',
        'Restricciones',
        `El nivel de un edificio <strong>nunca</strong> puede superar el <strong>Nivel de Prosperidad</strong> actual. No se puede mejorar un edificio <span class="hl-blood">En Ruinas</span>.`,
        'blood',
      ),
      ruleItem(
        'wrench',
        '2. Reconstruir',
        `<strong>Después</strong> de construir y mejorar, podéis reconstruir <em>cualquier cantidad</em> de edificios En Ruinas pagando su coste de reconstrucción desde el Suministro de Frosthaven y volteando su carta al lado normal.`,
        'gold',
      ),
    ],
  });
}

/* ==========================================================================
   Eventos
   ========================================================================== */

async function onClick(e) {
  const btn = e.target.closest('[data-action]');
  if (!btn || !root.contains(btn) || btn.disabled) return;

  switch (btn.dataset.action) {
    case 'step':
      goToStep(Number(btn.dataset.step));
      break;
    case 'prev':
      goToStep(activeStep - 1);
      break;
    case 'next':
      goToStep(activeStep + 1);
      break;
    case 'finish':
      toast('¡Fase de Puesto Avanzado completada! A por el siguiente escenario.', { type: 'success' });
      goToStep(0);
      break;
    case 'advance':
      await doAdvance();
      break;
    case 'rewind':
      doRewind();
      break;
    case 'open-week':
      openWeekModal(Number(btn.dataset.week));
      break;
    case 'toggle-logs':
      showAllLogs = !showAllLogs;
      renderStepBody();
      break;
    case 'delete-log': {
      const ok = await confirmDialog({
        title: '¿Borrar esta entrada del diario?',
        message: 'La entrada se eliminará definitivamente.',
        confirmText: 'Borrar',
        danger: true,
      });
      if (ok) {
        S.removeEventLog(btn.dataset.id);
        toast('Entrada eliminada.');
      }
      break;
    }
    case 'prosperity':
      prosperity = Math.min(9, Math.max(1, prosperity + Number(btn.dataset.delta)));
      writePref(PROSPERITY_KEY, prosperity);
      renderStepBody();
      root.querySelector(`[data-action="prosperity"][data-delta="${btn.dataset.delta}"]`)?.focus();
      break;
    default:
      break;
  }
}

function onSubmit(e) {
  const form = e.target.closest('form[data-form="log"]');
  if (!form) return;
  e.preventDefault();
  const error = form.querySelector('[data-error]');
  try {
    S.addEventLog({ cardNumber: form.cardNumber.value, notes: form.notes.value });
    toast('Entrada guardada en el diario.', { type: 'success' });
  } catch (err) {
    error.textContent = err.message;
  }
}

function onStepperKeydown(e) {
  const btn = e.target.closest('.stepper-btn');
  if (!btn) return;
  const keys = { ArrowRight: 1, ArrowLeft: -1, Home: -Infinity, End: Infinity };
  if (!(e.key in keys)) return;
  e.preventDefault();
  const delta = keys[e.key];
  const target = Number.isFinite(delta) ? activeStep + delta : delta < 0 ? 0 : STEPS.length - 1;
  goToStep(target, { focus: true });
}
