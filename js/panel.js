/* =========================================================================
 * Aura Invest · Vistas: cabecera, panel AI Analytics y watchlist
 * Solo pinta: recibe el modelo ya calculado y actualiza el DOM con animaciones suaves.
 * ========================================================================= */
(() => {
'use strict';

const { REDUCED_MOTION } = Aura.config;
const { TICKERS, fetchQuote } = Aura.data;
const { $, clamp, last, esc, fmtNum, fmtSigned, fmtPct, fmtPrice, fmtCompact, fmtDate, arrow, dirClass } = Aura.utils;
const state = Aura.state;

/** Interpola un número en pantalla (animación suave al actualizar). */
function tween(el, to, format, dur = 750) {
  const from = el._v ?? 0;
  el._v = to;
  cancelAnimationFrame(el._raf);
  if (REDUCED_MOTION || !Number.isFinite(from) || !Number.isFinite(to) || from === to) { el.textContent = format(to); return; }
  const t0 = performance.now();
  const step = (now) => {
    const p = Math.min(1, (now - t0) / dur);
    const e = 1 - (1 - p) ** 3;
    el.textContent = format(from + (to - from) * e);
    if (p < 1) el._raf = requestAnimationFrame(step);
  };
  el._raf = requestAnimationFrame(step);
}

function renderHeader(q) {
  const meta = q.meta;
  const chg = q.price - q.prevClose, pct = (chg / q.prevClose) * 100;
  $('#qSym').textContent = meta.symbol;
  $('#qName').textContent = `${meta.name} · ${meta.exchange}`;
  $('#qName').title = `${meta.name} · ${meta.exchange} · ${meta.currency}`;
  $('#qDate').textContent = fmtDate(q.time).replace(/ \d{4}$/, '');
  const priceEl = $('#qPrice');
  if (priceEl._sym !== meta.symbol) { priceEl._v = q.price; priceEl._sym = meta.symbol; }
  tween(priceEl, q.price, (v) => fmtPrice(v, meta));
  const chgEl = $('#qChg');
  chgEl.className = `quote-chg ${chg >= 0 ? 'up' : 'down'}`;
  chgEl.innerHTML = `${arrow(chg)} <span class="abs">${fmtSigned(chg, meta.precision)} (</span>${fmtPct(pct)}<span class="abs">)</span>`;
  $('#qOpen').textContent = fmtNum(q.open, meta.precision);
  $('#qHigh').textContent = fmtNum(q.high, meta.precision);
  $('#qLow').textContent = fmtNum(q.low, meta.precision);
  $('#qVol').textContent = fmtCompact(q.volume);
  document.title = `${meta.symbol} ${fmtPrice(q.price, meta)} · Aura Invest`;
}

function renderPerf(m) {
  const first = m.vis[0], lastBar = last(m.vis);
  const base = m.bars[m.ws - 1] ? m.bars[m.ws - 1].close : first.open;
  const pct = (lastBar.close / base - 1) * 100;
  $('#perf').innerHTML = `${m.tf.key} <b class="${dirClass(pct)}">${arrow(pct)} ${fmtPct(pct)}</b>`;
}

const RECO = {
  buy:  { text: 'Comprar',  icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7M9 7h8v8"/></svg>' },
  hold: { text: 'Mantener', icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M5 9h14M5 15h14"/></svg>' },
  sell: { text: 'Vender',   icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M7 7l10 10M17 9v8H9"/></svg>' },
};

function renderPanel(m) {
  const { trend, fc, adv, meta, tf } = m;
  const P = (v) => fmtPrice(v, meta);
  $('#aiContext').textContent = `${meta.symbol} · ${tf.key} · ${tf.intervalLabel} · ${m.vis.length} velas`;

  // 1. Probabilidad de tendencia
  const rows = [['Bull', trend.probs.bull], ['Neu', trend.probs.neutral], ['Bear', trend.probs.bear]];
  rows.forEach(([k, v]) => {
    $(`#p${k}Bar`).style.width = `${v}%`;
    tween($(`#p${k}Val`), v, (x) => `${Math.round(x)}%`);
  });
  const badge = $('#confBadge');
  badge.dataset.level = trend.level;
  badge.title = `Confianza del modelo: ${fmtNum(trend.conf * 100, 0)}/100`;
  $('#confText').textContent = trend.level;
  $('#scoreDot').style.left = `${((clamp(trend.score, -1, 1) + 1) / 2) * 100}%`;
  tween($('#scoreVal'), trend.score, (x) => fmtSigned(x, 2));
  $('#factorRows').innerHTML = trend.factors.map((f) => {
    const c = f.weight * f.score;
    return `<tr><td>${f.label}</td><td class="num">${esc(f.reading)}</td><td class="num">${fmtNum(f.weight * 100, 0)}%</td>
      <td class="num ${Math.abs(c) < 0.005 ? '' : dirClass(c)}">${fmtSigned(c, 2)}</td></tr>`;
  }).join('');

  // 2. Proyección predictiva
  const up = $('#upsideVal');
  up.className = `upside-val ${dirClass(fc.upside)}`;
  tween(up, fc.upside, (x) => `${arrow(x)} ${fmtPct(x, 1)}`);
  const lo = fc.end.lower, hi = fc.end.upper;
  const pos = (v) => `${clamp((v - lo) / (hi - lo), 0, 1) * 100}%`;
  $('#rgNow').style.left = pos(fc.P0);
  $('#rgMid').style.left = pos(fc.end.center);
  $('#rgLo').textContent = P(lo);
  $('#rgHi').textContent = P(hi);
  $('#fcNow').textContent = P(fc.P0);
  $('#fcMid').textContent = P(fc.end.center);
  $('#fcRange').textContent = `${P(lo)} – ${P(hi)}`;
  $('#fcVol').textContent = fmtPct(fc.sigmaAnnual * 100, 1).replace('+', '');
  $('#fcDrift').textContent = fmtPct(fc.muAnnual * 100, 1);
  $('#fcDate').textContent = fmtDate(fc.horizonT);

  // 3. AI Advisory
  const reco = $('#reco');
  reco.dataset.action = adv.action;
  $('#recoIcon').innerHTML = RECO[adv.action].icon;
  $('#recoText').textContent = RECO[adv.action].text;
  $('#recoTf').textContent = `${tf.key} · ${tf.intervalLabel}`;
  $('#rrTag').textContent = `R/B 1 : ${fmtNum(adv.rr, 1)}`;
  const rel = (v) => (v / fc.P0 - 1) * 100;
  $('#lvEntry').textContent = P(adv.entry);
  $('#lvEntrySub').textContent = adv.entryBasis === 'precio actual' ? 'a mercado' : fmtPct(rel(adv.entry));
  $('#lvTarget').textContent = P(adv.target);
  $('#lvTargetSub').innerHTML = `<span class="${dirClass(adv.target - adv.entry)}">${fmtPct((adv.target / adv.entry - 1) * 100)}</span>`;
  $('#lvStop').textContent = P(adv.stop);
  $('#lvStopSub').innerHTML = `<span class="${dirClass(adv.stop - adv.entry)}">${fmtPct((adv.stop / adv.entry - 1) * 100)}</span>`;
  $('#rationale').innerHTML = m.rationale.map((s) => `<li>${s}</li>`).join('');

  // Animación escalonada de las tarjetas
  ['#cardTrend', '#cardForecast', '#cardAdvisory'].forEach((sel, k) => {
    const el = $(sel);
    el.classList.remove('refresh');
    void el.offsetWidth;                             // reinicia la animación CSS
    el.style.animationDelay = `${k * 80}ms`;
    el.classList.add('refresh');
  });
}

/* ---- Watchlist ---- */
async function renderWatchlist() {
  const syms = Object.keys(TICKERS);
  if (!TICKERS[state.symbol]) syms.push(state.symbol);
  const quotes = await Promise.all(syms.map((s) => fetchQuote(s)));
  $('#watchlist').innerHTML = quotes.map((q) => {
    const pct = (q.price / q.prevClose - 1) * 100;
    return `<button class="wl-chip" data-sym="${esc(q.meta.symbol)}" aria-pressed="${q.meta.symbol === state.symbol}">
      <span class="s">${esc(q.meta.symbol)}</span><span class="p">${fmtPrice(q.price, q.meta)}</span>
      <span class="c ${dirClass(pct)}">${arrow(pct)} ${fmtPct(pct)}</span></button>`;
  }).join('');
  state.quotes = Object.fromEntries(quotes.map((q) => [q.meta.symbol, q]));
}

Aura.panel = { renderHeader, renderPerf, renderPanel, renderWatchlist };
})();
