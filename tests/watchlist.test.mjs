import test from 'node:test';
import assert from 'node:assert/strict';
import { loadAura, memoryStorage, plain } from './harness.mjs';

const fresh = (ls = memoryStorage()) => loadAura({ until: 'watchlist', localStorage: ls });

test('watchlist inicial: solo mercados del plan gratuito', () => {
  const { Aura } = fresh();
  assert.deepEqual(plain(Aura.watchlist.ids()), ['AAPL', 'MSFT', 'NVDA', 'TSLA', 'SAN', 'EUR/USD']);
});

test('añadir: se guarda, no duplica y valida el identificador', () => {
  const ls = memoryStorage();
  const { Aura } = fresh(ls);
  const wl = Aura.watchlist;
  assert.equal(wl.add({ id: 'AMZN', name: 'Amazon.com, Inc.', exchange: 'NASDAQ', currency: 'USD' }).ok, true);
  assert.equal(wl.add({ id: 'AMZN' }).error, 'AMZN ya está en la watchlist.');
  assert.match(wl.add({ id: '<script>' }).error, /no es válido/);
  assert.equal(wl.ids().at(-1), 'AMZN');
  // Persistencia: otra carga de la app con el mismo localStorage
  assert.equal(fresh(ls).Aura.watchlist.ids().at(-1), 'AMZN');
  assert.equal(JSON.parse(ls.getItem('aura:v1')).watchlist.at(-1).name, 'Amazon.com, Inc.');
});

test(`máximo de valores (cada actualización cuesta 1 crédito por valor)`, () => {
  const { Aura } = fresh();
  const wl = Aura.watchlist;
  for (let i = 0; wl.ids().length < wl.MAX; i++) assert.equal(wl.add({ id: `T${i}` }).ok, true);
  assert.match(wl.add({ id: 'OTRO' }).error, /como máximo 12/);
  assert.equal(wl.ids().length, 12);
});

test('quitar y reordenar; en los extremos no se mueve', () => {
  const { Aura } = fresh();
  const wl = Aura.watchlist;
  wl.move('MSFT', -1);
  assert.deepEqual(plain(wl.ids()).slice(0, 2), ['MSFT', 'AAPL']);
  wl.move('MSFT', -1);                                         // ya es el primero
  assert.equal(wl.ids()[0], 'MSFT');
  wl.move('EUR/USD', +1);                                      // ya es el último
  assert.equal(wl.ids().at(-1), 'EUR/USD');
  wl.move('AAPL', +1);
  assert.deepEqual(plain(wl.ids()).slice(0, 3), ['MSFT', 'NVDA', 'AAPL']);
  assert.equal(wl.remove('NVDA').ok, true);
  assert.equal(wl.has('NVDA'), false);
  assert.match(wl.remove('NVDA').error, /no está/);
});

test('learn completa nombre y bolsa sin pisar lo que ya había ni reordenar', () => {
  const { Aura } = fresh();
  const wl = Aura.watchlist;
  wl.add({ id: 'KO' });
  wl.learn('KO', { name: 'Coca-Cola Company', exchange: 'NYSE', currency: 'USD' });
  wl.learn('AAPL', { name: 'Otro nombre' });
  const items = plain(wl.items());
  assert.deepEqual(items.find((w) => w.id === 'KO'), { id: 'KO', name: 'Coca-Cola Company', exchange: 'NYSE', currency: 'USD' });
  assert.equal(items[0].name, 'Apple Inc.');
});

test('los cambios avisan a quien escucha (para repintar)', () => {
  const { Aura } = fresh();
  let calls = 0;
  Aura.watchlist.onChange(() => calls++);
  Aura.watchlist.add({ id: 'KO' });
  Aura.watchlist.move('KO', 0);                               // sin cambio real: no avisa
  Aura.watchlist.remove('KO');
  assert.equal(calls, 2);
});
