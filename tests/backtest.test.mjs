import test from 'node:test';
import assert from 'node:assert/strict';
import { loadAura, plain } from './harness.mjs';
import { td } from './helpers.mjs';

const { Aura } = loadAura({ until: 'backtest', now: Date.UTC(2026, 9, 4, 12), extra: ['tests/tools/simulator.js'] });
const B = Aura.backtest;
const sim = await Aura.simulator.fetchOHLCV('AAPL', '1A');          // 1700 velas diarias deterministas
const bars = plain(sim.bars);
const meta = plain(sim.meta);
const key = (s) => JSON.stringify({ a: s.action, p: s.probs, e: s.entry, t: s.target, st: s.stop, c: s.cone });

test('recortar el histórico a 400 velas no cambia la señal (analyze solo usa ventana + calentamiento)', () => {
  for (const d of [300, 777, 1500]) {
    const full = Aura.model.analyze({ meta, bars: bars.slice(0, d + 1), barsPerDay: 1 }, '6M');
    const s = B.signalAt(bars, d, meta);
    assert.equal(s.action, full.adv.action, `d=${d}`);
    assert.deepEqual(plain(s.probs), plain(full.trend.probs));
    assert.equal(s.target, full.adv.target);
  }
});

test('sin mirar al futuro (1): cambiar todas las velas posteriores no altera la señal de ese día', () => {
  for (const d of [400, 900, 1300]) {
    const before = key(B.signalAt(bars, d, meta));
    const future = bars.map((b, i) => (i <= d ? b : { ...b, open: b.open * 3, high: b.high * 3, low: b.low * 0.2, close: b.close * 0.5, volume: 1 }));
    assert.equal(key(B.signalAt(future, d, meta)), before, `d=${d}`);
  }
});

test('sin mirar al futuro (2): en un backtest completo analyze() nunca recibe velas posteriores al día evaluado', async () => {
  const sub = bars.slice(0, 520);
  let calls = 0, violations = 0;
  const spy = (data, tf) => {
    calls++;
    const lastSeen = data.bars.at(-1).time;
    const d = sub.findIndex((b) => b.time === lastSeen);
    if (d < 0 || data.bars.some((b) => b.time > sub[d].time)) violations++;
    return Aura.model.analyze(data, tf);
  };
  const res = await B.run(sub, meta, { analyze: spy });
  assert.equal(calls, sub.length - B.MIN_HISTORY);
  assert.equal(violations, 0);
  assert.equal(res.rows.length, calls);
});

/* ---- Qué pasó después (casos construidos a mano) ---- */

const mk = (closes, hi = 0, lo = 0) => closes.map((c, i) => ({ time: i, open: c, high: c + hi, low: c - lo, close: c, volume: 1 }));

test('rentabilidad a 21 y 63 sesiones y cono (dentro, por encima, por debajo)', () => {
  const series = mk([100, ...Array(62).fill(105), 110, 111]);
  const base = { d: 0, close: 100, action: 'hold', cone: { lower: 90, upper: 108 } };
  const o = B.outcome(series, base);
  assert.ok(Math.abs(o.r21 - 0.05) < 1e-12);
  assert.ok(Math.abs(o.r63 - 0.10) < 1e-12);
  assert.equal(o.cone, 'above');
  assert.equal(B.outcome(series, { ...base, cone: { lower: 90, upper: 120 } }).cone, 'inside');
  assert.equal(B.outcome(series, { ...base, cone: { lower: 115, upper: 120 } }).cone, 'below');
  assert.equal(B.outcome(series.slice(0, 30), base).r63, null, 'sin futuro suficiente: sin dato');
});

test('objetivo o stop primero, ambos el mismo día, ninguno y pendiente', () => {
  const s = (action, target, stop) => ({ d: 0, close: 100, action, target, stop, cone: { lower: 0, upper: 1e9 } });
  const path = mk([100, 101, 103, 99, 96, ...Array(60).fill(100)], 1, 1);
  assert.equal(B.outcome(path, s('buy', 104, 90)).touch, 'target');           // máximo 104 el día 2
  assert.equal(B.outcome(path, s('buy', 120, 96)).touch, 'stop');             // mínimo 95 el día 4
  assert.equal(B.outcome(path, s('sell', 95, 105)).touch, 'target');          // a la baja: mínimo 95 el día 4
  assert.equal(B.outcome(path, s('buy', 104, 100)).touch, 'stop', 'el día 1 el mínimo (100) toca el stop antes que el objetivo');
  assert.equal(B.outcome(mk([100, 100, ...Array(70).fill(100)], 10, 10), s('buy', 105, 95)).touch, 'both');
  assert.equal(B.outcome(mk(Array(80).fill(100)), s('buy', 150, 50)).touch, 'none');
  assert.equal(B.outcome(mk(Array(20).fill(100)), s('buy', 150, 50)).touch, 'pending');
  assert.equal(B.outcome(path, { ...s('hold', 104, 90) }).touch, null, 'Neutral no tiene objetivo/stop que medir');
});

test('resumen: medias, aciertos frente a cualquier día y reparto del cono', () => {
  const rows = [
    { action: 'buy', r21: 0.1, r63: 0.2, cone: 'inside', touch: 'target' },
    { action: 'buy', r21: -0.05, r63: 0.1, cone: 'above', touch: 'stop' },
    { action: 'sell', r21: -0.02, r63: 0.04, cone: 'inside', touch: 'none' },
    { action: 'hold', r21: 0.01, r63: null, cone: null, touch: null },
  ];
  const s = plain(B.summarize(rows));
  assert.deepEqual(s.counts, { buy: 2, hold: 1, sell: 1 });
  assert.equal(s.h21.all.n, 4);
  assert.ok(Math.abs(s.h21.all.mean - 0.01) < 1e-12);
  assert.equal(s.h21.all.up, 0.5);
  assert.ok(Math.abs(s.h21.by.buy.mean - 0.025) < 1e-12);
  assert.equal(s.h21.by.buy.hit, 0.5);
  assert.equal(s.h21.by.sell.hit, 1);
  assert.equal(s.h63.by.sell.hit, 0);
  assert.equal(s.h63.all.n, 3);
  assert.deepEqual(s.cone, { n: 3, inside: 2 / 3, above: 1 / 3, below: 0 });
  assert.deepEqual(s.touches.buy, { n: 2, target: 0.5, stop: 0.5, both: 0, none: 0 });
});

test('con velas diarias reales de AAPL (Twelve Data): se ejecuta entero y cuadra', async () => {
  const real = Aura.data.parseSeries(td('time_series_AAPL_1day'));
  const progress = [];
  const res = await B.run(plain(real), { symbol: 'AAPL', currency: 'USD', precision: 2 }, { onProgress: (p) => progress.push(p) });
  const s = res.summary;
  assert.equal(s.days, real.length - B.MIN_HISTORY);
  assert.equal(s.counts.buy + s.counts.hold + s.counts.sell, s.days);
  assert.equal(s.h63.all.n, s.days - B.H_LONG);
  assert.equal(s.h21.all.n, s.days - B.H_SHORT);
  assert.equal(progress.at(-1), 1);
  assert.ok(s.cone.inside >= 0 && s.cone.inside <= 1);
});

test('se puede cancelar', async () => {
  const ctrl = new AbortController();
  const p = B.run(bars.slice(0, 900), meta, { signal: ctrl.signal, onProgress: (x) => { if (x > 0.1) ctrl.abort(); } });
  await assert.rejects(p, /cancelado/);
});
