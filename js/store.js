/* =========================================================================
 * Aura Invest · Almacenamiento local
 * Todo lo que se guarda en el navegador vive bajo UNA clave de localStorage,
 * `aura:v1`, con un número de versión de esquema y migraciones.
 *
 *   { version, settings: { apiKey }, usage: {...}, cache: {...} }
 *
 * - settings: preferencias del usuario (la clave de API nunca sale de aquí:
 *   no se exporta, no va en la URL ni en los registros).
 * - usage: contador de créditos de la API (diario y del último minuto).
 * - cache: respuestas de la API con su caducidad; se puede vaciar sin perder nada.
 * Las fases siguientes añadirán secciones (watchlist, alertas, cartera…) con su
 * propia migración.
 * ========================================================================= */
(() => {
'use strict';

const KEY = 'aura:v1';
const VERSION = 1;
const CACHE_MAX_ENTRIES = 60;

function defaults() {
  return {
    version: VERSION,
    settings: { apiKey: '' },
    usage: { day: '', credits: 0, recent: [] },
    cache: {},
  };
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Migraciones de esquema: MIGRATIONS[n] convierte un objeto de la versión n−1 en la n.
 * La versión 0 es "nada guardado o formato desconocido".
 */
const MIGRATIONS = {
  1: () => defaults(),
};

/** Repara tipos y rellena lo que falte sin perder lo que es válido. */
function sanitize(d) {
  const out = defaults();
  if (isObj(d.settings) && typeof d.settings.apiKey === 'string') out.settings.apiKey = d.settings.apiKey.trim();
  if (isObj(d.usage)) {
    if (typeof d.usage.day === 'string') out.usage.day = d.usage.day;
    if (Number.isFinite(d.usage.credits) && d.usage.credits >= 0) out.usage.credits = d.usage.credits;
    if (Array.isArray(d.usage.recent)) out.usage.recent = d.usage.recent.filter((r) => isObj(r) && Number.isFinite(r.t) && Number.isFinite(r.cost));
  }
  if (isObj(d.cache)) {
    for (const [k, e] of Object.entries(d.cache)) {
      if (isObj(e) && Number.isFinite(e.t) && Number.isFinite(e.ttl) && 'data' in e) out.cache[k] = e;
    }
  }
  return out;
}

/** Lleva cualquier contenido guardado a la versión actual. */
function migrate(raw) {
  let d = isObj(raw) ? raw : {};
  let v = Number.isInteger(d.version) ? d.version : 0;
  if (v > VERSION) return { data: null, newer: true };
  while (v < VERSION) { v += 1; d = { ...MIGRATIONS[v](d), version: v }; }
  return { data: sanitize(d), newer: false };
}

/**
 * Crea el almacén sobre un `localStorage` (inyectable en pruebas).
 * Si el navegador no permite guardar, funciona en memoria y lo indica en `persistent`.
 */
function createStore(storage) {
  let persistent = true, readOnly = false, problem = null, data;

  try {
    const text = storage.getItem(KEY);
    let raw = null;
    if (text) {
      try { raw = JSON.parse(text); } catch { problem = 'Los datos guardados estaban dañados y se han restablecido.'; }
    }
    const res = migrate(raw);
    if (res.newer) {
      readOnly = true;
      problem = 'Los datos guardados son de una versión más nueva de Aura Invest; no se modificarán.';
      data = defaults();
    } else {
      data = res.data;
    }
  } catch {
    persistent = false;
    problem = 'Este navegador no permite guardar datos: se perderán al cerrar.';
    data = defaults();
  }

  function write() {
    if (!persistent || readOnly) return false;
    for (let attempt = 0; attempt < 4; attempt++) {
      try { storage.setItem(KEY, JSON.stringify(data)); return true; } catch (err) {
        // Cuota llena: se descarta la mitad más antigua de la caché y se reintenta
        const keys = Object.keys(data.cache).sort((a, b) => data.cache[a].t - data.cache[b].t);
        if (!keys.length) break;
        keys.slice(0, Math.ceil(keys.length / 2)).forEach((k) => delete data.cache[k]);
      }
    }
    problem = 'No se pudo guardar en el navegador (espacio lleno).';
    return false;
  }

  return {
    KEY,
    get persistent() { return persistent && !readOnly; },
    get problem() { return problem; },

    getApiKey: () => data.settings.apiKey,
    setApiKey(key) { data.settings.apiKey = String(key || '').trim(); return write(); },

    getUsage: () => data.usage,
    setUsage(u) { data.usage = u; return write(); },

    getCache: (k) => data.cache[k] || null,
    setCache(k, entry) {
      data.cache[k] = entry;
      const keys = Object.keys(data.cache);
      if (keys.length > CACHE_MAX_ENTRIES) {
        keys.sort((a, b) => data.cache[a].t - data.cache[b].t)
          .slice(0, keys.length - CACHE_MAX_ENTRIES).forEach((x) => delete data.cache[x]);
      }
      return write();
    },
    clearCache() { data.cache = {}; return write(); },
    cacheSize: () => Object.keys(data.cache).length,
  };
}

let browserStorage = null;
try { browserStorage = window.localStorage; } catch { /* almacenamiento bloqueado: se usará memoria */ }

Aura.store = createStore(browserStorage);
Aura.storeInternals = { createStore, migrate, VERSION, KEY };
})();
