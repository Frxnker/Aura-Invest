/* =========================================================================
 * Aura Invest · Backtest del modelo (cálculo puro)
 *
 * Para cada día pasado d se ejecuta Aura.model.analyze() SOLO con las velas hasta d
 * (incluida): nunca ve el futuro. Las señales de todos los días se calculan primero;
 * después, y por separado, se mide qué pasó:
 *   - rentabilidad a 21 y 63 sesiones tras cada señal (Alcista, Neutral, Bajista),
 *     frente a la de cualquier día (comprar y mantener) y frente a no operar (0 %);
 *   - acierto: Alcista acierta si el precio sube; Bajista, si baja;
 *   - cono del 80 % a 63 sesiones: cuántas veces acabó dentro, por encima o por debajo;
 *   - objetivo o stop: cuál se tocó antes en las 63 sesiones siguientes (con máximos y
 *     mínimos diarios) para las señales Alcista y Bajista.
 * Las reglas del modelo no cambian: se usa la misma vista diaria (6M) que en la app.
 * ========================================================================= */
(() => {
'use strict';

const { FORECAST_DAYS } = Aura.config;

const LOOKBACK = 400;       // velas que se pasan a analyze(): de sobra para la ventana de 6M + 120 de calentamiento
const MIN_HISTORY = 250;    // primer día evaluable (hace falta ventana + calentamiento)
const H_SHORT = 21;         // ≈ 1 mes
const H_LONG = FORECAST_DAYS;  // 63 sesiones ≈ 3 meses, el horizonte del cono

/** Señal del modelo el día `d` usando únicamente las velas 0…d. */
function signalAt(bars, d, meta, analyze = Aura.model.analyze) {
  const hist = bars.slice(Math.max(0, d - LOOKBACK + 1), d + 1);
  const m = analyze({ meta, bars: hist, barsPerDay: 1 }, '6M');
  return {
    d, time: bars[d].time, close: bars[d].close,
    action: m.adv.action, probs: m.trend.probs, score: m.trend.score,
    entry: m.adv.entry, target: m.adv.target, stop: m.adv.stop,
    cone: { lower: m.fc.end.lower, upper: m.fc.end.upper, center: m.fc.end.center },
  };
}

/** Qué pasó después de una señal (esto sí mira hacia delante: va aparte). */
function outcome(bars, s) {
  const { d } = s;
  const n = bars.length;
  const ret = (h) => (d + h < n ? bars[d + h].close / s.close - 1 : null);
  const out = { r21: ret(H_SHORT), r63: ret(H_LONG), cone: null, touch: null };
  if (d + H_LONG < n) {
    const c = bars[d + H_LONG].close;
    out.cone = c > s.cone.upper ? 'above' : c < s.cone.lower ? 'below' : 'inside';
  }
  if (s.action === 'buy' || s.action === 'sell') {
    const up = s.action === 'buy';
    out.touch = d + H_LONG < n ? 'none' : 'pending';
    for (let k = d + 1; k <= Math.min(d + H_LONG, n - 1); k++) {
      const b = bars[k];
      const hitTarget = up ? b.high >= s.target : b.low <= s.target;
      const hitStop = up ? b.low <= s.stop : b.high >= s.stop;
      if (hitTarget && hitStop) { out.touch = 'both'; break; }
      if (hitTarget) { out.touch = 'target'; break; }
      if (hitStop) { out.touch = 'stop'; break; }
    }
  }
  return out;
}

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const share = (a, f) => (a.length ? a.filter(f).length / a.length : null);

/** Resumen de las filas { action, r21, r63, cone, touch }. */
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
  const touches = Object.fromEntries(['buy', 'sell'].map((a) => {
    const rs = rows.filter((r) => r.action === a && r.touch && r.touch !== 'pending');
    return [a, { n: rs.length, target: share(rs, (r) => r.touch === 'target'), stop: share(rs, (r) => r.touch === 'stop'), both: share(rs, (r) => r.touch === 'both'), none: share(rs, (r) => r.touch === 'none') }];
  }));
  return {
    days: rows.length,
    counts: Object.fromEntries(actions.map((a) => [a, rows.filter((r) => r.action === a).length])),
    h21: horizon('r21'),
    h63: horizon('r63'),
    cone: { n: coneRows.length, inside: share(coneRows, (r) => r.cone === 'inside'), above: share(coneRows, (r) => r.cone === 'above'), below: share(coneRows, (r) => r.cone === 'below') },
    touches,
  };
}

/**
 * Ejecuta el backtest. Cede el control cada `chunk` días para no bloquear la página.
 * @param {object[]} bars   velas diarias reales, en orden
 * @param {object} meta
 * @param {object} [o]      onProgress(0…1), signal (AbortSignal), analyze (sustituible en pruebas)
 */
async function run(bars, meta, { onProgress = () => {}, signal, chunk = 25, analyze } = {}) {
  if (bars.length < MIN_HISTORY + H_SHORT + 1) {
    throw new Error(`Hacen falta al menos ${MIN_HISTORY + H_SHORT + 1} sesiones diarias; hay ${bars.length}.`);
  }
  const signals = [];
  const total = bars.length - MIN_HISTORY;
  for (let d = MIN_HISTORY; d < bars.length; d++) {
    if (signal && signal.aborted) throw Object.assign(new Error('Backtest cancelado.'), { name: 'AbortError' });
    signals.push(signalAt(bars, d, meta, analyze));
    if ((d - MIN_HISTORY) % chunk === 0) {
      onProgress((d - MIN_HISTORY) / total);
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  onProgress(1);
  const rows = signals.map((s) => ({ ...s, ...outcome(bars, s) }));
  return { rows, summary: summarize(rows), from: bars[MIN_HISTORY].time, to: bars[bars.length - 1].time };
}

Aura.backtest = { run, signalAt, outcome, summarize, LOOKBACK, MIN_HISTORY, H_SHORT, H_LONG };
})();
