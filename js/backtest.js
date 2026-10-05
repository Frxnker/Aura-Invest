/* =========================================================================
 * Aura Invest · Backtest del modelo (cálculo puro)
 *
 * Para cada día pasado d se ejecuta Aura.model.analyze() SOLO con las velas hasta d
 * (incluida): nunca ve el futuro. Las señales de todos los días se calculan primero;
 * después, y por separado, se mide qué pasó:
 *   - rentabilidad a corto y largo plazo tras cada señal (Alcista, Neutral, Bajista),
 *     frente a la de cualquier día (comprar y mantener) y frente a no operar (0 %);
 *   - acierto: Alcista acierta si el precio sube; Bajista, si baja;
 *   - cono del 80 % al horizonte largo: cuántas veces acabó dentro, por encima o por debajo;
 *   - objetivo o stop: cuál se tocó antes en el horizonte largo (con máximos y mínimos de
 *     cada vela) para las señales Alcista (Bajista no propone operación). Solo cuenta cuando
 *     ya ha pasado el horizonte entero: contar antes solo las que se resolvieron pronto
 *     sesgaría el reparto.
 * Y, aparte, medidas honestas con muestras que se solapan (intervalos por bloques), el
 * resultado en R frente a la misma operación abierta cualquier día y estrategias sencillas
 * con comisiones.
 *
 * Dos modos, con las mismas reglas del modelo que en la app:
 *   - diario: vista 6M; horizontes de 21 y 63 sesiones (≈ 1 y 3 meses; el cono es a 63);
 *   - semanal: vista 5A; horizontes de 4 y 13 semanas (13 semanas = 65 sesiones, lo más
 *     cerca de las 63 del cono que permiten las velas semanales).
 * ========================================================================= */
(() => {
'use strict';

const { FORECAST_DAYS } = Aura.config;

const MODES = {
  daily: { key: 'daily', tf: '6M', interval: '1day', barsPerDay: 1, lookback: 400, minHistory: 250, hShort: 21, hLong: FORECAST_DAYS, perYear: 252, unitOne: 'sesión', unitMany: 'sesiones' },
  // 5A: ventana de 5 años (≈ 262 semanas) + 120 de calentamiento
  weekly: { key: 'weekly', tf: '5A', interval: '1week', barsPerDay: 0.2, lookback: 400, minHistory: 390, hShort: 4, hLong: 13, perYear: 52, unitOne: 'semana', unitMany: 'semanas' },
};
const modeOf = (m) => (typeof m === 'string' ? MODES[m] : m) || MODES.daily;

// Compatibilidad: constantes del modo diario
const LOOKBACK = MODES.daily.lookback;
const MIN_HISTORY = MODES.daily.minHistory;
const H_SHORT = MODES.daily.hShort;
const H_LONG = MODES.daily.hLong;

/** Señal del modelo el día `d` usando únicamente las velas 0…d. */
function signalAt(bars, d, meta, analyze = Aura.model.analyze, mode = MODES.daily) {
  const md = modeOf(mode);
  const hist = bars.slice(Math.max(0, d - md.lookback + 1), d + 1);
  const m = analyze({ meta, bars: hist, barsPerDay: md.barsPerDay }, md.tf);
  return {
    d, time: bars[d].time, close: bars[d].close,
    action: m.adv.action, probs: m.trend.probs, score: m.trend.score,
    entry: m.adv.entry, target: m.adv.target, stop: m.adv.stop, atr: m.trend.details.atr,
    cone: { lower: m.fc.end.lower, upper: m.fc.end.upper, center: m.fc.end.center },
  };
}

/** Qué se toca antes en las `h` velas siguientes a `d` (largo): 'target' | 'stop' | 'both' | 'none'. */
function firstTouch(bars, d, h, target, stop) {
  for (let k = d + 1; k <= d + h; k++) {
    const b = bars[k];
    const hitTarget = b.high >= target, hitStop = b.low <= stop;
    if (hitTarget && hitStop) return 'both';
    if (hitTarget) return 'target';
    if (hitStop) return 'stop';
  }
  return 'none';
}

/** Qué pasó después de una señal (esto sí mira hacia delante: va aparte). */
function outcome(bars, s, mode = MODES.daily) {
  const { hShort, hLong } = modeOf(mode);
  const { d } = s;
  const n = bars.length;
  const ret = (h) => (d + h < n ? bars[d + h].close / s.close - 1 : null);
  const out = { r21: ret(hShort), r63: ret(hLong), cone: null, touch: null };
  if (d + hLong < n) {
    const c = bars[d + hLong].close;
    out.cone = c > s.cone.upper ? 'above' : c < s.cone.lower ? 'below' : 'inside';
  }
  if (s.action === 'buy') out.touch = d + hLong < n ? firstTouch(bars, d, hLong, s.target, s.stop) : 'pending';
  return out;
}

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const share = (a, f) => (a.length ? a.filter(f).length / a.length : null);

/** Resumen de las filas { action, r21, r63, cone, touch } (r21/r63: horizonte corto/largo). */
function summarize(rows) {
  const actions = ['buy', 'hold', 'sell'];
  const horizon = (key) => {
    const all = rows.filter((r) => r[key] != null);
    const base = { n: all.length, mean: mean(all.map((r) => r[key])), up: share(all, (r) => r[key] > 0), down: share(all, (r) => r[key] < 0) };
    const by = Object.fromEntries(actions.map((a) => {
      const rs = all.filter((r) => r.action === a);
      const hit = a === 'buy' ? share(rs, (r) => r[key] > 0) : a === 'sell' ? share(rs, (r) => r[key] < 0) : null;
      return [a, { n: rs.length, mean: mean(rs.map((r) => r[key])), hit }];
    }));
    return { all: base, by };
  };
  const coneRows = rows.filter((r) => r.cone);
  const done = rows.filter((r) => r.action === 'buy' && r.touch && r.touch !== 'pending');
  const touches = { buy: { n: done.length, target: share(done, (r) => r.touch === 'target'), stop: share(done, (r) => r.touch === 'stop'), both: share(done, (r) => r.touch === 'both'), none: share(done, (r) => r.touch === 'none') } };
  return {
    days: rows.length,
    counts: Object.fromEntries(actions.map((a) => [a, rows.filter((r) => r.action === a).length])),
    h21: horizon('r21'),
    h63: horizon('r63'),
    cone: { n: coneRows.length, inside: share(coneRows, (r) => r.cone === 'inside'), above: share(coneRows, (r) => r.cone === 'above'), below: share(coneRows, (r) => r.cone === 'below') },
    touches,
  };
}

/* ---------------------------------------------------------------------------
 * Medidas honestas
 * ------------------------------------------------------------------------- */

/**
 * Intervalo del 90 % por bootstrap de bloques móviles: se remuestrean tramos de `block` filas
 * seguidas, así que los días que comparten futuro (muestras solapadas) cuentan como lo que son.
 * Generador con semilla fija: el mismo backtest da siempre el mismo intervalo.
 */
function blockCI(rows, stat, { block = H_LONG, reps = 400, seed = 7 } = {}) {
  const n = rows.length;
  if (n < 2 * block) return null;
  let s = seed;
  const rnd = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
  const out = [];
  for (let r = 0; r < reps; r++) {
    const sample = [];
    while (sample.length < n) {
      const start = Math.floor(rnd() * (n - block + 1));
      for (let k = 0; k < block && sample.length < n; k++) sample.push(rows[start + k]);
    }
    const v = stat(sample);
    if (Number.isFinite(v)) out.push(v);
  }
  if (out.length < reps / 2) return null;
  out.sort((a, b) => a - b);
  return [out[Math.floor(out.length * 0.05)], out[Math.min(out.length - 1, Math.floor(out.length * 0.95))]];
}

/** Resultado en R de una compra con ese objetivo y stop (si se tocan ambos el mismo día, cuenta como stop). */
function rMultiple(bars, d, h, entry, target, stop) {
  const risk = entry - stop;
  if (!(risk > 0)) return null;
  const t = firstTouch(bars, d, h, target, stop);
  const exit = t === 'target' ? target : t === 'none' ? bars[d + h].close : stop;
  return (exit - entry) / risk;
}

/**
 * - Diferencia de la rentabilidad a largo plazo tras Alcista y Bajista con la de cualquier día,
 *   con su IC del 90 %, y el % dentro del cono con su IC.
 * - Periodos independientes: cuántos tramos sin solapar caben (lo que "valen" las muestras).
 * - R de las compras Alcista frente a la misma operación (misma distancia del stop en ATR y
 *   mismo riesgo/beneficio) abierta cualquier día: ¿añade algo la señal?
 */
function honest(rows, bars, mode = MODES.daily) {
  const md = modeOf(mode);
  const long = rows.filter((r) => r.r63 != null);
  const meanOf = (rs, f = () => true) => mean(rs.filter(f).map((r) => r.r63));
  const delta = (a) => (rs) => { const x = meanOf(rs, (r) => r.action === a); return x == null ? NaN : x - meanOf(rs); };
  const dOf = (a) => {
    const n = long.filter((r) => r.action === a).length;
    return { n, delta: n ? delta(a)(long) : null, ci: n ? blockCI(long, delta(a), { block: md.hLong }) : null };
  };
  const coneRows = rows.filter((r) => r.cone);
  const inside = (rs) => share(rs, (r) => r.cone === 'inside');

  const done = rows.filter((r) => r.d + md.hLong < bars.length && r.atr > 0);
  const buys = done.filter((r) => r.action === 'buy' && r.entry - r.stop > 0);
  let R = null;
  if (buys.length) {
    const kAtr = mean(buys.map((r) => (r.entry - r.stop) / r.atr));
    const rr = mean(buys.map((r) => (r.target - r.entry) / (r.entry - r.stop)));
    const signal = mean(buys.map((r) => rMultiple(bars, r.d, md.hLong, r.entry, r.target, r.stop)));
    const base = mean(done.map((r) => { const risk = kAtr * r.atr; return rMultiple(bars, r.d, md.hLong, r.close, r.close + rr * risk, r.close - risk); }));
    R = { n: buys.length, signal, base, kAtr, rr };
  }
  return {
    buy: dOf('buy'), sell: dOf('sell'),
    cone: { n: coneRows.length, inside: inside(coneRows), ci: blockCI(coneRows, inside, { block: md.hLong }) },
    independent: Math.floor(long.length / md.hLong),
    R,
  };
}

/* ---------------------------------------------------------------------------
 * Estrategias con comisiones
 * ------------------------------------------------------------------------- */

const STRATEGIES = {
  hold: { label: 'Comprar y mantener', pos: () => 1 },
  buyOnly: { label: 'Solo con señal Alcista', pos: (a) => (a === 'buy' ? 1 : 0) },
  exitOnSell: { label: 'Fuera con señal Bajista', pos: (a) => (a === 'sell' ? 0 : 1) },
};

/**
 * Posición decidida al cierre de cada vela con la señal de ese día y aplicada a la vela
 * siguiente (sin datos futuros). Cada compra o venta paga `fee` (fracción del importe).
 * @returns {{key, label, cagr, maxDrawdown, sharpe, trades, exposure}[]}
 */
function strategies(bars, rows, { fee = 0.001, mode = MODES.daily } = {}) {
  const { perYear } = modeOf(mode);
  return Object.entries(STRATEGIES).map(([key, s]) => {
    let eq = 1, peak = 1, maxDrawdown = 0, prev = 0, trades = 0, inMarket = 0, n = 0;
    const rets = [];
    for (const r of rows) {
      if (r.d + 1 >= bars.length) break;
      const p = s.pos(r.action);
      const before = eq;
      if (p !== prev) { eq *= 1 - Math.abs(p - prev) * fee; trades++; prev = p; }
      eq *= 1 + p * (bars[r.d + 1].close / bars[r.d].close - 1);
      rets.push(eq / before - 1);
      peak = Math.max(peak, eq);
      maxDrawdown = Math.min(maxDrawdown, eq / peak - 1);
      inMarket += p !== 0; n++;
    }
    const m = mean(rets) || 0;
    const sd = rets.length > 1 ? Math.sqrt(rets.reduce((a, x) => a + (x - m) ** 2, 0) / (rets.length - 1)) : 0;
    return {
      key, label: s.label, trades,
      cagr: n ? eq ** (perYear / n) - 1 : null,
      maxDrawdown, sharpe: sd ? (m / sd) * Math.sqrt(perYear) : null,
      exposure: n ? inMarket / n : null,
    };
  });
}

/* ---------------------------------------------------------------------------
 * Ejecución
 * ------------------------------------------------------------------------- */

/**
 * Ejecuta el backtest. Cede el control cada `chunk` velas para no bloquear la página.
 * @param {object[]} bars   velas reales (diarias o semanales, según `mode`), en orden
 * @param {object} meta
 * @param {object} [o]      mode ('daily' | 'weekly'), onProgress(0…1), signal (AbortSignal),
 *                          analyze (sustituible en pruebas), fee (comisión de las estrategias)
 */
async function run(bars, meta, { onProgress = () => {}, signal, chunk = 25, analyze, mode = 'daily', fee = 0.001 } = {}) {
  const md = modeOf(mode);
  if (bars.length < md.minHistory + md.hShort + 1) {
    throw new Error(`Hacen falta al menos ${md.minHistory + md.hShort + 1} velas ${md.key === 'weekly' ? 'semanales' : 'diarias'}; hay ${bars.length}.`);
  }
  const signals = [];
  const total = bars.length - md.minHistory;
  for (let d = md.minHistory; d < bars.length; d++) {
    if (signal && signal.aborted) throw Object.assign(new Error('Backtest cancelado.'), { name: 'AbortError' });
    signals.push(signalAt(bars, d, meta, analyze, md));
    if ((d - md.minHistory) % chunk === 0) {
      onProgress((d - md.minHistory) / total);
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  onProgress(1);
  const rows = signals.map((s) => ({ ...s, ...outcome(bars, s, md) }));
  return {
    mode: md, rows, summary: summarize(rows), honest: honest(rows, bars, md), strategies: strategies(bars, rows, { fee, mode: md }),
    from: bars[md.minHistory].time, to: bars[bars.length - 1].time,
  };
}

Aura.backtest = {
  run, signalAt, outcome, summarize, honest, strategies, blockCI, rMultiple, MODES,
  LOOKBACK, MIN_HISTORY, H_SHORT, H_LONG,
};
})();
