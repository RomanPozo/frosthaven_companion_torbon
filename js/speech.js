/**
 * speech.js — Motor de lectura en voz alta (Web Speech API, voces del sistema).
 *
 * - Divide el texto en frases cortas y las encadena: evita el corte de ~15 s
 *   de Chrome y permite resaltar la frase actual y saltar entre frases.
 * - "Pausa" = cancelar y recordar la frase (pause/resume nativos fallan en Android).
 * - Muestra una mini barra flotante con los controles mientras lee, visible
 *   desde cualquier pestaña o modal.
 */

import { escapeHtml, icon, refreshIcons } from './ui.js';

const PREF_KEY = 'fh_voice_prefs';
const MAX_CHUNK = 220;

const listeners = new Set();
let voices = [];
let prefs = loadPrefs();
let token = 0;
let bar = null;

/** Estado público de la lectura. */
let state = { status: 'idle', id: null, title: '', chunks: [], index: 0 };

export function isSpeechSupported() {
  return typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
}

function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(PREF_KEY) ?? '{}');
    return { voiceURI: typeof p.voiceURI === 'string' ? p.voiceURI : '', rate: Number(p.rate) || 1 };
  } catch {
    return { voiceURI: '', rate: 1 };
  }
}
function savePrefs() {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify(prefs));
  } catch {
    /* preferencia no crítica */
  }
}

function emit() {
  for (const fn of [...listeners]) {
    try {
      fn(state);
    } catch (err) {
      console.error('[speech]', err);
    }
  }
  renderBar();
}

/** Suscripción a cambios `(state) => void`. Devuelve la función para anularla. */
export function onSpeechChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getSpeechState() {
  return state;
}

/* ==========================================================================
   Voces
   ========================================================================== */

function refreshVoices() {
  voices = speechSynthesis.getVoices();
  emit();
}

if (isSpeechSupported()) {
  refreshVoices();
  speechSynthesis.addEventListener?.('voiceschanged', refreshVoices);
  // Al recargar la página con una lectura en curso, Chrome sigue hablando.
  speechSynthesis.cancel();
}

/** Voces ordenadas: español de España, resto de español y luego las demás. */
export function getVoices() {
  const score = (v) => (/^es[-_]ES/i.test(v.lang) ? 0 : /^es/i.test(v.lang) ? 1 : 2);
  return [...voices].sort((a, b) => score(a) - score(b) || a.name.localeCompare(b.name));
}

export function getSelectedVoice() {
  const list = getVoices();
  const chosen = list.find((v) => v.voiceURI === prefs.voiceURI);
  if (chosen) return chosen;
  // Preferimos voces "naturales" o de Google en español si existen.
  const spanish = list.filter((v) => /^es/i.test(v.lang));
  return spanish.find((v) => /natural|neural|online|google|enhanced|premium|mejorad/i.test(v.name)) ?? spanish[0] ?? null;
}

export function getRate() {
  return prefs.rate;
}

export function setVoice(voiceURI) {
  prefs.voiceURI = voiceURI;
  savePrefs();
  restartChunk();
}

export function setRate(rate) {
  prefs.rate = Math.min(1.6, Math.max(0.6, Number(rate) || 1));
  savePrefs();
  restartChunk();
}

/* ==========================================================================
   Texto → frases
   ========================================================================== */

/** Divide en frases (y trozos de ≤ MAX_CHUNK caracteres) conservando los párrafos. */
export function splitIntoChunks(text) {
  const chunks = [];
  const paragraphs = String(text ?? '')
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  paragraphs.forEach((para, pi) => {
    // Corta tras . ! ? … seguidos de espacio (así "183.3" no se parte).
    const sentences = para.replace(/([.!?…]+["»”)]*)\s+/g, '$1\u0000').split('\u0000');
    for (let s of sentences) {
      s = s.trim();
      while (s.length > MAX_CHUNK) {
        let cut = s.lastIndexOf(', ', MAX_CHUNK);
        if (cut < MAX_CHUNK / 2) cut = s.lastIndexOf(' ', MAX_CHUNK);
        if (cut < 1) cut = MAX_CHUNK;
        chunks.push({ text: s.slice(0, cut + 1).trim(), paragraph: pi });
        s = s.slice(cut + 1).trim();
      }
      if (s) chunks.push({ text: s, paragraph: pi });
    }
  });
  return chunks;
}

/* ==========================================================================
   Reproducción
   ========================================================================== */

function speakCurrent() {
  const chunk = state.chunks[state.index];
  if (!chunk) return finish();
  const my = ++token;
  const u = new SpeechSynthesisUtterance(chunk.text);
  const voice = getSelectedVoice();
  if (voice) u.voice = voice;
  u.lang = voice?.lang ?? 'es-ES';
  u.rate = prefs.rate;
  u.onend = () => {
    if (my !== token || state.status !== 'playing') return;
    if (state.index + 1 >= state.chunks.length) return finish();
    state = { ...state, index: state.index + 1 };
    emit();
    speakCurrent();
  };
  u.onerror = (e) => {
    if (my !== token || e.error === 'interrupted' || e.error === 'canceled') return;
    console.warn('[speech] Error de síntesis:', e.error);
    finish();
  };
  speechSynthesis.speak(u);
}

function finish() {
  token++;
  state = { ...state, status: 'idle', index: 0 };
  emit();
}

function restartChunk() {
  if (state.status !== 'playing') return;
  token++;
  speechSynthesis.cancel();
  speakCurrent();
}

/**
 * Empieza a leer un texto (detiene la lectura anterior).
 * @param {{ id?: string, title?: string, text: string, startAt?: number }} opts
 */
export function speak({ id = null, title = '', text, startAt = 0 }) {
  if (!isSpeechSupported()) return false;
  const chunks = splitIntoChunks(text);
  if (!chunks.length) return false;
  token++;
  speechSynthesis.cancel();
  state = { status: 'playing', id, title, chunks, index: Math.min(Math.max(0, startAt), chunks.length - 1) };
  emit();
  speakCurrent();
  return true;
}

export function pause() {
  if (state.status !== 'playing') return;
  token++;
  speechSynthesis.cancel();
  state = { ...state, status: 'paused' };
  emit();
}

export function resume() {
  if (state.status !== 'paused') return;
  state = { ...state, status: 'playing' };
  emit();
  speakCurrent();
}

export function togglePause() {
  if (state.status === 'playing') pause();
  else if (state.status === 'paused') resume();
}

export function stop() {
  if (state.status === 'idle') return;
  token++;
  speechSynthesis.cancel();
  state = { status: 'idle', id: null, title: '', chunks: [], index: 0 };
  emit();
}

/** Salta a una frase concreta (sigue leyendo desde ahí si estaba sonando). */
export function seek(index) {
  if (state.status === 'idle') return;
  const i = Math.min(Math.max(0, index), state.chunks.length - 1);
  state = { ...state, index: i };
  if (state.status === 'playing') {
    token++;
    speechSynthesis.cancel();
    emit();
    speakCurrent();
  } else emit();
}

/* ==========================================================================
   Mini barra flotante
   ========================================================================== */

function renderBar() {
  if (typeof document === 'undefined') return;
  const active = state.status !== 'idle';
  document.body.classList.toggle('speech-active', active);

  if (!active) {
    bar?.remove();
    bar = null;
    return;
  }
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'speech-bar';
    bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', 'Lectura en voz alta');
    bar.addEventListener('click', (e) => {
      const action = e.target.closest('[data-sp]')?.dataset.sp;
      if (action === 'toggle') togglePause();
      else if (action === 'prev') seek(state.index - 1);
      else if (action === 'next') seek(state.index + 1);
      else if (action === 'stop') stop();
    });
    document.body.appendChild(bar);
  }

  const playing = state.status === 'playing';
  const pct = Math.round(((state.index + 1) / state.chunks.length) * 100);
  bar.innerHTML = `
    <div class="speech-bar__progress" style="width:${pct}%"></div>
    <span class="speech-bar__icon ${playing ? 'is-playing' : ''}">${icon('audio-lines')}</span>
    <div class="min-w-0 flex-1">
      <p class="speech-bar__title">${escapeHtml(state.title || 'Leyendo')}</p>
      <p class="speech-bar__meta">Frase ${state.index + 1} de ${state.chunks.length}${playing ? '' : ' · en pausa'}</p>
    </div>
    <button type="button" class="speech-bar__btn" data-sp="prev" aria-label="Frase anterior" ${state.index === 0 ? 'disabled' : ''}>${icon('skip-back')}</button>
    <button type="button" class="speech-bar__btn speech-bar__btn--main" data-sp="toggle" aria-label="${playing ? 'Pausar' : 'Continuar'}">${icon(playing ? 'pause' : 'play')}</button>
    <button type="button" class="speech-bar__btn" data-sp="next" aria-label="Frase siguiente" ${state.index >= state.chunks.length - 1 ? 'disabled' : ''}>${icon('skip-forward')}</button>
    <button type="button" class="speech-bar__btn" data-sp="stop" aria-label="Detener">${icon('square')}</button>`;
  refreshIcons();
}
