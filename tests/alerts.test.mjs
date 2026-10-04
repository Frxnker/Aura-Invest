import test from 'node:test';
import assert from 'node:assert/strict';
import { loadAura, memoryStorage, readFixture, plain } from './harness.mjs';
import { td } from './helpers.mjs';

const fresh = () => loadAura({ until: 'alerts', localStorage: memoryStorage() }).Aura;
const Aura = fresh();
const { evaluate, create, rearm, applyResult, describe, validate } = Aura.alerts.pure;

const OCT2 = Date.UTC(2026, 9, 2, 12);       // sesión de la cotización real (vie 2 oct)
const OCT3 = Date.UTC(2026, 9, 3, 12);
/** Cotización real de AAPL (333,69; cierre anterior 330,32001), con cambios opcionales. */
const quote = (over = {}) => ({ ...Aura.data.parseQuote({ ...td('quote_AAPL'), ...over }) });
const alert = (input, now = OCT2) => create({ symbol: 'AAPL', ...input }, now);
const sig = (s) => ({ emaSign: null, rsi: null, action: null, ...s });

/* ---- Precio ---- */

test('precio por encima: el umbral exacto salta; un céntimo más, no', () => {
  assert.equal(evaluate(alert({ type: 'price_above', value: 333.69 }), { quote: quote() }).fire, true);
  const r = evaluate(alert({ type: 'price_above', value: 333.7 }), { quote: quote() });
  assert.equal(r.fire, false);
  assert.equal(r.reading, 'precio $333,69');
});

test('precio por debajo: el umbral exacto salta; un céntimo menos, no', () => {
  assert.equal(evaluate(alert({ type: 'price_below', value: 333.69 }), { quote: quote() }).fire, true);
  assert.equal(evaluate(alert({ type: 'price_below', value: 333.68 }), { quote: quote() }).fire, false);
});

test('datos que faltan: sin cotización, con error, con precio vacío o antiguos → no salta', () => {
  const a = alert({ type: 'price_above', value: 1 });
  const err = new Aura.api.ApiError('NETWORK', 'No hay conexión con Twelve Data.');
  const cases = [
    [undefined, /sin datos todavía/],
    [err, /sin datos: No hay conexión/],
    [quote({ close: '' }), /sin datos/],
    [{ ...quote(), stale: true }, /datos antiguos/],
  ];
  for (const [q, why] of cases) {
    const r = evaluate(a, { quote: q });
    assert.equal(r.fire, false);
    assert.match(r.missing, why);
  }
});

/* ---- Variación del día ---- */

test('variación del día: umbral exacto, sentido y "en cualquier sentido"', () => {
  const q = quote();
  const pct = (333.69 / 330.32001 - 1) * 100;                 // +1,0202 %
  assert.equal(evaluate(alert({ type: 'day_change', value: pct, dir: 'up' }), { quote: q }).fire, true, 'umbral exacto');
  assert.equal(evaluate(alert({ type: 'day_change', value: pct + 0.001, dir: 'up' }), { quote: q }).fire, false);
  assert.equal(evaluate(alert({ type: 'day_change', value: 1, dir: 'down' }), { quote: q }).fire, false, 'sube, no baja');
  assert.equal(evaluate(alert({ type: 'day_change', value: 1, dir: 'any' }), { quote: q }).fire, true);
  const down = quote({ close: '326', previous_close: '330' });
  assert.equal(evaluate(alert({ type: 'day_change', value: 1, dir: 'any' }), { quote: down }).fire, true, '−1,2 % cuenta en cualquier sentido');
});

test('cambio de día: una sesión anterior a la activación no dispara; la siguiente sí', () => {
  const a = alert({ type: 'day_change', value: 1, dir: 'any' }, OCT3);   // activada el sábado 3
  const friday = evaluate(a, { quote: quote() });                     // sesión del viernes 2: +1,02 %
  assert.equal(friday.fire, false);
  assert.match(friday.missing, /sesión posterior/);
  const monday = quote({ datetime: '2026-10-05', close: '340', previous_close: '333.69' });
  assert.equal(evaluate(a, { quote: monday }).fire, true);
});

test('variación del día sin cierre anterior → no se evalúa', () => {
  const r = evaluate(alert({ type: 'day_change', value: 1, dir: 'any' }), { quote: quote({ previous_close: '' }) });
  assert.equal(r.fire, false);
  assert.ok(r.missing);
});

/* ---- Cruce de medias ---- */

test('cruce EMA 20/SMA 50: la primera lectura solo fija el punto de partida', () => {
  let a = alert({ type: 'ema_cross', dir: 'up' });
  let r = evaluate(a, { signals: sig({ emaSign: -1 }) });
  assert.deepEqual([r.fire, r.baseline], [false, -1]);
  a = applyResult(a, r, OCT2);
  r = evaluate(a, { signals: sig({ emaSign: -1 }) });
  assert.equal(r.fire, false);
  r = evaluate(a, { signals: sig({ emaSign: 1 }) });
  assert.deepEqual([r.fire, r.baseline], [true, 1]);
  assert.match(r.message, /cruce alcista/);
});

test('cruce en el sentido contrario: no salta pero actualiza el punto de partida', () => {
  let a = applyResult(alert({ type: 'ema_cross', dir: 'down' }), { baseline: -1, reading: '', missing: null }, OCT2);
  const up = evaluate(a, { signals: sig({ emaSign: 1 }) });
  assert.equal(up.fire, false);
  a = applyResult(a, up, OCT2);
  assert.equal(evaluate(a, { signals: sig({ emaSign: -1 }) }).fire, true);
});

test('cruce sin medias disponibles o con señales con error → no se evalúa', () => {
  const a = alert({ type: 'ema_cross', dir: 'any' });
  assert.equal(evaluate(a, { signals: sig({ emaSign: null }) }).fire, false);
  assert.match(evaluate(a, { signals: new Aura.api.ApiError('NOT_FOUND', 'sin velas') }).missing, /sin datos: sin velas/);
  assert.match(evaluate(a, { signals: { ...sig({ emaSign: 1 }), stale: true } }).missing, /antiguos/);
});

/* ---- RSI ---- */

test('RSI: > 70 y < 30 son estrictos (70 y 30 exactos no saltan)', () => {
  const hi = alert({ type: 'rsi', level: 'above70' });
  const lo = alert({ type: 'rsi', level: 'below30' });
  assert.equal(evaluate(hi, { signals: sig({ rsi: 70 }) }).fire, false);
  assert.equal(evaluate(hi, { signals: sig({ rsi: 70.01 }) }).fire, true);
  assert.equal(evaluate(lo, { signals: sig({ rsi: 30 }) }).fire, false);
  assert.equal(evaluate(lo, { signals: sig({ rsi: 29.99 }) }).fire, true);
  assert.equal(evaluate(lo, { signals: sig({ rsi: null }) }).fire, false);
});

/* ---- Señal del modelo ---- */

test('señal del modelo: salta al CAMBIAR a la elegida, no si ya lo era', () => {
  let a = alert({ type: 'signal', target: 'buy' });
  let r = evaluate(a, { signals: sig({ action: 'buy' }) });
  assert.deepEqual([r.fire, r.baseline], [false, 'buy'], 'ya era Alcista al activarla');
  a = applyResult(a, r, OCT2);
  r = evaluate(a, { signals: sig({ action: 'hold' }) });
  assert.equal(r.fire, false);
  a = applyResult(a, r, OCT2);
  r = evaluate(a, { signals: sig({ action: 'buy' }) });
  assert.equal(r.fire, true);
  assert.match(r.message, /de Neutral a Alcista/);
});

test('signalsFrom: lee EMA/SMA, RSI y la señal de un análisis diario real del modelo', () => {
  const { Aura: A } = loadAura({ until: 'alerts' });
  const c = readFixture('candles.json').cases.find((x) => x.id === 'MSFT-YTD');
  const m = A.model.analyze({ meta: c.meta, bars: c.bars, barsPerDay: c.barsPerDay }, c.tf);
  const s = plain(A.alerts.signalsFrom(m, { at: 123 }));
  const i = m.bars.length - 1;
  assert.equal(s.action, 'buy');
  assert.equal(s.emaSign, Math.sign(m.ind.ema20[i] - m.ind.sma50[i]));
  assert.equal(s.rsi, m.ind.rsi14[i]);
  assert.equal(s.at, 123);
});

/* ---- Validación y textos ---- */

test('validación del formulario', () => {
  assert.match(validate({ symbol: 'AAPL', type: 'price_above', value: NaN }), /precio mayor que 0/);
  assert.match(validate({ symbol: 'AAPL', type: 'price_above', value: 0 }), /precio mayor que 0/);
  assert.match(validate({ symbol: 'AAPL', type: 'day_change', value: 150, dir: 'any' }), /entre 0 y 100/);
  assert.match(validate({ symbol: '', type: 'rsi', level: 'above70' }), /Elige un valor/);
  assert.match(validate({ symbol: 'AAPL', type: 'signal', target: 'hold' }), /Alcista o Bajista/);
  assert.equal(validate({ symbol: 'EUR/USD', type: 'price_below', value: 1.1 }), null);
});

test('descripción legible de cada alerta', () => {
  assert.equal(describe({ symbol: 'AAPL', type: 'price_above', value: 340 }), 'AAPL · precio ≥ 340,00');
  assert.equal(describe({ symbol: 'EUR/USD', type: 'price_below', value: 1.1 }), 'EUR/USD · precio ≤ 1,1000');
  assert.equal(describe({ symbol: 'MSFT', type: 'day_change', value: 3, dir: 'down' }), 'MSFT · variación del día ≥ 3,00 % a la baja');
  assert.equal(describe({ symbol: 'NVDA', type: 'ema_cross', dir: 'up' }), 'NVDA · cruce EMA 20 / SMA 50 alcista');
  assert.equal(describe({ symbol: 'TSLA', type: 'rsi', level: 'below30' }), 'TSLA · RSI 14 < 30');
  assert.equal(describe({ symbol: 'SAN', type: 'signal', target: 'sell' }), 'SAN · la señal del modelo pasa a Bajista');
});

/* ---- Ciclo de vida con persistencia ---- */

test('salta una sola vez, queda en el historial y se puede reactivar', () => {
  const A = fresh();
  const { alert: a } = A.alerts.add({ symbol: 'AAPL', type: 'price_above', value: 300 }, OCT2);
  const quotes = new Map([['AAPL', quote()]]);
  const fired = A.alerts.evaluateAll({ quotes, now: OCT2 + 1000 });
  assert.equal(fired.length, 1);
  assert.match(fired[0].message, /AAPL cotiza a \$333,69/);
  assert.equal(A.alerts.get(a.id).status, 'triggered');
  assert.equal(A.alerts.evaluateAll({ quotes, now: OCT2 + 2000 }).length, 0, 'no vuelve a saltar');
  assert.equal(A.alerts.history().length, 1);
  A.alerts.rearm(a.id, OCT2 + 3000);
  assert.equal(A.alerts.get(a.id).status, 'active');
  assert.equal(A.alerts.evaluateAll({ quotes, now: OCT2 + 4000 }).length, 1, 'reactivada vuelve a saltar');
  assert.equal(A.alerts.history().length, 2);
});

test('pausada no se evalúa; reanudada vuelve a vigilar desde cero', () => {
  const A = fresh();
  const { alert: a } = A.alerts.add({ symbol: 'AAPL', type: 'signal', target: 'buy' }, OCT2);
  A.alerts.evaluateAll({ signals: new Map([['AAPL', sig({ action: 'hold' })]]), now: OCT2 });
  assert.equal(A.alerts.get(a.id).baseline, 'hold');
  A.alerts.pause(a.id);
  assert.equal(A.alerts.evaluateAll({ signals: new Map([['AAPL', sig({ action: 'buy' })]]), now: OCT2 + 1 }).length, 0);
  assert.equal(A.alerts.get(a.id).status, 'paused');
  A.alerts.resume(a.id, OCT2 + 2);
  assert.equal(A.alerts.get(a.id).baseline, null, 'reanudar reinicia el punto de partida');
  assert.equal(A.alerts.evaluateAll({ signals: new Map([['AAPL', sig({ action: 'buy' })]]), now: OCT2 + 3 }).length, 0);
});

test('editar re-arma la alerta; borrar y deshacer la recupera tal cual', () => {
  const A = fresh();
  const { alert: a } = A.alerts.add({ symbol: 'AAPL', type: 'price_above', value: 300 }, OCT2);
  A.alerts.evaluateAll({ quotes: new Map([['AAPL', quote()]]), now: OCT2 });
  const res = A.alerts.update(a.id, { symbol: 'AAPL', type: 'price_above', value: 400 }, OCT3);
  assert.equal(res.ok, true);
  const edited = A.alerts.get(a.id);
  assert.deepEqual([edited.status, edited.value, edited.triggeredAt, edited.armedAt], ['active', 400, null, OCT3]);
  assert.match(A.alerts.update(a.id, { symbol: 'AAPL', type: 'price_above', value: -1 }).error, /mayor que 0/);
  const before = plain(A.alerts.get(a.id));
  A.alerts.remove(a.id);
  assert.equal(A.alerts.get(a.id), null);
  assert.equal(A.alerts.restore(before).ok, true);
  assert.deepEqual(plain(A.alerts.get(a.id)), before);
});

test('evaluateAll guarda la última lectura de cada alerta (para la interfaz)', () => {
  const A = fresh();
  const { alert: a } = A.alerts.add({ symbol: 'MSFT', type: 'price_below', value: 1 }, OCT2);
  A.alerts.evaluateAll({ quotes: new Map(), now: OCT2 });
  assert.match(A.alerts.get(a.id).last.missing, /sin datos/);
  A.alerts.evaluateAll({ quotes: new Map([['MSFT', quote({ symbol: 'MSFT' })]]), now: OCT2 + 1 });
  assert.equal(A.alerts.get(a.id).last.reading, 'precio $333,69');
});
