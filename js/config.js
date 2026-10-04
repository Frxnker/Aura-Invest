/* =========================================================================
 * Aura Invest · Configuración
 * Crea el espacio de nombres global `Aura` y define colores, temporalidades y
 * parámetros de la API y del modelo. Debe cargarse antes que el resto.
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

const WARMUP_BARS = 120;     // velas previas a la ventana para "calentar" los indicadores
const FORECAST_DAYS = 63;    // 3 meses ≈ 63 sesiones bursátiles
const FORECAST_Z = 1.2816;   // z para un intervalo central del 80 %

/**
 * Temporalidades: intervalo de vela en Twelve Data, velas a pedir, unidad para los
 * textos y muestreo del cono (paso en sesiones para diario/semanal; nº de puntos
 * para intradía).
 *
 * `outputsize` = velas de la ventana más larga posible + 120 de calentamiento + margen.
 * Las ventanas se calculan para sesiones de hasta 8,5 h (bolsas europeas):
 *   1D  5 min : 102 velas/sesión                         → 102 + 120 = 222  → 260
 *   5D  15 min: 5 × 34                                     → 170 + 120 = 290  → 330
 *   1M  1 h   : 23 sesiones × 9                            → 207 + 120 = 327  → 360
 *   6M/YTD/1A diario: hasta 262 sesiones (1 año)           → 262 + 120 = 382  → 400
 *   5A  semanal: hasta 262 semanas                         → 262 + 120 = 382  → 400
 * 6M, YTD y 1A comparten la misma petición diaria (y la misma entrada de caché).
 * tests/data.test.mjs comprueba que cada temporalidad deja ≥ 120 velas de calentamiento.
 */
const TIMEFRAMES = {
  '1D':  { key: '1D',  kind: 'intraday', minutes: 5,  interval: '5min',  outputsize: 260, intervalLabel: '5 min',   unitOne: 'vela de 5 min',  unitMany: 'velas de 5 min',  conePoints: 26 },
  '5D':  { key: '5D',  kind: 'intraday', minutes: 15, interval: '15min', outputsize: 330, intervalLabel: '15 min',  unitOne: 'vela de 15 min', unitMany: 'velas de 15 min', conePoints: 30 },
  '1M':  { key: '1M',  kind: 'intraday', minutes: 60, interval: '1h',    outputsize: 360, intervalLabel: '1 hora',  unitOne: 'vela horaria',   unitMany: 'velas horarias',  conePoints: 40 },
  '6M':  { key: '6M',  kind: 'daily',    interval: '1day',  outputsize: 400, intervalLabel: 'Diario',  unitOne: 'sesión', unitMany: 'sesiones', coneStep: 1 },
  'YTD': { key: 'YTD', kind: 'daily',    interval: '1day',  outputsize: 400, intervalLabel: 'Diario',  unitOne: 'sesión', unitMany: 'sesiones', coneStep: 1 },
  '1A':  { key: '1A',  kind: 'daily',    interval: '1day',  outputsize: 400, intervalLabel: 'Diario',  unitOne: 'sesión', unitMany: 'sesiones', coneStep: 1 },
  '5A':  { key: '5A',  kind: 'weekly',   interval: '1week', outputsize: 400, intervalLabel: 'Semanal', unitOne: 'semana', unitMany: 'semanas',  coneStep: 5 },
};

/** Twelve Data · plan Basic (gratuito): 8 créditos por minuto y 800 al día. */
const API = {
  base: 'https://api.twelvedata.com',
  provider: 'Twelve Data',
  perMinute: 8,
  perDay: 800,
  freePlan: 'Basic',
};

/**
 * Caducidad de la caché (segundos) según el intervalo pedido: cuanto más corta la
 * vela, antes cambia el dato.
 */
const CACHE_TTL = {
  '5min': 5 * 60,
  '15min': 15 * 60,
  '1h': 30 * 60,
  '1day': 60 * 60,
  '1week': 6 * 3600,
  quote: 60,
  search: 7 * 86400,
};

const DAY = 86400;
const REDUCED_MOTION = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

Aura.config = {
  LWC, COLORS, CHART_BG, TIMEFRAMES, API, CACHE_TTL,
  WARMUP_BARS, FORECAST_DAYS, FORECAST_Z,
  DAY, REDUCED_MOTION,
};
})();
