/**
 * state.js — Estado centralizado de la campaña.
 *
 * Patrón: store ligero con mutaciones mediante acciones, notificación a
 * suscriptores y persistencia automática en LocalStorage (`fh_campaign_state`).
 * El estado expuesto está congelado (solo lectura); toda modificación pasa por
 * las acciones exportadas.
 *
 * Las imágenes NUNCA se guardan aquí: viven en IndexedDB (ver db.js).
 */

/* ==========================================================================
   Constantes
   ========================================================================== */

export const STORAGE_KEY = 'fh_campaign_state';
export const STATE_VERSION = 1;
export const BACKUP_APP_ID = 'frosthaven-companion';

export const DEFAULT_CAMPAIGN_NAME = 'Campaña de Frosthaven';
export const MAX_CAMPAIGN_NAME = 80;

export const MIN_WEEK = 1;
export const MAX_WEEK = 80;
export const WEEKS_PER_SEASON = 10;
export const WEEKS_PER_YEAR = 20;
export const TOTAL_YEARS = 4;

export const SEASONS = Object.freeze({
  summer: Object.freeze({ id: 'summer', name: 'Verano', icon: 'sun', color: 'gold' }),
  winter: Object.freeze({ id: 'winter', name: 'Invierno', icon: 'snowflake', color: 'ice' }),
});

export const SCENARIO_STATUSES = Object.freeze(['unlocked', 'completed', 'locked']);
export const SCENARIO_STATUS_LABELS = Object.freeze({
  unlocked: 'Disponible',
  completed: 'Completado',
  locked: 'Bloqueado',
});

/** Geometría de nodos del árbol de escenarios (unidades del lienzo). */
export const NODE_WIDTH = 220;
export const NODE_HEIGHT = 96;
export const NODE_GAP_X = 90;
export const NODE_GAP_Y = 36;

const LIMITS = Object.freeze({
  sectionNote: 200,
  cardNumber: 20,
  logNotes: 4000,
  scenarioNumber: 12,
  scenarioName: 100,
  scenarioCoords: 12,
  scenarioNotes: 5000,
});

/* ==========================================================================
   Utilidades puras de calendario
   ========================================================================== */

/** Normaliza cualquier valor a una semana válida (1-80). */
export function clampWeek(week) {
  const n = Math.round(Number(week));
  if (!Number.isFinite(n)) return MIN_WEEK;
  return Math.min(MAX_WEEK, Math.max(MIN_WEEK, n));
}

/**
 * Regla oficial: cada estación dura 10 semanas, empezando en verano.
 * 1-10, 21-30, 41-50, 61-70 → 'summer'; 11-20, 31-40, 51-60, 71-80 → 'winter'.
 */
export function getSeason(week) {
  return Math.floor((clampWeek(week) - 1) / WEEKS_PER_SEASON) % 2 === 0 ? 'summer' : 'winter';
}

/** Año de campaña (1-4). */
export function getYear(week) {
  return Math.ceil(clampWeek(week) / WEEKS_PER_YEAR);
}

/** Posición de la semana dentro de su estación (1-10). */
export function getWeekInSeason(week) {
  return ((clampWeek(week) - 1) % WEEKS_PER_SEASON) + 1;
}

/** Información de la estación lista para pintar. */
export function getSeasonInfo(week) {
  return SEASONS[getSeason(week)];
}

/** true si pasar de `fromWeek` a `toWeek` cambia de estación. */
export function isSeasonChange(fromWeek, toWeek) {
  return getSeason(fromWeek) !== getSeason(toWeek);
}

/**
 * Estructura del calendario completo para la cuadrícula:
 * [{ year: 1, summer: [1..10], winter: [11..20] }, ...]
 */
export function getCalendarLayout() {
  const years = [];
  for (let y = 1; y <= TOTAL_YEARS; y++) {
    const start = (y - 1) * WEEKS_PER_YEAR + 1;
    years.push({
      year: y,
      summer: Array.from({ length: WEEKS_PER_SEASON }, (_, i) => start + i),
      winter: Array.from({ length: WEEKS_PER_SEASON }, (_, i) => start + WEEKS_PER_SEASON + i),
    });
  }
  return years;
}

/**
 * Normaliza un número del Libro de Secciones: "183,3" → "183.3".
 * Devuelve null si el formato no es válido (p. ej. "abc" o "1.2.3").
 */
export function normalizeSectionNumber(value) {
  const s = String(value ?? '').trim().replace(',', '.').replace(/\s+/g, '');
  return /^\d{1,4}(\.\d{1,2})?$/.test(s) ? s : null;
}

/**
 * Normaliza un número de escenario: "#23" → "23", "12a" → "12A".
 * Devuelve null si está vacío o tiene caracteres extraños.
 */
export function normalizeScenarioNumber(value) {
  const s = String(value ?? '').trim().replace(/^#/, '').replace(/\s+/g, '').toUpperCase();
  return /^[0-9A-Z][0-9A-Z.-]{0,11}$/.test(s) ? s : null;
}

/* ==========================================================================
   Errores y helpers internos
   ========================================================================== */

/** Error de validación con mensaje listo para mostrar al usuario. */
export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

export function uid(prefix = 'id') {
  const rnd =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 12)
      : Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  return `${prefix}_${rnd}`;
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v, max, fallback = '') => (typeof v === 'string' || typeof v === 'number' ? String(v).trim().slice(0, max) : fallback);
const longText = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const finiteOr = (v, fallback) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : fallback);
const nowISO = () => new Date().toISOString();

const clone = (obj) =>
  typeof structuredClone === 'function' ? structuredClone(obj) : JSON.parse(JSON.stringify(obj));

function deepFreeze(obj) {
  if (obj && typeof obj === 'object' && !Object.isFrozen(obj)) {
    Object.freeze(obj);
    for (const key of Object.keys(obj)) deepFreeze(obj[key]);
  }
  return obj;
}

/* ==========================================================================
   Estado por defecto y saneado
   ========================================================================== */

function defaultScenarios() {
  const t = nowISO();
  const y = 160;
  return {
    nodes: [
      {
        id: 'scn_0',
        number: '0',
        name: 'Howling in the Snow',
        coords: '',
        status: 'unlocked',
        notes: '',
        x: 60,
        y,
        createdAt: t,
        updatedAt: t,
      },
      {
        id: 'scn_1',
        number: '1',
        name: 'A Town in Flames',
        coords: '',
        status: 'unlocked',
        notes: '',
        x: 60 + NODE_WIDTH + NODE_GAP_X,
        y,
        createdAt: t,
        updatedAt: t,
      },
    ],
    edges: [{ id: 'edge_0_1', from: 'scn_0', to: 'scn_1' }],
  };
}

export function createDefaultState() {
  return withDerived({
    version: STATE_VERSION,
    campaignName: DEFAULT_CAMPAIGN_NAME,
    calendar: {
      currentWeek: 1,
      season: 'summer',
      year: 1,
      scheduledSections: {},
    },
    eventLogs: [],
    scenarios: defaultScenarios(),
    updatedAt: nowISO(),
  });
}

/** Recalcula los campos derivados (estación y año) a partir de la semana. */
function withDerived(s) {
  s.calendar.currentWeek = clampWeek(s.calendar.currentWeek);
  s.calendar.season = getSeason(s.calendar.currentWeek);
  s.calendar.year = getYear(s.calendar.currentWeek);
  return s;
}

function sanitizeScheduledSections(raw) {
  const out = {};
  if (!isPlainObject(raw)) return out;
  for (const [key, list] of Object.entries(raw)) {
    const week = Number(key);
    if (!Number.isInteger(week) || week < MIN_WEEK || week > MAX_WEEK || !Array.isArray(list)) continue;
    const entries = [];
    for (const item of list) {
      const entry = typeof item === 'string' ? { section: item } : item;
      if (!isPlainObject(entry)) continue;
      const section = normalizeSectionNumber(entry.section);
      if (!section) continue;
      entries.push({
        id: str(entry.id, 64) || uid('sec'),
        section,
        note: str(entry.note, LIMITS.sectionNote),
      });
    }
    if (entries.length) out[week] = entries;
  }
  return out;
}

function sanitizeEventLogs(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(isPlainObject)
    .map((log) => {
      const week = clampWeek(log.week);
      return {
        id: str(log.id, 64) || uid('log'),
        week,
        season: getSeason(week),
        cardNumber: str(log.cardNumber, LIMITS.cardNumber),
        notes: longText(log.notes, LIMITS.logNotes),
        createdAt: str(log.createdAt, 40) || nowISO(),
      };
    })
    .filter((log) => log.cardNumber || log.notes.trim());
}

function sanitizeNode(raw, index) {
  return {
    id: str(raw.id, 64) || uid('scn'),
    number: str(raw.number, LIMITS.scenarioNumber),
    name: str(raw.name, LIMITS.scenarioName),
    coords: str(raw.coords, LIMITS.scenarioCoords).toUpperCase(),
    status: SCENARIO_STATUSES.includes(raw.status) ? raw.status : 'unlocked',
    notes: longText(raw.notes, LIMITS.scenarioNotes),
    x: finiteOr(raw.x, 60 + (index % 4) * (NODE_WIDTH + NODE_GAP_X)),
    y: finiteOr(raw.y, 60 + Math.floor(index / 4) * (NODE_HEIGHT + NODE_GAP_Y)),
    createdAt: str(raw.createdAt, 40) || nowISO(),
    updatedAt: str(raw.updatedAt, 40) || nowISO(),
  };
}

/**
 * Acepta `{ nodes, edges }` o, por compatibilidad, un array plano mezclando
 * nodos y conexiones (las conexiones se reconocen por tener `from`/`to`).
 * Los nodos pueden declarar también `unlocks: [idHijo, ...]`.
 */
function sanitizeScenarios(raw) {
  let rawNodes = [];
  let rawEdges = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!isPlainObject(item)) continue;
      if ('from' in item && 'to' in item) rawEdges.push(item);
      else rawNodes.push(item);
    }
  } else if (isPlainObject(raw)) {
    rawNodes = Array.isArray(raw.nodes) ? raw.nodes.filter(isPlainObject) : [];
    rawEdges = Array.isArray(raw.edges) ? raw.edges.filter(isPlainObject) : Array.isArray(raw.links) ? raw.links.filter(isPlainObject) : [];
  } else {
    return defaultScenarios();
  }

  const seen = new Set();
  const nodes = [];
  rawNodes.forEach((n, i) => {
    const node = sanitizeNode(n, i);
    if (seen.has(node.id)) node.id = uid('scn');
    seen.add(node.id);
    nodes.push(node);
    if (Array.isArray(n.unlocks)) for (const to of n.unlocks) rawEdges.push({ from: node.id, to });
  });

  const edgeKeys = new Set();
  const edges = [];
  for (const e of rawEdges) {
    const from = str(e.from, 64);
    const to = str(e.to, 64);
    const key = `${from}->${to}`;
    if (!seen.has(from) || !seen.has(to) || from === to || edgeKeys.has(key)) continue;
    edgeKeys.add(key);
    edges.push({ id: str(e.id, 64) || uid('edge'), from, to });
  }
  return { nodes, edges };
}

/** Convierte cualquier objeto (LocalStorage, backup...) en un estado válido. */
export function sanitizeState(raw) {
  if (!isPlainObject(raw)) return createDefaultState();
  const cal = isPlainObject(raw.calendar) ? raw.calendar : {};
  return withDerived({
    version: STATE_VERSION,
    campaignName: str(raw.campaignName, MAX_CAMPAIGN_NAME) || DEFAULT_CAMPAIGN_NAME,
    calendar: {
      currentWeek: clampWeek(cal.currentWeek ?? 1),
      season: 'summer',
      year: 1,
      scheduledSections: sanitizeScheduledSections(cal.scheduledSections),
    },
    eventLogs: sanitizeEventLogs(raw.eventLogs),
    scenarios: 'scenarios' in raw ? sanitizeScenarios(raw.scenarios) : defaultScenarios(),
    updatedAt: str(raw.updatedAt, 40) || nowISO(),
  });
}

/* ==========================================================================
   Persistencia
   ========================================================================== */

let storageAvailable = true;

function loadFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return createDefaultState();
    return sanitizeState(JSON.parse(raw));
  } catch (err) {
    console.warn('[state] No se pudo leer LocalStorage, se usa el estado por defecto.', err);
    storageAvailable = false;
    return createDefaultState();
  }
}

function saveToStorage() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    storageAvailable = true;
    return true;
  } catch (err) {
    storageAvailable = false;
    console.error('[state] Error guardando en LocalStorage.', err);
    emit('storage:error', { error: err });
    return false;
  }
}

/** true si el último guardado/lectura en LocalStorage funcionó. */
export function isStorageAvailable() {
  return storageAvailable;
}

/* ==========================================================================
   Store
   ========================================================================== */

let state = deepFreeze(loadFromStorage());
const listeners = new Set();

function emit(type, payload) {
  for (const fn of [...listeners]) {
    try {
      fn(state, { type, payload });
    } catch (err) {
      console.error('[state] Error en un suscriptor:', err);
    }
  }
}

/**
 * Aplica una mutación sobre una copia del estado, recalcula derivados,
 * persiste y notifica. Devuelve lo que devuelva el mutador.
 */
function commit(type, mutator, { persist = true, notify = true } = {}) {
  const draft = clone(state);
  const result = mutator(draft);
  draft.updatedAt = nowISO();
  state = deepFreeze(withDerived(draft));
  if (persist) saveToStorage();
  if (notify) emit(type, result);
  return result;
}

/** Estado actual (congelado, solo lectura). */
export function getState() {
  return state;
}

/**
 * Suscribe un listener `(state, { type, payload }) => void`.
 * Si se pasa `types`, solo se notifica para esos tipos de acción
 * (admite prefijos con comodín, p. ej. 'scenario:*').
 * Devuelve la función para cancelar la suscripción.
 */
export function subscribe(listener, types = null) {
  const filter = types ? new Set([].concat(types)) : null;
  const wrapped = filter
    ? (s, meta) => {
        const prefix = meta.type.split(':')[0] + ':*';
        if (filter.has(meta.type) || filter.has(prefix)) listener(s, meta);
      }
    : listener;
  listeners.add(wrapped);
  return () => listeners.delete(wrapped);
}

/** Fuerza el guardado (p. ej. al terminar de arrastrar un nodo). */
export function persistNow() {
  return saveToStorage();
}

// Sincronización entre pestañas del navegador abiertas a la vez.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== STORAGE_KEY || !e.newValue) return;
    try {
      state = deepFreeze(sanitizeState(JSON.parse(e.newValue)));
      emit('sync', null);
    } catch (err) {
      console.warn('[state] Cambio externo ignorado (JSON inválido).', err);
    }
  });
}

/* ==========================================================================
   Acciones: campaña
   ========================================================================== */

export function setCampaignName(name) {
  const clean = str(name, MAX_CAMPAIGN_NAME) || DEFAULT_CAMPAIGN_NAME;
  if (clean === state.campaignName) return clean;
  return commit('campaign:rename', (s) => (s.campaignName = clean));
}

export function resetCampaign() {
  state = deepFreeze(createDefaultState());
  saveToStorage();
  emit('campaign:reset', null);
  return state;
}

/* ==========================================================================
   Acciones: calendario
   ========================================================================== */

function weekChange(from, to) {
  const seasonChanged = isSeasonChange(from, to);
  return {
    changed: from !== to,
    from,
    to,
    week: to,
    season: getSeason(to),
    seasonName: SEASONS[getSeason(to)].name,
    year: getYear(to),
    seasonChanged,
    sections: clone(state.calendar.scheduledSections[to] ?? []),
  };
}

/**
 * Avanza una semana. Devuelve información para que la UI lance las alertas:
 * `{ changed, from, to, season, seasonName, year, seasonChanged, sections: [...] }`.
 * Si ya estáis en la semana 80 → `{ changed: false, reason: 'max' }`.
 */
export function advanceWeek() {
  const from = state.calendar.currentWeek;
  if (from >= MAX_WEEK) return { changed: false, reason: 'max', from, to: from };
  return commit('calendar:advance', (s) => {
    s.calendar.currentWeek = from + 1;
    return weekChange(from, from + 1);
  });
}

/** Retrocede una semana (corrección de errores). Misma forma de respuesta. */
export function rewindWeek() {
  const from = state.calendar.currentWeek;
  if (from <= MIN_WEEK) return { changed: false, reason: 'min', from, to: from };
  return commit('calendar:rewind', (s) => {
    s.calendar.currentWeek = from - 1;
    return weekChange(from, from - 1);
  });
}

/** Salta directamente a una semana concreta (no dispara alertas por sí solo). */
export function setCurrentWeek(week) {
  const from = state.calendar.currentWeek;
  const to = clampWeek(week);
  if (from === to) return weekChange(from, to);
  return commit('calendar:set', (s) => {
    s.calendar.currentWeek = to;
    return weekChange(from, to);
  });
}

export function getScheduledSections(week) {
  return state.calendar.scheduledSections[clampWeek(week)] ?? [];
}

/** Set con las semanas que tienen alguna sección agendada. */
export function getWeeksWithSections() {
  return new Set(Object.keys(state.calendar.scheduledSections).map(Number));
}

/** Próximas lecturas agendadas a partir de `fromWeek` (incluida). */
export function getUpcomingSections(fromWeek = state.calendar.currentWeek, limit = 10) {
  const out = [];
  const weeks = Object.keys(state.calendar.scheduledSections)
    .map(Number)
    .filter((w) => w >= fromWeek)
    .sort((a, b) => a - b);
  for (const week of weeks) {
    for (const entry of state.calendar.scheduledSections[week]) {
      out.push({ week, ...entry });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/**
 * Agenda una sección del Libro de Secciones en una semana.
 * Lanza ValidationError si el número no es válido o ya está agendado.
 */
export function addScheduledSection(week, section, note = '') {
  const w = clampWeek(week);
  const normalized = normalizeSectionNumber(section);
  if (!normalized) throw new ValidationError('Número de sección no válido. Usa el formato 183.3 o 183.');
  const existing = state.calendar.scheduledSections[w] ?? [];
  if (existing.some((e) => e.section === normalized)) {
    throw new ValidationError(`La sección ${normalized} ya está agendada en la semana ${w}.`);
  }
  const entry = { id: uid('sec'), section: normalized, note: str(note, LIMITS.sectionNote) };
  commit('calendar:section-add', (s) => {
    (s.calendar.scheduledSections[w] ??= []).push(entry);
    return { week: w, entry };
  });
  return entry;
}

export function updateScheduledSection(week, entryId, patch = {}) {
  const w = clampWeek(week);
  const list = state.calendar.scheduledSections[w] ?? [];
  const current = list.find((e) => e.id === entryId);
  if (!current) return null;
  const section = patch.section !== undefined ? normalizeSectionNumber(patch.section) : current.section;
  if (!section) throw new ValidationError('Número de sección no válido. Usa el formato 183.3 o 183.');
  if (list.some((e) => e.id !== entryId && e.section === section)) {
    throw new ValidationError(`La sección ${section} ya está agendada en la semana ${w}.`);
  }
  return commit('calendar:section-update', (s) => {
    const entry = s.calendar.scheduledSections[w].find((e) => e.id === entryId);
    entry.section = section;
    if (patch.note !== undefined) entry.note = str(patch.note, LIMITS.sectionNote);
    return { week: w, entry: clone(entry) };
  });
}

export function removeScheduledSection(week, entryId) {
  const w = clampWeek(week);
  if (!(state.calendar.scheduledSections[w] ?? []).some((e) => e.id === entryId)) return false;
  commit('calendar:section-remove', (s) => {
    const next = s.calendar.scheduledSections[w].filter((e) => e.id !== entryId);
    if (next.length) s.calendar.scheduledSections[w] = next;
    else delete s.calendar.scheduledSections[w];
    return { week: w, id: entryId };
  });
  return true;
}

/* ==========================================================================
   Acciones: diario de eventos
   ========================================================================== */

/** Registros del diario; si se indica `week`, solo los de esa semana. Más recientes primero. */
export function getEventLogs(week = null) {
  const list = week == null ? [...state.eventLogs] : state.eventLogs.filter((l) => l.week === clampWeek(week));
  return list.sort((a, b) => b.week - a.week || b.createdAt.localeCompare(a.createdAt));
}

export function addEventLog({ week = state.calendar.currentWeek, cardNumber = '', notes = '' } = {}) {
  const w = clampWeek(week);
  const log = {
    id: uid('log'),
    week: w,
    season: getSeason(w),
    cardNumber: str(cardNumber, LIMITS.cardNumber),
    notes: longText(notes, LIMITS.logNotes),
    createdAt: nowISO(),
  };
  if (!log.cardNumber && !log.notes.trim()) {
    throw new ValidationError('Indica al menos el número de carta o unas notas.');
  }
  commit('log:add', (s) => {
    s.eventLogs.push(log);
    return log;
  });
  return log;
}

export function updateEventLog(id, patch = {}) {
  if (!state.eventLogs.some((l) => l.id === id)) return null;
  return commit('log:update', (s) => {
    const log = s.eventLogs.find((l) => l.id === id);
    if (patch.week !== undefined) {
      log.week = clampWeek(patch.week);
      log.season = getSeason(log.week);
    }
    if (patch.cardNumber !== undefined) log.cardNumber = str(patch.cardNumber, LIMITS.cardNumber);
    if (patch.notes !== undefined) log.notes = longText(patch.notes, LIMITS.logNotes);
    return clone(log);
  });
}

export function removeEventLog(id) {
  if (!state.eventLogs.some((l) => l.id === id)) return false;
  commit('log:remove', (s) => {
    s.eventLogs = s.eventLogs.filter((l) => l.id !== id);
    return { id };
  });
  return true;
}

/* ==========================================================================
   Acciones: árbol de escenarios
   ========================================================================== */

export function getScenarioNode(id) {
  return state.scenarios.nodes.find((n) => n.id === id) ?? null;
}

export function findScenarioByNumber(number) {
  const n = str(number, LIMITS.scenarioNumber).replace(/^#/, '');
  return n ? state.scenarios.nodes.find((node) => node.number === n) ?? null : null;
}

export function getScenarioChildren(id) {
  const ids = state.scenarios.edges.filter((e) => e.from === id).map((e) => e.to);
  return state.scenarios.nodes.filter((n) => ids.includes(n.id));
}

export function getScenarioParents(id) {
  const ids = state.scenarios.edges.filter((e) => e.to === id).map((e) => e.from);
  return state.scenarios.nodes.filter((n) => ids.includes(n.id));
}

function overlaps(nodes, x, y, ignoreId = null) {
  const padX = NODE_GAP_X / 2;
  const padY = NODE_GAP_Y / 2;
  return nodes.some(
    (n) =>
      n.id !== ignoreId &&
      x < n.x + NODE_WIDTH + padX &&
      x + NODE_WIDTH + padX > n.x &&
      y < n.y + NODE_HEIGHT + padY &&
      y + NODE_HEIGHT + padY > n.y,
  );
}

/**
 * Busca una posición libre para un nodo nuevo. Con padre: en la columna a su
 * derecha, probando alternativamente por debajo y por encima de su altura.
 * Sin padre: debajo del nodo más bajo de la columna izquierda.
 */
export function findFreePosition(parentId = null, nodes = state.scenarios.nodes) {
  const parent = parentId ? nodes.find((n) => n.id === parentId) : null;
  const stepY = NODE_HEIGHT + NODE_GAP_Y;

  if (parent) {
    const x = parent.x + NODE_WIDTH + NODE_GAP_X;
    for (let i = 0; i < 200; i++) {
      const k = Math.ceil(i / 2);
      const y = parent.y + (i % 2 === 0 ? k : -k) * stepY;
      if (!overlaps(nodes, x, y)) return { x, y };
    }
  }

  const minX = nodes.length ? Math.min(...nodes.map((n) => n.x)) : 60;
  const x = parent ? parent.x + NODE_WIDTH + NODE_GAP_X : minX;
  const maxY = nodes.length ? Math.max(...nodes.map((n) => n.y)) : 60 - stepY;
  let y = maxY + stepY;
  while (overlaps(nodes, x, y)) y += stepY;
  return { x, y };
}

function buildNode(data, position) {
  const t = nowISO();
  const number = str(data.number, LIMITS.scenarioNumber).replace(/^#/, '');
  const name = str(data.name, LIMITS.scenarioName);
  if (!number && !name) throw new ValidationError('Indica al menos el número o el nombre del escenario.');
  return {
    id: uid('scn'),
    number,
    name,
    coords: str(data.coords, LIMITS.scenarioCoords).toUpperCase(),
    status: SCENARIO_STATUSES.includes(data.status) ? data.status : 'unlocked',
    notes: longText(data.notes, LIMITS.scenarioNotes),
    x: finiteOr(data.x, position.x),
    y: finiteOr(data.y, position.y),
    createdAt: t,
    updatedAt: t,
  };
}

/** Crea un nodo suelto (sin padre). */
export function addScenarioNode(data = {}) {
  const node = buildNode(data, findFreePosition(null));
  commit('scenario:add', (s) => {
    s.scenarios.nodes.push(node);
    return node;
  });
  return node;
}

/**
 * Flujo de "Desbloquear Nueva Misión desde este escenario".
 * Si ya existe un escenario con ese número, solo se conecta (no se duplica).
 * Devuelve `{ node, created, edge }`.
 */
export function unlockScenarioFrom(parentId, data = {}) {
  if (!getScenarioNode(parentId)) throw new ValidationError('El escenario de origen ya no existe.');
  const existing = findScenarioByNumber(data.number);

  if (existing) {
    if (existing.id === parentId) throw new ValidationError('Un escenario no puede desbloquearse a sí mismo.');
    const edge = connectScenarios(parentId, existing.id);
    return { node: getScenarioNode(existing.id), created: false, edge };
  }

  const node = buildNode({ status: 'unlocked', ...data }, findFreePosition(parentId));
  const edge = { id: uid('edge'), from: parentId, to: node.id };
  commit('scenario:unlock', (s) => {
    s.scenarios.nodes.push(node);
    s.scenarios.edges.push(edge);
    return { node, edge, parentId };
  });
  return { node, created: true, edge };
}

export function updateScenarioNode(id, patch = {}) {
  if (!getScenarioNode(id)) return null;
  if (patch.number !== undefined) {
    const dup = findScenarioByNumber(patch.number);
    if (dup && dup.id !== id) throw new ValidationError(`Ya existe el escenario #${dup.number}.`);
  }
  return commit('scenario:update', (s) => {
    const node = s.scenarios.nodes.find((n) => n.id === id);
    if (patch.number !== undefined) node.number = str(patch.number, LIMITS.scenarioNumber).replace(/^#/, '');
    if (patch.name !== undefined) node.name = str(patch.name, LIMITS.scenarioName);
    if (patch.coords !== undefined) node.coords = str(patch.coords, LIMITS.scenarioCoords).toUpperCase();
    if (patch.status !== undefined && SCENARIO_STATUSES.includes(patch.status)) node.status = patch.status;
    if (patch.notes !== undefined) node.notes = longText(patch.notes, LIMITS.scenarioNotes);
    if (!node.number && !node.name) throw new ValidationError('El escenario necesita número o nombre.');
    node.updatedAt = nowISO();
    return clone(node);
  });
}

/**
 * Mueve un nodo. Durante el arrastre usar `{ persist: false }` y llamar a
 * `persistNow()` (o a esta función con persist: true) al soltar.
 */
export function moveScenarioNode(id, x, y, { persist = true, notify = true } = {}) {
  if (!getScenarioNode(id) || !Number.isFinite(x) || !Number.isFinite(y)) return false;
  commit(
    'scenario:move',
    (s) => {
      const node = s.scenarios.nodes.find((n) => n.id === id);
      node.x = Math.round(x);
      node.y = Math.round(y);
      return { id, x: node.x, y: node.y };
    },
    { persist, notify },
  );
  return true;
}

export function removeScenarioNode(id) {
  if (!getScenarioNode(id)) return false;
  commit('scenario:remove', (s) => {
    s.scenarios.nodes = s.scenarios.nodes.filter((n) => n.id !== id);
    s.scenarios.edges = s.scenarios.edges.filter((e) => e.from !== id && e.to !== id);
    return { id };
  });
  return true;
}

/** Conecta dos escenarios (padre → hijo). Devuelve la conexión (nueva o existente). */
export function connectScenarios(fromId, toId) {
  if (fromId === toId) throw new ValidationError('Un escenario no puede conectarse consigo mismo.');
  if (!getScenarioNode(fromId) || !getScenarioNode(toId)) throw new ValidationError('Escenario no encontrado.');
  const existing = state.scenarios.edges.find((e) => e.from === fromId && e.to === toId);
  if (existing) return existing;
  const edge = { id: uid('edge'), from: fromId, to: toId };
  commit('scenario:connect', (s) => {
    s.scenarios.edges.push(edge);
    return edge;
  });
  return edge;
}

export function disconnectScenarios(edgeId) {
  if (!state.scenarios.edges.some((e) => e.id === edgeId)) return false;
  commit('scenario:disconnect', (s) => {
    s.scenarios.edges = s.scenarios.edges.filter((e) => e.id !== edgeId);
    return { id: edgeId };
  });
  return true;
}

/**
 * Reorganiza el árbol por niveles: cada nodo va en la columna de su camino
 * más largo desde una raíz. Tolera ciclos.
 */
export function autoLayoutScenarios() {
  const { nodes, edges } = state.scenarios;
  if (!nodes.length) return false;

  const incoming = new Map(nodes.map((n) => [n.id, 0]));
  for (const e of edges) incoming.set(e.to, (incoming.get(e.to) ?? 0) + 1);

  const depth = new Map();
  const roots = nodes.filter((n) => incoming.get(n.id) === 0).map((n) => n.id);
  const queue = (roots.length ? roots : [nodes[0].id]).map((id) => [id, 0]);
  let guard = nodes.length * Math.max(edges.length, 1) + nodes.length;

  while (queue.length && guard-- > 0) {
    const [id, d] = queue.shift();
    if ((depth.get(id) ?? -1) >= d) continue;
    depth.set(id, d);
    for (const e of edges) if (e.from === id && d + 1 < nodes.length) queue.push([e.to, d + 1]);
  }
  for (const n of nodes) if (!depth.has(n.id)) depth.set(n.id, 0);

  const columns = new Map();
  const byNumber = (a, b) => (parseFloat(a.number) || 0) - (parseFloat(b.number) || 0) || a.name.localeCompare(b.name);
  for (const n of [...nodes].sort(byNumber)) {
    const d = depth.get(n.id);
    if (!columns.has(d)) columns.set(d, []);
    columns.get(d).push(n.id);
  }

  commit('scenario:layout', (s) => {
    for (const [d, ids] of columns) {
      ids.forEach((id, row) => {
        const node = s.scenarios.nodes.find((n) => n.id === id);
        node.x = 60 + d * (NODE_WIDTH + NODE_GAP_X);
        node.y = 60 + row * (NODE_HEIGHT + NODE_GAP_Y);
      });
    }
  });
  return true;
}

/* ==========================================================================
   Backups JSON
   ========================================================================== */

/**
 * Objeto listo para `JSON.stringify`. `extras` permite adjuntar datos externos
 * (p. ej. las fotos exportadas desde db.js) sin mezclarlos con el estado.
 */
export function exportBackup(extras = {}) {
  return {
    app: BACKUP_APP_ID,
    version: STATE_VERSION,
    exportedAt: nowISO(),
    state: clone(state),
    ...extras,
  };
}

export function backupFilename() {
  const slug =
    state.campaignName
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'campana';
  const date = new Date().toISOString().slice(0, 10);
  return `frosthaven-${slug}-semana-${state.calendar.currentWeek}-${date}.json`;
}

/**
 * Importa un backup (objeto ya parseado o texto JSON). Acepta el envoltorio
 * generado por `exportBackup` o un estado "pelado". Reemplaza el estado actual.
 */
export function importBackup(input) {
  let data = input;
  if (typeof input === 'string') {
    try {
      data = JSON.parse(input);
    } catch {
      throw new ValidationError('El archivo no es un JSON válido.');
    }
  }
  if (!isPlainObject(data)) throw new ValidationError('El backup está vacío o tiene un formato desconocido.');
  if (data.app && data.app !== BACKUP_APP_ID) {
    throw new ValidationError('Este archivo no parece un backup de Frosthaven Companion.');
  }
  const raw = isPlainObject(data.state) ? data.state : data;
  if (!('calendar' in raw) && !('scenarios' in raw) && !('campaignName' in raw)) {
    throw new ValidationError('El backup no contiene datos de campaña reconocibles.');
  }

  state = deepFreeze(sanitizeState(raw));
  saveToStorage();
  emit('campaign:import', null);
  return {
    campaignName: state.campaignName,
    week: state.calendar.currentWeek,
    scenarios: state.scenarios.nodes.length,
    logs: state.eventLogs.length,
  };
}
