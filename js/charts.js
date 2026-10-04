/* =========================================================================
 * Aura Invest · Renderizado de gráficos
 * Velas + EMA/SMA + S/R + cono, volumen y RSI en tres gráficos sincronizados.
 * ========================================================================= */
(() => {
'use strict';

const { LWC, COLORS, CHART_BG, TIMEFRAMES } = Aura.config;
const { $, clamp, fmtNum, fmtPct, fmtPrice, fmtCompact, fmtDate, MONTHS, pad2, esc, arrow, dirClass } = Aura.utils;
const { ConeFillPrimitive, HorizontalBandPrimitive } = Aura.primitives;
const state = Aura.state;

const CH = {};               // instancias de gráficos y series
let srLines = [];            // líneas de soporte/resistencia activas

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
  const priceFmt = (p) => fmtNum(p, state.model ? state.model.meta.precision : 2);

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
  CH.ema = CH.main.addLineSeries({ color: COLORS.ema, lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
  CH.sma = CH.main.addLineSeries({ color: COLORS.sma, lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });

  CH.volume = CH.vol.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false });
  CH.volSma = CH.vol.addLineSeries({ color: COLORS.volSma, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });

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
    document.fonts.ready.then(() => [CH.main, CH.vol, CH.rsi].forEach((c) => c.applyOptions({ layout: { fontSize: 11 } })));
  }
}

/** Sincroniza zoom/desplazamiento y crosshair entre las tres gráficas. */
function syncCharts() {
  const panes = [
    { key: 'main', chart: CH.main, el: $('#paneMain') },
    { key: 'vol', chart: CH.vol, el: $('#paneVol') },
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

  for (const p of others) {
    if (p.key === 'main') {
      if (bar) p.chart.setCrosshairPosition(bar.close, t, CH.candles);
      else if (f) p.chart.setCrosshairPosition(f.center, t, CH.coneCenter);
    } else if (p.key === 'vol') {
      p.chart.setCrosshairPosition(bar ? bar.volume : 0, t, CH.volume);
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
  [CH.main, CH.vol, CH.rsi].forEach((c) => c.applyOptions({ timeScale: { timeVisible: intraday, secondsVisible: false } }));
  const minMove = 1 / 10 ** meta.precision;
  const priceFormat = { type: 'price', precision: meta.precision, minMove };
  [CH.candles, CH.ema, CH.sma, CH.coneCenter, CH.coneUpper, CH.coneLower].forEach((s) => s.applyOptions({ priceFormat }));

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
  const show = state.show.cone;
  const future = show ? fc.points.slice(1).map((p) => ({ time: p.time })) : [];

  CH.volume.setData(vis.map((b) => ({ time: b.time, value: b.volume, color: b.close >= b.open ? COLORS.upA : COLORS.downA })).concat(future));
  CH.rsiLine.setData(vis.map((b, i) => (ind.rsi14[ws + i] == null ? { time: b.time } : { time: b.time, value: ind.rsi14[ws + i] })).concat(future));

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
  if (!state.show.sr) return;
  const add = (lvl, title, color) => srLines.push(CH.candles.createPriceLine({
    price: lvl.price, color, lineWidth: 1, lineStyle: LWC.LineStyle.Dashed, axisLabelVisible: true, title,
  }));
  m.sr.resistances.forEach((l, k) => add(l, `R${k + 1}`, k ? 'rgba(229,72,77,0.5)' : 'rgba(229,72,77,0.85)'));
  m.sr.supports.forEach((l, k) => add(l, `S${k + 1}`, k ? 'rgba(22,168,137,0.5)' : 'rgba(22,168,137,0.9)'));
}

function fitAll() {
  // Las tres gráficas comparten el mismo eje temporal, así que el encuadre coincide;
  // en el siguiente frame se copia el rango del principal por si alguna difiere.
  [CH.main, CH.vol, CH.rsi].forEach((c) => c.timeScale().fitContent());
  requestAnimationFrame(() => {
    const r = CH.main.timeScale().getVisibleLogicalRange();
    if (r) [CH.vol, CH.rsi].forEach((c) => c.timeScale().setVisibleLogicalRange(r));
  });
}

/* ---- Leyenda, etiquetas de panel y tooltip ---- */

function renderLegend() {
  const m = state.model;
  $('#legend').innerHTML = `
    <div class="lg-title"><b>${esc(m.meta.symbol)}</b><span>${esc(m.meta.name)} · ${m.tf.key} · ${m.tf.intervalLabel}</span></div>
    <div class="lg-items">
      <span class="lg-item ${state.show.ema ? '' : 'off'}"><i style="background:${COLORS.ema}"></i>EMA 20 <b id="lgEma">—</b></span>
      <span class="lg-item ${state.show.sma ? '' : 'off'}"><i style="background:${COLORS.sma}"></i>SMA 50 <b id="lgSma">—</b></span>
      <span class="lg-item ${state.show.cone ? '' : 'off'}"><i class="dash" style="border-color:${COLORS.aura}"></i>Proyección 3M <b>${fmtPrice(m.fc.end.center, m.meta)}</b></span>
    </div>`;
}

/** Actualiza los valores de leyenda y etiquetas para la vela `i` (o la última). */
function updateReadouts(i) {
  const m = state.model;
  if (!m) return;
  const k = i == null ? m.vis.length - 1 : i;
  const g = (arr) => arr[m.ws + k];
  const emaEl = $('#lgEma'), smaEl = $('#lgSma');
  if (emaEl) emaEl.textContent = fmtNum(g(m.ind.ema20), m.meta.precision);
  if (smaEl) smaEl.textContent = fmtNum(g(m.ind.sma50), m.meta.precision);
  $('#volLabel').innerHTML = `Volumen <b>${fmtCompact(m.vis[k].volume)}</b> · media 20 <b>${fmtCompact(g(m.ind.volSma20))}</b>`;
  $('#rsiLabel').innerHTML = `RSI 14 <b>${fmtNum(g(m.ind.rsi14), 1)}</b> · bandas 30 / 70`;
}

function showTooltip(src, point, i, f) {
  const m = state.model, tt = $('#tooltip');
  const intraday = m.tf.kind === 'intraday';
  const P = (v) => fmtNum(v, m.meta.precision);
  if (i != null) {
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
      <div class="tt-row"><span>RSI 14</span><b>${fmtNum(r, 1)}</b></div>`;
  } else {
    const chg = (f.center / m.fc.P0 - 1) * 100;
    tt.innerHTML = `
      <span class="tt-tag">Proyección IA</span>
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

/* ---- API pública ---- */

/** Pinta un modelo completo (gráficos, leyenda y etiquetas de panel). */
function render(m) {
  hideTooltip();
  renderCharts(m);
  renderLegend();
  updateReadouts(null);
}

/** Aplica un toggle de la barra de herramientas sobre el gráfico ya renderizado. */
function applyToggle(key) {
  const m = state.model;
  if (!m) return;
  if (key === 'ema') CH.ema.applyOptions({ visible: state.show.ema });
  if (key === 'sma') CH.sma.applyOptions({ visible: state.show.sma });
  if (key === 'sr') renderLevels(m);
  if (key === 'cone') { renderForecastLayer(m); fitAll(); }
  renderLegend();
  updateReadouts(null);
}

Aura.charts = { init: initCharts, render, applyToggle, fitAll, hideTooltip };
})();
