import test from 'node:test';
import assert from 'node:assert/strict';
import { loadAura, plain } from './harness.mjs';
import { fakeFetch, td } from './helpers.mjs';

const { Aura } = loadAura({ until: 'charts' });
const { zoneOffsetMin, wallToUtc, localTimeZone } = Aura.utils;
const { percentSeries, percentSeriesUtc } = Aura.charts;
const U = (y, m, d, h = 0, mi = 0) => Date.UTC(y, m - 1, d, h, mi) / 1000;

test('desfase de cada zona respecto a UTC, con horario de verano', () => {
  assert.equal(zoneOffsetMin('America/New_York', U(2026, 10, 2, 14) * 1000), -240);
  assert.equal(zoneOffsetMin('America/New_York', U(2026, 12, 2, 14) * 1000), -300);
  assert.equal(zoneOffsetMin('Europe/Madrid', U(2026, 10, 2, 14) * 1000), 120);
  assert.equal(zoneOffsetMin('Europe/Madrid', U(2026, 11, 2, 14) * 1000), 60);
  assert.equal(zoneOffsetMin('Australia/Sydney', U(2026, 10, 5, 7) * 1000), 660, 'Sídney: UTC+11 desde el 4 oct 2026');
  assert.equal(zoneOffsetMin('UTC', 0), 0);
  assert.equal(zoneOffsetMin('Zona/Inventada', 0), 0, 'una zona no válida no rompe nada');
});

test('hora de pared → UTC real, también el día del cambio de hora', () => {
  assert.equal(wallToUtc(U(2026, 10, 2, 9, 30), 'America/New_York'), U(2026, 10, 2, 13, 30));
  assert.equal(wallToUtc(U(2026, 10, 2, 15, 30), 'Europe/Madrid'), U(2026, 10, 2, 13, 30));
  // 29 mar 2026: en Madrid las 02:00 pasan a ser las 03:00 (01:00 UTC)
  assert.equal(wallToUtc(U(2026, 3, 29, 1, 30), 'Europe/Madrid'), U(2026, 3, 29, 0, 30));
  assert.equal(wallToUtc(U(2026, 3, 29, 3, 30), 'Europe/Madrid'), U(2026, 3, 29, 1, 30));
  assert.equal(wallToUtc(U(2026, 10, 2, 9, 30), ''), U(2026, 10, 2, 9, 30), 'sin zona se deja igual');
});

test('forex y cripto en intradía se piden en la zona del usuario; acciones y diario, en la de la bolsa', async () => {
  const fetch = fakeFetch((u) => ({ body: u.searchParams.get('symbol') === 'EUR/USD' && u.searchParams.get('interval') === '5min'
    ? td('time_series_EURUSD_5min_madrid') : td('time_series_AAPL_5min') }));
  const { Aura: A } = loadAura({ until: 'data', fetch });
  A.store.setApiKey('clave-de-prueba-123');
  const fx = await A.data.fetchMarketData('EUR/USD', '1D');
  const st = await A.data.fetchMarketData('AAPL', '1D');
  const tzOf = (sym) => fetch.calls.find((c) => c.params.symbol === sym).params.timezone;
  assert.equal(tzOf('EUR/USD'), localTimeZone());
  assert.equal(tzOf('AAPL'), 'Exchange');
  assert.deepEqual([fx.meta.timeBasis, fx.meta.timezone], ['local', localTimeZone()]);
  assert.deepEqual([st.meta.timeBasis, st.meta.timezone], ['exchange', 'America/New_York']);
  assert.deepEqual(plain(fx.meta.session), [0, 1440], 'el forex cotiza las 24 h, aunque el día vaya a medias');
  assert.equal(fx.barsPerDay, 288);
  assert.deepEqual(plain(st.meta.session), [570, 390], 'AAPL: 09:30–16:00, deducido de las velas');
});

test('migración v4 → v5: las tendencias intradía de forex (Sídney) y cripto (UTC) pasan a la hora local', async () => {
  const { relocatePairDrawings, createStore } = Aura.storeInternals;
  const trend = (ta, tb) => ({ id: 'x', kind: 'trend', a: { t: ta, p: 1.1 }, b: { t: tb, p: 1.2 } });
  const v4 = {
    'EUR/USD': [trend(U(2026, 10, 5, 18, 20), U(2026, 10, 2)), { id: 'h', kind: 'hline', price: 1.1 }],  // 18:20 de Sídney = 07:20 UTC
    'BTC/USD': [trend(U(2026, 10, 5, 7, 20), U(2026, 10, 5, 8, 0))],                                      // cripto: venía en UTC
    AAPL: [trend(U(2026, 10, 2, 9, 30), U(2026, 10, 2, 15, 0))],                                         // acciones: sin cambios
  };
  const out = plain(relocatePairDrawings(v4, 'Europe/Madrid'));
  assert.equal(out['EUR/USD'][0].a.t, U(2026, 10, 5, 9, 20), '07:20 UTC = 09:20 en Madrid');
  assert.equal(out['EUR/USD'][0].b.t, U(2026, 10, 2), 'una fecha de vela diaria no se mueve');
  assert.deepEqual(out['EUR/USD'][1], v4['EUR/USD'][1], 'las horizontales no tienen hora');
  assert.equal(out['BTC/USD'][0].a.t, U(2026, 10, 5, 9, 20));
  assert.equal(out['BTC/USD'][0].b.t, U(2026, 10, 5, 10, 0));
  assert.deepEqual(out.AAPL, v4.AAPL);
  // Y de verdad al abrir un aura:v1 de la versión 4 (con la zona de esta máquina)
  const { memoryStorage } = await import('./harness.mjs');
  const s = createStore(memoryStorage({ 'aura:v1': JSON.stringify({ version: 4, drawings: v4 }) }));
  const local = localTimeZone();
  assert.equal(s.get('drawings')['EUR/USD'][0].a.t, U(2026, 10, 5, 7, 20) + zoneOffsetMin(local, U(2026, 10, 5, 7, 20) * 1000) * 60);
});

test('Comparar en intradía con datos reales: AAPL (Nueva York) y EUR/USD (Madrid) alineados en UTC', () => {
  const aapl = Aura.data.parseSeries(td('time_series_AAPL_5min')).filter((b) => b.time >= U(2026, 10, 2) && b.time < U(2026, 10, 3));
  const eur = Aura.data.parseSeries(td('time_series_EURUSD_5min_madrid'));
  assert.equal(aapl.length, 78);
  const v = plain(percentSeriesUtc(aapl, 'America/New_York', eur, 'Europe/Madrid'));
  // 09:30 en Nueva York = 15:30 en Madrid: la base es el cierre de EUR/USD de las 15:30 de Madrid
  const at = (h, mi) => eur.find((b) => b.time === U(2026, 10, 2, h, mi)).close;
  const base = at(15, 30);
  assert.ok(Math.abs(v[0]) < 1e-12, 'empieza en 0 %');
  assert.ok(Math.abs(v.at(-1) - (at(21, 55) / base - 1) * 100) < 1e-9, '15:55 en Nueva York = 21:55 en Madrid');
  assert.equal(v.filter((x) => x == null).length, 0, 'todas las velas de AAPL tienen dato de EUR/USD');
  // Sin pasar a UTC (como antes): de 09:30 a 14:55 no hay dato y lo que sale es de 6 h antes
  const naive = plain(percentSeries(aapl, eur));
  assert.equal(naive.filter((x) => x == null).length, 66);
  assert.ok(Math.abs(naive.at(-1) - (at(15, 55) / at(15, 0) - 1) * 100) < 1e-9, 'las 15:55 de Madrid frente a las 15:55 de Nueva York');
});
