/* =========================================================================
 * Aura Invest · Utilidades
 * Helpers genéricos, PRNG determinista, calendario bursátil y formato es-ES.
 * ========================================================================= */
(() => {
'use strict';

const { DAY } = Aura.config;

const $ = (sel) => document.querySelector(sel);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const last = (arr) => arr[arr.length - 1];
const mean = (arr) => arr.reduce((a, b) => a + b, 0) / (arr.length || 1);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Hash FNV-1a: semilla estable por ticker. */
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
/** PRNG determinista (mulberry32). */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** Normal estándar (Box-Muller polar) a partir de un PRNG uniforme. */
function makeGauss(rng) {
  let spare = null;
  return () => {
    if (spare !== null) { const s = spare; spare = null; return s; }
    let u, v, s;
    do { u = rng() * 2 - 1; v = rng() * 2 - 1; s = u * u + v * v; } while (s >= 1 || s === 0);
    const m = Math.sqrt(-2 * Math.log(s) / s);
    spare = v * m;
    return u * m;
  };
}

/* ---- Fechas (todas en segundos UTC; el intradía se codifica en hora local de mercado) ---- */
const dayStart = (t) => Math.floor(t / DAY) * DAY;
const weekdayOf = (t) => (Math.floor(t / DAY) + 4) % 7;          // 0 = domingo
const isWeekend = (t) => { const w = weekdayOf(t); return w === 0 || w === 6; };

/** Última sesión cerrada: el último día laborable anterior a hoy. */
function lastClosedSession(now = new Date()) {
  let t = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / 1000 - DAY;
  while (isWeekend(t)) t -= DAY;
  return t;
}
function tradingDaysBack(endT, count) {
  const out = [];
  for (let t = endT; out.length < count; t -= DAY) if (!isWeekend(t)) out.push(t);
  return out.reverse();
}
/** Próximas sesiones a partir de una fecha, tomando una de cada `step`. */
function nextTradingDays(fromT, count, step = 1) {
  const out = [];
  let t = dayStart(fromT), k = 0;
  while (out.length < count) {
    t += DAY;
    if (isWeekend(t)) continue;
    k++;
    if (k % step === 0) out.push(t);
  }
  return out;
}
function addMonthsUTC(t, months) {
  const d = new Date(t * 1000);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.getTime() / 1000;
}

/* ---- Formato numérico y de fechas (es-ES) ---- */
const NF = {};
const nf = (d) => (NF[d] ||= new Intl.NumberFormat('es-ES', { minimumFractionDigits: d, maximumFractionDigits: d }));
const fmtNum = (v, d = 2) => (Number.isFinite(v) ? nf(d).format(v) : '—');
const fmtSigned = (v, d = 2) => (Number.isFinite(v) ? (v > 0 ? '+' : v < 0 ? '−' : '') + nf(d).format(Math.abs(v)) : '—');
const fmtPct = (v, d = 2) => (Number.isFinite(v) ? fmtSigned(v, d) + '%' : '—');
function fmtPrice(v, meta) {
  if (!Number.isFinite(v)) return '—';
  const s = nf(meta.precision).format(v);
  return meta.currency === 'EUR' ? `${s} €` : `$${s}`;
}
function fmtCompact(v) {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1e9) return nf(2).format(v / 1e9) + ' B';
  if (a >= 1e6) return nf(1).format(v / 1e6) + ' M';
  if (a >= 1e3) return nf(1).format(v / 1e3) + ' K';
  return nf(0).format(v);
}
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const WDAYS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const pad2 = (n) => String(n).padStart(2, '0');
function fmtDate(t, withTime = false) {
  const d = new Date(t * 1000);
  let s = `${WDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  if (withTime) s += ` · ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
  return s;
}
const arrow = (v) => (v >= 0 ? '▲' : '▼');
const dirClass = (v) => (v >= 0 ? 'up-t' : 'down-t');

Aura.utils = {
  $, clamp, last, mean, sleep, esc,
  hashStr, mulberry32, makeGauss,
  dayStart, weekdayOf, isWeekend, lastClosedSession, tradingDaysBack, nextTradingDays, addMonthsUTC,
  fmtNum, fmtSigned, fmtPct, fmtPrice, fmtCompact, fmtDate, MONTHS, pad2, arrow, dirClass,
};
})();
