/* =========================================================================
 * Aura Invest · Almacenamiento local
 * Todo lo que se guarda en el navegador vive bajo UNA clave de localStorage,
 * `aura:v1`, con un número de versión de esquema y migraciones.
 *
 *   { version, settings, usage, cache, watchlist, alerts, alertHistory, prefs, portfolio, drawings }
 *
 * - settings: { apiKey }. La clave nunca sale de aquí: no se exporta, no va en la
 *   URL ni en los registros.
 * - usage: contador de créditos de la API (diario y del último minuto).
 * - cache: respuestas de la API con su caducidad; se puede vaciar sin perder nada.
 * - watchlist: [{ id, name, exchange, currency }] en el orden elegido.         (v2)
 * - alerts / alertHistory: alertas y alertas que han saltado.                 (v2)
 * - prefs: { notify, alertsSeenAt } (notificaciones del navegador; alertas vistas). (v2)
 *          + refreshMinutes: 0 (desactivada) | 5 | 15 | 30, actualización automática.  (v3)
 * - portfolio: { baseCurrency: 'EUR', transactions: [...] } operaciones manuales.     (v3)
 * - drawings: { [símbolo]: [{ id, kind: 'hline', price } | { id, kind: 'trend', a, b }] } (v4)
 * ========================================================================= */
(() => {
'use strict';

const KEY = 'aura:v1';
const VERSION = 4;
const DRAWINGS_MAX = 50;          // por símbolo
const CACHE_MAX_ENTRIES = 60;
const HISTORY_MAX = 200;

/** Watchlist con la que arranca la app (solo mercados del plan gratuito de Twelve Data). */
const DEFAULT_WATCHLIST = [
  { id: 'AAPL', name: 'Apple Inc.', exchange: 'NASDAQ', currency: 'USD' },
  { id: 'MSFT', name: 'Microsoft Corporation', exchange: 'NASDAQ', currency: 'USD' },
  { id: 'NVDA', name: 'NVIDIA Corporation', exchange: 'NASDAQ', currency: 'USD' },
  { id: 'TSLA', name: 'Tesla, Inc.', exchange: 'NASDAQ', currency: 'USD' },
  { id: 'SAN', name: 'Banco Santander, S.A. (ADR)', exchange: 'NYSE', currency: 'USD' },
  { id: 'EUR/USD', name: 'Euro / Dólar estadounidense', exchange: 'Forex', currency: 'USD' },
];

const ID_FORMAT = /^[A-Za-z0-9.\-/:^]{1,24}$/;
const REFRESH_OPTIONS = [0, 5, 15, 30];
const TX_TYPES = ['buy', 'sell', 'dividend'];
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v, max = 120) => (typeof v === 'string' ? v.slice(0, max) : '');

function defaults() {
  return {
    version: VERSION,
    settings: { apiKey: '' },
    usage: { day: '', credits: 0, recent: [] },
    cache: {},
    watchlist: DEFAULT_WATCHLIST.map((w) => ({ ...w })),
    alerts: [],
    alertHistory: [],
    prefs: { notify: false, alertsSeenAt: 0, refreshMinutes: 15 },
    portfolio: { baseCurrency: 'EUR', transactions: [] },
    drawings: {},
  };
}

/**
 * Migraciones de esquema: MIGRATIONS[n] convierte un objeto de la versión n−1 en la n.
 * La versión 0 es "nada guardado o formato desconocido".
 */
const MIGRATIONS = {
  1: () => ({ settings: { apiKey: '' }, usage: { day: '', credits: 0, recent: [] }, cache: {} }),
  // v2 · Fase 2: watchlist editable (con la lista inicial), alertas, historial y preferencias
  2: (d) => ({ ...d, watchlist: DEFAULT_WATCHLIST.map((w) => ({ ...w })), alerts: [], alertHistory: [], prefs: { notify: false } }),
  // v3 · Fase 3: cartera y frecuencia de actualización automática (15 min por defecto)
  3: (d) => ({ ...d, prefs: { ...(isObj(d.prefs) ? d.prefs : {}), refreshMinutes: 15 }, portfolio: { baseCurrency: 'EUR', transactions: [] } }),
  // v4 · Fase 4: dibujos (líneas horizontales y de tendencia) por símbolo
  4: (d) => ({ ...d, drawings: {} }),
};

const point = (q) => isObj(q) && Number.isFinite(q.t) && Number.isFinite(q.p) && q.p > 0;
function validDrawing(x) {
  if (!isObj(x) || typeof x.id !== 'string') return false;
  if (x.kind === 'hline') return Number.isFinite(x.price) && x.price > 0;
  if (x.kind === 'trend') return point(x.a) && point(x.b);
  return false;
}

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
  if (Array.isArray(d.watchlist)) {
    const seen = new Set();
    out.watchlist = d.watchlist
      .filter((w) => isObj(w) && ID_FORMAT.test(w.id || '') && !seen.has(w.id) && seen.add(w.id))
      .map((w) => ({ id: w.id, name: str(w.name), exchange: str(w.exchange, 40), currency: str(w.currency, 8) }));
  }
  if (Array.isArray(d.alerts)) {
    out.alerts = d.alerts.filter((a) => isObj(a) && typeof a.id === 'string' && ID_FORMAT.test(a.symbol || '')
      && typeof a.type === 'string' && typeof a.status === 'string');
  }
  if (Array.isArray(d.alertHistory)) {
    out.alertHistory = d.alertHistory.filter((h) => isObj(h) && Number.isFinite(h.at) && typeof h.message === 'string').slice(-HISTORY_MAX);
  }
  if (isObj(d.prefs)) {
    out.prefs.notify = d.prefs.notify === true;
    if (Number.isFinite(d.prefs.alertsSeenAt)) out.prefs.alertsSeenAt = d.prefs.alertsSeenAt;
    if (REFRESH_OPTIONS.includes(d.prefs.refreshMinutes)) out.prefs.refreshMinutes = d.prefs.refreshMinutes;
  }
  if (isObj(d.drawings)) {
    for (const [sym, list] of Object.entries(d.drawings)) {
      if (!ID_FORMAT.test(sym) || !Array.isArray(list)) continue;
      const ok = list.filter(validDrawing).slice(0, DRAWINGS_MAX);
      if (ok.length) out.drawings[sym] = ok;
    }
  }
  if (isObj(d.portfolio)) {
    if (/^[A-Z]{3}$/.test(d.portfolio.baseCurrency || '')) out.portfolio.baseCurrency = d.portfolio.baseCurrency;
    if (Array.isArray(d.portfolio.transactions)) {
      // Forma básica; la validación completa (fechas, ventas sin acciones…) es de Aura.portfolio
      out.portfolio.transactions = d.portfolio.transactions.filter((t) => isObj(t) && typeof t.id === 'string'
        && TX_TYPES.includes(t.type) && ID_FORMAT.test(t.symbol || '') && /^\d{4}-\d{2}-\d{2}$/.test(t.date || '')
        && ['quantity', 'price', 'fees'].every((k) => Number.isFinite(t[k])));
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

  const clone = (v) => JSON.parse(JSON.stringify(v));

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

    /** Secciones del usuario (watchlist, alerts, alertHistory, prefs): copias, para no mutar sin guardar. */
    get: (section) => clone(data[section]),
    set(section, value) {
      if (!['watchlist', 'alerts', 'alertHistory', 'prefs', 'portfolio', 'drawings'].includes(section)) throw new Error(`Sección desconocida: ${section}`);
      data[section] = section === 'alertHistory' ? clone(value).slice(-HISTORY_MAX) : clone(value);
      return write();
    },
  };
}

let browserStorage = null;
try { browserStorage = window.localStorage; } catch { /* almacenamiento bloqueado: se usará memoria */ }

Aura.store = createStore(browserStorage);
Aura.storeInternals = { createStore, migrate, VERSION, KEY, DEFAULT_WATCHLIST, HISTORY_MAX, REFRESH_OPTIONS, DRAWINGS_MAX, validDrawing };
})();
