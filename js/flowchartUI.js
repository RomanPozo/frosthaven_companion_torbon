/**
 * flowchartUI.js — Pestaña 2: Árbol de Escenarios.
 *
 * Grafo SVG con pan & zoom (ratón, rueda y gestos táctiles con Pointer Events),
 * nodos arrastrables, conexiones Bézier con flecha y un modal para editar cada
 * escenario y desbloquear misiones nuevas conectadas automáticamente.
 */

import * as S from './state.js';
import * as DB from './db.js';
import { escapeHtml, icon, refreshIcons, toast, openModal, confirmDialog } from './ui.js';
import { readStoredText, openTextEditor, TEXTS_CHANGED } from './narratorUI.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const W = S.NODE_WIDTH;
const H = S.NODE_HEIGHT;
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 2.5;
const DRAG_THRESHOLD = 6;

const STATUS_STYLE = {
  unlocked: { pill: 'pill-ice', icon: 'lock-open', color: '#38bdf8' },
  completed: { pill: 'pill-gold', icon: 'circle-check', color: '#f59e0b' },
  locked: { pill: 'pill-blood', icon: 'lock', color: '#ef4444' },
};

/* Iconos dibujados dentro del SVG (24×24, trazo). */
const SVG_ICONS = {
  completed: '<path d="M20 6 9 17l-5-5"/>',
  locked: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  unlocked: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/>',
};

let root = null;
let svg = null;
let viewport = null;
let gridPattern = null;
let view = { x: 40, y: 40, k: 1 };
let needsFit = true;
let selectedId = null;

/* Estado de interacción con punteros. */
const pointers = new Map();
let gesture = null;

/* ==========================================================================
   Inicialización
   ========================================================================== */

export function initFlowchartUI(el) {
  root = el;
  root.innerHTML = `
    <div class="space-y-3">
      <div class="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 class="section-title">Árbol de Escenarios</h2>
          <p class="section-subtitle">Toca un escenario para editarlo o desbloquear misiones. Arrastra para reorganizar.</p>
        </div>
        <div class="flex flex-wrap gap-1.5" data-counts></div>
      </div>

      <div class="graph-shell">
        <svg class="graph-viewport" role="application" aria-label="Árbol de escenarios. Arrastra para mover el lienzo; usa la rueda o pellizca para hacer zoom.">
          <defs>
            <pattern id="graph-grid" width="28" height="28" patternUnits="userSpaceOnUse">
              <circle class="graph-grid-dot" cx="1.5" cy="1.5" r="1.5"></circle>
            </pattern>
            ${['unlocked', 'completed', 'locked']
              .map(
                (s) => `
              <marker id="arrow-${s}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0 0 10 5 0 10z" fill="${STATUS_STYLE[s].color}" opacity="${s === 'locked' ? 0.6 : 0.9}"></path>
              </marker>`,
              )
              .join('')}
          </defs>
          <rect class="graph-bg" width="100%" height="100%" fill="url(#graph-grid)"></rect>
          <g class="graph-world">
            <g class="graph-edges"></g>
            <g class="graph-nodes"></g>
          </g>
        </svg>

        <div class="graph-toolbar" role="toolbar" aria-label="Controles del árbol">
          <button type="button" class="btn btn-ghost" data-action="zoom-in" title="Acercar" aria-label="Acercar">${icon('zoom-in')}</button>
          <button type="button" class="btn btn-ghost" data-action="zoom-out" title="Alejar" aria-label="Alejar">${icon('zoom-out')}</button>
          <button type="button" class="btn btn-ghost" data-action="fit" title="Encuadrar todo" aria-label="Encuadrar todo">${icon('scan')}</button>
          <button type="button" class="btn btn-ghost" data-action="layout" title="Reorganizar automáticamente" aria-label="Reorganizar automáticamente">${icon('network')}</button>
          <button type="button" class="btn btn-ghost !text-sky-300" data-action="add" title="Añadir escenario suelto" aria-label="Añadir escenario suelto">${icon('plus')}</button>
        </div>
        <p class="graph-hint">Arrastra para mover · Rueda o pellizco para zoom</p>
      </div>
    </div>`;

  svg = root.querySelector('svg');
  viewport = root.querySelector('.graph-world');
  gridPattern = root.querySelector('#graph-grid');

  root.addEventListener('click', onToolbarClick);
  svg.addEventListener('pointerdown', onPointerDown);
  svg.addEventListener('pointermove', onPointerMove);
  svg.addEventListener('pointerup', onPointerUp);
  svg.addEventListener('pointercancel', onPointerUp);
  svg.addEventListener('lostpointercapture', onPointerUp);
  svg.addEventListener('wheel', onWheel, { passive: false });
  svg.addEventListener('keydown', onNodeKeydown);
  svg.addEventListener('dblclick', (e) => {
    if (!e.target.closest('.scn-node')) zoomAt(1.4, pointFromEvent(e));
  });

  if ('ResizeObserver' in window) {
    new ResizeObserver(() => {
      if (needsFit && svg.clientWidth > 0) fitView();
    }).observe(svg);
  }

  S.subscribe((state, { type }) => {
    if (type === 'scenario:move' || type.startsWith('scenario:') || ['campaign:import', 'campaign:reset', 'sync'].includes(type)) {
      if (type === 'campaign:import' || type === 'campaign:reset') needsFit = true;
      renderGraph();
      if (needsFit && svg.clientWidth > 0) fitView();
    }
  });

  renderGraph();
  refreshIcons();

  return {
    onShow() {
      if (needsFit) requestAnimationFrame(fitView);
    },
  };
}

/* ==========================================================================
   Renderizado
   ========================================================================== */

function applyView() {
  const t = `translate(${view.x} ${view.y}) scale(${view.k})`;
  viewport.setAttribute('transform', t);
  gridPattern.setAttribute('patternTransform', t);
}

/** Corta un texto en hasta `maxLines` líneas de ~`perLine` caracteres. */
function wrapText(text, perLine = 25, maxLines = 2) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length <= perLine) {
      line = candidate;
    } else {
      if (line) lines.push(line);
      line = word.length > perLine ? word.slice(0, perLine - 1) + '…' : word;
    }
    if (lines.length === maxLines) break;
  }
  if (line && lines.length < maxLines) lines.push(line);
  const used = lines.join(' ').length;
  if (used < String(text).trim().length && lines.length) {
    const last = lines[lines.length - 1];
    lines[lines.length - 1] = (last.length >= perLine ? last.slice(0, perLine - 1) : last) + '…';
  }
  return lines;
}

function nodeMarkup(node) {
  const style = STATUS_STYLE[node.status];
  const lines = node.name ? wrapText(node.name) : ['Sin nombre'];
  const label = `Escenario ${node.number ? '#' + node.number : ''} ${node.name}, ${S.SCENARIO_STATUS_LABELS[node.status]}`;
  return `
    <g class="scn-node scn-node--${node.status} ${node.id === selectedId ? 'is-selected' : ''}" data-id="${escapeHtml(node.id)}"
       transform="translate(${node.x} ${node.y})" tabindex="0" role="button" aria-label="${escapeHtml(label)}">
      ${node.status === 'unlocked' ? `<rect class="scn-node__glow" x="-5" y="-5" width="${W + 10}" height="${H + 10}" rx="16" fill="none" stroke="#38bdf8" stroke-width="6"></rect>` : ''}
      <rect class="scn-node__card" width="${W}" height="${H}" rx="12"></rect>
      <text class="scn-node__number" x="14" y="29">${node.number ? '#' + escapeHtml(node.number) : '—'}</text>
      ${node.coords ? `<text class="scn-node__coords" x="${W - 40}" y="26" text-anchor="end">${escapeHtml(node.coords)}</text>` : ''}
      <svg x="${W - 32}" y="12" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="${style.color}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${SVG_ICONS[node.status]}</svg>
      ${lines.map((l, i) => `<text class="scn-node__text" x="14" y="${51 + i * 17}">${escapeHtml(l)}</text>`).join('')}
      <text class="scn-node__coords" x="14" y="${H - 10}">${S.SCENARIO_STATUS_LABELS[node.status]}${node.notes.trim() ? ' · con notas' : ''}</text>
    </g>`;
}

/** Puntos de anclaje y path Bézier entre dos nodos. */
function edgePath(from, to) {
  let x1;
  let x2;
  const y1 = from.y + H / 2;
  const y2 = to.y + H / 2;
  if (to.x >= from.x + W / 2) {
    x1 = from.x + W;
    x2 = to.x;
  } else if (to.x + W <= from.x + W / 2) {
    x1 = from.x;
    x2 = to.x + W;
  } else {
    // Uno encima del otro: conectar por arriba/abajo.
    const down = to.y > from.y;
    const sx = from.x + W / 2;
    const ex = to.x + W / 2;
    const sy = down ? from.y + H : from.y;
    const ey = down ? to.y : to.y + H;
    const off = Math.max(30, Math.abs(ey - sy) / 2) * (down ? 1 : -1);
    return `M${sx} ${sy} C${sx} ${sy + off} ${ex} ${ey - off} ${ex} ${ey}`;
  }
  const dir = x2 >= x1 ? 1 : -1;
  const off = Math.max(40, Math.abs(x2 - x1) / 2) * dir;
  return `M${x1} ${y1} C${x1 + off} ${y1} ${x2 - off} ${y2} ${x2} ${y2}`;
}

function edgesMarkup(nodes, edges) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return edges
    .map((e) => {
      const from = byId.get(e.from);
      const to = byId.get(e.to);
      if (!from || !to) return '';
      const d = edgePath(from, to);
      return `
        <g data-edge="${escapeHtml(e.id)}" data-from="${escapeHtml(e.from)}" data-to="${escapeHtml(e.to)}">
          <path class="scn-edge scn-edge--${to.status}" d="${d}" marker-end="url(#arrow-${to.status})"></path>
          <path class="scn-edge-hit" d="${d}"><title>#${escapeHtml(from.number)} → #${escapeHtml(to.number)} (toca para quitar la conexión)</title></path>
        </g>`;
    })
    .join('');
}

function renderGraph() {
  if (!svg) return;
  const { nodes, edges } = S.getState().scenarios;
  if (selectedId && !nodes.some((n) => n.id === selectedId)) selectedId = null;

  root.querySelector('.graph-edges').innerHTML = edgesMarkup(nodes, edges);
  root.querySelector('.graph-nodes').innerHTML = nodes.map(nodeMarkup).join('');
  applyView();

  const count = (s) => nodes.filter((n) => n.status === s).length;
  root.querySelector('[data-counts]').innerHTML = ['completed', 'unlocked', 'locked']
    .map((s) => `<span class="pill ${STATUS_STYLE[s].pill}">${icon(STATUS_STYLE[s].icon)}${count(s)} ${S.SCENARIO_STATUS_LABELS[s].toLowerCase()}${count(s) === 1 ? '' : 's'}</span>`)
    .join('');
  refreshIcons();
}

/** Actualiza solo la posición de un nodo y sus conexiones (durante el arrastre). */
function updateNodePosition(id, x, y) {
  const g = svg.querySelector(`.scn-node[data-id="${CSS.escape(id)}"]`);
  g?.setAttribute('transform', `translate(${x} ${y})`);
  const nodes = S.getState().scenarios.nodes.map((n) => (n.id === id ? { ...n, x, y } : n));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const eg of svg.querySelectorAll(`[data-from="${CSS.escape(id)}"], [data-to="${CSS.escape(id)}"]`)) {
    const d = edgePath(byId.get(eg.dataset.from), byId.get(eg.dataset.to));
    eg.querySelectorAll('path').forEach((p) => p.setAttribute('d', d));
  }
}

/* ==========================================================================
   Vista: zoom, encuadre y centrado
   ========================================================================== */

const clampZoom = (k) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));

function pointFromEvent(e) {
  const r = svg.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function zoomAt(factor, point = { x: svg.clientWidth / 2, y: svg.clientHeight / 2 }) {
  const k = clampZoom(view.k * factor);
  const wx = (point.x - view.x) / view.k;
  const wy = (point.y - view.y) / view.k;
  view = { k, x: point.x - wx * k, y: point.y - wy * k };
  applyView();
}

function fitView() {
  const { nodes } = S.getState().scenarios;
  const width = svg.clientWidth;
  const height = svg.clientHeight;
  if (!width || !height) return;
  needsFit = false;
  if (!nodes.length) {
    view = { x: 40, y: 40, k: 1 };
    applyView();
    return;
  }
  const pad = 48;
  const minX = Math.min(...nodes.map((n) => n.x));
  const minY = Math.min(...nodes.map((n) => n.y));
  const maxX = Math.max(...nodes.map((n) => n.x + W));
  const maxY = Math.max(...nodes.map((n) => n.y + H));
  const k = clampZoom(Math.min((width - pad * 2) / (maxX - minX), (height - pad * 2) / (maxY - minY), 1.2));
  view = {
    k,
    x: (width - (maxX - minX) * k) / 2 - minX * k,
    y: (height - (maxY - minY) * k) / 2 - minY * k,
  };
  applyView();
}

function centerOn(id) {
  const node = S.getScenarioNode(id);
  if (!node || !svg.clientWidth) return;
  view.k = Math.max(view.k, 0.8);
  view.x = svg.clientWidth / 2 - (node.x + W / 2) * view.k;
  view.y = svg.clientHeight / 2 - (node.y + H / 2) * view.k;
  applyView();
}

function onWheel(e) {
  e.preventDefault();
  // ctrlKey = pellizco en trackpad: deltas pequeños.
  const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
  zoomAt(factor, pointFromEvent(e));
}

/* ==========================================================================
   Punteros: pan, arrastre de nodos y pellizco
   ========================================================================== */

function startPinch() {
  const [a, b] = [...pointers.values()];
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  gesture = {
    type: 'pinch',
    dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
    k: view.k,
    world: { x: (mid.x - view.x) / view.k, y: (mid.y - view.y) / view.k },
  };
}

function startPan(p) {
  gesture = { type: 'pan', start: p, origin: { x: view.x, y: view.y } };
}

function onPointerDown(e) {
  if (e.button !== undefined && e.button > 0) return;
  const p = pointFromEvent(e);
  pointers.set(e.pointerId, p);
  try {
    svg.setPointerCapture(e.pointerId);
  } catch {
    /* algunos navegadores no lo permiten en SVG */
  }

  if (pointers.size === 2) {
    if (gesture?.type === 'node' && gesture.moved) finishNodeDrag();
    startPinch();
    return;
  }
  if (pointers.size > 2) return;

  const nodeEl = e.target.closest('.scn-node');
  const edgeEl = e.target.closest('[data-edge]');
  if (nodeEl) {
    const node = S.getScenarioNode(nodeEl.dataset.id);
    gesture = { type: 'node', id: node.id, start: p, origin: { x: node.x, y: node.y }, moved: false, el: nodeEl };
  } else if (edgeEl) {
    gesture = { type: 'edge', id: edgeEl.dataset.edge, start: p };
  } else {
    startPan(p);
    svg.classList.add('is-panning');
  }
}

function onPointerMove(e) {
  if (!pointers.has(e.pointerId) || !gesture) return;
  const p = pointFromEvent(e);
  pointers.set(e.pointerId, p);

  if (gesture.type === 'pinch' && pointers.size >= 2) {
    const [a, b] = [...pointers.values()];
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const k = clampZoom(gesture.k * (Math.hypot(a.x - b.x, a.y - b.y) / gesture.dist));
    view = { k, x: mid.x - gesture.world.x * k, y: mid.y - gesture.world.y * k };
    applyView();
    return;
  }

  const dx = p.x - gesture.start.x;
  const dy = p.y - gesture.start.y;

  if (gesture.type === 'pan') {
    view.x = gesture.origin.x + dx;
    view.y = gesture.origin.y + dy;
    applyView();
  } else if (gesture.type === 'node') {
    if (!gesture.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    if (!gesture.moved) {
      gesture.moved = true;
      gesture.el.classList.add('is-dragging');
      gesture.el.parentNode.appendChild(gesture.el); // traer al frente
    }
    gesture.x = gesture.origin.x + dx / view.k;
    gesture.y = gesture.origin.y + dy / view.k;
    updateNodePosition(gesture.id, gesture.x, gesture.y);
  } else if (gesture.type === 'edge' && Math.hypot(dx, dy) >= DRAG_THRESHOLD) {
    // Un arrastre que empieza sobre una línea se convierte en pan.
    startPan(gesture.start);
    svg.classList.add('is-panning');
  }
}

function finishNodeDrag() {
  if (gesture?.type !== 'node' || !gesture.moved) return;
  gesture.el.classList.remove('is-dragging');
  S.moveScenarioNode(gesture.id, gesture.x, gesture.y, { persist: true });
}

function onPointerUp(e) {
  if (!pointers.has(e.pointerId)) return;
  pointers.delete(e.pointerId);
  svg.classList.remove('is-panning');
  if (!gesture) return;

  if (gesture.type === 'pinch') {
    // Si queda un dedo, seguimos con pan desde su posición.
    if (pointers.size === 1) startPan([...pointers.values()][0]);
    else gesture = null;
    return;
  }

  const g = gesture;
  gesture = null;
  if (e.type !== 'pointerup') {
    if (g.type === 'node' && g.moved) {
      gesture = g;
      finishNodeDrag();
      gesture = null;
    }
    return;
  }

  if (g.type === 'node') {
    if (g.moved) {
      gesture = g;
      finishNodeDrag();
      gesture = null;
    } else {
      selectNode(g.id);
      openNodeModal(g.id);
    }
  } else if (g.type === 'edge') {
    askRemoveEdge(g.id);
  }
}

function onNodeKeydown(e) {
  const nodeEl = e.target.closest?.('.scn-node');
  if (!nodeEl) return;
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    selectNode(nodeEl.dataset.id);
    openNodeModal(nodeEl.dataset.id);
  }
}

function selectNode(id) {
  selectedId = id;
  svg.querySelectorAll('.scn-node.is-selected').forEach((n) => n.classList.remove('is-selected'));
  svg.querySelector(`.scn-node[data-id="${CSS.escape(id)}"]`)?.classList.add('is-selected');
}

/* ==========================================================================
   Barra de herramientas
   ========================================================================== */

async function onToolbarClick(e) {
  const btn = e.target.closest('.graph-toolbar [data-action]');
  if (!btn) return;
  switch (btn.dataset.action) {
    case 'zoom-in':
      zoomAt(1.25);
      break;
    case 'zoom-out':
      zoomAt(0.8);
      break;
    case 'fit':
      fitView();
      break;
    case 'layout': {
      const ok = await confirmDialog({
        title: '¿Reorganizar el árbol?',
        message: 'Los escenarios se colocarán automáticamente por niveles. Perderéis la colocación manual actual.',
        confirmText: 'Reorganizar',
      });
      if (ok) {
        S.autoLayoutScenarios();
        fitView();
      }
      break;
    }
    case 'add':
      openCreateModal();
      break;
    default:
      break;
  }
}

async function askRemoveEdge(edgeId) {
  const edge = S.getState().scenarios.edges.find((e) => e.id === edgeId);
  if (!edge) return;
  const from = S.getScenarioNode(edge.from);
  const to = S.getScenarioNode(edge.to);
  const ok = await confirmDialog({
    title: '¿Quitar esta conexión?',
    message: `Se borrará la flecha de #${from?.number ?? '?'} a #${to?.number ?? '?'}. Los escenarios no se borran.`,
    confirmText: 'Quitar conexión',
    danger: true,
  });
  if (ok) {
    S.disconnectScenarios(edgeId);
    toast('Conexión eliminada.');
  }
}

/* ==========================================================================
   Modales
   ========================================================================== */

function statusPicker(name, current) {
  return `
    <div class="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Estado">
      ${S.SCENARIO_STATUSES.map(
        (s) => `
        <label class="status-option status-option--${s}">
          <input type="radio" name="${name}" value="${s}" class="sr-only" ${s === current ? 'checked' : ''} />
          <span>${icon(STATUS_STYLE[s].icon)}${S.SCENARIO_STATUS_LABELS[s]}</span>
        </label>`,
      ).join('')}
    </div>`;
}

function scenarioFields(prefix, node = {}) {
  return `
    <div class="grid grid-cols-[5.5rem_1fr_5rem] gap-2">
      <div>
        <label class="fh-label" for="${prefix}-number">Nº</label>
        <input id="${prefix}-number" name="number" class="fh-input font-display font-bold" maxlength="12" inputmode="numeric"
          value="${escapeHtml(node.number ?? '')}" placeholder="12" autocomplete="off" />
      </div>
      <div>
        <label class="fh-label" for="${prefix}-name">Nombre</label>
        <input id="${prefix}-name" name="name" class="fh-input" maxlength="100" value="${escapeHtml(node.name ?? '')}" placeholder="Nombre del escenario" autocomplete="off" />
      </div>
      <div>
        <label class="fh-label" for="${prefix}-coords">Coord.</label>
        <input id="${prefix}-coords" name="coords" class="fh-input uppercase" maxlength="12" value="${escapeHtml(node.coords ?? '')}" placeholder="C4" autocomplete="off" />
      </div>
    </div>`;
}

const field = (form, name) => form.elements.namedItem(name);

function relationPills(nodes, emptyText) {
  if (!nodes.length) return `<span class="text-sm text-slate-500">${emptyText}</span>`;
  return nodes
    .map(
      (n) => `<button type="button" class="pill ${STATUS_STYLE[n.status].pill}" data-goto="${escapeHtml(n.id)}">#${escapeHtml(n.number || '?')} ${escapeHtml(n.name)}</button>`,
    )
    .join('');
}

function openNodeModal(id) {
  const node = S.getScenarioNode(id);
  if (!node) return;
  const children = S.getScenarioChildren(id);
  const parents = S.getScenarioParents(id);
  const others = S.getState()
    .scenarios.nodes.filter((n) => n.id !== id && !children.some((c) => c.id === n.id))
    .sort((a, b) => (parseFloat(a.number) || 0) - (parseFloat(b.number) || 0));

  openModal({
    title: `${node.number ? `#${node.number} · ` : ''}${node.name || 'Escenario'}`,
    wide: true,
    content: `
      <div class="mt-3 flex flex-wrap gap-2" data-tts-scenario></div>
      <form class="mt-4 grid gap-3" data-form="edit" novalidate>
        ${scenarioFields('edit', node)}
        <div>
          <span class="fh-label">Estado</span>
          ${statusPicker('status', node.status)}
        </div>
        <div>
          <label class="fh-label" for="edit-notes">Notas: decisiones, botín, recordatorios</label>
          <textarea id="edit-notes" name="notes" class="fh-textarea" rows="4" maxlength="5000"
            placeholder="Elegimos salvar al mercader; conseguimos el plano del Taller…">${escapeHtml(node.notes)}</textarea>
        </div>
        <p class="text-xs text-red-300 min-h-[1rem]" data-error></p>
        <button type="submit" class="btn btn-primary">${icon('save')}Guardar cambios</button>
      </form>

      <div class="mt-5 grid gap-3 text-sm">
        <div class="flex flex-wrap items-center gap-1.5"><span class="fh-label !mb-0 mr-1">Desbloqueado por</span>${relationPills(parents, 'Ninguno (escenario raíz)')}</div>
        <div class="flex flex-wrap items-center gap-1.5"><span class="fh-label !mb-0 mr-1">Desbloquea</span>${relationPills(children, 'Todavía nada')}</div>
      </div>

      <section class="mt-5 rule-card rule-card--gold !p-4">
        <h3 class="rule-card__title !text-base">${icon('sparkles')}Desbloquear Nueva Misión desde este escenario</h3>
        <form class="mt-3 grid gap-3" data-form="unlock" novalidate>
          ${scenarioFields('new')}
          <div>
            <label class="fh-label" for="new-notes">¿Qué nos espera en esta misión?</label>
            <textarea id="new-notes" name="notes" class="fh-textarea" rows="2" maxlength="5000" placeholder="Rumores de una cueva helada al norte…"></textarea>
          </div>
          ${
            node.status !== 'completed'
              ? `<label class="flex items-center gap-2 text-sm text-slate-300">
                  <input type="checkbox" name="completeParent" checked class="w-4 h-4 accent-amber-500" />
                  Marcar #${escapeHtml(node.number || '?')} como completado
                </label>`
              : ''
          }
          <p class="text-xs text-red-300 min-h-[1rem]" data-error></p>
          <button type="submit" class="btn btn-gold">${icon('git-branch-plus')}Añadir y conectar</button>
        </form>
        ${
          others.length
            ? `<form class="mt-4 pt-4 border-t border-slate-700/60 flex gap-2 items-end" data-form="connect">
                <div class="flex-1 min-w-0">
                  <label class="fh-label" for="connect-target">O conectar con uno existente</label>
                  <select id="connect-target" name="target" class="fh-select">
                    ${others.map((n) => `<option value="${escapeHtml(n.id)}">#${escapeHtml(n.number || '?')} ${escapeHtml(n.name)}</option>`).join('')}
                  </select>
                </div>
                <button type="submit" class="btn btn-ghost">${icon('link')}Conectar</button>
              </form>`
            : ''
        }
      </section>

      <div class="mt-5 flex flex-wrap justify-between gap-2">
        <button type="button" class="btn btn-ghost-danger btn-icon-sm" data-action="delete">${icon('trash-2')}Borrar escenario</button>
        <button type="button" class="btn btn-ghost btn-icon-sm" data-modal-close>Cerrar</button>
      </div>`,
    onOpen(panel, modal) {
      bindIntroButton(panel, node.number);
      panel.addEventListener('submit', (e) => {
        e.preventDefault();
        const form = e.target;
        const error = form.querySelector('[data-error]');
        if (error) error.textContent = '';
        try {
          if (form.dataset.form === 'edit') {
            S.updateScenarioNode(id, {
              number: field(form, 'number').value,
              name: field(form, 'name').value,
              coords: field(form, 'coords').value,
              status: field(form, 'status').value,
              notes: field(form, 'notes').value,
            });
            toast('Escenario guardado.', { type: 'success' });
            modal.close();
          } else if (form.dataset.form === 'unlock') {
            const result = S.unlockScenarioFrom(id, {
              number: field(form, 'number').value,
              name: field(form, 'name').value,
              coords: field(form, 'coords').value,
              notes: field(form, 'notes').value,
            });
            if (field(form, 'completeParent')?.checked) S.updateScenarioNode(id, { status: 'completed' });
            toast(
              result.created
                ? `Misión #${result.node.number || result.node.name} desbloqueada.`
                : `El escenario #${result.node.number} ya existía: se ha conectado.`,
              { type: 'success' },
            );
            modal.close();
            selectNode(result.node.id);
            renderGraph();
            centerOn(result.node.id);
          } else if (form.dataset.form === 'connect') {
            S.connectScenarios(id, field(form, 'target').value);
            toast('Escenarios conectados.', { type: 'success' });
            modal.close();
          }
        } catch (err) {
          if (error) error.textContent = err.message;
          else toast(err.message, { type: 'error' });
        }
      });

      panel.addEventListener('click', async (e) => {
        const goto = e.target.closest('[data-goto]');
        if (goto) {
          modal.close();
          selectNode(goto.dataset.goto);
          centerOn(goto.dataset.goto);
          setTimeout(() => openNodeModal(goto.dataset.goto), 220);
          return;
        }
        if (e.target.closest('[data-action="delete"]')) {
          const ok = await confirmDialog({
            title: `¿Borrar ${node.number ? `#${node.number}` : 'este escenario'}?`,
            message: 'Se eliminarán el escenario, sus notas y todas sus conexiones.',
            confirmText: 'Borrar',
            danger: true,
          });
          if (ok) {
            S.removeScenarioNode(id);
            modal.close();
            toast('Escenario eliminado.');
          }
        }
      });
    },
  });
}

/** Botón "Leer introducción" / "Añadir introducción" enlazado con el Narrador. */
function bindIntroButton(panel, number) {
  const slot = panel.querySelector('[data-tts-scenario]');
  if (!slot || !S.normalizeScenarioNumber(number)) return;
  const refresh = async () => {
    if (!panel.isConnected) {
      window.removeEventListener(TEXTS_CHANGED, refresh);
      return;
    }
    const record = await DB.getText('scenario', number).catch(() => null);
    slot.innerHTML = record
      ? `<button type="button" class="btn btn-gold btn-icon-sm" data-intro="read">${icon('volume-2')}Leer introducción</button>`
      : `<button type="button" class="btn btn-ghost btn-icon-sm" data-intro="add">${icon('camera')}Añadir introducción al Narrador</button>`;
    refreshIcons();
  };
  slot.addEventListener('click', (e) => {
    const action = e.target.closest('[data-intro]')?.dataset.intro;
    if (action === 'read') readStoredText('scenario', number);
    else if (action === 'add') openTextEditor({ kind: 'scenario', number });
  });
  window.addEventListener(TEXTS_CHANGED, refresh);
  refresh();
}

function openCreateModal() {
  openModal({
    title: 'Añadir escenario',
    content: `
      <form class="mt-4 grid gap-3" data-form="create" novalidate>
        ${scenarioFields('create')}
        <div>
          <span class="fh-label">Estado</span>
          ${statusPicker('status', 'unlocked')}
        </div>
        <div>
          <label class="fh-label" for="create-notes">Notas</label>
          <textarea id="create-notes" name="notes" class="fh-textarea" rows="3" maxlength="5000"></textarea>
        </div>
        <p class="text-xs text-red-300 min-h-[1rem]" data-error></p>
        <button type="submit" class="btn btn-primary">${icon('plus')}Añadir al árbol</button>
      </form>`,
    onOpen(panel, modal) {
      panel.querySelector('#create-number').focus();
      panel.querySelector('form').addEventListener('submit', (e) => {
        e.preventDefault();
        const form = e.target;
        try {
          if (S.findScenarioByNumber(field(form, 'number').value)) throw new S.ValidationError(`Ya existe el escenario #${field(form, 'number').value.replace(/^#/, '')}.`);
          const node = S.addScenarioNode({
            number: field(form, 'number').value,
            name: field(form, 'name').value,
            coords: field(form, 'coords').value,
            status: field(form, 'status').value,
            notes: field(form, 'notes').value,
          });
          modal.close();
          selectNode(node.id);
          renderGraph();
          centerOn(node.id);
          toast('Escenario añadido. Ábrelo para conectarlo.', { type: 'success' });
        } catch (err) {
          form.querySelector('[data-error]').textContent = err.message;
        }
      });
    },
  });
}
