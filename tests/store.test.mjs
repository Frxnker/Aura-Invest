import test from 'node:test';
import assert from 'node:assert/strict';
import { loadAura, memoryStorage, plain } from './harness.mjs';

const { Aura } = loadAura({ until: 'store' });
const { createStore, KEY, VERSION } = Aura.storeInternals;

test('usa una única clave "aura:v1" con número de versión', () => {
  const ls = memoryStorage();
  const s = createStore(ls);
  s.setApiKey('  abc123  ');
  assert.deepEqual(Object.keys(ls.dump()), ['aura:v1']);
  const saved = JSON.parse(ls.getItem(KEY));
  assert.equal(saved.version, VERSION);
  assert.equal(saved.settings.apiKey, 'abc123', 'se recortan los espacios');
  assert.equal(createStore(ls).getApiKey(), 'abc123', 'persiste entre sesiones');
});

test('sin datos guardados arranca con valores por defecto', () => {
  const s = createStore(memoryStorage());
  assert.equal(s.getApiKey(), '');
  assert.equal(s.getUsage().credits, 0);
  assert.equal(s.problem, null);
});

test('migra contenido sin versión (v0) a la versión actual', () => {
  const ls = memoryStorage({ 'aura:v1': JSON.stringify({ algo: 'antiguo' }) });
  const s = createStore(ls);
  assert.equal(s.getApiKey(), '');
  s.setApiKey('k');
  assert.equal(JSON.parse(ls.getItem(KEY)).version, VERSION);
});

test('JSON dañado: se restablece y se avisa', () => {
  const s = createStore(memoryStorage({ 'aura:v1': '{no es json' }));
  assert.equal(s.getApiKey(), '');
  assert.match(s.problem, /dañados/);
});

test('datos de una versión más nueva: no se sobrescriben', () => {
  const future = JSON.stringify({ version: 99, settings: { apiKey: 'futura' } });
  const ls = memoryStorage({ 'aura:v1': future });
  const s = createStore(ls);
  assert.equal(s.persistent, false);
  s.setApiKey('otra');
  assert.equal(ls.getItem(KEY), future, 'el contenido original queda intacto');
  assert.match(s.problem, /más nueva/);
});

test('repara tipos inválidos sin perder lo válido', () => {
  const ls = memoryStorage({ 'aura:v1': JSON.stringify({
    version: 1, settings: { apiKey: 42 },
    usage: { day: '2026-10-05', credits: 'x', recent: [{ t: 1, cost: 1 }, 'basura'] },
    cache: { buena: { t: 1, ttl: 60, data: { a: 1 } }, mala: { t: 'x' } },
  }) });
  const s = createStore(ls);
  assert.equal(s.getApiKey(), '');
  assert.equal(s.getUsage().day, '2026-10-05');
  assert.equal(s.getUsage().credits, 0);
  assert.equal(s.getUsage().recent.length, 1);
  assert.ok(s.getCache('buena'));
  assert.equal(s.getCache('mala'), null);
});

test('localStorage bloqueado: funciona en memoria y lo indica', () => {
  const broken = { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('SecurityError'); } };
  const s = createStore(broken);
  assert.equal(s.persistent, false);
  assert.equal(s.setApiKey('k'), false);
  assert.equal(s.getApiKey(), 'k');
  assert.match(s.problem, /no permite guardar/);
});

test('cuota llena: descarta la caché más antigua y guarda', () => {
  const ls = memoryStorage();
  let fail = 0;
  const tight = { ...ls, getItem: ls.getItem, setItem(k, v) { if (fail-- > 0) throw new Error('QuotaExceededError'); ls.setItem(k, v); } };
  const s = createStore(tight);
  for (let i = 0; i < 10; i++) s.setCache(`k${i}`, { t: i, ttl: 60, data: i });
  fail = 1;
  assert.equal(s.setApiKey('nueva'), true);
  assert.equal(s.cacheSize(), 5, 'se descartó la mitad más antigua');
  assert.equal(s.getCache('k0'), null);
  assert.ok(s.getCache('k9'));
  assert.equal(JSON.parse(ls.getItem(KEY)).settings.apiKey, 'nueva');
});

test('la caché tiene un máximo de entradas (se eliminan las más antiguas)', () => {
  const s = createStore(memoryStorage());
  for (let i = 0; i < 70; i++) s.setCache(`k${i}`, { t: i, ttl: 60, data: i });
  assert.equal(s.cacheSize(), 60);
  assert.equal(s.getCache('k0'), null);
  assert.ok(s.getCache('k69'));
});

test('migración v1 → v2: conserva clave, consumo y caché, y añade watchlist, alertas y preferencias', () => {
  const v1 = {
    version: 1,
    settings: { apiKey: 'clave-v1' },
    usage: { day: '2026-10-05', credits: 37, recent: [] },
    cache: { 'quote|AAPL': { t: 1, ttl: 60, data: { symbol: 'AAPL' } } },
  };
  const ls = memoryStorage({ 'aura:v1': JSON.stringify(v1) });
  const s = createStore(ls);
  assert.equal(s.getApiKey(), 'clave-v1');
  assert.equal(s.getUsage().credits, 37);
  assert.ok(s.getCache('quote|AAPL'));
  assert.deepEqual(plain(s.get('watchlist').map((w) => w.id)), ['AAPL', 'MSFT', 'NVDA', 'TSLA', 'SAN', 'EUR/USD']);
  assert.deepEqual(plain(s.get('alerts')), []);
  assert.deepEqual(plain(s.get('alertHistory')), []);
  assert.equal(s.get('prefs').notify, false);
  s.set('prefs', { notify: true, alertsSeenAt: 5 });
  const saved = JSON.parse(ls.getItem(KEY));
  assert.equal(saved.version, VERSION);
  assert.equal(saved.settings.apiKey, 'clave-v1');
});

test('migración v2 → v3: conserva watchlist, alertas y preferencias; añade cartera y frecuencia 15 min', () => {
  const v2 = {
    version: 2, settings: { apiKey: 'k' }, usage: { day: '', credits: 0, recent: [] }, cache: {},
    watchlist: [{ id: 'KO', name: 'Coca-Cola', exchange: 'NYSE', currency: 'USD' }],
    alerts: [{ id: 'a1', symbol: 'KO', type: 'price_above', status: 'active', value: 90 }],
    alertHistory: [{ at: 1, message: 'm' }], prefs: { notify: true, alertsSeenAt: 7 },
  };
  const s = createStore(memoryStorage({ 'aura:v1': JSON.stringify(v2) }));
  assert.deepEqual(plain(s.get('watchlist').map((w) => w.id)), ['KO']);
  assert.equal(s.get('alerts').length, 1);
  assert.deepEqual(plain(s.get('prefs')), { notify: true, alertsSeenAt: 7, refreshMinutes: 15 });
  assert.deepEqual(plain(s.get('portfolio')), { baseCurrency: 'EUR', transactions: [] });
});

test('v3: frecuencia no válida vuelve a 15 y se descartan operaciones mal formadas', () => {
  const s = createStore(memoryStorage({ 'aura:v1': JSON.stringify({
    version: 3, prefs: { refreshMinutes: 7 },
    portfolio: { baseCurrency: 'eur', transactions: [
      { id: 't1', type: 'buy', symbol: 'AAPL', date: '2026-01-05', quantity: 1, price: 200, fees: 0, currency: 'USD' },
      { id: 't2', type: 'regalo', symbol: 'AAPL', date: '2026-01-05', quantity: 1, price: 1, fees: 0 },
      { id: 't3', type: 'sell', symbol: 'AAPL', date: '5/1/2026', quantity: 1, price: 1, fees: 0 },
    ] },
  }) }));
  assert.equal(s.get('prefs').refreshMinutes, 15);
  assert.equal(s.get('portfolio').baseCurrency, 'EUR');
  assert.deepEqual(plain(s.get('portfolio').transactions.map((t) => t.id)), ['t1']);
});

test('v2: repara watchlist y alertas dañadas sin perder lo válido', () => {
  const ls = memoryStorage({ 'aura:v1': JSON.stringify({
    version: 2,
    watchlist: [{ id: 'AAPL', name: 'Apple' }, { id: 'AAPL' }, { id: '<img onerror=x>' }, 'basura', { id: 'KO', name: 42 }],
    alerts: [{ id: 'a1', symbol: 'AAPL', type: 'price_above', status: 'active', value: 300 }, { id: 2, symbol: 'X' }],
    alertHistory: [{ at: 1, message: 'ok' }, { at: 'x' }],
    prefs: { notify: 'sí' },
  }) });
  const s = createStore(ls);
  assert.deepEqual(plain(s.get('watchlist')), [{ id: 'AAPL', name: 'Apple', exchange: '', currency: '' }, { id: 'KO', name: '', exchange: '', currency: '' }]);
  assert.equal(s.get('alerts').length, 1);
  assert.equal(s.get('alertHistory').length, 1);
  assert.equal(s.get('prefs').notify, false);
});

test('set() solo admite secciones del usuario y el historial tiene un máximo', () => {
  const s = createStore(memoryStorage());
  assert.throws(() => s.set('settings', {}), /Sección desconocida/);
  s.set('alertHistory', Array.from({ length: 250 }, (_, i) => ({ at: i, message: `m${i}` })));
  assert.equal(s.get('alertHistory').length, 200);
  assert.equal(s.get('alertHistory')[0].message, 'm50');
});
