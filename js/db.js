/**
 * db.js — Almacenamiento de fotografías del "Salón de los Héroes" en IndexedDB.
 *
 * - Base de datos: `fh_gallery_db`, almacén `photos` (keyPath `id`).
 * - Cada imagen se redimensiona en un <canvas> a máx. 1280px y se comprime a
 *   JPEG (calidad 0.8) antes de guardarse como Blob. Se guarda además una
 *   miniatura ligera para que la cuadrícula cargue rápido en el móvil.
 * - 100% local y offline: ninguna imagen sale del dispositivo.
 */

import { clampWeek, normalizeSectionNumber, normalizeScenarioNumber } from './state.js';

export const DB_NAME = 'fh_gallery_db';
export const DB_VERSION = 2;
export const STORE = 'photos';
/** Textos del Narrador (secciones e introducciones transcritas por el usuario). */
export const TEXT_STORE = 'texts';

export const MAX_DIMENSION = 1280;
export const JPEG_QUALITY = 0.8;
export const THUMB_DIMENSION = 480;
export const THUMB_QUALITY = 0.75;
export const MAX_INPUT_BYTES = 50 * 1024 * 1024;

const LIMITS = Object.freeze({ title: 120, description: 1000 });
const IMAGE_EXT = /\.(jpe?g|png|gif|webp|bmp|avif|heic|heif)$/i;

/* ==========================================================================
   Apertura de la base de datos
   ========================================================================== */

let dbPromise = null;

export function isIndexedDBSupported() {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null;
  } catch {
    return false;
  }
}

/** Abre (y crea/migra si hace falta) la base de datos. La conexión se reutiliza. */
export function openDB() {
  if (dbPromise) return dbPromise;
  if (!isIndexedDBSupported()) {
    return Promise.reject(new Error('Este navegador no permite IndexedDB (¿modo privado?). La galería no está disponible.'));
  }

  dbPromise = new Promise((resolve, reject) => {
    let request;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      reject(err);
      return;
    }

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('week', 'week', { unique: false });
        store.createIndex('createdAt', 'createdAt', { unique: false });
      }
      // v2: almacén de textos del Narrador.
      if (!db.objectStoreNames.contains(TEXT_STORE)) {
        const texts = db.createObjectStore(TEXT_STORE, { keyPath: 'id' });
        texts.createIndex('kind', 'kind', { unique: false });
      }
    };

    request.onsuccess = () => {
      const db = request.result;
      // Si otra pestaña abre una versión más nueva, cerramos para no bloquearla.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      db.onclose = () => {
        dbPromise = null;
      };
      resolve(db);
    };

    request.onerror = () => reject(request.error ?? new Error('No se pudo abrir la base de datos de la galería.'));
    request.onblocked = () => console.warn('[db] Apertura bloqueada: cierra otras pestañas de la app.');
  });

  dbPromise.catch(() => {
    dbPromise = null;
  });
  return dbPromise;
}

/** Traduce errores de IndexedDB a mensajes comprensibles. */
function friendlyError(err) {
  if (err?.name === 'QuotaExceededError') {
    return new Error('No queda espacio en el almacenamiento del navegador. Borra algunas fotos o libera espacio.');
  }
  return err instanceof Error ? err : new Error(String(err?.message ?? err ?? 'Error de IndexedDB'));
}

/**
 * Ejecuta `fn(store)` dentro de una transacción y resuelve cuando ésta se
 * completa. Si `fn` devuelve un IDBRequest, se resuelve con su `result`;
 * si devuelve un objeto `{ value }` mutable, con `value` (útil para get+put).
 */
async function runTx(mode, fn, storeName = STORE) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction(storeName, mode);
    } catch (err) {
      reject(friendlyError(err));
      return;
    }
    let out;
    try {
      out = fn(tx.objectStore(storeName));
    } catch (err) {
      try {
        tx.abort();
      } catch {
        /* ya abortada */
      }
      reject(friendlyError(err));
      return;
    }
    tx.oncomplete = () => resolve(out instanceof IDBRequest ? out.result : out?.value !== undefined ? out.value : out);
    tx.onerror = () => reject(friendlyError(tx.error));
    tx.onabort = () => reject(friendlyError(tx.error ?? new Error('Transacción cancelada.')));
  });
}

/* ==========================================================================
   Procesado de imágenes (canvas)
   ========================================================================== */

/** Escala (w, h) para que el lado mayor no supere `max`, manteniendo proporción. */
export function fitWithin(width, height, max) {
  const scale = Math.min(1, max / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function looksLikeImage(file) {
  if (!file) return false;
  if (file.type) return file.type.startsWith('image/');
  return IMAGE_EXT.test(file.name ?? '');
}

/**
 * Decodifica un Blob/File de imagen. Intenta `createImageBitmap` (respetando
 * la orientación EXIF de las fotos del móvil) y, si falla, usa <img>.
 */
async function decodeImage(blob) {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
      return { source: bmp, width: bmp.width, height: bmp.height, release: () => bmp.close?.() };
    } catch {
      /* Navegadores sin soporte de opciones o formato: probamos con <img>. */
    }
  }

  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    if (typeof img.decode === 'function') {
      await img.decode();
    } else {
      await new Promise((res, rej) => {
        img.onload = res;
        img.onerror = rej;
      });
    }
    return {
      source: img,
      width: img.naturalWidth,
      height: img.naturalHeight,
      release: () => URL.revokeObjectURL(url),
    };
  } catch {
    URL.revokeObjectURL(url);
    throw new Error('No se pudo leer la imagen. Si es HEIC/HEIF, conviértela a JPG o cambia el formato de la cámara a "Más compatible".');
  }
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    if (typeof canvas.toBlob === 'function') {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('No se pudo comprimir la imagen.'))), type, quality);
      return;
    }
    try {
      resolve(dataURLToBlob(canvas.toDataURL(type, quality)));
    } catch (err) {
      reject(err);
    }
  });
}

function drawToCanvas(source, width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('El navegador no permite usar <canvas>.');
  // JPEG no tiene transparencia: rellenamos con el fondo de la app.
  ctx.fillStyle = '#0f172a';
  ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, width, height);
  return canvas;
}

function releaseCanvas(canvas) {
  // Libera memoria rápidamente en iOS/Safari.
  canvas.width = 0;
  canvas.height = 0;
}

/**
 * Redimensiona (máx. `maxDimension`) y comprime a JPEG. Genera también una
 * miniatura a partir de la imagen ya reducida (mejor calidad y más rápido).
 * @returns {Promise<{ blob: Blob, thumb: Blob, width: number, height: number }>}
 */
export async function processImage(file, { maxDimension = MAX_DIMENSION, quality = JPEG_QUALITY, thumbDimension = THUMB_DIMENSION } = {}) {
  if (!looksLikeImage(file)) throw new Error('El archivo seleccionado no es una imagen.');
  if (file.size > MAX_INPUT_BYTES) throw new Error('La imagen es demasiado grande (máx. 50 MB).');

  const decoded = await decodeImage(file);
  let main;
  let small;
  try {
    const size = fitWithin(decoded.width, decoded.height, maxDimension);
    main = drawToCanvas(decoded.source, size.width, size.height);
    const blob = await canvasToBlob(main, 'image/jpeg', quality);

    const tSize = fitWithin(size.width, size.height, thumbDimension);
    small = drawToCanvas(main, tSize.width, tSize.height);
    const thumb = await canvasToBlob(small, 'image/jpeg', THUMB_QUALITY);

    return { blob, thumb, width: size.width, height: size.height };
  } finally {
    decoded.release();
    if (main) releaseCanvas(main);
    if (small) releaseCanvas(small);
  }
}

/** Atajo: solo la imagen comprimida. */
export async function compressImage(file, options) {
  const { blob, width, height } = await processImage(file, options);
  return { blob, width, height };
}

/* ==========================================================================
   Conversión Blob <-> data URL (para backups JSON)
   ========================================================================== */

export function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export function dataURLToBlob(dataURL) {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(String(dataURL));
  if (!match) throw new Error('Data URL no válida.');
  const mime = match[1] || 'application/octet-stream';
  if (!match[2]) return new Blob([decodeURIComponent(match[3])], { type: mime });
  const bin = atob(match[3]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/* ==========================================================================
   CRUD de fotos
   ========================================================================== */

function cleanMeta({ title, week, description } = {}) {
  return {
    title: String(title ?? '').trim().slice(0, LIMITS.title) || 'Momento épico',
    week: clampWeek(week ?? 1),
    description: String(description ?? '').trim().slice(0, LIMITS.description),
  };
}

function newId() {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? `photo_${crypto.randomUUID()}`
    : `photo_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Procesa y guarda una foto.
 * @param {{ file: File|Blob, title?: string, week?: number, description?: string }} input
 * @returns {Promise<object>} el registro guardado (con `blob` y `thumb`).
 */
export async function addPhoto({ file, title, week, description } = {}) {
  const { blob, thumb, width, height } = await processImage(file);
  const record = {
    id: newId(),
    ...cleanMeta({ title, week, description }),
    createdAt: new Date().toISOString(),
    width,
    height,
    size: blob.size,
    mimeType: blob.type || 'image/jpeg',
    blob,
    thumb,
  };
  await runTx('readwrite', (store) => store.add(record));
  return record;
}

/** Todas las fotos, ordenadas por semana (desc) y fecha de subida (desc). */
export async function getAllPhotos() {
  const list = await runTx('readonly', (store) => store.getAll());
  return (list ?? []).sort((a, b) => b.week - a.week || String(b.createdAt).localeCompare(String(a.createdAt)));
}

export async function getPhoto(id) {
  return (await runTx('readonly', (store) => store.get(id))) ?? null;
}

export async function countPhotos() {
  return runTx('readonly', (store) => store.count());
}

/** Actualiza título, semana y/o descripción (la imagen no cambia). */
export async function updatePhotoMeta(id, patch = {}) {
  return runTx('readwrite', (store) => {
    const box = { value: null };
    const req = store.get(id);
    req.onsuccess = () => {
      const current = req.result;
      if (!current) return;
      const meta = cleanMeta({ ...current, ...patch });
      const updated = { ...current, ...meta, updatedAt: new Date().toISOString() };
      store.put(updated);
      box.value = updated;
    };
    return box;
  }).then((v) => (v && v.blob ? v : null));
}

export async function deletePhoto(id) {
  await runTx('readwrite', (store) => store.delete(id));
  return true;
}

export async function clearAllPhotos() {
  await runTx('readwrite', (store) => store.clear());
  return true;
}

/* ==========================================================================
   Exportación / importación (para incluir la galería en el backup JSON)
   ========================================================================== */

/**
 * Exporta las fotos como data URLs JPEG. Puede ocupar bastante: la UI debería
 * preguntar antes de incluirlas en el backup.
 * @param {(done: number, total: number) => void} [onProgress]
 */
export async function exportPhotos(onProgress) {
  const photos = await getAllPhotos();
  const out = [];
  for (let i = 0; i < photos.length; i++) {
    const p = photos[i];
    out.push({
      id: p.id,
      title: p.title,
      week: p.week,
      description: p.description,
      createdAt: p.createdAt,
      width: p.width,
      height: p.height,
      image: await blobToDataURL(p.blob),
    });
    onProgress?.(i + 1, photos.length);
  }
  return out;
}

/**
 * Importa fotos exportadas con `exportPhotos`. Regenera la miniatura.
 * @param {Array} list
 * @param {{ replace?: boolean, onProgress?: (done:number,total:number)=>void }} [opts]
 *   replace: borra antes la galería actual. Si no, se omiten los ids ya existentes.
 * @returns {Promise<{ imported: number, skipped: number, failed: number }>}
 */
export async function importPhotos(list, { replace = false, onProgress } = {}) {
  if (!Array.isArray(list)) return { imported: 0, skipped: 0, failed: 0 };
  if (replace) await clearAllPhotos();

  const existing = replace ? new Set() : new Set((await runTx('readonly', (s) => s.getAllKeys())) ?? []);
  let imported = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    try {
      if (!item || typeof item.image !== 'string') throw new Error('Entrada sin imagen');
      const id = typeof item.id === 'string' && item.id ? item.id : newId();
      if (existing.has(id)) {
        skipped++;
      } else {
        const source = dataURLToBlob(item.image);
        const { blob, thumb, width, height } = await processImage(new File([source], 'import.jpg', { type: source.type || 'image/jpeg' }));
        await runTx('readwrite', (store) =>
          store.put({
            id,
            ...cleanMeta(item),
            createdAt: typeof item.createdAt === 'string' ? item.createdAt : new Date().toISOString(),
            width,
            height,
            size: blob.size,
            mimeType: 'image/jpeg',
            blob,
            thumb,
          }),
        );
        existing.add(id);
        imported++;
      }
    } catch (err) {
      console.warn('[db] Foto no importada:', err);
      failed++;
    }
    onProgress?.(i + 1, list.length);
  }
  return { imported, skipped, failed };
}

/* ==========================================================================
   Textos del Narrador
   ========================================================================== */

export const TEXT_KINDS = Object.freeze(['section', 'scenario']);

/** Normaliza el número según el tipo; null si no es válido. */
export function normalizeTextNumber(kind, number) {
  return kind === 'section' ? normalizeSectionNumber(number) : normalizeScenarioNumber(number);
}

export function textId(kind, number) {
  const n = normalizeTextNumber(kind, number);
  return n ? `${kind}:${n}` : null;
}

/** Texto guardado para una sección o escenario, o null. */
export async function getText(kind, number) {
  const id = textId(kind, number);
  if (!id) return null;
  return (await runTx('readonly', (store) => store.get(id), TEXT_STORE)) ?? null;
}

/** Todos los textos, ordenados por tipo y número. */
export async function getAllTexts() {
  const list = (await runTx('readonly', (store) => store.getAll(), TEXT_STORE)) ?? [];
  const num = (n) => parseFloat(n) || 0;
  return list.sort((a, b) => a.kind.localeCompare(b.kind) || num(a.number) - num(b.number) || a.number.localeCompare(b.number));
}

/**
 * Crea o reemplaza un texto. Conserva `createdAt` si ya existía.
 * @param {{ kind: 'section'|'scenario', number: string, title?: string, text: string }} data
 */
export async function saveText({ kind, number, title = '', text = '' }) {
  if (!TEXT_KINDS.includes(kind)) throw new Error('Tipo de texto desconocido.');
  const n = normalizeTextNumber(kind, number);
  if (!n) throw new Error(kind === 'section' ? 'Número de sección no válido (ej. 183.3).' : 'Número de escenario no válido (ej. 23).');
  const clean = String(text).trim().slice(0, 20000);
  if (!clean) throw new Error('El texto está vacío.');
  const now = new Date().toISOString();
  const id = `${kind}:${n}`;
  return runTx(
    'readwrite',
    (store) => {
      const box = { value: null };
      const req = store.get(id);
      req.onsuccess = () => {
        const record = {
          id,
          kind,
          number: n,
          title: String(title ?? '').trim().slice(0, 120),
          text: clean,
          createdAt: req.result?.createdAt ?? now,
          updatedAt: now,
        };
        store.put(record);
        box.value = record;
      };
      return box;
    },
    TEXT_STORE,
  );
}

export async function deleteText(id) {
  await runTx('readwrite', (store) => store.delete(id), TEXT_STORE);
  return true;
}

/** Textos listos para incluir en el backup JSON. */
export async function exportTexts() {
  return (await getAllTexts()).map(({ kind, number, title, text, createdAt, updatedAt }) => ({ kind, number, title, text, createdAt, updatedAt }));
}

/**
 * Importa textos de un backup. Si ya existe uno con el mismo número, gana el
 * más reciente (`updatedAt`).
 * @returns {Promise<{ imported: number, skipped: number, failed: number }>}
 */
export async function importTexts(list) {
  if (!Array.isArray(list)) return { imported: 0, skipped: 0, failed: 0 };
  const existing = new Map((await getAllTexts()).map((t) => [t.id, t]));
  const records = [];
  let skipped = 0;
  let failed = 0;
  for (const item of list) {
    const id = item && TEXT_KINDS.includes(item.kind) ? textId(item.kind, item.number) : null;
    const text = typeof item?.text === 'string' ? item.text.trim().slice(0, 20000) : '';
    if (!id || !text) {
      failed++;
      continue;
    }
    const current = existing.get(id);
    if (current && String(current.updatedAt) >= String(item.updatedAt ?? '')) {
      skipped++;
      continue;
    }
    const now = new Date().toISOString();
    records.push({
      id,
      kind: item.kind,
      number: id.split(':')[1],
      title: String(item.title ?? '').trim().slice(0, 120),
      text,
      createdAt: typeof item.createdAt === 'string' ? item.createdAt : now,
      updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : now,
    });
  }
  if (records.length) await runTx('readwrite', (store) => records.forEach((r) => store.put(r)), TEXT_STORE);
  return { imported: records.length, skipped, failed };
}

/* ==========================================================================
   Almacenamiento persistente y cuota
   ========================================================================== */

/**
 * Pide al navegador que no borre los datos automáticamente (importante en
 * móviles con poco espacio). Devuelve true si queda persistente.
 */
export async function requestPersistentStorage() {
  try {
    if (!navigator.storage?.persist) return false;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

/** `{ usage, quota }` en bytes, o null si el navegador no lo expone. */
export async function getStorageEstimate() {
  try {
    if (!navigator.storage?.estimate) return null;
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    return { usage, quota };
  } catch {
    return null;
  }
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
}
