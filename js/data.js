/* =========================================================================
 * Aura Invest · Capa de datos (Twelve Data)
 * Toda la app consume únicamente:
 *   fetchMarketData(id, tfKey) → { meta, bars, barsPerDay, source }
 *   fetchQuotes(ids)           → Map(id → cotización | ApiError)
 *   searchSymbols(texto)       → [instrumentos]
 *
 * Fechas: las velas se piden con `timezone=Exchange` (hora local de la bolsa) y se
 * codifican como si fueran UTC, que es lo que esperan los gráficos y el modelo
 * (las 09:30 de Nueva York se muestran como 09:30). Las marcas de tiempo absolutas
 * (última cotización) se conservan en UTC real.
 *
 * Identificadores: "AAPL" (cotización principal en EE. UU.) o "SÍMBOLO:BOLSA"
 * (p. ej. "SAN:BME") para cualquier otra.
 * ========================================================================= */
(() => {
'use strict';

const { TIMEFRAMES, CACHE_TTL, API } = Aura.config;
const { last } = Aura.utils;
const { client, ApiError, MESSAGES, errorFrom } = Aura.api;

const INSTRUMENT_TTL = 30 * 86400;     // lo aprendido de symbol_search (plan, nombre…)
const UNAVAILABLE_TTL = 86400;         // un símbolo que la API ha rechazado por plan
const SESSION_TTL = 30 * 86400;        // horario de sesión deducido de velas de 5/15 min

/* ---------------------------------------------------------------------------
 * Parseo
 * ------------------------------------------------------------------------- */

/** "2026-10-02" o "2026-10-02 15:55:00" (hora de la bolsa) → segundos, codificados como UTC. */
function parseDateTime(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(String(s || '').trim());
  if (!m) return NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)) / 1000;
}

const num = (v) => (v === undefined || v === null || v === '' ? NaN : Number(v));

/** Decimales de precio según su magnitud (forex y céntimos necesitan más). */
const precisionFor = (price) => (price < 2 ? 4 : price < 20 ? 3 : 2);

/**
 * Divisa de una respuesta: `currency` en acciones, la cotizada en pares ("EUR/USD" → USD).
 * Solo se aceptan códigos alfabéticos: la divisa acaba dentro de textos con HTML del modelo.
 */
function currencyOf(meta, symbol) {
  const valid = (c) => (/^[A-Za-z]{2,5}$/.test(c || '') ? c : '');
  if (meta && meta.currency) return valid(meta.currency);
  const pair = String((meta && meta.symbol) || symbol || '').split(':')[0];
  return pair.includes('/') ? valid(pair.split('/')[1]) : '';
}

/** Velas de una respuesta de time_series, en orden ascendente y sin duplicados. */
function parseSeries(json) {
  if (!json || !Array.isArray(json.values)) throw new ApiError('SERVER', 'La respuesta de Twelve Data no contiene velas.');
  const bars = [];
  for (const v of json.values) {
    const b = {
      time: parseDateTime(v.datetime),
      open: num(v.open), high: num(v.high), low: num(v.low), close: num(v.close),
      volume: Number.isFinite(num(v.volume)) ? num(v.volume) : 0,
    };
    if ([b.time, b.open, b.high, b.low, b.close].every(Number.isFinite)) bars.push(b);
  }
  bars.sort((a, b) => a.time - b.time);
  const out = [];
  for (const b of bars) {
    if (out.length && last(out).time === b.time) out[out.length - 1] = b;   // la API a veces repite la última fecha
    else out.push(b);
  }
  return out;
}

/**
 * Horario de sesión [apertura, duración] en minutos (hora de la bolsa), deducido de
 * velas intradía: la apertura más frecuente y el cierre más frecuente (inicio de la
 * última vela + su duración). Con velas de 1 h el cierre es aproximado (la última
 * vela puede durar menos de una hora), por eso se marca `exact: false`.
 */
function inferSession(bars, minutes) {
  const days = new Map();
  for (const b of bars) {
    const d = Math.floor(b.time / 86400);
    const m = Math.round((b.time - d * 86400) / 60);
    const e = days.get(d);
    if (e) { e.first = Math.min(e.first, m); e.last = Math.max(e.last, m); } else days.set(d, { first: m, last: m });
  }
  if (!days.size) return null;
  const mode = (arr) => {
    const c = new Map();
    arr.forEach((v) => c.set(v, (c.get(v) || 0) + 1));
    return [...c.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
  };
  const open = mode([...days.values()].map((e) => e.first));
  const close = mode([...days.values()].map((e) => e.last + minutes));
  return { session: [open, Math.max(minutes, close - open)], exact: minutes <= 15 };
}

function parseQuote(q) {
  const price = num(q.close);
  return {
    meta: {
      symbol: q.symbol, name: q.name || q.symbol, exchange: q.exchange || '', mic: q.mic_code || '',
      currency: currencyOf(q, q.symbol), precision: precisionFor(price),
    },
    price,
    prevClose: num(q.previous_close),
    open: num(q.open), high: num(q.high), low: num(q.low), volume: num(q.volume),
    change: num(q.change), pct: num(q.percent_change),
    time: parseDateTime(q.datetime),                              // fecha de la sesión (hora de la bolsa)
    lastQuoteAt: (num(q.last_quote_at) || num(q.timestamp)) * 1000, // última cotización (UTC real, ms)
    isMarketOpen: q.is_market_open === true,
  };
}

function parseSearchItem(d) {
  const us = d.country === 'United States';
  const plan = d.access && d.access.plan ? d.access.plan : null;
  return {
    id: us || String(d.symbol).includes('/') ? d.symbol : `${d.symbol}:${d.exchange}`,
    symbol: d.symbol, name: d.instrument_name || d.symbol,
    exchange: d.exchange || '', mic: d.mic_code || '', currency: d.currency || '',
    country: d.country || '', type: d.instrument_type || '', timezone: d.exchange_timezone || '',
    plan, available: !plan || plan === API.freePlan,
  };
}

/* ---------------------------------------------------------------------------
 * Conocimiento de instrumentos (plan, nombre) y de sesiones
 * ------------------------------------------------------------------------- */

const instrumentKey = (id) => `instrument|${id}`;
const unavailableKey = (id) => `unavailable|${id}`;
const sessionKey = (id) => `session|${id}`;

function rememberInstrument(item) { client.cachePut(instrumentKey(item.id), item, INSTRUMENT_TTL); }
function knownInstrument(id) { const e = client.cacheGet(instrumentKey(id)); return e ? e.data : null; }

/** Error de plan conocido de antemano (sin gastar créditos), o null. */
function planError(id) {
  const info = knownInstrument(id);
  if (info && !info.available) {
    return new ApiError('PLAN', `${id} requiere el plan ${info.plan} de Twelve Data; el plan gratuito (${API.freePlan}) no lo incluye.`);
  }
  const rej = client.cacheGet(unavailableKey(id));
  if (rej) return new ApiError('PLAN', MESSAGES.PLAN, { apiMessage: rej.data.apiMessage });
  return null;
}
function rememberRejection(id, err) {
  if (err && err.code === 'PLAN') client.cachePut(unavailableKey(id), { apiMessage: err.apiMessage }, UNAVAILABLE_TTL);
}

/** "SAN:BME" → { symbol: 'SAN', exchange: 'BME' }; "AAPL" o "EUR/USD" → { symbol }. */
function idParams(id) {
  const i = id.lastIndexOf(':');
  return i > 0 ? { symbol: id.slice(0, i), exchange: id.slice(i + 1) } : { symbol: id };
}

/* ---------------------------------------------------------------------------
 * API pública
 * ------------------------------------------------------------------------- */

function barsPerDayFor(tf, session) {
  if (tf.kind === 'intraday') return session[1] / tf.minutes;
  return tf.kind === 'weekly' ? 0.2 : 1;
}

/** Velas de una temporalidad, con metadatos y origen. */
async function fetchMarketData(id, tfKey, { priority = 3 } = {}) {
  const tf = TIMEFRAMES[tfKey];
  const known = planError(id);
  if (known) throw known;

  let res;
  try {
    res = await client.get('/time_series',
      { ...idParams(id), interval: tf.interval, outputsize: tf.outputsize, timezone: 'Exchange' },
      { ttl: CACHE_TTL[tf.interval], priority });
  } catch (err) {
    rememberRejection(id, err);
    throw err;
  }
  const bars = parseSeries(res.data);
  if (bars.length < 30) throw new ApiError('NOT_FOUND', 'Twelve Data devuelve demasiado pocas velas para analizar este símbolo.');

  const m = res.data.meta || {};
  let session = null, sessionExact = true;
  if (tf.kind === 'intraday') {
    const inferred = inferSession(bars, tf.minutes);
    const stored = client.cacheGet(sessionKey(id));
    if (inferred.exact) client.cachePut(sessionKey(id), inferred.session, SESSION_TTL);
    if (!inferred.exact && stored) session = stored.data;            // mejor el horario exacto ya aprendido
    else { session = inferred.session; sessionExact = inferred.exact; }
  }
  const info = knownInstrument(id);
  const meta = {
    id, symbol: m.symbol || idParams(id).symbol,
    name: (info && info.name) || m.symbol || id,
    exchange: m.exchange || (info && info.exchange) || '',
    mic: m.mic_code || '', timezone: m.exchange_timezone || '', type: m.type || '',
    currency: currencyOf(m, id),
    precision: precisionFor(last(bars).close),
    session, sessionExact,
  };
  return {
    meta, bars,
    barsPerDay: barsPerDayFor(tf, session),
    source: { provider: API.provider, at: res.at, cached: res.cached, interval: tf.interval },
  };
}

/** Separa una respuesta de quote (individual o por lotes) por identificador. */
function splitQuotes(body, ids) {
  if (ids.length === 1) return [[ids[0], body]];
  return ids.map((id) => {
    if (body[id]) return [id, body[id]];
    const sym = idParams(id).symbol;
    const hit = Object.values(body).find((v) => v && v.symbol === sym);
    return [id, hit || null];
  });
}

/**
 * Cotizaciones de varios símbolos, agrupadas en peticiones por lotes de hasta
 * 8 (el cupo por minuto; cada símbolo cuesta 1 crédito). Nunca rechaza: cada
 * identificador obtiene su cotización o su ApiError.
 */
async function fetchQuotes(ids, { priority = 2, force = false } = {}) {
  const out = new Map();
  const need = [];
  for (const id of [...new Set(ids)]) {
    const known = planError(id);
    if (known) { out.set(id, known); continue; }
    const c = !force && client.cacheGet(`quote|${id}`);
    if (c) out.set(id, { ...parseQuote(c.data), id, at: c.t, cached: true });
    else need.push(id);
  }
  for (let i = 0; i < need.length; i += API.perMinute) {
    const chunk = need.slice(i, i + API.perMinute);
    try {
      const res = await client.get('/quote', { symbol: chunk.join(',') }, { cost: chunk.length, priority });
      for (const [id, body] of splitQuotes(res.data, chunk)) {
        if (!body) { out.set(id, new ApiError('NOT_FOUND', MESSAGES.NOT_FOUND)); continue; }
        if (body.status === 'error' || (body.code && !body.symbol)) {
          const err = errorFrom(Number(body.code) || 400, body);
          rememberRejection(id, err);
          out.set(id, err);
          continue;
        }
        const e = client.cachePut(`quote|${id}`, body, CACHE_TTL.quote);
        out.set(id, { ...parseQuote(body), id, at: e.t, cached: false });
      }
    } catch (err) {
      if (chunk.length === 1) rememberRejection(chunk[0], err);
      chunk.forEach((id) => out.set(id, err));
    }
  }
  return out;
}

/**
 * Búsqueda de instrumentos (nombre, bolsa, divisa y plan necesario).
 * Se intenta sin clave, que no consume créditos; si Twelve Data la exige, se usa la
 * clave (1 crédito por búsqueda).
 */
async function searchSymbols(text, { signal } = {}) {
  const q = String(text || '').trim();
  if (!q) return [];
  const params = { symbol: q, outputsize: 15, show_plan: 'true' };
  let res;
  try {
    res = await client.get('/symbol_search', params, { ttl: CACHE_TTL.search, auth: false, signal, priority: 4 });
  } catch (err) {
    if (err.code !== 'AUTH') throw err;
    res = await client.get('/symbol_search', params, { ttl: CACHE_TTL.search, auth: true, cost: 1, signal, priority: 4 });
  }
  const items = (res.data.data || []).map(parseSearchItem);
  items.forEach(rememberInstrument);
  // Primero lo que entra en el plan gratuito; dentro de cada grupo, el orden de Twelve Data
  return items.sort((a, b) => Number(b.available) - Number(a.available));
}

Aura.data = {
  fetchMarketData, fetchQuotes, searchSymbols, knownInstrument,
  // expuestos para las pruebas
  parseDateTime, parseSeries, parseQuote, parseSearchItem, inferSession, precisionFor, idParams, barsPerDayFor,
};
})();
