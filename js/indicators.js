/* =========================================================================
 * Aura Invest · Indicadores técnicos
 * Todas las funciones devuelven arrays alineados con las velas (null si no hay dato).
 * ========================================================================= */
(() => {
'use strict';

const { clamp, last, mean } = Aura.utils;

function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = mean(values.slice(0, period));           // semilla: media simple
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** RSI de Wilder. */
function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  gain /= period; loss /= period;
  const value = () => (loss === 0 ? 100 : 100 - 100 / (1 + gain / loss));
  out[period] = value();
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = value();
  }
  return out;
}

/** Average True Range (Wilder). */
function atr(bars, period = 14) {
  const out = new Array(bars.length).fill(null);
  if (bars.length <= period) return out;
  const tr = bars.map((b, i) => (i === 0 ? b.high - b.low
    : Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1].close), Math.abs(b.low - bars[i - 1].close))));
  let prev = mean(tr.slice(1, period + 1));
  out[period] = prev;
  for (let i = period + 1; i < bars.length; i++) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

function stdev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1));
}

/** Pendiente por mínimos cuadrados de una serie equiespaciada. */
function linregSlope(ys) {
  const n = ys.length;
  if (n < 2) return 0;
  const xm = (n - 1) / 2, ym = mean(ys);
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (i - xm) * (ys[i] - ym); den += (i - xm) ** 2; }
  return num / den;
}

/** Último cruce entre dos series dentro de las `lookback` velas finales. */
function lastCross(a, b, lookback = 15) {
  const n = a.length;
  for (let k = n - 1; k >= Math.max(1, n - lookback); k--) {
    if (a[k] == null || b[k] == null || a[k - 1] == null || b[k - 1] == null) break;
    const now = Math.sign(a[k] - b[k]), before = Math.sign(a[k - 1] - b[k - 1]);
    if (now !== 0 && now !== before) return { ago: n - 1 - k, dir: now };
  }
  return null;
}

/**
 * Soportes y resistencias a partir de máximos/mínimos locales (pivots) recientes.
 * Los pivots cercanos (< 0,6 ATR) se agrupan en un único nivel; se devuelven los
 * dos niveles más próximos por encima (resistencias) y por debajo (soportes).
 */
function supportResistance(bars, ws, atrV) {
  const n = bars.length;
  const close = bars[n - 1].close;
  const start = Math.max(ws, n - 160);
  const len = n - start;
  const k = clamp(Math.round(len / 24), 2, 6);
  const pivots = [];

  for (let i = start + k; i < n - k; i++) {
    let isHigh = true, isLow = true;
    for (let j = i - k; j <= i + k && (isHigh || isLow); j++) {
      if (j === i) continue;
      if (bars[j].high > bars[i].high) isHigh = false;
      if (bars[j].low < bars[i].low) isLow = false;
    }
    if (isHigh) pivots.push({ price: bars[i].high, idx: i });
    if (isLow) pivots.push({ price: bars[i].low, idx: i });
  }

  const tol = Math.max(0.6 * atrV, close * 0.004);
  pivots.sort((a, b) => a.price - b.price);
  const clusters = [];
  for (const p of pivots) {
    const c = last(clusters);
    if (c && p.price - c.max <= tol) { c.members.push(p); c.max = p.price; }
    else clusters.push({ members: [p], max: p.price });
  }
  const levels = clusters.map((c) => ({ price: mean(c.members.map((m) => m.price)), touches: c.members.length }));

  const gap = 0.15 * atrV;
  const resistances = levels.filter((l) => l.price > close + gap).sort((a, b) => a.price - b.price).slice(0, 2);
  const supports = levels.filter((l) => l.price < close - gap).sort((a, b) => b.price - a.price).slice(0, 2);

  if (!resistances.length) {
    const hi = Math.max(...bars.slice(start).map((b) => b.high));
    if (hi > close + gap) resistances.push({ price: hi, touches: 1 });
  }
  if (!supports.length) {
    const lo = Math.min(...bars.slice(start).map((b) => b.low));
    if (lo < close - gap) supports.push({ price: lo, touches: 1 });
  }
  return { supports, resistances };
}

Aura.indicators = { sma, ema, rsi, atr, stdev, linregSlope, lastCross, supportResistance };
})();
