/* =========================================================================
 * Aura Invest · Renderizado de gráficos
 * Velas + EMA/SMA + Bollinger + S/R + cono, volumen, MACD y RSI en gráficos
 * sincronizados. MACD y Bollinger son solo visuales: se calculan aquí, fuera del
 * modelo, y no cambian su puntuación.
 * ========================================================================= */
(() => {
'use strict';

const { LWC, COLORS, CHART_BG, TIMEFRAMES } = Aura.config;
const { $, clamp, fmtNum, fmtPct, fmtSigned, fmtPrice, fmtCompact, fmtDate, MONTHS, pad2, esc, arrow, dirClass, wallToUtc } = Aura.utils;
const { ConeFillPrimitive, HorizontalBandPrimitive, DrawingsPrimitive } = Aura.primitives;
const { macd: calcMacd, bollinger: calcBollinger } = Aura.indicators;
const state = Aura.state;

const CH = {};               // instancias de gráficos y series
let srLines = [];            // líneas de soporte/resistencia activas
let extra = null;            // { bb, macd } alineados con state.model.bars
let cmp = null;              // modo Comparar: [{ id, color, values: (número|null)[] alineados con vis, error }]
const comparing = () => Boolean(cmp && cmp.length);

function merge(a, b) {
  const out = { ...a };
  for (const k of Object.keys(b)) {
    const v = b[k];
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object' ? merge(a[k], v) : v;
  }
  return out;
}

function tickFormatter(time, type) {
  const d = new Date(time * 1000);
  switch (type) {
    case 0: return String(d.getUTCFullYear());
    case 1: return MONTHS[d.getUTCMonth()];
    case 2: return String(d.getUTCDate());
    default: return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
  }
}

function baseChartOptions(extra) {
  return merge({
    autoSize: true,
    layout: {
      background: { type: 'solid', color: CHART_BG },
      textColor: COLORS.text,
      fontFamily: "'JetBrains Mono', ui-monospace, Menlo, Consolas, monospace",
      fontSize: 11,
    },
    grid: { vertLines: { color: COLORS.grid }, horzLines: { color: COLORS.grid } },
    crosshair: {
      mode: LWC.CrosshairMode.Normal,
      vertLine: { color: COLORS.crosshair, width: 1, style: LWC.LineStyle.Dashed, labelBackgroundColor: COLORS.label },
      horzLine: { color: COLORS.crosshair, width: 1, style: LWC.LineStyle.Dashed, labelBackgroundColor: COLORS.label },
    },
    rightPriceScale: { borderColor: COLORS.border, minimumWidth: 84 },
    timeScale: { borderColor: COLORS.border, rightOffset: 2, minBarSpacing: 0.5, tickMarkFormatter: tickFormatter },
    localization: { locale: 'es-ES', timeFormatter: (t) => fmtDate(t, state.tf && TIMEFRAMES[state.tf].kind === 'intraday') },
  }, extra);
}

function initCharts() {
  const priceFmt = (p) => (comparing() ? `${fmtSigned(p, 1)} %` : fmtNum(p, state.model ? state.model.meta.precision : 2));

  CH.main = LWC.createChart($('#chartMain'), baseChartOptions({
    layout: { attributionLogo: false },
    timeScale: { visible: false },
    rightPriceScale: { scaleMargins: { top: 0.12, bottom: 0.06 } },
    localization: { priceFormatter: priceFmt },
  }));
  CH.vol = LWC.createChart($('#chartVol'), baseChartOptions({
    layout: { attributionLogo: false },
    timeScale: { visible: false },
    rightPriceScale: { scaleMargins: { top: 0.22, bottom: 0 } },
    localization: { priceFormatter: fmtCompact },
  }));
  CH.macd = LWC.createChart($('#chartMacd'), baseChartOptions({
    layout: { attributionLogo: false },
    timeScale: { visible: false },
    rightPriceScale: { scaleMargins: { top: 0.15, bottom: 0.1 } },
  }));
  CH.rsi = LWC.createChart($('#chartRsi'), baseChartOptions({
    rightPriceScale: { scaleMargins: { top: 0.14, bottom: 0.06 } },
    localization: { priceFormatter: (p) => fmtNum(p, 0) },
  }));

  // El cono se recorta para que nunca aplaste las velas al autoescalar
  const coneAutoscale = (base) => {
    const res = base();
    const c = state.coneClamp;
    if (!res || !res.priceRange || !c) return res;
    const minValue = Math.max(res.priceRange.minValue, c.min), maxValue = Math.min(res.priceRange.maxValue, c.max);
    return minValue < maxValue ? { ...res, priceRange: { minValue, maxValue } } : res;
  };
  const coneBand = { color: COLORS.auraLine, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, autoscaleInfoProvider: coneAutoscale };
  CH.coneUpper = CH.main.addLineSeries(coneBand);
  CH.coneLower = CH.main.addLineSeries(coneBand);
  CH.coneCenter = CH.main.addLineSeries({
    color: COLORS.aura, lineWidth: 2, lineStyle: LWC.LineStyle.Dashed,
    priceLineVisible: false, lastValueVisible: true, title: '3M', autoscaleInfoProvider: coneAutoscale,
  });
  CH.coneFill = new ConeFillPrimitive();
  CH.coneCenter.attachPrimitive(CH.coneFill);

  CH.candles = CH.main.addCandlestickSeries({
    upColor: COLORS.up, downColor: COLORS.down, borderUpColor: COLORS.up, borderDownColor: COLORS.down,
    wickUpColor: COLORS.up, wickDownColor: COLORS.down, priceLineStyle: LWC.LineStyle.Dotted,
  });
  const bbLine = { color: COLORS.bb, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, visible: false };
  CH.bbUpper = CH.main.addLineSeries(bbLine);
  CH.bbLower = CH.main.addLineSeries(bbLine);
  CH.bbMid = CH.main.addLineSeries({ ...bbLine, lineStyle: LWC.LineStyle.Dotted });
  CH.bbFill = new ConeFillPrimitive({ fill: COLORS.bbFill });
  CH.bbMid.attachPrimitive(CH.bbFill);
  CH.cmpSeries = COLORS.compare.map((color) => CH.main.addLineSeries({
    color, lineWidth: 2, priceLineVisible: false, lastValueVisible: true, visible: false,
    priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
  }));
  CH.drawings = new DrawingsPrimitive();
  CH.candles.attachPrimitive(CH.drawings);
  CH.ema = CH.main.addLineSeries({ color: COLORS.ema, lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
  CH.sma = CH.main.addLineSeries({ color: COLORS.sma, lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });

  CH.volume = CH.vol.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false });
  CH.volSma = CH.vol.addLineSeries({ color: COLORS.volSma, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });

  CH.macdHist = CH.macd.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false });
  CH.macdLine = CH.macd.addLineSeries({ color: COLORS.macd, lineWidth: 2, priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: false });
  CH.macdSignal = CH.macd.addLineSeries({ color: COLORS.macdSignal, lineWidth: 1, priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: false });
  CH.macdLine.createPriceLine({ price: 0, color: 'rgba(127,135,155,0.45)', lineWidth: 1, lineStyle: LWC.LineStyle.Dotted, axisLabelVisible: false, title: '' });

  CH.rsiLine = CH.rsi.addLineSeries({
    color: COLORS.rsi, lineWidth: 2, priceLineVisible: false, lastValueVisible: true,
    autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }),
  });
  CH.rsiLine.attachPrimitive(new HorizontalBandPrimitive(30, 70, 'rgba(139,108,240,0.07)'));
  CH.rsiLine.createPriceLine({ price: 70, color: 'rgba(229,72,77,0.7)', lineWidth: 1, lineStyle: LWC.LineStyle.Dashed, axisLabelVisible: true, title: '' });
  CH.rsiLine.createPriceLine({ price: 30, color: 'rgba(22,168,137,0.8)', lineWidth: 1, lineStyle: LWC.LineStyle.Dashed, axisLabelVisible: true, title: '' });
  CH.rsiLine.createPriceLine({ price: 50, color: 'rgba(127,135,155,0.35)', lineWidth: 1, lineStyle: LWC.LineStyle.Dotted, axisLabelVisible: false, title: '' });

  syncCharts();
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => [CH.main, CH.vol, CH.macd, CH.rsi].forEach((c) => c.applyOptions({ layout: { fontSize: 11 } })));
  }
}

/** Sincroniza zoom/desplazamiento y crosshair entre las gráficas. */
function syncCharts() {
  const panes = [
    { key: 'main', chart: CH.main, el: $('#paneMain') },
    { key: 'vol', chart: CH.vol, el: $('#paneVol') },
    { key: 'macd', chart: CH.macd, el: $('#paneMacd') },
    { key: 'rsi', chart: CH.rsi, el: $('#paneRsi') },
  ];
  CH.panes = panes;

  let rangeLock = false;
  panes.forEach(({ chart }) => {
    chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (rangeLock || !range) return;
      rangeLock = true;
      panes.forEach((o) => { if (o.chart !== chart) o.chart.timeScale().setVisibleLogicalRange(range); });
      rangeLock = false;
    });
  });

  let activePane = null;     // panel bajo el puntero: solo él propaga el crosshair
  let crossLock = false;
  panes.forEach((p) => {
    p.el.addEventListener('pointerenter', () => { activePane = p.key; });
    p.el.addEventListener('pointerleave', () => { if (activePane === p.key) activePane = null; });
    p.chart.subscribeCrosshairMove((param) => {
      if (crossLock || (activePane && activePane !== p.key)) return;
      crossLock = true;
      try { onCrosshair(p, param); } finally { crossLock = false; }
    });
  });
}

function onCrosshair(src, param) {
  const m = state.model;
  if (!m) return;
  const others = CH.panes.filter((p) => p !== src);
  if (!param.point || param.time == null) {
    others.forEach((p) => p.chart.clearCrosshairPosition());
    hideTooltip();
    updateReadouts(null);
    return;
  }
  const t = param.time;
  const i = m.timeIndex.get(t);
  const f = m.futureIndex.get(t);
  const bar = i != null ? m.vis[i] : null;
  const rsiV = i != null ? m.ind.rsi14[m.ws + i] : null;
  const macdV = i != null && extra ? extra.macd.line[m.ws + i] : null;

  for (const p of others) {
    if (p.key === 'main') {
      if (bar && comparing()) { if (cmp[0].values[i] != null) p.chart.setCrosshairPosition(cmp[0].values[i], t, CH.cmpSeries[0]); }
      else if (bar) p.chart.setCrosshairPosition(bar.close, t, CH.candles);
      else if (f) p.chart.setCrosshairPosition(f.center, t, CH.coneCenter);
    } else if (p.key === 'vol') {
      p.chart.setCrosshairPosition(bar ? bar.volume : 0, t, CH.volume);
    } else if (p.key === 'macd') {
      if (state.show.macd) p.chart.setCrosshairPosition(macdV != null ? macdV : 0, t, CH.macdLine);
    } else {
      p.chart.setCrosshairPosition(rsiV != null ? rsiV : 50, t, CH.rsiLine);
    }
  }
  if (bar || f) showTooltip(src, param.point, i, f); else hideTooltip();
  updateReadouts(i);
}

/** Pinta velas, medias, volumen, RSI, niveles y cono para el modelo dado. */
function renderCharts(m) {
  const { vis, ind, ws, meta, tf } = m;
  const at = (arr, i) => arr[ws + i];
  const line = (arr) => vis.map((b, i) => (at(arr, i) == null ? { time: b.time } : { time: b.time, value: at(arr, i) }));

  const intraday = tf.kind === 'intraday';
  [CH.main, CH.vol, CH.macd, CH.rsi].forEach((c) => c.applyOptions({ timeScale: { timeVisible: intraday, secondsVisible: false } }));
  const minMove = 1 / 10 ** meta.precision;
  const priceFormat = { type: 'price', precision: meta.precision, minMove };
  [CH.candles, CH.ema, CH.sma, CH.coneCenter, CH.coneUpper, CH.coneLower, CH.bbUpper, CH.bbLower, CH.bbMid].forEach((s) => s.applyOptions({ priceFormat }));
  const macdPrec = Math.max(2, meta.precision + 1);
  [CH.macdLine, CH.macdSignal, CH.macdHist].forEach((s) => s.applyOptions({ priceFormat: { type: 'price', precision: macdPrec, minMove: 1 / 10 ** macdPrec } }));

  // Indicadores solo visuales (calculados con el calentamiento, como los del modelo)
  const closes = m.bars.map((b) => b.close);
  extra = { bb: calcBollinger(closes), macd: calcMacd(closes) };
  CH.bbUpper.setData(line(extra.bb.upper));
  CH.bbLower.setData(line(extra.bb.lower));
  CH.bbMid.setData(line(extra.bb.mid));
  CH.bbFill.setPoints(vis.map((b, i) => ({ time: b.time, upper: at(extra.bb.upper, i), lower: at(extra.bb.lower, i) })).filter((p) => p.upper != null));
  CH.macdLine.setData(line(extra.macd.line));
  CH.macdSignal.setData(line(extra.macd.signal));
  CH.macdHist.setData(vis.map((b, i) => {
    const h = at(extra.macd.hist, i);
    return h == null ? { time: b.time } : { time: b.time, value: h, color: h >= 0 ? COLORS.upA : COLORS.downA };
  }));
  applyIndicatorVisibility();

  CH.candles.setData(vis.map(({ time, open, high, low, close }) => ({ time, open, high, low, close })));
  CH.ema.setData(line(ind.ema20));
  CH.sma.setData(line(ind.sma50));
  CH.ema.applyOptions({ visible: state.show.ema });
  CH.sma.applyOptions({ visible: state.show.sma });
  CH.volSma.setData(line(ind.volSma20));

  // Límite de autoescala del cono: como mucho un 75 % del rango visible de velas por cada lado
  const lo = Math.min(...vis.map((b) => b.low)), hi = Math.max(...vis.map((b) => b.high));
  const span = Math.max(hi - lo, hi * 0.01);
  state.coneClamp = { min: lo - 0.75 * span, max: hi + 0.75 * span };

  renderLevels(m);
  renderForecastLayer(m);
  fitAll();
}

/** Velas de volumen/RSI + espacio futuro en blanco para alinear los ejes temporales. */
function renderForecastLayer(m) {
  const { vis, ind, ws, fc } = m;
  const show = state.show.cone && !comparing();
  const future = show ? fc.points.slice(1).map((p) => ({ time: p.time })) : [];

  CH.volume.setData(vis.map((b) => ({ time: b.time, value: b.volume, color: b.close >= b.open ? COLORS.upA : COLORS.downA })).concat(future));
  CH.rsiLine.setData(vis.map((b, i) => (ind.rsi14[ws + i] == null ? { time: b.time } : { time: b.time, value: ind.rsi14[ws + i] })).concat(future));
  if (extra) {
    const ml = extra.macd.line;
    CH.macdLine.setData(vis.map((b, i) => (ml[ws + i] == null ? { time: b.time } : { time: b.time, value: ml[ws + i] })).concat(future));
  }

  if (show) {
    CH.coneCenter.setData(fc.points.map((p) => ({ time: p.time, value: p.center })));
    CH.coneUpper.setData(fc.points.map((p) => ({ time: p.time, value: p.upper })));
    CH.coneLower.setData(fc.points.map((p) => ({ time: p.time, value: p.lower })));
    CH.coneFill.setPoints(fc.points);
  } else {
    [CH.coneCenter, CH.coneUpper, CH.coneLower].forEach((s) => s.setData([]));
    CH.coneFill.setPoints([]);
  }
}

function renderLevels(m) {
  srLines.forEach((l) => CH.candles.removePriceLine(l));
  srLines = [];
  if (!state.show.sr || comparing()) return;
  const add = (lvl, title, color) => srLines.push(CH.candles.createPriceLine({
    price: lvl.price, color, lineWidth: 1, lineStyle: LWC.LineStyle.Dashed, axisLabelVisible: true, title,
  }));
  m.sr.resistances.forEach((l, k) => add(l, `R${k + 1}`, k ? 'rgba(229,72,77,0.5)' : 'rgba(229,72,77,0.85)'));
  m.sr.supports.forEach((l, k) => add(l, `S${k + 1}`, k ? 'rgba(22,168,137,0.5)' : 'rgba(22,168,137,0.9)'));
}

function fitAll() {
  // Todas las gráficas comparten el mismo eje temporal, así que el encuadre coincide;
  // en el siguiente frame se copia el rango del principal por si alguna difiere.
  [CH.main, CH.vol, CH.macd, CH.rsi].forEach((c) => c.timeScale().fitContent());
  requestAnimationFrame(() => {
    const r = CH.main.timeScale().getVisibleLogicalRange();
    if (r) [CH.vol, CH.macd, CH.rsi].forEach((c) => c.timeScale().setVisibleLogicalRange(r));
  });
}

/** Bollinger (series del gráfico principal) y panel MACD según los botones. */
function applyIndicatorVisibility() {
  const bb = state.show.bb && !comparing();
  [CH.bbUpper, CH.bbLower, CH.bbMid].forEach((s) => s.applyOptions({ visible: bb }));
  CH.bbFill.fill = bb ? COLORS.bbFill : 'rgba(0,0,0,0)';
  CH.bbFill.requestUpdate && CH.bbFill.requestUpdate();
  const showMacd = state.show.macd;
  if ($('#paneMacd').hidden === showMacd) {
    $('#paneMacd').hidden = !showMacd;
    $('#chartStack').classList.toggle('has-macd', showMacd);
  }
}

/* ---- Leyenda, etiquetas de panel y tooltip ---- */

function renderLegend() {
  const m = state.model;
  if (comparing()) {
    $('#legend').innerHTML = `
      <div class="lg-title"><b>Comparar</b><span>% desde el ${fmtDate(m.vis[0].time, m.tf.kind === 'intraday')} · ${m.tf.key}</span></div>
      <div class="lg-items">${cmp.map((c, k) => `<span class="lg-item"><i style="background:${c.color}"></i>${esc(c.id)}${c.error ? ' <b>sin datos</b>' : ` <b id="lgCmp${k}">—</b>`}</span>`).join('')}</div>`;
    return;
  }
  $('#legend').innerHTML = `
    <div class="lg-title"><b>${esc(m.meta.symbol)}</b><span>${m.meta.name && m.meta.name !== m.meta.symbol ? `${esc(m.meta.name)} · ` : ''}${m.tf.key} · ${m.tf.intervalLabel}</span></div>
    <div class="lg-items">
      <span class="lg-item ${state.show.ema ? '' : 'off'}"><i style="background:${COLORS.ema}"></i>EMA 20 <b id="lgEma">—</b></span>
      <span class="lg-item ${state.show.sma ? '' : 'off'}"><i style="background:${COLORS.sma}"></i>SMA 50 <b id="lgSma">—</b></span>
      <span class="lg-item ${state.show.cone ? '' : 'off'}"><i class="dash" style="border-color:${COLORS.aura}"></i>Proyección 3M <b>${fmtPrice(m.fc.end.center, m.meta)}</b></span>
      ${state.show.bb ? `<span class="lg-item"><i style="background:${COLORS.bb}"></i>Bollinger 20, 2 <b id="lgBb">—</b></span>` : ''}
    </div>`;
}

/** Actualiza los valores de leyenda y etiquetas para la vela `i` (o la última). */
function updateReadouts(i) {
  const m = state.model;
  if (!m) return;
  const k = i == null ? m.vis.length - 1 : i;
  const g = (arr) => arr[m.ws + k];
  if (comparing()) {
    cmp.forEach((c, j) => { const el = $(`#lgCmp${j}`); if (el) el.textContent = c.values[k] != null ? `${fmtSigned(c.values[k], 2)} %` : '—'; });
  }
  const emaEl = $('#lgEma'), smaEl = $('#lgSma');
  if (emaEl) emaEl.textContent = fmtNum(g(m.ind.ema20), m.meta.precision);
  if (smaEl) smaEl.textContent = fmtNum(g(m.ind.sma50), m.meta.precision);
  $('#volLabel').innerHTML = `Volumen <b>${fmtCompact(m.vis[k].volume)}</b> · media 20 <b>${fmtCompact(g(m.ind.volSma20))}</b>`;
  $('#rsiLabel').innerHTML = `RSI 14 <b>${fmtNum(g(m.ind.rsi14), 1)}</b> · bandas 30 / 70`;
  if (!extra) return;
  const e = (arr) => arr[m.ws + k];
  const bbEl = $('#lgBb');
  if (bbEl) bbEl.textContent = `${fmtNum(e(extra.bb.lower), m.meta.precision)} – ${fmtNum(e(extra.bb.upper), m.meta.precision)}`;
  const mp = Math.max(2, m.meta.precision + 1);
  $('#macdLabel').innerHTML = `MACD 12, 26, 9 · <b>${fmtNum(e(extra.macd.line), mp)}</b> · señal <b>${fmtNum(e(extra.macd.signal), mp)}</b> · hist. <b>${fmtNum(e(extra.macd.hist), mp)}</b>`;
}

function showTooltip(src, point, i, f) {
  const m = state.model, tt = $('#tooltip');
  const intraday = m.tf.kind === 'intraday';
  const P = (v) => fmtNum(v, m.meta.precision);
  if (i != null && comparing()) {
    tt.innerHTML = `<div class="tt-date">${fmtDate(m.vis[i].time, intraday)}</div>`
      + cmp.map((c) => `<div class="tt-row"><span style="color:${c.color}">${esc(c.id)}</span><b class="${c.values[i] != null ? dirClass(c.values[i]) : ''}">${c.values[i] != null ? `${fmtSigned(c.values[i], 2)} %` : '—'}</b></div>`).join('');
  } else if (i != null) {
    const b = m.vis[i];
    const prev = m.bars[m.ws + i - 1];
    const chg = prev ? (b.close / prev.close - 1) * 100 : 0;
    const r = m.ind.rsi14[m.ws + i];
    tt.innerHTML = `
      <div class="tt-date">${fmtDate(b.time, intraday)}</div>
      <div class="tt-grid">
        <span>O</span><b>${P(b.open)}</b><span>H</span><b>${P(b.high)}</b>
        <span>L</span><b>${P(b.low)}</b><span>C</span><b>${P(b.close)}</b>
      </div>
      <div class="tt-sep"></div>
      <div class="tt-row"><span>Var.</span><b class="${dirClass(chg)}">${arrow(chg)} ${fmtPct(chg)}</b></div>
      <div class="tt-row"><span>Volumen</span><b>${fmtCompact(b.volume)}</b></div>
      <div class="tt-row"><span>RSI 14</span><b>${fmtNum(r, 1)}</b></div>${extraTooltip(i)}`;
  } else {
    const chg = (f.center / m.fc.P0 - 1) * 100;
    tt.innerHTML = `
      <span class="tt-tag">Proyección del modelo</span>
      <div class="tt-date">${fmtDate(f.time, intraday)}</div>
      <div class="tt-row"><span>Central</span><b>${P(f.center)}</b></div>
      <div class="tt-row"><span>Superior</span><b>${P(f.upper)}</b></div>
      <div class="tt-row"><span>Inferior</span><b>${P(f.lower)}</b></div>
      <div class="tt-sep"></div>
      <div class="tt-row"><span>vs. actual</span><b class="${dirClass(chg)}">${arrow(chg)} ${fmtPct(chg)}</b></div>`;
  }
  tt.hidden = false;
  const stack = $('#chartStack');
  const x = point.x + src.el.offsetLeft, y = point.y + src.el.offsetTop;
  const tw = tt.offsetWidth, th = tt.offsetHeight;
  const W = stack.clientWidth, H = stack.clientHeight;
  let left = x + 18;
  if (left + tw > W - 90) left = x - tw - 18;
  const top = clamp(y - th / 2, 8, H - th - 8);
  tt.style.transform = `translate(${Math.max(8, left)}px, ${top}px)`;
}
function hideTooltip() { $('#tooltip').hidden = true; }

/** Filas del tooltip para Bollinger y MACD, si están activados. */
function extraTooltip(i) {
  const m = state.model;
  if (!extra) return '';
  const k = m.ws + i;
  const P = (v) => fmtNum(v, m.meta.precision);
  const mp = Math.max(2, m.meta.precision + 1);
  let out = '';
  if (state.show.bb && extra.bb.upper[k] != null) out += `<div class="tt-row"><span>Bollinger</span><b>${P(extra.bb.lower[k])} – ${P(extra.bb.upper[k])}</b></div>`;
  if (state.show.macd && extra.macd.line[k] != null) out += `<div class="tt-row"><span>MACD / señal</span><b>${fmtNum(extra.macd.line[k], mp)} / ${fmtNum(extra.macd.signal[k], mp)}</b></div>`;
  return out;
}

/* ---- API pública ---- */

/** Pinta un modelo completo (gráficos, leyenda y etiquetas de panel). */
function render(m) {
  hideTooltip();
  cmp = null;                                         // main.js vuelve a aplicar Comparar si toca
  CH.candles.applyOptions({ visible: true });
  CH.cmpSeries.forEach((s) => { s.applyOptions({ visible: false }); s.setData([]); });
  renderCharts(m);
  renderLegend();
  updateReadouts(null);
  refreshDrawings({ selectedId: null, preview: null, override: null });
}

/** Vacía los tres gráficos (sin datos que mostrar: sin clave, error o símbolo no disponible). */
function clear() {
  hideTooltip();
  srLines.forEach((l) => CH.candles.removePriceLine(l));
  srLines = [];
  [CH.candles, CH.ema, CH.sma, CH.coneCenter, CH.coneUpper, CH.coneLower, CH.volume, CH.volSma, CH.rsiLine,
    CH.bbUpper, CH.bbLower, CH.bbMid, CH.macdHist, CH.macdLine, CH.macdSignal].forEach((s) => s.setData([]));
  CH.coneFill.setPoints([]);
  CH.bbFill.setPoints([]);
  CH.cmpSeries.forEach((s) => { s.setData([]); s.applyOptions({ visible: false }); });
  extra = null;
  cmp = null;
  CH.drawings.set({ items: [], preview: null, selectedId: null });
  $('#macdLabel').textContent = 'MACD 12, 26, 9';
  state.coneClamp = null;
  $('#legend').textContent = '';
  $('#volLabel').textContent = 'Volumen';
  $('#rsiLabel').textContent = 'RSI 14';
}

/* ---- Dibujos ---- */

let drawState = { selectedId: null, preview: null, override: null };

/** Tiempos del eje del gráfico principal (velas visibles + futuro del cono si se ve). */
function axisTimes() {
  const m = state.model;
  if (!m) return [];
  const times = m.vis.map((b) => b.time);
  if (state.show.cone && !comparing()) m.fc.points.slice(1).forEach((p) => times.push(p.time));
  return times;
}

/** Herramientas para js/drawing-tools.js: conversión píxel ↔ fecha/precio sobre el gráfico principal. */
function drawingApi() {
  const times = axisTimes();
  const step = Aura.drawings.stepOf(state.model ? state.model.vis.map((b) => b.time) : []);
  return {
    chart: CH.main, series: CH.candles, primitive: CH.drawings,
    // Área de dibujo del panel (sin la escala de precios). timeScale().width() vale 0
    // aquí porque el eje de tiempo del gráfico principal está oculto.
    paneWidth: () => CH.main.paneSize().width,
    paneHeight: () => CH.main.paneSize().height,
    xToTime: (x) => Aura.drawings.logicalToTime(times, CH.main.timeScale().coordinateToLogical(x), step),
    yToPrice: (y) => CH.candles.coordinateToPrice(y),
    precision: state.model ? state.model.meta.precision : 2,
  };
}

/** Repinta los dibujos del valor actual (ninguno en el modo Comparar: el eje está en %). */
function refreshDrawings(o = {}) {
  drawState = { ...drawState, ...o };
  const m = state.model;
  let items = m && !comparing() ? Aura.drawings.list(state.symbol) : [];
  if (drawState.override) items = items.map((d) => (d.id === drawState.override.id ? drawState.override : d));
  const times = axisTimes();
  const step = Aura.drawings.stepOf(m ? m.vis.map((b) => b.time) : []);
  CH.drawings.set({
    items, selectedId: drawState.selectedId, preview: m && !comparing() ? drawState.preview : null,
    format: (p) => fmtNum(p, m ? m.meta.precision : 2),
    resolveX: (t) => { const l = Aura.drawings.timeToLogical(times, t, step); return l == null ? null : CH.main.timeScale().logicalToCoordinate(l); },
  });
}

/* ---- Comparar ---- */

/**
 * % desde el inicio de la ventana, alineado con las fechas del valor principal: para
 * cada vela visible se toma el último cierre del otro valor en esa fecha o antes (así
 * volumen, MACD y RSI siguen alineados). Base: el cierre en la primera vela visible
 * (o el primero disponible después, si el otro valor empieza más tarde).
 */
function percentSeries(vis, bars) {
  const values = new Array(vis.length).fill(null);
  let j = -1, base = null;
  for (let i = 0; i < vis.length; i++) {
    while (j + 1 < bars.length && bars[j + 1].time <= vis[i].time) j++;
    if (j < 0) continue;
    if (base == null) base = bars[j].close;
    values[i] = (bars[j].close / base - 1) * 100;
  }
  return values;
}

/**
 * Como percentSeries, pero alineando en UTC real: cada serie trae las horas de su zona
 * (la de su bolsa, o la del usuario en forex y cripto) codificadas como UTC. Hace falta en
 * intradía; en diario se alinea por fecha.
 */
function percentSeriesUtc(vis, visTz, bars, barsTz) {
  const toUtc = (arr, tz) => arr.map((b) => ({ time: wallToUtc(b.time, tz), close: b.close }));
  return percentSeries(toUtc(vis, visTz), toUtc(bars, barsTz));
}

/**
 * Activa, actualiza o desactiva el modo Comparar.
 * @param {object} m          modelo del valor principal
 * @param {object[]} others   [{ id, data } | { id, error }] (vacío = salir del modo)
 * @returns {object[]} resumen para la interfaz: [{ id, color, last, error }]
 */
function renderCompare(m, others) {
  const intraday = m.tf.kind === 'intraday';
  const series = (o) => (o.error ? [] : intraday
    ? percentSeriesUtc(m.vis, m.meta.timezone, o.data ? o.data.bars : o.bars, o.data ? o.data.meta.timezone : m.meta.timezone)
    : percentSeries(m.vis, o.bars || o.data.bars));
  cmp = others.length ? [{ id: m.meta.id || m.meta.symbol, bars: m.vis }, ...others].map((o, k) => ({
    id: o.id, color: COLORS.compare[k], error: o.error || null, values: series(o),
  })) : null;
  const on = comparing();
  CH.candles.applyOptions({ visible: !on });
  CH.ema.applyOptions({ visible: state.show.ema && !on });
  CH.sma.applyOptions({ visible: state.show.sma && !on });
  CH.cmpSeries.forEach((s, k) => {
    const c = on ? cmp[k] : null;
    s.applyOptions({ visible: Boolean(c && !c.error) });
    s.setData(c && !c.error ? m.vis.map((b, i) => (c.values[i] == null ? { time: b.time } : { time: b.time, value: c.values[i] })) : []);
  });
  CH.main.applyOptions({ localization: { priceFormatter: CH.main.options().localization.priceFormatter } });
  applyIndicatorVisibility();
  renderLevels(m);
  renderForecastLayer(m);
  renderLegend();
  updateReadouts(null);
  refreshDrawings();
  fitAll();
  return on ? cmp.slice(1).map((c) => ({ id: c.id, color: c.color, last: c.values.length ? c.values.at(-1) : null, error: c.error })) : [];
}

/** Aplica un toggle de la barra de herramientas sobre el gráfico ya renderizado. */
function applyToggle(key) {
  const m = state.model;
  if (!m) return;
  if (key === 'ema') CH.ema.applyOptions({ visible: state.show.ema && !comparing() });
  if (key === 'sma') CH.sma.applyOptions({ visible: state.show.sma && !comparing() });
  if (key === 'sr') renderLevels(m);
  if (key === 'cone') { renderForecastLayer(m); refreshDrawings(); fitAll(); }
  if (key === 'bb' || key === 'macd') applyIndicatorVisibility();
  if (key === 'macd') fitAll();
  renderLegend();
  updateReadouts(null);
}

Aura.charts = { init: initCharts, render, clear, applyToggle, fitAll, hideTooltip, renderCompare, comparing, percentSeries, percentSeriesUtc, drawingApi, refreshDrawings };
})();
