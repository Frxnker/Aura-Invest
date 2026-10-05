import test from 'node:test';
import assert from 'node:assert/strict';
import { loadAura, readFixture } from './harness.mjs';
import { fingerprint } from './fingerprint.mjs';

const { Aura } = loadAura({ until: 'model' });
const { cases } = readFixture('candles.json');
const expected = readFixture('model-fingerprint.json');
const run = (c) => Aura.model.analyze({ meta: c.meta, bars: c.bars, barsPerDay: c.barsPerDay }, c.tf);

for (const c of cases) {
  test(`huella de analyze() sin cambios · ${c.id}`, () => {
    assert.ok(expected[c.id], `no hay huella guardada para ${c.id}`);
    assert.deepEqual(fingerprint(run(c)), expected[c.id]);
  });
}

test('las velas fijas cubren Comprar, Mantener y Vender', () => {
  const actions = new Set(Object.values(expected).map((f) => f.advisory.action));
  assert.deepEqual([...actions].sort(), ['buy', 'hold', 'sell']);
});

test('las probabilidades son enteras y suman 100', () => {
  for (const c of cases) {
    const { bull, neutral, bear } = run(c).trend.probs;
    assert.ok([bull, neutral, bear].every(Number.isInteger), c.id);
    assert.equal(bull + neutral + bear, 100, c.id);
  }
});

test('Bajista no propone operación en corto: sin entrada, stop ni objetivo, y el soporte S1 como nivel a vigilar', () => {
  const sells = cases.map((c) => [c, run(c)]).filter(([, m]) => m.adv.action === 'sell');
  assert.ok(sells.length >= 2);
  for (const [c, m] of sells) {
    assert.equal(m.adv.entry, null, c.id);
    assert.equal(m.adv.stop, null, c.id);
    assert.equal(m.adv.target, null, c.id);
    assert.equal(m.adv.rr, null, c.id);
    assert.equal(m.adv.watch, m.sr.supports[0].price, c.id);
    assert.equal(m.adv.watchBasis, 'soporte S1', c.id);
    assert.match(m.rationale.at(-1), /no propone abrir cortos/, c.id);
  }
});

test('Bajista sin soporte por debajo: no inventa un nivel a vigilar', () => {
  const c = cases.find((x) => x.id === 'AAPL-6M');
  const m = run(c);
  assert.equal(m.adv.action, 'sell');
  // Mismas velas con una última sesión que cierra en su mínimo, por debajo de todos los mínimos previos
  const lo = Math.min(...c.bars.map((b) => b.low));
  const bars = c.bars.map((b, i) => (i < c.bars.length - 1 ? b : { ...b, open: lo * 0.97, high: lo * 0.97, low: lo * 0.95, close: lo * 0.95 }));
  const m2 = Aura.model.analyze({ meta: c.meta, bars, barsPerDay: c.barsPerDay }, c.tf);
  assert.equal(m2.adv.action, 'sell');
  assert.equal(m2.sr.supports.length, 0);
  assert.equal(m2.adv.watch, null);
  assert.equal(m2.adv.watchBasis, null);
  assert.match(m2.rationale.at(-1), /no hay soporte por debajo del precio/);
});

test('cono en diario: σ de las últimas 250 sesiones de la serie completa, igual en 6M, YTD y 1A', () => {
  const c = cases.find((x) => x.id === 'NVDA-1A');
  const { stdev } = Aura.indicators;
  const lr = c.bars.slice(1).map((b, i) => Math.log(b.close / c.bars[i].close)).slice(-250);
  const expectedSigma = Math.min(0.09, Math.max(0.006, stdev(lr)));
  for (const tf of ['6M', 'YTD', '1A']) {
    const m = Aura.model.analyze({ meta: c.meta, bars: c.bars, barsPerDay: 1 }, tf);
    assert.equal(m.fc.sigmaDay, expectedSigma, tf);
  }
});

test('analyze() no modifica las velas de entrada y es determinista', () => {
  const c = cases[0];
  const before = JSON.stringify(c.bars);
  const a = fingerprint(run(c));
  const b = fingerprint(run(c));
  assert.equal(JSON.stringify(c.bars), before);
  assert.deepEqual(a, b);
});
