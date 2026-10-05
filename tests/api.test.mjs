import test from 'node:test';
import assert from 'node:assert/strict';
import { loadAura, memoryStorage } from './harness.mjs';
import { fakeFetch, fakeClock, td } from './helpers.mjs';

const { Aura } = loadAura({ until: 'api' });
const { createClient, classify } = Aura.api;
const { createStore } = Aura.storeInternals;

const OK = { status: 200, body: { status: 'ok', values: [] } };
const KEY = 'clave-de-prueba-123';

function setup({ handler = () => OK, key = KEY, usage } = {}) {
  const ls = memoryStorage();
  const store = createStore(ls);
  if (key) store.setApiKey(key);
  if (usage) store.setUsage(usage);
  const clock = fakeClock();
  const fetch = fakeFetch(handler);
  const client = createClient({ fetch, store, now: clock.now, wait: clock.wait });
  return { ls, store, clock, fetch, client };
}
const codeOf = (p) => p.then(() => 'ok', (e) => e.code);

test('la clave va en la cabecera Authorization y nunca en la URL', async () => {
  const { fetch, client } = setup();
  await client.get('/time_series', { symbol: 'AAPL', interval: '1day' });
  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0].headers.Authorization, `apikey ${KEY}`);
  assert.equal(fetch.calls[0].url.includes(KEY), false);
  assert.equal('apikey' in fetch.calls[0].params, false);
});

test('sin clave no se hace ninguna petición', async () => {
  const { fetch, client } = setup({ key: '' });
  assert.equal(await codeOf(client.get('/quote', { symbol: 'AAPL' })), 'NO_KEY');
  assert.equal(fetch.calls.length, 0);
});

test('caché: no repite la petición mientras no caduca y persiste entre sesiones', async () => {
  const { store, clock, fetch, client } = setup();
  const p = { symbol: 'AAPL', interval: '1day' };
  const a = await client.get('/time_series', p, { ttl: 60 });
  const b = await client.get('/time_series', p, { ttl: 60 });
  assert.equal(fetch.calls.length, 1);
  assert.equal(a.cached, false);
  assert.equal(b.cached, true);

  // Otra "sesión" con el mismo localStorage: sigue en caché
  const fetch2 = fakeFetch(() => OK);
  const client2 = createClient({ fetch: fetch2, store, now: clock.now, wait: clock.wait });
  assert.equal((await client2.get('/time_series', p, { ttl: 60 })).cached, true);
  assert.equal(fetch2.calls.length, 0);

  clock.advance(61000);
  assert.equal((await client.get('/time_series', p, { ttl: 60 })).cached, false);
  assert.equal(fetch.calls.length, 2);
});

test('la caché guardada no contiene la clave de API', async () => {
  const { ls, client } = setup();
  await client.get('/quote', { symbol: 'AAPL' }, { ttl: 60 });
  const saved = JSON.parse(ls.getItem('aura:v1'));
  assert.equal(JSON.stringify(saved.cache).includes(KEY), false);
});

test('peticiones idénticas simultáneas se agrupan en una', async () => {
  const { fetch, client } = setup();
  await Promise.all([client.get('/quote', { symbol: 'AAPL' }), client.get('/quote', { symbol: 'AAPL' })]);
  assert.equal(fetch.calls.length, 1);
});

test('límite por minuto: la 9.ª petición espera a que haya cupo (sin errores)', async () => {
  const { fetch, clock, client } = setup();
  const t0 = clock.now();
  const sentAt = [];
  const f = fakeFetch(() => { sentAt.push(clock.now()); return OK; });
  const c = createClient({ fetch: f, store: setup().store, now: clock.now, wait: clock.wait });
  const statuses = [];
  c.onStatus((s) => statuses.push(s));
  await Promise.all(Array.from({ length: 9 }, (_, i) => c.get('/quote', { symbol: `S${i}` })));
  assert.equal(f.calls.length, 9);
  assert.ok(sentAt.slice(0, 8).every((t) => t === t0), 'las 8 primeras salen ya');
  assert.ok(sentAt[8] >= t0 + 60000, 'la 9.ª sale al liberarse la ventana de 60 s');
  assert.ok(statuses.some((s) => s.waitingUntil > t0), 'se informa de la espera');
  assert.equal(fetch.calls.length, 0);
});

test('un lote cuesta un crédito por símbolo y respeta el cupo por minuto', async () => {
  const { clock, client, store } = setup();
  const sentAt = [];
  const f = fakeFetch(() => { sentAt.push(clock.now()); return OK; });
  const c = createClient({ fetch: f, store, now: clock.now, wait: clock.wait });
  await c.get('/quote', { symbol: 'A,B,C,D,E' }, { cost: 5 });
  await c.get('/quote', { symbol: 'F,G,H,I' }, { cost: 4 });
  assert.equal(store.getUsage().credits, 9);
  assert.ok(sentAt[1] - sentAt[0] >= 60000, '5 + 4 > 8: el segundo lote espera');
});

test('límite diario: al llegar a 800 no se envía nada más', async () => {
  const { fetch, client, clock } = setup({ usage: { day: '2026-10-05', credits: 799, recent: [] } });
  assert.equal(await codeOf(client.get('/quote', { symbol: 'A' })), 'ok');
  assert.equal(await codeOf(client.get('/quote', { symbol: 'B' })), 'DAILY_LIMIT');
  assert.equal(fetch.calls.length, 1);
  assert.equal(client.status().dailyExhausted, true);
  // Al cambiar el día UTC se reinicia el contador
  clock.advance(11 * 3600 * 1000);
  assert.equal(await codeOf(client.get('/quote', { symbol: 'C' })), 'ok');
  assert.equal(client.status().creditsToday, 1);
});

test('429 por minuto del servidor: espera al minuto siguiente y reintenta una sola vez', async () => {
  let n = 0;
  const limit = { status: 429, body: { code: 429, status: 'error', message: 'You have run out of API credits for the current minute. 9 API credits were used, with the current limit being 8.' } };
  const { fetch, clock, client } = setup({ handler: () => (n++ === 0 ? limit : OK) });
  const t0 = clock.now();
  assert.equal(await codeOf(client.get('/quote', { symbol: 'A' })), 'ok');
  assert.equal(fetch.calls.length, 2);
  assert.ok(clock.now() >= Math.ceil((t0 + 1) / 60000) * 60000, 'reintenta en el minuto siguiente');

  const s2 = setup({ handler: () => limit });
  assert.equal(await codeOf(s2.client.get('/quote', { symbol: 'A' })), 'MINUTE_LIMIT');
  assert.equal(s2.fetch.calls.length, 2, 'no reintenta en bucle');
});

test('429 diario del servidor: rechaza y deja de pedir hasta el día siguiente', async () => {
  const daily = { status: 429, body: { code: 429, status: 'error', message: 'You have run out of API credits for the day. 800 API credits were used, with the current limit being 800.' } };
  const { fetch, client } = setup({ handler: () => daily });
  const results = await Promise.all([codeOf(client.get('/quote', { symbol: 'A' })), codeOf(client.get('/quote', { symbol: 'B' }))]);
  assert.deepEqual(results, ['DAILY_LIMIT', 'DAILY_LIMIT']);
  assert.equal(await codeOf(client.get('/quote', { symbol: 'C' })), 'DAILY_LIMIT');
  assert.equal(fetch.calls.length, 1);
});

test('errores reales de Twelve Data: clave incorrecta y clave demo limitada → AUTH', async () => {
  for (const name of ['error_401_bad_key', 'error_401_demo_limited']) {
    const body = td(name);
    const { client } = setup({ handler: () => ({ status: 401, body }) });
    const err = await client.get('/quote', { symbol: 'AAPL' }).catch((e) => e);
    assert.equal(err.code, 'AUTH', name);
    assert.equal(err.httpStatus, 401);
    assert.match(err.apiMessage, /API key|apikey/i);
  }
});

test('Twelve Data puede devolver el error con HTTP 200: también se detecta', async () => {
  const { client } = setup({ handler: () => ({ status: 200, body: { code: 404, status: 'error', message: '**symbol** not found: ZZZZ.' } }) });
  assert.equal(await codeOf(client.get('/quote', { symbol: 'ZZZZ' })), 'NOT_FOUND');
});

test('clasificación de errores', () => {
  assert.equal(classify(403, { code: 403, message: 'Forbidden' }), 'PLAN');
  assert.equal(classify(200, { code: 404, message: 'This symbol is available starting with the Pro plan.' }), 'PLAN');
  assert.equal(classify(200, { code: 400, message: '**symbol** parameter is missing or invalid.' }), 'BAD_REQUEST');
  assert.equal(classify(500, null), 'SERVER');
  assert.equal(classify(429, { code: 429, message: 'run out of API credits for the day' }), 'DAILY_LIMIT');
  assert.equal(classify(429, { code: 429, message: 'current minute' }), 'MINUTE_LIMIT');
});

test('fallo de red y respuesta no JSON', async () => {
  const net = setup({ handler: () => new TypeError('Failed to fetch') });
  assert.equal(await codeOf(net.client.get('/quote', { symbol: 'A' })), 'NETWORK');
  const html = setup({ handler: () => ({ status: 502, body: '<html>Bad gateway</html>' }) });
  assert.equal(await codeOf(html.client.get('/quote', { symbol: 'A' })), 'SERVER');
});

test('sin conexión la petición no llega a Twelve Data: no cuenta créditos ni ocupa cupo del minuto', async () => {
  let online = false;
  const { client, fetch } = setup({ handler: () => (online ? OK : new TypeError('Failed to fetch')) });
  for (let i = 0; i < 12; i++) assert.equal(await codeOf(client.get('/quote', { symbol: `S${i}` }, { cost: 2 })), 'NETWORK');
  assert.equal(fetch.calls.length, 12);
  assert.equal(client.status().creditsToday, 0);
  assert.equal(client.status().minuteUsed, 0);
  online = true;
  await client.get('/quote', { symbol: 'AAPL' }, { cost: 3 });
  assert.equal(client.status().creditsToday, 3, 'las que sí llegan cuentan como siempre');
  assert.equal(client.status().minuteUsed, 3);
});

test('prioridad: con la cola esperando, lo prioritario sale antes', async () => {
  const { clock, store } = setup({ usage: { day: '2026-10-05', credits: 8, recent: Array.from({ length: 8 }, () => ({ t: Date.UTC(2026, 9, 5, 14, 0, 0), cost: 1 })) } });
  const order = [];
  const f = fakeFetch((u) => { order.push(u.searchParams.get('symbol')); return OK; });
  const c = createClient({ fetch: f, store, now: clock.now, wait: clock.wait });
  await Promise.all([
    c.get('/quote', { symbol: 'fondo' }, { priority: 1 }),
    c.get('/time_series', { symbol: 'grafico' }, { priority: 3 }),
  ]);
  assert.deepEqual(order, ['grafico', 'fondo']);
});

test('una petición cancelada mientras espera no se envía', async () => {
  const { clock, store } = setup({ usage: { day: '2026-10-05', credits: 8, recent: Array.from({ length: 8 }, () => ({ t: Date.UTC(2026, 9, 5, 14, 0, 0), cost: 1 })) } });
  const f = fakeFetch(() => OK);
  const c = createClient({ fetch: f, store, now: clock.now, wait: async () => {} });
  const ctrl = new AbortController();
  const p = c.get('/quote', { symbol: 'X' }, { signal: ctrl.signal });
  ctrl.abort();
  assert.equal(await codeOf(p), 'ABORTED');
  assert.equal(f.calls.length, 0);
});

test('las peticiones sin clave (coste 0) no consumen créditos ni esperan cupo', async () => {
  const { fetch, store, client } = setup({ usage: { day: '2026-10-05', credits: 800, recent: [] } });
  await client.get('/symbol_search', { symbol: 'apple' }, { auth: false });
  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0].headers.Authorization, undefined);
  assert.equal(store.getUsage().credits, 800);
});
