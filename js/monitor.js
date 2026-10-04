/* =========================================================================
 * Aura Invest · Vigilancia: cotizaciones de la watchlist y alertas
 *
 * Funciona SOLO con la app abierta: no hay servidor, así que con la app cerrada nadie
 * comprueba nada. Con la pestaña en segundo plano el navegador puede ralentizar los
 * temporizadores o congelar la página (p. ej. las pestañas en suspensión de Edge); al
 * volver a la pestaña se hace enseguida la comprobación que se haya perdido.
 *
 * - Al abrir la app y después a intervalos, pide en lote las cotizaciones de la
 *   watchlist y de los valores con alertas, calcula las señales diarias que hagan
 *   falta y evalúa las alertas activas.
 * - El intervalo se adapta al cupo: reparte los créditos que quedan hoy (menos una
 *   reserva para navegar) hasta las 00:00 UTC. Nunca es menor que la frecuencia
 *   elegida en Ajustes (5, 15 o 30 min; 15 por defecto) si hay algún mercado abierto,
 *   ni que 60 min si todos están cerrados. Con la frecuencia desactivada solo se
 *   comprueba al abrir la app y a mano.
 * ========================================================================= */
(() => {
'use strict';

const { fetchQuotes, fetchMarketData } = Aura.data;
const { analyze } = Aura.model;
const { client } = Aura.api;
const store = Aura.store;
const watchlist = Aura.watchlist;
const alerts = Aura.alerts;

const MIN_OPEN_MS = 5 * 60 * 1000;
const CLOSED_MS = 60 * 60 * 1000;
const RESERVE = 150;                 // créditos reservados para usar la app a mano

/**
 * Milisegundos hasta el próximo refresco automático, o null si no toca programarlo.
 * @param {{creditsToday:number, perDay:number}} usage
 * @param {number} cost        créditos que cuesta un refresco
 * @param {boolean} anyOpen    ¿hay algún mercado abierto?
 * @param {number} now         ms
 * @param {number} [minMinutes=5]  frecuencia máxima elegida (0 = desactivada)
 */
function nextDelay(usage, cost, anyOpen, now, minMinutes = 5) {
  if (cost <= 0 || !minMinutes) return null;
  const spendable = usage.perDay - usage.creditsToday - RESERVE;
  if (spendable < cost) return null;
  const msLeft = Math.ceil((now + 1) / 86400000) * 86400000 - now;
  const runs = Math.floor(spendable / cost);
  const floor = Math.max(anyOpen ? MIN_OPEN_MS : CLOSED_MS, minMinutes * 60000);
  return Math.max(floor, Math.ceil(msLeft / runs));
}

/**
 * Entrega de avisos: notificación del sistema si el usuario la activó y dio permiso;
 * si no, solo dentro de la app. Devuelve el canal usado ('system' | 'app').
 */
function deliver(entries, { Notification: N, enabled }) {
  const system = Boolean(enabled && N && N.permission === 'granted');
  if (system) {
    for (const e of entries) {
      try { new N(`Aura Invest · ${e.symbol}`, { body: e.message, tag: `aura-${e.alertId}` }); } catch { /* el navegador puede negarse */ }
    }
  }
  return system ? 'system' : 'app';
}

/* ---- Estado ---- */

const subs = { quotes: new Set(), fired: new Set(), status: new Set() };
const emit = (kind, v) => subs[kind].forEach((f) => f(v));
const lastQuotes = new Map();
const lastSignals = new Map();
let timer = null, running = null, lastRun = null, started = false;

const activeAlerts = () => alerts.list().filter((a) => a.status === 'active');
const watchedIds = () => [...new Set([...watchlist.ids(), ...activeAlerts().map((a) => a.symbol)])];
const signalIds = () => [...new Set(activeAlerts().filter(alerts.needsSignals).map((a) => a.symbol))];

function schedule() {
  clearTimeout(timer);
  timer = null;
  if (!started) return;
  const ids = watchedIds();
  const anyOpen = [...lastQuotes.values()].some((q) => q && q.isMarketOpen);
  const minutes = store.get('prefs').refreshMinutes;
  const delay = store.getApiKey() ? nextDelay(client.status(), ids.length + signalIds().length, anyOpen, Date.now(), minutes) : null;
  const nextAt = delay == null ? null : Date.now() + delay;
  if (delay != null) timer = setTimeout(() => runCheck(), delay);
  emit('status', {
    running: false, lastRun, nextAt, delay,
    reason: !store.getApiKey() ? 'nokey' : !ids.length ? 'empty' : !minutes ? 'off' : delay == null ? 'budget' : null,
  });
}

/** Una pasada completa: cotizaciones → señales → alertas → avisos. */
function runCheck({ force = false } = {}) {
  if (running) return running;
  running = (async () => {
    clearTimeout(timer);
    if (!store.getApiKey()) return;
    emit('status', { running: true, lastRun, nextAt: null });
    const quotes = await fetchQuotes(watchedIds(), { priority: 1, force });
    quotes.forEach((q, id) => lastQuotes.set(id, q));
    emit('quotes', quotes);

    const signals = new Map();
    for (const id of signalIds()) {
      try {
        const d = await fetchMarketData(id, '6M', { priority: 1 });
        signals.set(id, alerts.signalsFrom(analyze(d, '6M'), d.source));
      } catch (err) {
        signals.set(id, err);
      }
    }
    signals.forEach((v, id) => lastSignals.set(id, v));
    evaluate(quotes, signals);
    lastRun = Date.now();
  })().finally(() => { running = null; schedule(); });
  return running;
}

function evaluate(quotes, signals) {
  const fired = alerts.evaluateAll({ quotes, signals, now: Date.now() });
  if (fired.length) {
    const channel = deliver(fired, { Notification: window.Notification, enabled: store.get('prefs').notify });
    emit('fired', { entries: fired, channel });
  }
  return fired;
}

/**
 * Comprobación inmediata tras crear, editar o reactivar alertas: usa las últimas
 * cotizaciones y señales ya obtenidas y solo pide a la API lo que falte (1 crédito
 * por valor nuevo, y las velas diarias suelen estar ya en caché).
 */
async function checkAlertsQuick() {
  if (!store.getApiKey()) return [];
  const active = activeAlerts();
  const needQuote = [...new Set(active.filter((a) => !alerts.needsSignals(a) && !lastQuotes.has(a.symbol)).map((a) => a.symbol))];
  if (needQuote.length) (await fetchQuotes(needQuote, { priority: 2 })).forEach((q, id) => lastQuotes.set(id, q));
  for (const id of [...new Set(active.filter((a) => alerts.needsSignals(a) && !lastSignals.has(a.symbol)).map((a) => a.symbol))]) {
    try {
      const d = await fetchMarketData(id, '6M', { priority: 2 });
      lastSignals.set(id, alerts.signalsFrom(analyze(d, '6M'), d.source));
    } catch (err) {
      lastSignals.set(id, err);
    }
  }
  return evaluate(lastQuotes, lastSignals);
}

/** Cotiza ya unos valores concretos (p. ej. recién añadidos a la watchlist). */
async function refreshIds(ids) {
  if (!store.getApiKey() || !ids.length) return;
  const quotes = await fetchQuotes(ids, { priority: 2 });
  quotes.forEach((q, id) => lastQuotes.set(id, q));
  emit('quotes', quotes);
}

/** Al volver a la pestaña: si la comprobación programada ya debería haberse hecho, se hace ahora. */
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !started || running) return;
    const minutes = store.get('prefs').refreshMinutes;
    const overdue = timer && lastRun && minutes && Date.now() - lastRun > Math.max(MIN_OPEN_MS, minutes * 60000);
    if (overdue) runCheck();
  });
}

Aura.monitor = {
  start() { started = true; return runCheck(); },
  stop() { started = false; clearTimeout(timer); timer = null; },
  runCheck, refreshIds, checkAlertsQuick, reschedule: schedule,
  onQuotes: (f) => subs.quotes.add(f),
  onFired: (f) => subs.fired.add(f),
  onStatus: (f) => subs.status.add(f),
  // puras, para pruebas
  nextDelay, deliver, RESERVE, MIN_OPEN_MS, CLOSED_MS,
};
})();
