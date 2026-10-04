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

test('analyze() no modifica las velas de entrada y es determinista', () => {
  const c = cases[0];
  const before = JSON.stringify(c.bars);
  const a = fingerprint(run(c));
  const b = fingerprint(run(c));
  assert.equal(JSON.stringify(c.bars), before);
  assert.deepEqual(a, b);
});
