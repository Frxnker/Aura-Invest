import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { loadAura, plain, ROOT } from './harness.mjs';
import { fakeFetch, fakeClock, td } from './helpers.mjs';

const KEY = 'clave-de-prueba-123';
const quoteAAPL = td('quote_AAPL');

/** Twelve Data falso que responde con las respuestas reales guardadas. */
function realTwelveData(extra = () => null) {
  return fakeFetch((u, init) => {
    const custom = extra(u, init);
    if (custom) return custom;
    const p = u.searchParams;
    if (u.pathname === '/time_series' && p.get('symbol') === 'AAPL') return { body: td(`time_series_AAPL_${p.get('interval')}`) };
    if (u.pathname === '/quote' && p.get('symbol') === 'AAPL') return { body: quoteAAPL };
    if (u.pathname === '/symbol_search' && p.get('symbol') === 'SAN') return { body: td('symbol_search_SAN') };
    return { status: 404, body: { code: 404, status: 'error', message: `sin fixture para ${u.pathname}?${p}` } };
  });
}

function app({ fetch = realTwelveData(), key = KEY } = {}) {
  const clock = fakeClock();
  const { Aura } = loadAura({ until: 'model', fetch, clock });
  if (key) Aura.store.setApiKey(key);
  return { Aura, fetch, clock };
}

/* ---- Parseo ---- */

test('fechas: la hora de la bolsa se codifica como UTC (09:30 NY → 09:30)', () => {
  const { Aura } = app();
  assert.equal(Aura.data.parseDateTime('2026-10-02 15:55:00'), Date.UTC(2026, 9, 2, 15, 55) / 1000);
  assert.equal(Aura.data.parseDateTime('2026-10-02'), Date.UTC(2026, 9, 2) / 1000);
  assert.ok(Number.isNaN(Aura.data.parseDateTime('ayer')));
});

test('time_series real (1day): 400 velas ascendentes y numéricas', () => {
  const { Aura } = app();
  const bars = plain(Aura.data.parseSeries(td('time_series_AAPL_1day')));
  assert.equal(bars.length, 400);
  assert.equal(bars[0].time, Date.UTC(2025, 2, 3) / 1000);
  assert.equal(bars.at(-1).time, Date.UTC(2026, 9, 2) / 1000);
  assert.ok(bars.every((b, i) => i === 0 || b.time > bars[i - 1].time));
  assert.deepEqual(bars.at(-1), { time: Date.UTC(2026, 9, 2) / 1000, open: 333.26001, high: 334.54001, low: 330.60999, close: 333.69, volume: 33245500 });
});

test('time_series: elimina fechas repetidas y velas incompletas', () => {
  const { Aura } = app();
  // La API devolvió así EUR/USD: dos entradas con la misma fecha (se queda la más reciente de la lista)
  const bars = Aura.data.parseSeries({ values: [
    { datetime: '2026-10-04', open: '1.1255', high: '1.1262', low: '1.12514', close: '1.1258' },
    { datetime: '2026-10-04', open: '1.1255', high: '1.1262', low: '1.12514', close: '1.12578' },
    { datetime: '2026-10-03', open: '1.12', high: '1.13', low: '1.11', close: '' },
  ] });
  assert.equal(bars.length, 1);
  assert.equal(bars[0].volume, 0, 'forex no trae volumen');
});

test('sesión deducida de las velas reales: 09:30–16:00 (390 min)', () => {
  const { Aura } = app();
  const s5 = plain(Aura.data.inferSession(Aura.data.parseSeries(td('time_series_AAPL_5min')), 5));
  const s15 = plain(Aura.data.inferSession(Aura.data.parseSeries(td('time_series_AAPL_15min')), 15));
  const s60 = plain(Aura.data.inferSession(Aura.data.parseSeries(td('time_series_AAPL_1h')), 60));
  assert.deepEqual(s5, { session: [570, 390], exact: true });
  assert.deepEqual(s15, { session: [570, 390], exact: true });
  assert.deepEqual(s60, { session: [570, 420], exact: false }, 'con velas de 1 h el cierre es aproximado');
});

test('quote real: precio, cierre anterior, estado del mercado y horas', () => {
  const { Aura } = app();
  const q = plain(Aura.data.parseQuote(quoteAAPL));
  assert.equal(q.price, 333.69);
  assert.equal(q.prevClose, 330.32001);
  assert.equal(q.isMarketOpen, false);
  assert.equal(q.lastQuoteAt, 1790971140 * 1000);
  assert.equal(q.time, Date.UTC(2026, 9, 2) / 1000);
  assert.deepEqual(q.meta, { symbol: 'AAPL', name: 'Apple Inc.', exchange: 'NASDAQ', mic: 'XNGS', currency: 'USD', precision: 2, pair: false });
});

/* ---- fetchMarketData ---- */

test('cada temporalidad pide su intervalo, en hora de la bolsa y con la clave en cabecera', async () => {
  const { Aura, fetch } = app();
  const expected = { '1D': ['5min', '260'], '5D': ['15min', '330'], '1M': ['1h', '360'], '6M': ['1day', '400'], '5A': ['1week', '400'] };
  for (const [tf, [interval, outputsize]] of Object.entries(expected)) {
    await Aura.data.fetchMarketData('AAPL', tf);
    const call = fetch.calls.at(-1);
    assert.deepEqual(call.params, { symbol: 'AAPL', interval, outputsize, timezone: 'Exchange' }, tf);
    assert.equal(call.headers.Authorization, `apikey ${KEY}`);
  }
});

test('6M, YTD y 1A comparten la misma petición diaria (caché)', async () => {
  const { Aura, fetch } = app();
  await Aura.data.fetchMarketData('AAPL', '6M');
  await Aura.data.fetchMarketData('AAPL', 'YTD');
  const d = await Aura.data.fetchMarketData('AAPL', '1A');
  assert.equal(fetch.calls.length, 1);
  assert.equal(d.source.cached, true);
});

test('datos reales de todas las temporalidades: hay 120 velas de calentamiento y el modelo funciona', async () => {
  const { Aura } = app();
  for (const tf of ['1D', '5D', '1M', '6M', 'YTD', '1A', '5A']) {
    const data = await Aura.data.fetchMarketData('AAPL', tf);
    assert.equal(data.meta.currency, 'USD');
    assert.equal(data.meta.timezone, 'America/New_York');
    const m = Aura.model.analyze(data, tf);
    assert.equal(m.ws, 120, `${tf}: la ventana tiene sus 120 velas de calentamiento`);
    assert.ok(m.vis.length >= 10, tf);
    assert.ok(Number.isFinite(m.fc.end.center) && Number.isFinite(m.trend.score), tf);
  }
});

test('el horario exacto aprendido en 1D/5D se usa también en 1M (velas de 1 h)', async () => {
  const { Aura } = app();
  const before = await Aura.data.fetchMarketData('AAPL', '1M');
  assert.equal(before.barsPerDay, 7);
  assert.equal(before.meta.sessionExact, false);
  await Aura.data.fetchMarketData('AAPL', '5D');
  Aura.api.client.clearMemoryCache();
  const after = await Aura.data.fetchMarketData('AAPL', '1M');
  assert.deepEqual(plain(after.meta.session), [570, 390]);
  assert.equal(after.barsPerDay, 6.5);
});

test('outputsize suficiente en el peor caso (sesiones de 8,5 h, bolsas europeas)', () => {
  const { Aura } = app();
  const { TIMEFRAMES } = Aura.config;
  const end = Date.UTC(2026, 9, 2) / 1000;                   // viernes
  for (const [tfKey, tf] of Object.entries(TIMEFRAMES)) {
    const times = [];
    const perDay = tf.kind === 'intraday' ? Math.ceil(510 / tf.minutes) : 1;
    for (let d = end; times.length < tf.outputsize; d -= 86400) {
      const wd = new Date(d * 1000).getUTCDay();
      if (wd === 0 || wd === 6) continue;
      if (tf.kind === 'weekly' && wd !== 1) continue;
      for (let k = perDay - 1; k >= 0 && times.length < tf.outputsize; k--) times.push(d + 540 * 60 + k * (tf.minutes || 0) * 60);
    }
    times.reverse();
    const bars = times.map((time, i) => { const c = 100 + 5 * Math.sin(i / 7); return { time, open: c, high: c + 1, low: c - 1, close: c, volume: 1000 }; });
    const m = Aura.model.analyze({ meta: { precision: 2, currency: 'EUR', session: [540, 510] }, bars, barsPerDay: tf.kind === 'intraday' ? 510 / tf.minutes : 1 }, tfKey);
    assert.equal(m.ws, 120, `${tfKey}: con ${tf.outputsize} velas faltaría calentamiento`);
  }
});

test('sin clave: no se pide nada y el error es NO_KEY', async () => {
  const { Aura, fetch } = app({ key: '' });
  const err = await Aura.data.fetchMarketData('AAPL', '6M').catch((e) => e);
  assert.equal(err.code, 'NO_KEY');
  assert.equal(fetch.calls.length, 0);
});

/* ---- Cotizaciones por lotes ---- */

test('lote real de cotizaciones: una petición, un crédito por símbolo y error por símbolo', async () => {
  // Respuesta real de Twelve Data (plan Basic): un campo por símbolo pedido; SAN:BME → 403
  const batch = td('quote_batch_watchlist');
  const ids = ['AAPL', 'MSFT', 'NVDA', 'TSLA', 'SAN:BME'];
  const fetch = realTwelveData((u) => (u.pathname === '/quote' && u.searchParams.get('symbol').includes(',') ? { body: batch } : null));
  const { Aura } = app({ fetch });
  const res = await Aura.data.fetchQuotes(ids);
  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0].params.symbol, 'AAPL,MSFT,NVDA,TSLA,SAN:BME');
  assert.equal(Aura.api.client.status().creditsToday, 5);
  assert.deepEqual(['AAPL', 'MSFT', 'NVDA', 'TSLA'].map((id) => res.get(id).price), [333.69, 517.53003, 233.95, 370.59]);
  assert.equal(res.get('MSFT').meta.name, 'Microsoft Corporation Common Stock');
  const san = res.get('SAN:BME');
  assert.equal(san.code, 'PLAN');
  assert.match(san.apiMessage, /not available with your plan/);

  // Segunda vez: cotizaciones de caché y SAN:BME recordado como fuera del plan → 0 peticiones
  const again = await Aura.data.fetchQuotes(ids);
  assert.equal(fetch.calls.length, 1);
  assert.equal(again.get('AAPL').cached, true);
  assert.equal(again.get('SAN:BME').code, 'PLAN');
});

test('errores reales: SAN en la BME (HTTP 404 que significa plan) y símbolo inexistente', async () => {
  const fetch = realTwelveData((u) => {
    const s = u.searchParams.get('symbol');
    if (s === 'SAN') return { status: 404, body: td('error_SAN_BME_time_series') };
    if (s === 'ZZZQXW') return { status: 404, body: td('error_not_found') };
    return null;
  });
  const { Aura } = app({ fetch });
  const plan = await Aura.data.fetchMarketData('SAN:BME', '6M').catch((e) => e);
  assert.equal(plan.code, 'PLAN');
  assert.match(plan.apiMessage, /Pro or Venture plan/);
  const nf = await Aura.data.fetchMarketData('ZZZQXW', '6M').catch((e) => e);
  assert.equal(nf.code, 'NOT_FOUND');
});

test('más de 8 símbolos: lotes de 8 y espera de cupo entre ellos', async () => {
  const ids = Array.from({ length: 10 }, (_, i) => `T${i}`);
  const batchFor = (syms) => Object.fromEntries(syms.map((s) => [s, { ...quoteAAPL, symbol: s }]));
  const fetch = fakeFetch((u) => ({ body: batchFor(u.searchParams.get('symbol').split(',')) }));
  const { Aura, clock } = app({ fetch });
  const t0 = clock.now();
  const res = await Aura.data.fetchQuotes(ids);
  assert.deepEqual(fetch.calls.map((c) => c.params.symbol.split(',').length), [8, 2]);
  assert.ok(clock.now() - t0 >= 60000, 'el segundo lote esperó a tener cupo');
  assert.ok(ids.every((id) => res.get(id).price === 333.69));
});

/* ---- Búsqueda y planes ---- */

test('búsqueda real: sin clave (0 créditos), con nombre, bolsa, divisa y plan', async () => {
  const { Aura, fetch } = app();
  const items = plain(await Aura.data.searchSymbols('SAN'));
  assert.equal(fetch.calls[0].headers.Authorization, undefined);
  assert.equal(Aura.api.client.status().creditsToday, 0);
  const bme = items.find((i) => i.exchange === 'BME');
  const nyse = items.find((i) => i.exchange === 'NYSE');
  assert.deepEqual([bme.id, bme.name, bme.currency, bme.plan, bme.available], ['SAN:BME', 'Banco Santander, S.A.', 'EUR', 'Pro', false]);
  assert.deepEqual([nyse.id, nyse.currency, nyse.plan, nyse.available], ['SAN', 'USD', 'Basic', true]);
});

test('un mercado fuera del plan gratuito (SAN en la BME) se avisa sin gastar créditos', async () => {
  const { Aura, fetch } = app();
  await Aura.data.searchSymbols('SAN');
  const n = fetch.calls.length;
  const err = await Aura.data.fetchMarketData('SAN:BME', '6M').catch((e) => e);
  assert.equal(err.code, 'PLAN');
  assert.match(err.message, /plan Pro/);
  assert.equal(fetch.calls.length, n, 'no se llamó a time_series');
});

test('si la API rechaza un símbolo por plan, no se vuelve a pedir durante un día', async () => {
  const fetch = realTwelveData((u) => (u.searchParams.get('symbol') === 'VOD' ? { status: 403, body: { code: 403, status: 'error', message: 'Not available on your plan.' } } : null));
  const { Aura, clock } = app({ fetch });
  assert.equal((await Aura.data.fetchMarketData('VOD:LSE', '6M').catch((e) => e)).code, 'PLAN');
  assert.deepEqual(fetch.calls[0].params, { symbol: 'VOD', exchange: 'LSE', interval: '1day', outputsize: '400', timezone: 'Exchange' });
  assert.equal((await Aura.data.fetchMarketData('VOD:LSE', '6M').catch((e) => e)).code, 'PLAN');
  assert.equal(fetch.calls.length, 1);
  clock.advance(86400 * 1000 + 1);
  await Aura.data.fetchMarketData('VOD:LSE', '6M').catch(() => {});
  assert.equal(fetch.calls.length, 2);
});

test('si la búsqueda sin clave se rechaza, se repite con clave (1 crédito)', async () => {
  const fetch = fakeFetch((u, init) => (init.headers && init.headers.Authorization
    ? { body: td('symbol_search_apple') }
    : { status: 401, body: td('error_401_bad_key') }));
  const { Aura } = app({ fetch });
  const items = await Aura.data.searchSymbols('apple');
  assert.ok(items.length > 0);
  assert.equal(fetch.calls.length, 2);
  assert.equal(Aura.api.client.status().creditsToday, 1);
});

/* ---- Sin simulador en la app ---- */

test('la app no contiene el simulador ni datos inventados', () => {
  const files = readdirSync(path.join(ROOT, 'js')).map((f) => readFileSync(path.join(ROOT, 'js', f), 'utf8'));
  assert.equal(files.some((s) => /Math\.random/.test(s)), false, 'ningún js/ usa Math.random');
  assert.equal(files.some((s) => /simulad|simulator|mulberry/i.test(s)), false);
  const html = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.equal(/simulad/i.test(html), false);
});

/* ---- Si la API falla: datos antiguos de la caché, marcados ---- */

test('velas: si la API falla y hay caché caducada, se devuelve marcada como antigua', async () => {
  let fail = null;
  const fetch = realTwelveData(() => fail);
  const { Aura, clock } = app({ fetch });
  const ok = await Aura.data.fetchMarketData('AAPL', '6M');
  assert.equal(ok.source.stale, false);
  clock.advance(2 * 3600 * 1000);                              // la caché diaria (1 h) ha caducado
  for (const [name, res] of [
    ['red', new TypeError('Failed to fetch')],
    ['servidor', { status: 503, body: { code: 503, status: 'error', message: 'Service Unavailable' } }],
    ['cupo diario', { status: 429, body: { code: 429, status: 'error', message: 'You have run out of API credits for the day.' } }],
  ]) {
    fail = res;
    const old = await Aura.data.fetchMarketData('AAPL', '6M');
    assert.equal(old.source.stale, true, name);
    assert.ok(old.source.error && old.source.error.code, name);
    assert.equal(old.bars.length, ok.bars.length, name);
    assert.equal(old.source.at, ok.source.at, `${name}: conserva la hora real de los datos`);
  }
});

test('sin caché previa, o si el fallo es de plan/símbolo, no hay datos antiguos: error', async () => {
  const fetch = realTwelveData((u) => (u.searchParams.get('symbol') === 'AAPL' ? new TypeError('Failed to fetch') : null));
  const { Aura } = app({ fetch });
  assert.equal((await Aura.data.fetchMarketData('AAPL', '6M').catch((e) => e)).code, 'NETWORK');
  assert.equal((await Aura.data.fetchMarketData('ZZZQXW', '6M').catch((e) => e)).code, 'NOT_FOUND');
});

test('cotizaciones: si el lote falla, las que había en caché vuelven marcadas como antiguas', async () => {
  let fail = false;
  const batch = td('quote_batch_watchlist');
  const fetch = fakeFetch(() => (fail ? new TypeError('Failed to fetch') : { body: { AAPL: batch.AAPL, MSFT: batch.MSFT } }));
  const { Aura, clock } = app({ fetch });
  await Aura.data.fetchQuotes(['AAPL', 'MSFT']);
  clock.advance(5 * 60000);
  fail = true;
  const res = await Aura.data.fetchQuotes(['AAPL', 'MSFT', 'NVDA']);
  assert.equal(res.get('AAPL').stale, true);
  assert.equal(res.get('AAPL').price, 333.69);
  assert.equal(res.get('AAPL').error.code, 'NETWORK');
  assert.equal(res.get('NVDA').code, 'NETWORK', 'sin caché: error');
});

test('búsqueda real de KO: sin duplicados de la misma cotización en varias bolsas de EE. UU.', async () => {
  const fetch = fakeFetch(() => ({ body: td('symbol_search_KO') }));
  const { Aura } = app({ fetch });
  const ids = plain(await Aura.data.searchSymbols('KO')).map((i) => i.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids[0], 'KO');
  assert.equal(td('symbol_search_KO').data.filter((d) => d.symbol === 'KO' && d.country === 'United States').length > 1, true, 'la respuesta real trae KO repetido');
});

/* ---- Histórico diario para la cartera ---- */

test('histórico diario: tamaño según la fecha de inicio y caché compartida con 6M/YTD/1A', async () => {
  const fetch = realTwelveData((u) => (u.searchParams.get('symbol') === 'EUR/USD' ? { body: td('time_series_EURUSD_1day') } : null));
  const { Aura, clock } = app({ fetch });
  await Aura.data.fetchMarketData('AAPL', '6M');
  const h = await Aura.data.fetchDailyHistory('AAPL', '2025-10-01');      // 369 días + 30 de margen ≤ 400
  assert.equal(fetch.calls.length, 1, 'mismo outputsize=400: sale de la caché');
  assert.equal(h.closes.at(-1).date, '2026-10-02');
  assert.equal(h.currency, 'USD');
  assert.equal(h.complete, true);
  const fx = await Aura.data.fetchDailyHistory('EUR/USD', '2025-10-01');
  assert.equal(fx.currency, 'USD');
  assert.deepEqual(fetch.calls.at(-1).params, { symbol: 'EUR/USD', interval: '1day', outputsize: '400', timezone: 'Exchange' });
  assert.equal(new Date(clock.now()).toISOString().slice(0, 10), '2026-10-05');
  await Aura.data.fetchDailyHistory('EUR/USD', '2023-01-02').catch(() => {});
  assert.equal(fetch.calls.at(-1).params.outputsize, '1600', 'desde 2023: ~1.400 días → 1600');
});
