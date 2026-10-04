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

/**
 * Si la API falla por uno de estos motivos y hay una respuesta anterior en caché
 * (aunque haya caducado), se devuelve marcada como antigua (`stale`) junto al error.
 * Sin clave, fuera del plan o símbolo inexistente no hay "datos antiguos" que valgan.
 */
const STALE_OK = new Set(['NETWORK', 'SERVER', 'MINUTE_LIMIT', 'DAILY_LIMIT', 'AUTH']);

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
      pair: String(q.symbol || '').includes('/'),
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

/**
 * Petición de velas común a gráficos y cartera: plan conocido, caché por intervalo y,
 * si la API falla, la última respuesta guardada marcada como antigua.
 */
async function requestSeries(id, interval, outputsize, priority) {
  const known = planError(id);
  if (known) throw known;
  const params = { ...idParams(id), interval, outputsize, timezone: 'Exchange' };
  try {
    return await client.get('/time_series', params, { ttl: CACHE_TTL[interval], priority });
  } catch (err) {
    rememberRejection(id, err);
    const old = STALE_OK.has(err.code) && client.cacheGetAny(client.keyFor('/time_series', params));
    if (!old) throw err;
    return { data: old.data, cached: true, at: old.t, stale: true, error: err };
  }
}

const sourceOf = (res, interval) => ({ provider: API.provider, at: res.at, cached: res.cached, interval, stale: res.stale === true, error: res.error || null });

/** Velas de una temporalidad, con metadatos y origen. */
async function fetchMarketData(id, tfKey, { priority = 3 } = {}) {
  const tf = TIMEFRAMES[tfKey];
  const res = await requestSeries(id, tf.interval, tf.outputsize, priority);
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
    pair: id.includes('/'),
    precision: precisionFor(last(bars).close),
    session, sessionExact,
  };
  return {
    meta, bars,
    barsPerDay: barsPerDayFor(tf, session),
    source: sourceOf(res, tf.interval),
  };
}

/** Tamaños de petición para el histórico diario: 400 comparte caché con 6M/YTD/1A. */
const HISTORY_SIZES = [400, 800, 1600, 3200, 5000];

/**
 * Cierres diarios desde una fecha (para la cartera: tipo de cambio de cada operación
 * y evolución del valor). Devuelve { closes: [{ date, close }], currency, from, complete, source }.
 * `complete` es false si Twelve Data no llega hasta `fromDate` (más de 5000 sesiones).
 */
async function fetchDailyHistory(id, fromDate, { priority = 1 } = {}) {
  const days = Math.ceil((Date.now() - Date.parse(`${fromDate}T00:00:00Z`)) / 86400000) + 30;
  const outputsize = HISTORY_SIZES.find((n) => n >= days) || HISTORY_SIZES.at(-1);
  const res = await requestSeries(id, '1day', outputsize, priority);
  const closes = parseSeries(res.data).map((b) => ({ date: new Date(b.time * 1000).toISOString().slice(0, 10), close: b.close }));
  const m = res.data.meta || {};
  return {
    closes, currency: currencyOf(m, id),
    from: closes.length ? closes[0].date : null,
    complete: closes.length > 0 && (closes[0].date <= fromDate || closes.length < outputsize),
    source: sourceOf(res, '1day'),
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
      chunk.forEach((id) => out.set(id, staleQuote(id, err) || err));
    }
  }
  return out;
}

/** Última cotización guardada aunque haya caducado, marcada como antigua (o null). */
function staleQuote(id, err) {
  const old = STALE_OK.has(err.code) && client.cacheGetAny(`quote|${id}`);
  return old ? { ...parseQuote(old.data), id, at: old.t, cached: true, stale: true, error: err } : null;
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
  // Primero lo que entra en el plan gratuito; dentro de cada grupo, el orden de Twelve Data.
  // Una misma cotización de EE. UU. aparece en varias bolsas (p. ej. KO en NYSE e IEX) con el
  // mismo identificador: se deja solo la primera.
  const seen = new Set();
  return items.sort((a, b) => Number(b.available) - Number(a.available)).filter((i) => !seen.has(i.id) && seen.add(i.id));
}

/**
 * Velas diarias completas (OHLCV) para el backtest. `outputsize` hasta 5000 sesiones
 * (≈ 20 años); cuesta 1 crédito y queda en caché 1 h.
 */
async function fetchDailyBars(id, outputsize, { priority = 2 } = {}) {
  const res = await requestSeries(id, '1day', outputsize, priority);
  const bars = parseSeries(res.data);
  if (!bars.length) throw new ApiError('NOT_FOUND', MESSAGES.NOT_FOUND);
  const m = res.data.meta || {};
  const info = knownInstrument(id);
  return {
    meta: {
      id, symbol: m.symbol || idParams(id).symbol, name: (info && info.name) || m.symbol || id,
      exchange: m.exchange || '', currency: currencyOf(m, id), pair: id.includes('/'),
      precision: precisionFor(last(bars).close), session: null, sessionExact: true,
    },
    bars, barsPerDay: 1, source: sourceOf(res, '1day'),
  };
}

Aura.data = {
  fetchMarketData, fetchDailyHistory, fetchDailyBars, fetchQuotes, searchSymbols, knownInstrument,
  // expuestos para las pruebas
  parseDateTime, parseSeries, parseQuote, parseSearchItem, inferSession, precisionFor, idParams, barsPerDayFor,
};
})();
