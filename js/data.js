/* =========================================================================
 * Aura Invest · Capa de datos
 * Toda la app consume únicamente `fetchMarketData()` y `fetchQuote()`.
 * Para usar una API real basta con cambiar DATA_SOURCE y aportar la clave.
 * ========================================================================= */
(() => {
'use strict';

const { TIMEFRAMES, DAILY_HISTORY, INTRADAY_DAYS, DAY } = Aura.config;
const { last, sleep, hashStr, mulberry32, makeGauss, dayStart, weekdayOf, lastClosedSession, tradingDaysBack } = Aura.utils;

const DATA_SOURCE = 'simulated';   // 'simulated' | 'twelvedata'

/** Universo de ejemplo con parámetros del simulador (no son cotizaciones reales). */
const TICKERS = {
  'AAPL':   { symbol: 'AAPL',   name: 'Apple Inc.',            exchange: 'NASDAQ', currency: 'USD', price: 255.4, vol: 0.016,  drift: 0.0005,  avgVolume: 52e6,  session: [570, 390] },
  'MSFT':   { symbol: 'MSFT',   name: 'Microsoft Corp.',       exchange: 'NASDAQ', currency: 'USD', price: 512.8, vol: 0.0145, drift: 0.00055, avgVolume: 21e6,  session: [570, 390] },
  'NVDA':   { symbol: 'NVDA',   name: 'NVIDIA Corp.',          exchange: 'NASDAQ', currency: 'USD', price: 186.6, vol: 0.027,  drift: 0.0012,  avgVolume: 185e6, session: [570, 390] },
  'TSLA':   { symbol: 'TSLA',   name: 'Tesla Inc.',            exchange: 'NASDAQ', currency: 'USD', price: 438.2, vol: 0.034,  drift: 0.0007,  avgVolume: 92e6,  session: [570, 390] },
  'SAN.MC': { symbol: 'SAN.MC', name: 'Banco Santander, S.A.', exchange: 'BME',    currency: 'EUR', price: 8.912, vol: 0.017,  drift: 0.0007,  avgVolume: 31e6,  session: [540, 510] },
};

/** Metadatos de un ticker; los desconocidos reciben parámetros genéricos derivados de su nombre. */
function resolveMeta(symbol) {
  const known = TICKERS[symbol];
  const h = hashStr(symbol);
  const meta = known ? { ...known } : {
    symbol, name: `${symbol} (ticker simulado)`, exchange: 'SIM', currency: 'USD',
    price: 20 + (h % 380), vol: 0.012 + ((h >>> 8) % 22) / 1000, drift: 0.0002 + ((h >>> 16) % 8) / 10000,
    avgVolume: 4e6 + ((h >>> 4) % 40) * 1e6, session: [570, 390], custom: true,
  };
  meta.precision = meta.price < 20 ? 3 : 2;
  return meta;
}

/**
 * Serie diaria OHLCV: paseo aleatorio geométrico con
 *  - regímenes de tendencia de duración aleatoria,
 *  - volatilidad agrupada (GARCH(1,1)),
 *  - saltos por resultados trimestrales y shocks esporádicos,
 *  - volumen correlacionado con el tamaño del movimiento.
 * Al final se reescala para que el último cierre coincida con el precio de referencia.
 */
function generateDaily(meta, endT, count) {
  const rng = mulberry32(hashStr(meta.symbol));
  const gauss = makeGauss(rng);
  const days = tradingDaysBack(endT, count);
  const base = meta.vol;
  const alpha = 0.08, beta = 0.9, omega = base * base * (1 - alpha - beta);
  const earningsPhase = hashStr(meta.symbol + 'E') % 63;

  let sigma2 = base * base, shock = 0, drift = meta.drift, regimeLeft = 0, close = 100, volTrend = 1;
  const bars = [], sigmas = [];

  for (let i = 0; i < days.length; i++) {
    if (regimeLeft-- <= 0) {                           // nuevo régimen de tendencia
      drift = meta.drift + gauss() * base * 0.1;
      regimeLeft = 15 + Math.floor(rng() * 90);
    }
    sigma2 = omega + alpha * shock * shock + beta * sigma2;
    const sigma = Math.sqrt(sigma2);
    const earnings = i % 63 === earningsPhase;
    let z = gauss();
    if (earnings) z += gauss() * 3;                   // gap por resultados
    else if (rng() < 0.012) z += gauss() * 2.5;       // shock esporádico

    const r = drift - 0.5 * sigma2 + sigma * z;
    shock = r - drift;
    const gap = earnings ? r * 0.8 : r * (0.15 + 0.2 * rng()) + gauss() * sigma * 0.15;
    const open = close * Math.exp(gap);
    const next = close * Math.exp(r);
    const high = Math.max(open, next) * Math.exp(Math.abs(gauss()) * sigma * 0.55);
    const low = Math.min(open, next) * Math.exp(-Math.abs(gauss()) * sigma * 0.55);
    volTrend = volTrend * 0.98 + 0.02 * Math.exp(gauss() * 0.3);
    const volume = meta.avgVolume * volTrend * Math.exp(gauss() * 0.28) * (0.65 + 0.55 * Math.abs(r) / base) * (earnings ? 2.6 : 1);

    bars.push({ time: days[i], open, high, low, close: next, volume: Math.round(volume) });
    sigmas.push(sigma);
    close = next;
  }

  const k = meta.price / close;
  for (const b of bars) { b.open *= k; b.high *= k; b.low *= k; b.close *= k; }
  return { bars, sigmas };
}

/**
 * Detalle intradía (5 min) de las últimas sesiones mediante un puente browniano
 * que parte de la apertura y termina en el cierre diario. El volumen sigue una
 * curva en "U" (más actividad en apertura y cierre). Los máximos, mínimos y
 * volumen diarios se recalculan para que ambas series sean coherentes.
 */
function generateIntraday(meta, daily, sigmas, nDays) {
  const rng = mulberry32(hashStr(meta.symbol + '|intraday'));
  const gauss = makeGauss(rng);
  const [openMin, sessMin] = meta.session;
  const n = Math.round(sessMin / 5);
  const out = [];

  for (let d = Math.max(1, daily.length - nDays); d < daily.length; d++) {
    const day = daily[d];
    const sd = sigmas[d] * (0.85 + 0.3 * rng());
    const sb = sd / Math.sqrt(n);
    const lo0 = Math.log(day.open), lc = Math.log(day.close);

    const B = [0];
    for (let k = 1; k <= n; k++) B.push(B[k - 1] + gauss() * sb);
    const path = B.map((b, k) => lo0 + (k / n) * (lc - lo0) + b - (k / n) * B[n]);

    const w = [];
    let wsum = 0;
    for (let k = 0; k < n; k++) {
      const x = (k + 0.5) / n;
      const v = (0.55 + 1.6 * Math.exp(-x * 9) + 0.9 * Math.exp(-(1 - x) * 11)) * Math.exp(gauss() * 0.35);
      w.push(v); wsum += v;
    }

    const t0 = day.time + openMin * 60;
    let hi = -Infinity, lo = Infinity, vsum = 0;
    for (let k = 0; k < n; k++) {
      const o = Math.exp(path[k]), c = Math.exp(path[k + 1]);
      const h = Math.max(o, c) * Math.exp(Math.abs(gauss()) * sb * 0.45);
      const l = Math.min(o, c) * Math.exp(-Math.abs(gauss()) * sb * 0.45);
      const v = Math.round(day.volume * (w[k] / wsum) * (1 + 0.2 * Math.abs(Math.log(c / o)) / sb));
      out.push({ time: t0 + k * 300, open: o, high: h, low: l, close: c, volume: v });
      hi = Math.max(hi, h); lo = Math.min(lo, l); vsum += v;
    }
    day.high = hi; day.low = lo; day.volume = vsum;
  }
  return out;
}

/** Agrupa velas consecutivas que comparten clave (p. ej. 5 min → 1 h, diario → semanal). */
function aggregateBars(bars, keyFn) {
  const out = [];
  let cur = null, curKey = null;
  for (const b of bars) {
    const k = keyFn(b.time);
    if (k !== curKey) {
      if (cur) out.push(cur);
      cur = { time: k, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume };
      curKey = k;
    } else {
      cur.high = Math.max(cur.high, b.high);
      cur.low = Math.min(cur.low, b.low);
      cur.close = b.close;
      cur.volume += b.volume;
    }
  }
  if (cur) out.push(cur);
  return out;
}
const intradayKey = (openMin, minutes) => (t) => {
  const open = dayStart(t) + openMin * 60;
  return open + Math.floor((t - open) / (minutes * 60)) * minutes * 60;
};
const weekKey = (t) => {
  const idx = Math.floor(t / DAY);
  return (idx - ((weekdayOf(t) + 6) % 7)) * DAY;      // lunes de esa semana
};
function barsPerDayFor(tf, meta) {
  if (tf.kind === 'intraday') return meta.session[1] / tf.minutes;
  return tf.kind === 'weekly' ? 0.2 : 1;
}

/** Proveedor por defecto: genera y cachea el histórico de cada ticker en memoria. */
const SimulatedProvider = {
  cache: new Map(),
  universe(symbol) {
    if (!this.cache.has(symbol)) {
      const meta = resolveMeta(symbol);
      const { bars: daily, sigmas } = generateDaily(meta, lastClosedSession(), DAILY_HISTORY);
      const intraday5 = generateIntraday(meta, daily, sigmas, INTRADAY_DAYS);
      const weekly = aggregateBars(daily, weekKey);
      this.cache.set(symbol, { meta, daily, intraday5, weekly, byMinutes: new Map([[5, intraday5]]) });
    }
    return this.cache.get(symbol);
  },
  async fetchOHLCV(symbol, tfKey) {
    await sleep(160 + Math.random() * 140);           // simula la latencia de una API
    const u = this.universe(symbol);
    const tf = TIMEFRAMES[tfKey];
    let bars;
    if (tf.kind === 'intraday') {
      if (!u.byMinutes.has(tf.minutes)) u.byMinutes.set(tf.minutes, aggregateBars(u.intraday5, intradayKey(u.meta.session[0], tf.minutes)));
      bars = u.byMinutes.get(tf.minutes);
    } else {
      bars = tf.kind === 'daily' ? u.daily : u.weekly;
    }
    return { meta: u.meta, bars, barsPerDay: barsPerDayFor(tf, u.meta) };
  },
  async fetchQuote(symbol) {
    const { meta, daily } = this.universe(symbol);
    const a = daily[daily.length - 1], b = daily[daily.length - 2];
    return { meta, price: a.close, prevClose: b.close, open: a.open, high: a.high, low: a.low, volume: a.volume, time: a.time };
  },
};

/**
 * Adaptador opcional para Twelve Data (https://twelvedata.com/docs#time-series).
 * Activar con DATA_SOURCE = 'twelvedata' y una clave en `apiKey`.
 * Alpha Vantage o Finnhub se integran igual: basta con devolver el mismo formato
 * { meta, bars: [{ time, open, high, low, close, volume }], barsPerDay } en orden ascendente.
 */
const TwelveDataProvider = {
  apiKey: 'TU_API_KEY',
  map: { '1D': ['5min', 220], '5D': ['15min', 280], '1M': ['1h', 300], '6M': ['1day', 300], 'YTD': ['1day', 400], '1A': ['1day', 400], '5A': ['1week', 400] },
  async fetchOHLCV(symbol, tfKey) {
    const [interval, outputsize] = this.map[tfKey];
    const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=${interval}&outputsize=${outputsize}&apikey=${this.apiKey}`;
    const json = await (await fetch(url)).json();
    if (json.status === 'error') throw new Error(json.message);
    const toTime = (s) => Date.parse(s.replace(' ', 'T') + (s.length > 10 ? 'Z' : 'T00:00:00Z')) / 1000;
    const bars = json.values.map((v) => ({ time: toTime(v.datetime), open: +v.open, high: +v.high, low: +v.low, close: +v.close, volume: +v.volume || 0 })).reverse();
    const price = last(bars).close;
    const meta = {
      symbol, name: json.meta.symbol, exchange: json.meta.exchange || '', currency: json.meta.currency || 'USD',
      session: [570, 390], precision: price < 20 ? 3 : 2,
    };
    return { meta, bars, barsPerDay: barsPerDayFor(TIMEFRAMES[tfKey], meta) };
  },
};

const PROVIDERS = { simulated: SimulatedProvider, twelvedata: TwelveDataProvider };

/** Punto único de acceso a datos OHLCV: sustituir aquí el proveedor por una API real. */
async function fetchMarketData(symbol, tfKey) {
  return PROVIDERS[DATA_SOURCE].fetchOHLCV(symbol, tfKey);
}
/** Cotización de la última sesión (deriva de las velas diarias si el proveedor no la ofrece). */
async function fetchQuote(symbol) {
  const p = PROVIDERS[DATA_SOURCE];
  if (p.fetchQuote) return p.fetchQuote(symbol);
  const { meta, bars } = await p.fetchOHLCV(symbol, '6M');
  const a = last(bars), b = bars[bars.length - 2] || a;
  return { meta, price: a.close, prevClose: b.close, open: a.open, high: a.high, low: a.low, volume: a.volume, time: a.time };
}

Aura.data = { TICKERS, fetchMarketData, fetchQuote };
})();
