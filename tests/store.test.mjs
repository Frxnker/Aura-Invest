import test from 'node:test';
import assert from 'node:assert/strict';
import { loadAura, memoryStorage } from './harness.mjs';

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
