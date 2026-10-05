/* =========================================================================
 * Aura Invest · Vistas: cabecera, estado de los datos, panel de análisis del modelo,
 * watchlist y estado vacío.
 * Solo pinta: recibe datos ya obtenidos y actualiza el DOM. Todo texto que venga
 * de la API se inserta con textContent o pasa por `esc`.
 * ========================================================================= */
(() => {
'use strict';

const { REDUCED_MOTION, API } = Aura.config;
const { $, clamp, last, esc, fmtNum, fmtSigned, fmtPct, fmtPrice, fmtCompact, fmtDate, arrow, dirClass,
  fmtLocalTime, fmtLocalDateTime, fmtAgo } = Aura.utils;
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

const isQuote = (q) => q && !(q instanceof Error) && Number.isFinite(q.price);

/* ---- Cabecera ---- */

/** Pinta la cotización; sin cotización válida, solo el identificador y guiones. */
function renderHeader(q, id) {
  const ok = isQuote(q);
  const priceEl = $('#qPrice');
  $('#qSym').textContent = ok ? q.meta.symbol : id;
  $('#qName').textContent = ok ? `${q.meta.name} · ${q.meta.exchange}` : '';
  $('#qName').title = ok ? `${q.meta.name} · ${q.meta.exchange} · ${q.meta.currency}` : '';
  $('#qDate').textContent = ok && Number.isFinite(q.time) ? fmtDate(q.time).replace(/ \d{4}$/, '') : '—';
  const chgEl = $('#qChg');
  if (!ok) {
    priceEl.textContent = '—'; priceEl._v = undefined; priceEl._sym = null;
    chgEl.className = 'quote-chg';
    chgEl.textContent = '—';
    ['#qOpen', '#qHigh', '#qLow', '#qVol'].forEach((s) => { $(s).textContent = '—'; });
    document.title = `${id} · Aura Invest`;
    return;
  }
  const meta = q.meta;
  const chg = q.price - q.prevClose, pct = (chg / q.prevClose) * 100;
  if (priceEl._sym !== meta.symbol) { priceEl._v = q.price; priceEl._sym = meta.symbol; }
  tween(priceEl, q.price, (v) => fmtPrice(v, meta));
  chgEl.className = `quote-chg ${chg >= 0 ? 'up' : 'down'}`;
  chgEl.innerHTML = `${arrow(chg)} <span class="abs">${fmtSigned(chg, meta.precision)} (</span>${fmtPct(pct)}<span class="abs">)</span>`;
  $('#qOpen').textContent = fmtNum(q.open, meta.precision);
  $('#qHigh').textContent = fmtNum(q.high, meta.precision);
  $('#qLow').textContent = fmtNum(q.low, meta.precision);
  $('#qVol').textContent = fmtCompact(q.volume);
  document.title = `${meta.symbol} ${fmtPrice(q.price, meta)} · Aura Invest`;
}

function renderPerf(m) {
  if (!m) { $('#perf').textContent = ''; return; }
  const first = m.vis[0], lastBar = last(m.vis);
  const base = m.bars[m.ws - 1] ? m.bars[m.ws - 1].close : first.open;
  const pct = (lastBar.close / base - 1) * 100;
  $('#perf').innerHTML = `${m.tf.key} <b class="${dirClass(pct)}">${arrow(pct)} ${fmtPct(pct)}</b>`;
}

/* ---- Estado de los datos: fuente, actualización, mercado y retraso ---- */

const STALE_MS = 5 * 60 * 1000;      // con el mercado abierto, una cotización más antigua puede ir con retraso
const INTERVAL_TEXT = { '5min': 'de 5 min', '15min': 'de 15 min', '1h': 'horarias', '1day': 'diarias', '1week': 'semanales' };

/**
 * @param {object} o
 * @param {object} [o.data]   resultado de fetchMarketData (source.at, source.cached)
 * @param {object} [o.quote]  cotización (o ApiError)
 * @param {object} [o.queue]  estado de la cola de la API (espera de cupo)
 */
function renderStatus({ data, quote, queue } = {}) {
  const now = Date.now();
  const items = [];
  const item = (html, cls = '') => items.push(`<span class="st-item ${cls}">${html}</span>`);

  if (queue && queue.waitingUntil > now) {
    const s = Math.ceil((queue.waitingUntil - now) / 1000);
    item(`Esperando cupo de la API (${API.perMinute} créditos/min): <b>${s} s</b>`, 'st-warn');
  }
  if (data && data.source.stale) {
    item(`Datos antiguos: velas de ${fmtAgo(data.source.at, now)}; no se pudieron actualizar (${esc(data.source.error ? data.source.error.message : 'error')})`, 'st-warn');
  }
  if (data) {
    item(`Fuente: <b>${esc(data.source.provider)}</b>`);
    item(`Velas ${INTERVAL_TEXT[data.source.interval] || esc(data.source.interval)} obtenidas a las <b>${fmtLocalTime(data.source.at)}</b> (${data.source.cached ? 'de la caché, ' : ''}${fmtAgo(data.source.at, now)})`);
    if (data.meta.session) {
      // Intradía: en qué hora están las velas (acciones: la de su bolsa; forex y cripto: la del usuario)
      const city = (data.meta.timezone || '').split('/').pop().replace(/_/g, ' ');
      item(data.meta.timeBasis === 'local' ? 'Horas del gráfico: <b>tu hora local</b>' : `Horas del gráfico: <b>hora de la bolsa</b>${city ? ` (${esc(city)})` : ''}`);
    }
    if (data.meta.session && !data.meta.sessionExact) item('Horario de sesión aproximado (velas de 1 h)');
  }
  if (isQuote(quote)) {
    item(`<span class="st-dot ${quote.isMarketOpen ? 'open' : ''}" aria-hidden="true"></span><b>${quote.isMarketOpen ? 'Mercado abierto' : 'Mercado cerrado'}</b>`);
    item(`Última cotización: <b>${fmtLocalDateTime(quote.lastQuoteAt)}</b> (hora local)`);
    if (quote.stale) {
      item(`Cotización antigua (${fmtAgo(quote.at, now)}): no se pudo actualizar (${esc(quote.error ? quote.error.message : 'error')})`, 'st-warn');
    } else if (quote.isMarketOpen && now - quote.lastQuoteAt > STALE_MS) {
      item(`Puede ir con retraso: la última cotización es de ${fmtAgo(quote.lastQuoteAt, now)}`, 'st-warn');
    } else if (quote.cached) {
      item(`Cotización de ${fmtAgo(quote.at, now)} (caché de 1 min)`);
    }
  } else if (quote instanceof Error && data) {
    item(`Sin cotización: ${esc(quote.message)}`, 'st-warn');
  }
  $('#statusBar').innerHTML = items.join('');
}

/* ---- Estado vacío ---- */

/**
 * Sustituye gráficos y panel por un mensaje con el motivo.
 * @param {object} o  title, detail, apiMessage (texto de Twelve Data), actions [{ label, onClick, primary }]
 */
function renderEmpty({ title, detail, apiMessage = '', actions = [] }) {
  $('#emptyTitle').textContent = title;
  $('#emptyDetail').textContent = detail;
  const api = $('#emptyApi');
  api.hidden = !apiMessage;
  api.textContent = apiMessage ? `Twelve Data: ${apiMessage}` : '';
  const box = $('#emptyActions');
  box.textContent = '';
  for (const a of actions) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `btn ${a.primary ? 'primary' : ''}`;
    b.textContent = a.label;
    b.addEventListener('click', a.onClick);
    box.appendChild(b);
  }
  $('#emptyState').hidden = false;
  $('#aiPanel').classList.add('is-empty');
  $('#aiEmpty').hidden = false;
  $('#aiContext').textContent = '';
  renderPerf(null);
}

function hideEmpty() {
  $('#emptyState').hidden = true;
  $('#aiPanel').classList.remove('is-empty');
  $('#aiEmpty').hidden = true;
}

/* ---- Contador de créditos ---- */

function renderUsage(s) {
  const pill = $('#usagePill');
  $('#usageText').textContent = `${s.creditsToday}/${s.perDay}`;
  pill.dataset.level = s.creditsToday >= s.perDay ? 'full' : s.creditsToday >= s.perDay * 0.8 ? 'warn' : '';
  pill.setAttribute('aria-label', `Créditos de Twelve Data usados hoy: ${s.creditsToday} de ${s.perDay}. Abrir ajustes`);
}

/* ---- Panel de análisis del modelo ---- */

const RECO = {
  buy:  { text: 'Alcista',  icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7M9 7h8v8"/></svg>' },
  hold: { text: 'Neutral',  icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M5 9h14M5 15h14"/></svg>' },
  sell: { text: 'Bajista',  icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M7 7l10 10M17 9v8H9"/></svg>' },
};

const CONF_TEXT = { High: 'Alta', Medium: 'Media', Low: 'Baja' };

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
  $('#confText').textContent = CONF_TEXT[trend.level];
  $('#scoreDot').style.left = `${((clamp(trend.score, -1, 1) + 1) / 2) * 100}%`;
  tween($('#scoreVal'), trend.score, (x) => fmtSigned(x, 2));
  $('#factorRows').innerHTML = trend.factors.map((f) => {
    const c = f.weight * f.score;
    return `<tr><td>${esc(f.label)}</td><td class="num">${esc(f.reading)}</td><td class="num">${fmtNum(f.weight * 100, 0)}%</td>
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

  // 3. Señal del modelo
  const reco = $('#reco');
  reco.dataset.action = adv.action;
  $('#recoIcon').innerHTML = RECO[adv.action].icon;
  $('#recoText').textContent = RECO[adv.action].text;
  $('#recoTf').textContent = `${tf.key} · ${tf.intervalLabel}`;
  const rel = (v) => (v / fc.P0 - 1) * 100;
  // Bajista no propone operación en corto: en lugar de entrada/objetivo/stop, el nivel a vigilar
  const sell = adv.action === 'sell';
  $('#rrTag').textContent = sell ? 'Sin operación' : `R/B 1 : ${fmtNum(adv.rr, 1)}`;
  $('#levels').hidden = sell;
  $('#lvWatchBox').hidden = !sell;
  if (sell) {
    const has = adv.watch != null;
    $('#lvWatch').textContent = has ? P(adv.watch) : '—';
    $('#lvWatchSub').innerHTML = has
      ? `<span class="${dirClass(adv.watch - fc.P0)}">${fmtPct(rel(adv.watch))}</span> · ${esc(adv.watchBasis)}`
      : 'sin soporte por debajo';
  } else {
    $('#lvEntry').textContent = P(adv.entry);
    $('#lvEntrySub').textContent = adv.entryBasis === 'precio actual' ? 'a mercado' : fmtPct(rel(adv.entry));
    $('#lvTarget').textContent = P(adv.target);
    $('#lvTargetSub').innerHTML = `<span class="${dirClass(adv.target - adv.entry)}">${fmtPct((adv.target / adv.entry - 1) * 100)}</span>`;
    $('#lvStop').textContent = P(adv.stop);
    $('#lvStopSub').innerHTML = `<span class="${dirClass(adv.stop - adv.entry)}">${fmtPct((adv.stop / adv.entry - 1) * 100)}</span>`;
  }
  // Las frases del modelo llevan <b> propios; los valores que contienen son números
  // formateados y divisas validadas en la capa de datos.
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

const QUOTE_STATE = {
  PLAN: 'Fuera del plan',
  AUTH: 'Clave rechazada',
  NO_KEY: 'Sin clave',
  DAILY_LIMIT: 'Sin cupo hoy',
  NOT_FOUND: 'Sin datos',
};

/**
 * @param {object[]} items    watchlist guardada [{ id, name, exchange }] en su orden
 * @param {Map} [quotes]      id → cotización | ApiError (sin cotizaciones: solo los nombres)
 */
function renderWatchlist(items, quotes = new Map()) {
  if (!items.length) {
    $('#watchlist').innerHTML = '<span class="wl-empty">Watchlist vacía: añade valores desde el buscador o con la estrella.</span>';
    return;
  }
  $('#watchlist').innerHTML = items.map(({ id, name }) => {
    const q = quotes.get(id);
    const pressed = id === state.symbol;
    const title = name ? ` title="${esc(name)}"` : '';
    if (isQuote(q)) {
      const pct = (q.price / q.prevClose - 1) * 100;
      const old = q.stale ? `, dato antiguo de ${fmtAgo(q.at)}` : '';
      const label = `${q.meta.symbol}, ${fmtPrice(q.price, q.meta)}, ${fmtPct(pct)} hoy${old}`;
      return `<button class="wl-chip${q.stale ? ' is-stale' : ''}" data-sym="${esc(id)}" aria-pressed="${pressed}" aria-label="${esc(label)}"${title}>
        <span class="s">${esc(id)}</span><span class="p">${esc(fmtPrice(q.price, q.meta))}</span>
        <span class="c ${dirClass(pct)}">${arrow(pct)} ${fmtPct(pct)}</span>${q.stale ? '<span class="old" aria-hidden="true">antiguo</span>' : ''}</button>`;
    }
    const why = q instanceof Error ? (QUOTE_STATE[q.code] || 'Error') : '—';
    return `<button class="wl-chip" data-sym="${esc(id)}" data-state="error" aria-pressed="${pressed}" aria-label="${esc(`${id}: ${why}`)}"
      title="${esc(q instanceof Error ? q.message : name || id)}">
      <span class="s">${esc(id)}</span><span class="c muted">${esc(why)}</span></button>`;
  }).join('');
}

Aura.panel = { renderHeader, renderPerf, renderPanel, renderWatchlist, renderStatus, renderEmpty, hideEmpty, renderUsage };
})();
