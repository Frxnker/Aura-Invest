/* =========================================================================
 * Aura Invest · Modelo predictivo
 * Probabilidad de tendencia, cono de previsión a 3 meses y recomendación táctica.
 * ========================================================================= */
(() => {
'use strict';

const { TIMEFRAMES, WARMUP_BARS, FORECAST_DAYS, FORECAST_Z } = Aura.config;
const { clamp, last, mean, dayStart, addMonthsUTC, nextTradingDays, fmtNum, fmtSigned, fmtPct, fmtPrice } = Aura.utils;
const { sma, ema, rsi, atr, stdev, linregSlope, lastCross, supportResistance } = Aura.indicators;

/** Índice de la primera vela visible según la temporalidad (por calendario). */
function windowStartIndex(bars, tfKey) {
  const lastT = last(bars).time;
  let cutoff;
  switch (tfKey) {
    case '1D': cutoff = dayStart(lastT); break;
    case '5D': {
      const days = [...new Set(bars.map((b) => dayStart(b.time)))];
      cutoff = days[Math.max(0, days.length - 5)];
      break;
    }
    case '1M': cutoff = addMonthsUTC(dayStart(lastT), -1); break;
    case '6M': cutoff = addMonthsUTC(lastT, -6); break;
    case 'YTD': cutoff = Date.UTC(new Date(lastT * 1000).getUTCFullYear(), 0, 1) / 1000; break;
    case '1A': cutoff = addMonthsUTC(lastT, -12); break;
    case '5A': cutoff = addMonthsUTC(lastT, -60); break;
    default: cutoff = bars[0].time;
  }
  let idx = bars.findIndex((b) => b.time >= cutoff);
  if (idx < 0) idx = 0;
  return clamp(idx, 0, Math.max(0, bars.length - 10));   // mínimo 10 velas visibles
}

/** Reparte porcentajes enteros que suman exactamente 100 (mayor resto). */
function roundTo100(obj) {
  const keys = Object.keys(obj);
  const raw = keys.map((k) => obj[k] * 100);
  const floored = raw.map(Math.floor);
  let rest = 100 - floored.reduce((a, b) => a + b, 0);
  raw.map((v, i) => [v - floored[i], i]).sort((a, b) => b[0] - a[0]).forEach(([, i]) => { if (rest-- > 0) floored[i]++; });
  return Object.fromEntries(keys.map((k, i) => [k, floored[i]]));
}

/**
 * Probabilidad de tendencia. Cada señal produce una puntuación en [-1, 1]:
 *   1. Precio vs EMA 20 (distancia en ATR)          · peso 0,18
 *   2. Precio vs SMA 50 (distancia en 1,5 ATR)      · peso 0,18
 *   3. Cruce de medias (separación; cruce reciente refuerza) · peso 0,24
 *   4. Nivel de RSI (sobrecompra/sobreventa penalizan)        · peso 0,14
 *   5. Pendiente del RSI en 5 velas                · peso 0,12
 *   6. Volumen relativo vs media 20 × dirección del precio    · peso 0,14
 * La puntuación compuesta S se transforma con softmax en Bullish / Neutral / Bearish.
 */
function trendProbability(bars, ind) {
  const n = bars.length, i = n - 1;
  const close = bars[i].close;
  const atrV = ind.atr14[i] || close * 0.02;
  const e = ind.ema20[i], s = ind.sma50[i], r = ind.rsi14[i];
  const r5 = ind.rsi14[Math.max(0, i - 5)];
  const factors = [];

  factors.push({ label: 'Precio vs EMA 20', weight: 0.18,
    score: e != null ? Math.tanh((close - e) / atrV) : 0,
    reading: e != null ? fmtPct((close / e - 1) * 100) : '—' });

  factors.push({ label: 'Precio vs SMA 50', weight: 0.18,
    score: s != null ? Math.tanh((close - s) / (1.5 * atrV)) : 0,
    reading: s != null ? fmtPct((close / s - 1) * 100) : '—' });

  const cross = lastCross(ind.ema20, ind.sma50, 15);
  let crossScore = 0, crossReading = '—';
  if (e != null && s != null) {
    crossScore = Math.tanh((e - s) / atrV);
    if (cross) {
      crossScore = cross.dir * Math.max(Math.abs(crossScore), 0.75);
      crossReading = `${cross.dir > 0 ? 'Alcista' : 'Bajista'} (${cross.ago})`;
    } else {
      crossReading = e > s ? 'EMA > SMA' : 'EMA < SMA';
    }
  }
  factors.push({ label: 'Cruce EMA 20 / SMA 50', weight: 0.24, score: crossScore, reading: crossReading });

  let rsiLevel = 0;
  if (r != null) {
    if (r > 70) rsiLevel = 1 - (r - 70) / 10;        // 70 → +1, 80 → 0, 90 → −1
    else if (r < 30) rsiLevel = -1 + (30 - r) / 10;
    else rsiLevel = (r - 50) / 20;
    rsiLevel = clamp(rsiLevel, -1, 1);
  }
  factors.push({ label: 'Nivel RSI 14', weight: 0.14, score: rsiLevel, reading: fmtNum(r, 1) });

  const slope = r != null && r5 != null ? r - r5 : 0;
  factors.push({ label: 'Pendiente RSI (5)', weight: 0.12, score: clamp(slope / 12, -1, 1), reading: fmtSigned(slope, 1) });

  const vAvg = ind.volSma20[i];
  const vRecent = mean(bars.slice(-3).map((b) => b.volume));
  const relVol = vAvg ? vRecent / vAvg : 1;
  const move = (close - bars[Math.max(0, i - 3)].close) / atrV;
  const volScore = clamp(Math.tanh(move * 1.5) * clamp((relVol - 0.8) / 0.8, -0.3, 1), -1, 1);
  factors.push({ label: 'Volumen relativo (20)', weight: 0.14, score: volScore, reading: `${fmtNum(relVol, 2)}×` });

  const score = factors.reduce((acc, f) => acc + f.weight * f.score, 0);

  // Softmax: Neutral domina cuando |S| es pequeño
  const logits = { bull: 1.8 * score, neutral: 0.55 - 1.6 * Math.abs(score), bear: -1.8 * score };
  const ex = Object.fromEntries(Object.entries(logits).map(([k, v]) => [k, Math.exp(v)]));
  const sum = ex.bull + ex.neutral + ex.bear;
  const probs = roundTo100({ bull: ex.bull / sum, neutral: ex.neutral / sum, bear: ex.bear / sum });

  // Confianza: magnitud de S + consenso entre señales activas
  const active = factors.filter((f) => Math.abs(f.score) >= 0.1);
  const wActive = active.reduce((a, f) => a + f.weight, 0);
  const agree = wActive ? active.filter((f) => Math.sign(f.score) === Math.sign(score)).reduce((a, f) => a + f.weight, 0) / wActive : 0;
  let conf = 0.55 * Math.min(1, Math.abs(score) / 0.55) + 0.45 * agree;
  if (n < 60) conf *= 0.8;
  const level = conf >= 0.75 ? 'High' : conf >= 0.5 ? 'Medium' : 'Low';

  return { score, probs, conf, level, factors, details: { close, e, s, r, slope, relVol, move, cross, atr: atrV } };
}

/**
 * Cono de previsión a 3 meses (paseo aleatorio geométrico):
 *  - σ diaria: desviación de los log-rendimientos recientes, escalada a sesión (√velas/día).
 *    En diario se usan las últimas 250 sesiones (≈ 1 año) de la serie descargada, no solo la
 *    ventana visible, para que el cono no dependa de la vista (6M, YTD o 1A); con 120 el
 *    cono del 80 % cubría menos de lo debido en el backtest. Intradía y semanal: 120 velas.
 *  - μ diaria: pendiente de regresión del log-precio, contraída hacia 0 según la longitud
 *    del histórico (una tendencia de 1 día pesa poco) + sesgo de la puntuación técnica.
 *  - Central: P0·e^(μt); bandas: P0·e^(μt ± z·σ·√t), z = 1,2816 (80 %).
 */
const SIGMA_LOOKBACK = { intraday: 120, daily: 250, weekly: 120 };

/**
 * Instantes futuros donde se evalúa el cono, como { time, t } con t en sesiones.
 *  - Diario/semanal: una vela futura por sesión (o por semana), igual que el histórico.
 *  - Intradía: t = 63·(j/N)², de modo que la anchura (∝ √t) crece linealmente con el
 *    índice y el cono no "salta" fuera de escala en el primer punto. Las fracciones de
 *    sesión se colocan dentro del horario de mercado.
 */
function futureSchedule(lastT, tf, meta) {
  if (tf.kind !== 'intraday') {
    const step = tf.coneStep;
    return nextTradingDays(lastT, Math.ceil(FORECAST_DAYS / step), step)
      .map((time, j) => ({ time, t: Math.min((j + 1) * step, FORECAST_DAYS) }));
  }
  const [openMin, sessMin] = meta.session;
  const sessions = nextTradingDays(lastT, FORECAST_DAYS, 1);
  const out = [];
  for (let j = 1; j <= tf.conePoints; j++) {
    const t = FORECAST_DAYS * (j / tf.conePoints) ** 2;
    const d = Math.max(1, Math.ceil(t));
    const time = sessions[d - 1] + openMin * 60 + Math.round((t - (d - 1)) * sessMin) * 60;
    if (!out.length || time > last(out).time) out.push({ time, t });
  }
  return out;
}

/** @param {object[]} volBars  serie para la σ (en diario, la descargada completa); acaba en la misma vela que `bars` */
function forecastCone(bars, barsPerDay, score, tf, meta, volBars = bars) {
  const n = bars.length;
  const P0 = bars[n - 1].close;
  const nv = volBars.length;
  const lookR = Math.min(SIGMA_LOOKBACK[tf.kind], nv - 1);
  const rets = [];
  for (let k = nv - lookR; k < nv; k++) {
    // En intradía se excluyen los huecos de apertura para no inflar la volatilidad por vela
    if (tf.kind === 'intraday' && dayStart(volBars[k].time) !== dayStart(volBars[k - 1].time)) continue;
    rets.push(Math.log(volBars[k].close / volBars[k - 1].close));
  }
  const sigmaDay = clamp(stdev(rets) * Math.sqrt(barsPerDay), 0.006, 0.09);

  const L = Math.min(60, n);
  const slopeDay = linregSlope(bars.slice(n - L).map((b) => Math.log(b.close))) * barsPerDay;
  const lookDays = L / barsPerDay;
  const shrink = lookDays / (lookDays + 120);
  const muDay = clamp(shrink * slopeDay + 0.0007 * score, -0.0012, 0.0012);   // tope ≈ ±35 % anual

  const at = (t) => ({
    center: P0 * Math.exp(muDay * t),
    upper: P0 * Math.exp(muDay * t + FORECAST_Z * sigmaDay * Math.sqrt(t)),
    lower: P0 * Math.exp(muDay * t - FORECAST_Z * sigmaDay * Math.sqrt(t)),
  });

  const lastT = bars[n - 1].time;
  const schedule = futureSchedule(lastT, tf, meta);
  const points = [{ time: lastT, t: 0, center: P0, upper: P0, lower: P0 }]
    .concat(schedule.map(({ time, t }) => ({ time, t, ...at(t) })));

  const end = at(FORECAST_DAYS);
  return {
    P0, muDay, sigmaDay, end, points,
    sigmaAnnual: sigmaDay * Math.sqrt(252),
    muAnnual: Math.exp(muDay * 252) - 1,
    upside: (end.center / P0 - 1) * 100,
    horizonT: last(schedule).time,
  };
}

/**
 * Recomendación táctica y niveles operativos.
 *  - Comprar: Bullish ≥ 55 % y S > 0,2 · Vender: Bearish ≥ 55 % y S < −0,2 · resto: Mantener.
 *  - Bajista no propone operación en corto: en el backtest con datos reales (6 valores, 5 a
 *    20 años) esos cortos perdían de media. Solo se señala el soporte S1 como nivel a vigilar.
 *  - Stop: tras el soporte más cercano si está a 0,6–3,5 ATR; si no, a 2 ATR.
 *  - Objetivo: la resistencia más cercana que ofrezca ≥ 1,5R; si no hay, la proyección
 *    central (si aporta entre 1R y 3R, coherente con el stop de la temporalidad) o 2R.
 *    Siempre acotado al cono del 80 % a 3 meses.
 */
function buildAdvisory(trend, fc, sr) {
  const close = fc.P0, a = trend.details.atr;
  const S1 = sr.supports[0]?.price;
  let action = 'hold';
  if (trend.probs.bull >= 55 && trend.score > 0.2) action = 'buy';
  else if (trend.probs.bear >= 55 && trend.score < -0.2) action = 'sell';

  if (action === 'sell') {
    return { action, entry: null, stop: null, target: null, rr: null, watch: S1 ?? null, watchBasis: S1 != null ? 'soporte S1' : null };
  }

  let entry = close, entryBasis = 'precio actual', stop, stopBasis;

  if (action === 'hold') {
    // Mantener: se propone una entrada en retroceso (soporte o EMA 20) en lugar de perseguir el precio
    const e = trend.details.e;
    if (S1 != null && close - S1 <= 3 * a) { entry = S1; entryBasis = 'retroceso al soporte S1'; }
    else if (e != null && e < close) { entry = e; entryBasis = 'retroceso a la EMA 20'; }
    stop = entry - 1.5 * a; stopBasis = 'a 1,5× ATR bajo la entrada';
  } else {
    const dist = S1 != null ? entry - S1 : null;
    if (dist != null && dist >= 0.6 * a && dist <= 3.5 * a) {
      stop = S1 - 0.35 * a; stopBasis = 'bajo el soporte S1';
    } else {
      stop = entry - 2 * a; stopBasis = 'a 2× ATR(14)';
    }
  }

  const risk = Math.abs(entry - stop);
  const gain = (v) => v - entry;
  const levels = sr.resistances.map((l, k) => [l.price, `resistencia R${k + 1}`]);
  const viable = levels.filter(([p]) => gain(p) >= 1.5 * risk).sort((x, y) => gain(x[0]) - gain(y[0]));
  let target, targetBasis;
  if (viable.length) [target, targetBasis] = viable[0];
  else if (gain(fc.end.center) >= risk && gain(fc.end.center) <= 3 * risk) [target, targetBasis] = [fc.end.center, 'proyección central a 3M'];
  else [target, targetBasis] = [entry + 2 * risk, 'objetivo 2R'];

  if (gain(target) > gain(fc.end.upper)) { target = fc.end.upper; targetBasis = 'banda superior del cono 3M'; }

  const rr = Math.abs(target - entry) / Math.max(1e-9, risk);
  return { action, entry, stop, target, rr, entryBasis, stopBasis, targetBasis };
}

/** Justificación en 3–4 frases: cruce de medias, RSI, volumen y escenario de la señal. */
function buildRationale(m) {
  const { trend, adv, tf, meta } = m;
  const d = trend.details;
  const P = (v) => `<b>${fmtPrice(v, meta)}</b>`;
  const unit = (k) => (k === 1 ? tf.unitOne : tf.unitMany);
  const out = [];

  if (d.e != null && d.s != null) {
    const gap = (d.e / d.s - 1) * 100;
    if (d.cross) {
      const when = d.cross.ago === 0 ? 'en la última vela' : `hace ${d.cross.ago} ${unit(d.cross.ago)}`;
      out.push(d.cross.dir > 0
        ? `<b>Cruce alcista</b> reciente: la EMA 20 ha cortado al alza la SMA 50 ${when} y ya la supera en un ${fmtNum(Math.abs(gap), 2)}%, señal de aceleración del impulso.`
        : `<b>Cruce bajista</b> reciente: la EMA 20 ha perforado la SMA 50 ${when} y queda un ${fmtNum(Math.abs(gap), 2)}% por debajo, lo que suele anticipar debilidad.`);
    } else if (d.e > d.s) {
      out.push(`La EMA 20 (${P(d.e)}) se mantiene un ${fmtNum(gap, 2)}% sobre la SMA 50 (${P(d.s)}): <b>estructura de medias alcista</b>${d.close >= d.e ? ', con el precio por encima de ambas' : ', aunque el precio ha perdido la EMA 20'}.`);
    } else {
      out.push(`La EMA 20 (${P(d.e)}) cotiza un ${fmtNum(-gap, 2)}% bajo la SMA 50 (${P(d.s)}): <b>estructura de medias bajista</b>${d.close <= d.e ? ', con el precio por debajo de ambas' : ', aunque el precio intenta recuperar la EMA 20'}.`);
    }
  }

  if (d.r != null) {
    const sl = `${fmtSigned(d.slope, 1)} pts en 5 ${tf.unitMany}`;
    const r = `<b>RSI(14) ${fmtNum(d.r, 1)}</b>`;
    if (d.r >= 70) out.push(`${r}: zona de sobrecompra. El impulso es fuerte, pero crece el riesgo de recogida de beneficios.`);
    else if (d.r <= 30) out.push(`${r}: zona de sobreventa. Posible rebote técnico, aunque la presión vendedora sigue dominando.`);
    else if (d.r >= 55) out.push(`${r} (${sl}): momentum positivo sin llegar a sobrecompra.`);
    else if (d.r <= 45) out.push(`${r} (${sl}): por debajo de la línea media de 50, momentum débil.`);
    else out.push(`${r} (${sl}): zona neutral, sin sesgo claro de momentum.`);
  }

  const rv = d.relVol, upMove = d.move >= 0;
  const vol = `El volumen reciente es <b>${fmtNum(rv, 2)}× su media de 20 ${tf.unitMany}</b>`;
  if (rv >= 1.2) out.push(`${vol}, ${upMove ? 'respaldando el avance del precio' : 'confirmando la presión vendedora'}.`);
  else if (rv <= 0.8) out.push(`${vol}: participación baja y poca convicción en el movimiento ${upMove ? 'alcista' : 'bajista'}.`);
  else out.push(`${vol}, en línea con lo habitual: no confirma ni contradice el movimiento.`);

  const rr = fmtNum(adv.rr, 1);
  if (adv.action === 'buy') out.push(`Escenario alcista: entrada de referencia en ${P(adv.entry)}, stop ${adv.stopBasis} (${P(adv.stop)}) y objetivo en ${P(adv.target)} (${adv.targetBasis}); riesgo/beneficio 1:${rr}.`);
  else if (adv.action === 'sell') {
    const watch = adv.watch != null
      ? `nivel a vigilar: ${adv.watchBasis} en ${P(adv.watch)} (${fmtPct((adv.watch / d.close - 1) * 100)})`
      : 'no hay soporte por debajo del precio en la ventana';
    out.push(`Escenario bajista: el modelo no propone abrir cortos (con datos reales, sus posiciones cortas perdían de media en el backtest); ${watch}.`);
  }
  else out.push(`Sin ventaja estadística clara (${trend.probs.bull}% alcista frente a ${trend.probs.bear}% bajista): el nivel de referencia sería un ${adv.entryBasis} en ${P(adv.entry)}.`);

  return out;
}

/** Orquesta indicadores + modelo para el ticker y la temporalidad actuales. */
function analyze(data, tfKey) {
  const tf = TIMEFRAMES[tfKey];
  const meta = data.meta;
  let ws = windowStartIndex(data.bars, tfKey);
  const from = Math.max(0, ws - WARMUP_BARS);
  const bars = data.bars.slice(from);
  ws -= from;

  const closes = bars.map((b) => b.close);
  const ind = {
    ema20: ema(closes, 20),
    sma50: sma(closes, 50),
    rsi14: rsi(closes, 14),
    atr14: atr(bars, 14),
    volSma20: sma(bars.map((b) => b.volume), 20),
  };
  const atrLast = ind.atr14[bars.length - 1] || last(bars).close * 0.02;

  const sr = supportResistance(bars, ws, atrLast);
  const trend = trendProbability(bars, ind);
  const fc = forecastCone(bars, data.barsPerDay, trend.score, tf, meta, tf.kind === 'daily' ? data.bars : bars);
  const adv = buildAdvisory(trend, fc, sr);
  const vis = bars.slice(ws);

  const model = { tf, meta, bars, ws, vis, ind, sr, trend, fc, adv };
  model.rationale = buildRationale(model);
  model.timeIndex = new Map(vis.map((b, i) => [b.time, i]));
  model.futureIndex = new Map(fc.points.slice(1).map((p) => [p.time, p]));
  return model;
}

Aura.model = { analyze };
})();
