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
/** Con signo (+/−); el signo sale del valor ya redondeado, así nunca aparece "−0,00". */
function fmtSigned(v, d = 2) {
  if (!Number.isFinite(v)) return '—';
  const r = Number(v.toFixed(d));
  return (r > 0 ? '+' : r < 0 ? '−' : '') + nf(d).format(Math.abs(r));
}
const fmtPct = (v, d = 2) => (Number.isFinite(v) ? fmtSigned(v, d) + '%' : '—');
function fmtPrice(v, meta) {
  if (!Number.isFinite(v)) return '—';
  const s = nf(meta.precision).format(v);
  if (meta.pair) return meta.currency ? `${s} ${meta.currency}` : s;   // pares de divisas: 1,1712 USD
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

/* ---- Zonas horarias (para alinear en UTC real velas de bolsas distintas) ---- */

/** Zona horaria IANA del navegador (p. ej. "Europe/Madrid"); "UTC" si no se puede saber. */
function localTimeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}

const ZONE_FMT = new Map();
const ZONE_OFFSET = new Map();
/** Minutos que la zona `tz` va por delante de UTC en el instante `utcMs` (0 si la zona no es válida). */
function zoneOffsetMin(tz, utcMs) {
  if (!tz || tz === 'UTC') return 0;
  const hour = Math.floor(utcMs / 3600000);           // los cambios de hora ocurren en horas en punto
  const key = `${tz}|${hour}`;
  if (ZONE_OFFSET.has(key)) return ZONE_OFFSET.get(key);
  let off = 0;
  try {
    if (!ZONE_FMT.has(tz)) {
      ZONE_FMT.set(tz, new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }));
    }
    const p = Object.fromEntries(ZONE_FMT.get(tz).formatToParts(new Date(hour * 3600000)).map((x) => [x.type, x.value]));
    off = Math.round((Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute) - hour * 3600000) / 60000);
  } catch { off = 0; }
  ZONE_OFFSET.set(key, off);
  return off;
}

/**
 * Hora de pared de la zona `tz` codificada como UTC (así se guardan las velas) → instante UTC
 * real, ambos en segundos. Sin zona conocida se deja igual.
 */
function wallToUtc(sec, tz) {
  if (!tz || tz === 'UTC') return sec;
  const ms = sec * 1000;
  const first = ms - zoneOffsetMin(tz, ms) * 60000;
  return (ms - zoneOffsetMin(tz, first) * 60000) / 1000;   // segunda pasada por si cruza un cambio de hora
}

const arrow = (v) => (v >= 0 ? '▲' : '▼');
const dirClass = (v) => (v >= 0 ? 'up-t' : 'down-t');

Aura.utils = {
  $, clamp, last, mean, sleep, esc,
  dayStart, weekdayOf, isWeekend, nextTradingDays, addMonthsUTC,
  fmtNum, fmtSigned, fmtPct, fmtPrice, fmtCompact, fmtDate, MONTHS, pad2, arrow, dirClass,
  fmtLocalTime, fmtLocalDateTime, fmtAgo, utcDay,
  localTimeZone, zoneOffsetMin, wallToUtc,
};
})();
