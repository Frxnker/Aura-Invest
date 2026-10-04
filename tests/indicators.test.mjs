import test from 'node:test';
import assert from 'node:assert/strict';
import { loadAura, plain } from './harness.mjs';

const { Aura } = loadAura({ until: 'indicators' });
const { macd, bollinger, ema } = Aura.indicators;
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);

/* Valores calculados a mano */

test('MACD de una serie constante: todo 0', () => {
  const m = macd(Array(40).fill(50));
  assert.equal(m.line[24], null, 'antes de la vela 26 no hay MACD');
  close(m.line[25], 0);
  assert.equal(m.signal[32], null, 'la señal necesita 9 valores de MACD');
  close(m.signal[33], 0);
  close(m.hist[39], 0);
});

test('MACD de una recta (cierre = i): EMA12 = i − 5,5 y EMA26 = i − 12,5 → MACD = 7, señal 7, histograma 0', () => {
  const c = Array.from({ length: 60 }, (_, i) => i);
  const m = macd(c);
  const e12 = ema(c, 12), e26 = ema(c, 26);
  close(e12[40], 40 - 5.5);
  close(e26[40], 40 - 12.5);
  for (let i = 25; i < 60; i++) close(m.line[i], 7);
  for (let i = 33; i < 60; i++) { close(m.signal[i], 7); close(m.hist[i], 0); }
});

test('MACD ante un escalón de 10 a 20 (fórmula de la EMA: k = 2 / (n + 1))', () => {
  const c = [...Array(40).fill(10), 20];
  const m = macd(c);
  const e12 = 10 + 10 * (2 / 13), e26 = 10 + 10 * (2 / 27);
  close(m.line[40], e12 - e26);                          // 0,797720797…
  close(m.line[40], 0.7977207977207978, 1e-12);
  close(m.signal[40], (e12 - e26) * (2 / 10));           // la señal venía en 0
  close(m.hist[40], (e12 - e26) * (1 - 2 / 10));
});

test('Bollinger de 1…20: media 10,5 y σ poblacional = √((20² − 1) / 12)', () => {
  const b = bollinger(Array.from({ length: 20 }, (_, i) => i + 1));
  const sd = Math.sqrt(399 / 12);                        // 5,766281…
  assert.equal(b.mid[18], null);
  close(b.mid[19], 10.5);
  close(b.upper[19], 10.5 + 2 * sd);
  close(b.lower[19], 10.5 - 2 * sd);
});

test('Bollinger de 10, 12, 10, 12…: media 11, σ = 1 → bandas 13 y 9', () => {
  const b = bollinger(Array.from({ length: 25 }, (_, i) => (i % 2 ? 12 : 10)));
  for (let i = 19; i < 25; i++) { close(b.mid[i], 11); close(b.upper[i], 13); close(b.lower[i], 9); }
});

test('MACD y Bollinger no forman parte de analyze(): la huella del modelo no los ve', () => {
  const { Aura: A } = loadAura({ until: 'model' });
  const c = JSON.parse(JSON.stringify(Array.from({ length: 300 }, (_, i) => ({ time: 1e9 + i * 86400, open: 100 + Math.sin(i / 9), high: 102, low: 98, close: 100 + Math.sin(i / 9), volume: 1000 }))));
  const m = A.model.analyze({ meta: { precision: 2, currency: 'USD' }, bars: c, barsPerDay: 1 }, '6M');
  assert.deepEqual(plain(Object.keys(m.ind)).sort(), ['atr14', 'ema20', 'rsi14', 'sma50', 'volSma20']);
});
