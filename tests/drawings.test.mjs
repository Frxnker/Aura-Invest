import test from 'node:test';
import assert from 'node:assert/strict';
import { loadAura, memoryStorage, plain } from './harness.mjs';

const fresh = (ls = memoryStorage()) => loadAura({ until: 'drawings', localStorage: ls }).Aura;
const A = fresh();
const D = A.drawings;
const day = (d) => Date.UTC(2026, 0, d) / 1000;
const times = [day(5), day(6), day(7), day(8), day(9), day(12)];     // lunes–viernes y lunes
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≠ ${b}`);

test('fecha → índice lógico: exacta en las velas e interpolada entre ellas (p. ej. fin de semana)', () => {
  close(D.timeToLogical(times, day(7), 86400), 2);
  close(D.timeToLogical(times, day(7) + 43200, 86400), 2.5);
  close(D.timeToLogical(times, day(10), 86400), 4 + 1 / 3, 'sábado: entre el viernes (4) y el lunes (5)');
});

test('fuera de los datos se extrapola con el paso medio; logicalToTime es su inversa', () => {
  close(D.timeToLogical(times, day(2), 86400), -3);
  close(D.timeToLogical(times, day(14), 86400), 7);
  for (const t of [day(2), day(5), day(7) + 3600, day(10), day(14)]) close(D.logicalToTime(times, D.timeToLogical(times, t, 86400), 86400), t);
});

test('paso medio de las últimas velas', () => {
  close(D.stepOf(times), (day(12) - day(5)) / 5);
  assert.equal(D.stepOf([day(5)]), 86400);
});

test('qué dibujo hay bajo el puntero: tolerancia, el más cercano y los extremos primero', () => {
  const coords = [
    { id: 'h', kind: 'hline', y: 100 },
    { id: 't', kind: 'trend', xa: 10, ya: 200, xb: 110, yb: 300 },
  ];
  assert.deepEqual(plain(D.hitTest(coords, 50, 104)), { id: 'h', part: 'line' });
  assert.equal(D.hitTest(coords, 50, 110), null);
  assert.deepEqual(plain(D.hitTest(coords, 60, 252)), { id: 't', part: 'line' });
  assert.deepEqual(plain(D.hitTest(coords, 12, 203)), { id: 't', part: 'a' });
  assert.deepEqual(plain(D.hitTest(coords, 108, 299)), { id: 't', part: 'b' });
  assert.equal(D.hitTest(coords, 200, 400), null, 'más allá del segmento no cuenta');
  close(D.distToSegment(0, 10, 0, 0, 100, 0), 10);
});

test('mover: precio relativo (teclado) y tiempo para tendencias', () => {
  assert.equal(D.shift({ id: 'h', kind: 'hline', price: 100 }, { factor: 1.01 }).price, 101);
  const t = D.shift({ id: 't', kind: 'trend', a: { t: 10, p: 100 }, b: { t: 20, p: 200 } }, { factor: 0.5, dt: 5 });
  assert.deepEqual(plain(t), { id: 't', kind: 'trend', a: { t: 15, p: 50 }, b: { t: 25, p: 100 } });
});

test('persistencia por valor: añadir, actualizar, borrar, vaciar; tras recargar siguen ahí', () => {
  const ls = memoryStorage();
  const X = fresh(ls).drawings;
  const h = X.add('AAPL', { kind: 'hline', price: 250 }).drawing;
  const t = X.add('AAPL', { kind: 'trend', a: { t: day(5), p: 240 }, b: { t: day(12), p: 260 } }).drawing;
  X.add('MSFT', { kind: 'hline', price: 500 });
  assert.equal(X.list('AAPL').length, 2);
  assert.equal(X.update('AAPL', h.id, { ...h, price: 255 }).ok, true);
  assert.match(X.update('AAPL', h.id, { ...h, price: -1 }).error, /no válido/);
  const again = fresh(ls).drawings;
  assert.deepEqual(plain(again.list('AAPL').map((d) => d.price ?? d.a.p)), [255, 240]);
  again.remove('AAPL', t.id);
  again.clear('MSFT');
  assert.deepEqual(plain(Object.keys(JSON.parse(ls.getItem('aura:v1')).drawings)), ['AAPL']);
});

test(`como mucho ${50} dibujos por valor`, () => {
  const X = fresh().drawings;
  for (let i = 0; i < X.MAX; i++) X.add('KO', { kind: 'hline', price: 60 + i });
  assert.match(X.add('KO', { kind: 'hline', price: 1 }).error, /Como mucho 50/);
});

test('migración v3 → v4: conserva la cartera y añade dibujos vacíos; descarta dibujos dañados', () => {
  const { createStore } = A.storeInternals;
  const v3 = { version: 3, portfolio: { baseCurrency: 'EUR', transactions: [{ id: 't1', type: 'buy', symbol: 'AAPL', date: '2026-01-05', quantity: 1, price: 200, fees: 0, currency: 'USD' }] } };
  const s = createStore(memoryStorage({ 'aura:v1': JSON.stringify(v3) }));
  assert.equal(s.get('portfolio').transactions.length, 1);
  assert.deepEqual(plain(s.get('drawings')), {});
  const v4 = { version: 4, drawings: { AAPL: [{ id: 'a', kind: 'hline', price: 10 }, { id: 'b', kind: 'hline', price: -3 }, { id: 'c', kind: 'trend', a: { t: 1, p: 1 } }], '<x>': [{ id: 'z', kind: 'hline', price: 1 }] } };
  assert.deepEqual(plain(createStore(memoryStorage({ 'aura:v1': JSON.stringify(v4) })).get('drawings')), { AAPL: [{ id: 'a', kind: 'hline', price: 10 }] });
});
