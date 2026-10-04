import test from 'node:test';
import assert from 'node:assert/strict';
import { loadAura, plain } from './harness.mjs';

const { Aura } = loadAura({ until: 'charts' });
const { percentSeries } = Aura.charts;
const D = (d) => Date.UTC(2026, 0, d) / 1000;
const bar = (d, close) => ({ time: D(d), close });
const vis = [bar(5, 100), bar(6, 110), bar(7, 99), bar(8, 120)];       // lunes a jueves

test('% desde el inicio de la ventana: el principal empieza en 0', () => {
  assert.deepEqual(plain(percentSeries(vis, vis)).map((v) => Math.round(v * 1e6) / 1e6), [0, 10, -1, 20]);
});

test('otro calendario (forex con domingo): se toma el último cierre en esa fecha o antes', () => {
  const fx = [bar(4, 1.1), bar(5, 1.2), bar(7, 1.32)];                 // sin dato el día 6 ni el 8
  const v = plain(percentSeries(vis, fx));
  assert.deepEqual(v.map((x) => Math.round(x * 1e6) / 1e6), [0, 0, 10, 10]);
  assert.equal(v.length, vis.length, 'alineado con las velas del valor principal');
});

test('un valor que empieza más tarde: huecos antes y base en su primer cierre', () => {
  const late = [bar(7, 50), bar(8, 55)];
  assert.deepEqual(plain(percentSeries(vis, late)).map((x) => (x == null ? null : Math.round(x * 1e6) / 1e6)), [null, null, 0, 10]);
});
