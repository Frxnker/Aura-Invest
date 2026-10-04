import test from 'node:test';
import assert from 'node:assert/strict';
import { loadAura, memoryStorage } from './harness.mjs';
import { fakeFetch, fakeClock, td } from './helpers.mjs';

const { Aura } = loadAura({ until: 'monitor' });
const { nextDelay, deliver, RESERVE } = Aura.monitor;
const MIN = 60000, HOUR = 3600000;
const at = (h, m = 0) => Date.UTC(2026, 9, 5, h, m);

/* ---- Ritmo de actualización ---- */

test('con mercados abiertos: cada 5 min como mínimo, más espaciado si el cupo no da', () => {
  const usage = { creditsToday: 0, perDay: 800 };
  assert.equal(nextDelay(usage, 6, true, at(14)), Math.ceil((10 * HOUR) / Math.floor(650 / 6)));   // ≈ 5,6 min
  assert.equal(nextDelay(usage, 2, true, at(14)), 5 * MIN, 'nunca más a menudo que cada 5 min');
  assert.equal(nextDelay(usage, 12, true, at(2)), Math.ceil((22 * HOUR) / Math.floor(650 / 12)), '12 valores de madrugada: ≈ 24 min');
});

test('la frecuencia elegida en Ajustes es el mínimo entre pasadas; 0 la desactiva', () => {
  const usage = { creditsToday: 0, perDay: 800 };
  assert.equal(nextDelay(usage, 6, true, at(14), 15), 15 * MIN);
  assert.equal(nextDelay(usage, 6, true, at(14), 30), 30 * MIN);
  assert.equal(nextDelay(usage, 6, false, at(14), 30), HOUR, 'con todo cerrado manda la hora');
  assert.equal(nextDelay(usage, 6, true, at(14), 0), null, 'desactivada');
  assert.equal(nextDelay(usage, 12, true, at(2), 15), Math.ceil((22 * HOUR) / Math.floor(650 / 12)), 'si el cupo no da, se espacia más');
});

test('con todo cerrado, cada hora; sin cupo o sin nada que vigilar, no se programa', () => {
  assert.equal(nextDelay({ creditsToday: 0, perDay: 800 }, 6, false, at(14)), HOUR);
  assert.equal(nextDelay({ creditsToday: 800 - RESERVE - 5, perDay: 800 }, 6, true, at(14)), null);
  assert.equal(nextDelay({ creditsToday: 0, perDay: 800 }, 0, true, at(14)), null);
});

test('simulación de un día entero: los refrescos automáticos nunca pasan de 800 − reserva', () => {
  for (const cost of [1, 6, 12, 20]) {
    let t = at(0), credits = 0, runs = 0;
    const end = at(24);
    while (t < end) {
      const d = nextDelay({ creditsToday: credits, perDay: 800 }, cost, true, t);
      if (d == null) break;
      credits += cost; runs++;
      t += d;
    }
    assert.ok(credits <= 800 - RESERVE, `coste ${cost}: ${credits} créditos en ${runs} pasadas`);
  }
});

/* ---- Entrega de avisos ---- */

test('notificación del sistema solo si está activada y hay permiso; si no, aviso en la app', () => {
  const shown = [];
  class N { constructor(title, opts) { shown.push([title, opts.body]); } }
  const entries = [{ symbol: 'AAPL', alertId: 'a1', message: 'AAPL cotiza a $333,69' }];
  N.permission = 'granted';
  assert.equal(deliver(entries, { Notification: N, enabled: true }), 'system');
  assert.deepEqual(shown, [['Aura Invest · AAPL', 'AAPL cotiza a $333,69']]);
  assert.equal(deliver(entries, { Notification: N, enabled: false }), 'app');
  N.permission = 'default';
  assert.equal(deliver(entries, { Notification: N, enabled: true }), 'app');
  assert.equal(deliver(entries, { Notification: undefined, enabled: true }), 'app');
  assert.equal(shown.length, 1);
});

/* ---- Una pasada completa con respuestas reales de Twelve Data ---- */

function setup() {
  const batch = td('quote_batch_watchlist');                   // AAPL, MSFT, NVDA, TSLA (+ SAN:BME)
  const fetch = fakeFetch((u) => {
    const s = u.searchParams.get('symbol');
    if (u.pathname === '/quote') {
      const ids = s.split(',');
      return { body: ids.length === 1 ? batch[ids[0]] : Object.fromEntries(ids.map((id) => [id, batch[id]])) };
    }
    if (u.pathname === '/time_series' && s === 'AAPL') return { body: td(`time_series_AAPL_${u.searchParams.get('interval')}`) };
    return { status: 404, body: { code: 404, status: 'error', message: '**symbol** or **figi** parameter is missing or invalid.' } };
  });
  const clock = fakeClock(Date.UTC(2026, 9, 3, 12));
  const { Aura: A } = loadAura({ until: 'monitor', fetch, clock, localStorage: memoryStorage() });
  A.store.setApiKey('clave-de-prueba-123');
  for (const id of ['SAN', 'EUR/USD']) A.watchlist.remove(id);   // la watchlist del fixture
  return { A, fetch, clock };
}

test('pasada completa: un lote de cotizaciones, velas diarias solo para las señales y alertas evaluadas', async () => {
  const { A, fetch } = setup();
  const price = A.alerts.add({ symbol: 'AAPL', type: 'price_above', value: 300 }).alert;
  const signal = A.alerts.add({ symbol: 'AAPL', type: 'signal', target: 'sell' }).alert;
  const rsi = A.alerts.add({ symbol: 'NVDA', type: 'rsi', level: 'above70' }).alert;
  const fired = [];
  A.monitor.onFired((ev) => fired.push(ev));

  await A.monitor.runCheck();
  const quoteCalls = fetch.calls.filter((c) => c.path === '/quote');
  assert.deepEqual(quoteCalls.map((c) => c.params.symbol), ['AAPL,MSFT,NVDA,TSLA']);
  assert.deepEqual(fetch.calls.filter((c) => c.path === '/time_series').map((c) => [c.params.symbol, c.params.interval]), [['AAPL', '1day'], ['NVDA', '1day']]);
  assert.equal(A.api.client.status().creditsToday, 6);

  assert.equal(fired.length, 1);
  assert.equal(fired[0].channel, 'app');
  assert.equal(fired[0].entries[0].alertId, price.id);
  assert.equal(A.alerts.get(price.id).status, 'triggered');
  assert.ok(['buy', 'hold', 'sell'].includes(A.alerts.get(signal.id).baseline), 'la señal fija su punto de partida');
  assert.match(A.alerts.get(rsi.id).last.missing, /sin datos/, 'NVDA sin velas: no se evalúa');

  // Segunda pasada inmediata: todo en caché, nada vuelve a saltar
  const n = fetch.calls.length;
  await A.monitor.runCheck();
  assert.equal(fetch.calls.filter((c) => c.path === '/time_series' && c.params.symbol === 'AAPL').length, 1, 'velas diarias en caché');
  assert.ok(fetch.calls.length - n <= 1, 'como mucho NVDA, que falló');
  assert.equal(fired.length, 1);
});

test('sin clave no se pide nada', async () => {
  const { A, fetch } = setup();
  A.store.setApiKey('');
  await A.monitor.runCheck();
  assert.equal(fetch.calls.length, 0);
});

test('comprobación rápida al crear una alerta: usa lo ya obtenido y no gasta créditos', async () => {
  const { A, fetch } = setup();
  await A.monitor.runCheck();
  const n = fetch.calls.length, credits = A.api.client.status().creditsToday;
  A.alerts.add({ symbol: 'MSFT', type: 'price_below', value: 600 });
  const fired = await A.monitor.checkAlertsQuick();
  assert.equal(fired.length, 1);
  assert.match(fired[0].message, /MSFT cotiza a \$517,53/);
  assert.equal(fetch.calls.length, n);
  assert.equal(A.api.client.status().creditsToday, credits);
});
