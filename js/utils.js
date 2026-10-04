/* =========================================================================
 * Aura Invest · Utilidades
 * Helpers genéricos, calendario bursátil y formato es-ES.
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

/* ---- Fechas (todas en segundos UTC; el intradía se codifica en hora local de mercado) ---- */
const dayStart = (t) => Math.floor(t / DAY) * DAY;
const weekdayOf = (t) => (Math.floor(t / DAY) + 4) % 7;          // 0 = domingo
const isWeekend = (t) => { const w = weekdayOf(t); return w === 0 || w === 6; };

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
  if (meta.currency === 'USD') return `$${s}`;
  if (meta.currency === 'EUR') return `${s} €`;
  return meta.currency ? `${s} ${meta.currency}` : s;
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
/* ---- Hora local del usuario (para "actualizado a las…", no para las velas) ---- */
const LOCAL_TIME = new Intl.DateTimeFormat('es-ES', { hour: '2-digit', minute: '2-digit' });
const LOCAL_DATETIME = new Intl.DateTimeFormat('es-ES', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const fmtLocalTime = (ms) => (Number.isFinite(ms) ? LOCAL_TIME.format(ms) : '—');
const fmtLocalDateTime = (ms) => (Number.isFinite(ms) ? LOCAL_DATETIME.format(ms) : '—');
/** "hace 3 min", "hace 2 h", "hace 4 días". */
function fmtAgo(ms, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return 'hace unos segundos';
  if (s < 3600) return `hace ${Math.round(s / 60)} min`;
  if (s < 86400) return `hace ${Math.round(s / 3600)} h`;
  const d = Math.round(s / 86400);
  return `hace ${d} ${d === 1 ? 'día' : 'días'}`;
}
/** Fecha UTC 'AAAA-MM-DD' (para el contador diario de créditos). */
const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

const arrow = (v) => (v >= 0 ? '▲' : '▼');
const dirClass = (v) => (v >= 0 ? 'up-t' : 'down-t');

Aura.utils = {
  $, clamp, last, mean, sleep, esc,
  dayStart, weekdayOf, isWeekend, nextTradingDays, addMonthsUTC,
  fmtNum, fmtSigned, fmtPct, fmtPrice, fmtCompact, fmtDate, MONTHS, pad2, arrow, dirClass,
  fmtLocalTime, fmtLocalDateTime, fmtAgo, utcDay,
};
})();
