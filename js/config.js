/* =========================================================================
 * Aura Invest · Configuración
 * Crea el espacio de nombres global `Aura` y define colores, temporalidades y
 * parámetros del simulador y del modelo. Debe cargarse antes que el resto.
 * ========================================================================= */
window.Aura = {};

(() => {
'use strict';

const LWC = window.LightweightCharts;

const COLORS = {
  up: '#16a889', down: '#e5484d',
  upA: 'rgba(22,168,137,0.55)', downA: 'rgba(229,72,77,0.55)',
  ema: '#0ea5c6', sma: '#c9820f', aura: '#8b6cf0', auraLine: 'rgba(139,108,240,0.75)',
  rsi: '#c7cbe0', volSma: 'rgba(199,203,224,0.55)',
  grid: 'rgba(255,255,255,0.045)', border: '#1b1f2b', text: '#8b92a5',
  crosshair: 'rgba(200,205,225,0.38)', label: '#272c3b',
};
const CHART_BG = '#0b0d13';

/**
 * Temporalidades: intervalo de vela, unidad para los textos y muestreo del cono
 * (paso en sesiones para diario/semanal; nº de puntos para intradía).
 */
const TIMEFRAMES = {
  '1D':  { key: '1D',  kind: 'intraday', minutes: 5,  intervalLabel: '5 min',   unitOne: 'vela de 5 min',  unitMany: 'velas de 5 min',  conePoints: 26 },
  '5D':  { key: '5D',  kind: 'intraday', minutes: 15, intervalLabel: '15 min',  unitOne: 'vela de 15 min', unitMany: 'velas de 15 min', conePoints: 30 },
  '1M':  { key: '1M',  kind: 'intraday', minutes: 60, intervalLabel: '1 hora',  unitOne: 'vela horaria',   unitMany: 'velas horarias',  conePoints: 40 },
  '6M':  { key: '6M',  kind: 'daily',    intervalLabel: 'Diario',  unitOne: 'sesión', unitMany: 'sesiones', coneStep: 1 },
  'YTD': { key: 'YTD', kind: 'daily',    intervalLabel: 'Diario',  unitOne: 'sesión', unitMany: 'sesiones', coneStep: 1 },
  '1A':  { key: '1A',  kind: 'daily',    intervalLabel: 'Diario',  unitOne: 'sesión', unitMany: 'sesiones', coneStep: 1 },
  '5A':  { key: '5A',  kind: 'weekly',   intervalLabel: 'Semanal', unitOne: 'semana', unitMany: 'semanas',  coneStep: 5 },
};

const WARMUP_BARS = 120;     // velas previas a la ventana para "calentar" los indicadores
const DAILY_HISTORY = 1700;  // ≈ 6,7 años de sesiones simuladas
const INTRADAY_DAYS = 34;    // sesiones con detalle intradía (5 min)
const FORECAST_DAYS = 63;    // 3 meses ≈ 63 sesiones bursátiles
const FORECAST_Z = 1.2816;   // z para un intervalo central del 80 %

const DAY = 86400;
const REDUCED_MOTION = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

Aura.config = {
  LWC, COLORS, CHART_BG, TIMEFRAMES,
  WARMUP_BARS, DAILY_HISTORY, INTRADAY_DAYS, FORECAST_DAYS, FORECAST_Z,
  DAY, REDUCED_MOTION,
};
})();
