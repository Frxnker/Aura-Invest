/* =========================================================================
 * Aura Invest · Arranque y ciclo de carga
 * datos reales → indicadores/modelo → gráficos → panel, cada vez que cambia el
 * valor o la temporalidad. Sin clave, o si la API falla, se muestra un estado
 * vacío con el motivo: nunca precios inventados.
 * ========================================================================= */
(() => {
'use strict';

const { LWC, TIMEFRAMES, API } = Aura.config;
const { fetchMarketData, fetchQuotes } = Aura.data;
const { $, fmtLocalTime } = Aura.utils;
const { analyze } = Aura.model;
const { charts, panel, controls, settings, store, watchlist, monitor, watchlistUI, alertsUI, portfolioUI, compareUI } = Aura;
const { client } = Aura.api;
const state = Aura.state;

/* ---- Mensajes de error comprensibles ---- */

function describeError(err, id) {
  const openSettings = { label: 'Abrir ajustes', onClick: () => settings.open(), primary: true };
  const retry = { label: 'Reintentar', onClick: () => load(), primary: true };
  const api = (err && err.apiMessage) || '';
  const nextReset = Math.ceil((Date.now() + 1) / 86400000) * 86400000;
  switch (err && err.code) {
    case 'NO_KEY':
      return { title: 'Conecta tus datos de mercado',
        detail: 'Aura Invest solo muestra precios reales de Twelve Data. Añade tu clave gratuita en Ajustes para empezar.',
        actions: [openSettings] };
    case 'AUTH':
      return { title: 'La clave de API no es válida',
        detail: 'Twelve Data ha rechazado la clave guardada. Revísala o pega otra en Ajustes.',
        apiMessage: api, actions: [openSettings] };
    case 'PLAN':
      return { title: `${id} no está incluido en el plan gratuito`,
        detail: `${err.message} El plan Basic cubre acciones de EE. UU., forex y cripto; prueba otra cotización del mismo valor (por ejemplo, un ADR en NYSE).`,
        apiMessage: api,
        actions: [{ label: 'Buscar alternativas', primary: true, onClick: () => controls.searchFor(id.split(':')[0]) }] };
    case 'NOT_FOUND':
      return { title: `Sin datos para ${id}`, detail: err.message, apiMessage: api,
        actions: [{ label: 'Buscar otro valor', primary: true, onClick: () => controls.searchFor('') }] };
    case 'DAILY_LIMIT':
      return { title: 'Cupo diario agotado',
        detail: `Se han usado los ${API.perDay} créditos de hoy. Se asume que el cupo se reinicia a las 00:00 UTC (las ${fmtLocalTime(nextReset)} en tu hora local). No se reintentará hasta entonces.`,
        apiMessage: api, actions: [] };
    case 'MINUTE_LIMIT':
      return { title: 'Límite por minuto alcanzado',
        detail: 'Twelve Data sigue rechazando peticiones tras esperar un minuto (¿usas la misma clave en otro sitio?). Vuelve a intentarlo en un momento.',
        apiMessage: api, actions: [retry] };
    case 'NETWORK':
      return { title: 'Sin conexión con Twelve Data', detail: 'Comprueba la conexión a internet y vuelve a intentarlo.', actions: [retry] };
    case 'SERVER':
    case 'BAD_REQUEST':
      return { title: 'Twelve Data no ha podido responder', detail: err.message, apiMessage: api, actions: [retry] };
    default:
      return { title: 'Error inesperado', detail: String((err && err.message) || err), actions: [retry] };
  }
}

/* ---- Ciclo de carga ---- */

function showEmpty(err, id) {
  state.model = null;
  state.view = null;
  charts.clear();
  panel.renderEmpty(describeError(err, id));
  panel.renderStatus({ queue: state.queue });
}

async function load() {
  const id = ++state.reqId;
  const sym = state.symbol, tf = state.tf;
  updateHash();
  const stale = () => id !== state.reqId;

  watchlistUI.updateStar();
  if (!store.getApiKey()) {
    panel.renderHeader(null, sym);
    panel.renderWatchlist(watchlist.items());
    showEmpty({ code: 'NO_KEY' }, sym);
    return;
  }

  document.body.classList.add('is-loading');
  // Cotización del valor en paralelo con las velas (la de la watchlist la lleva el
  // monitor en lote; si es reciente, sale de la caché y no gasta créditos).
  const quotesP = fetchQuotes([sym], { priority: 2 }).then((q) => { q.forEach((v, k) => state.quotes.set(k, v)); return q; });
  try {
    const data = await fetchMarketData(sym, tf, { priority: 3 });
    const quotes = await quotesP;
    if (stale()) return;
    const quote = quotes.get(sym);
    if (quote && !(quote instanceof Error)) data.meta.name = quote.meta.name;
    const m = analyze(data, tf);
    state.model = m;
    state.view = { data, quote };
    panel.hideEmpty();
    panel.renderHeader(quote, sym);
    charts.render(m);
    panel.renderPerf(m);
    panel.renderPanel(m);
    panel.renderStatus({ data, quote, queue: state.queue });
    if (state.compare.length) loadCompare();
    if (quote && !(quote instanceof Error)) watchlist.learn(sym, quote.meta);
    panel.renderWatchlist(watchlist.items(), state.quotes);
    settings.reportKeyOk();
  } catch (err) {
    if (stale()) return;
    if (!err || !err.code) console.error(err);         // errores de programación; nunca incluyen la clave
    if (err && err.code === 'AUTH') settings.reportKeyError(err);
    showEmpty(err, sym);
    const quotes = await quotesP;
    if (stale()) return;
    panel.renderHeader(quotes.get(sym), sym);
    panel.renderWatchlist(watchlist.items(), state.quotes);
  } finally {
    if (!stale()) document.body.classList.remove('is-loading');
  }
}

function selectSymbol(sym) {
  if (state.page !== 'market') selectView('market');
  if (sym === state.symbol) return;
  state.symbol = sym;
  Aura.drawingTools.reset();
  if (state.compare.includes(sym)) { state.compare = state.compare.filter((x) => x !== sym); compareUI.render(); }
  load();
}

/** Comparar: pide las velas de cada valor en la temporalidad actual y las superpone. */
async function loadCompare() {
  const m = state.model;
  if (!m) { compareUI.render([]); return; }
  if (!state.compare.length) { compareUI.render(charts.renderCompare(m, [])); return; }
  const ids = [...state.compare];
  compareUI.render([]);
  const others = await Promise.all(ids.map((id) => fetchMarketData(id, state.tf, { priority: 2 })
    .then((data) => ({ id, data }), (error) => ({ id, error }))));
  if (state.model !== m || ids.join() !== state.compare.join()) return;   // algo cambió mientras tanto
  compareUI.render(charts.renderCompare(m, others));
}

/* ---- Vistas: Mercado / Cartera ---- */

/** Enlace directo: #t=AAPL&tf=6M (&view=cartera). Nunca lleva la clave. */
function updateHash() {
  const view = state.page === 'portfolio' ? '&view=cartera' : '';
  try { history.replaceState(null, '', `#t=${encodeURIComponent(state.symbol)}&tf=${state.tf}${view}`); } catch (_) { /* file:// restringido */ }
}

function selectView(page, { focus = false } = {}) {
  state.page = page;
  const market = page === 'market';
  $('#viewMarket').hidden = !market;
  $('#viewPortfolio').hidden = market;
  for (const [tab, on] of [['#tabMarket', market], ['#tabPortfolio', !market]]) {
    $(tab).setAttribute('aria-selected', String(on));
    $(tab).tabIndex = on ? 0 : -1;
  }
  updateHash();
  if (!market) portfolioUI.refresh();
  if (focus) $(market ? '#tabMarket' : '#tabPortfolio').focus();
}

function initViews() {
  $('#tabMarket').addEventListener('click', () => selectView('market'));
  $('#tabPortfolio').addEventListener('click', () => selectView('portfolio'));
  $('.views').addEventListener('keydown', (e) => {
    const map = { ArrowLeft: 'market', Home: 'market', ArrowRight: 'portfolio', End: 'portfolio' };
    if (!map[e.key]) return;
    e.preventDefault();
    selectView(map[e.key], { focus: true });
  });
}

function selectTimeframe(tf) {
  state.tf = tf;
  load();
}

/* ---- Estado de la cola: contador y cuenta atrás mientras se espera cupo ---- */

let countdown = null;
function onQueueStatus(s) {
  state.queue = s;
  panel.renderUsage(s);
  settings.renderUsage(s);
  const rerender = () => panel.renderStatus({ ...(state.view || {}), queue: state.queue });
  rerender();
  if (s.waitingUntil > Date.now() && !countdown) {
    countdown = setInterval(() => {
      rerender();
      if (!(state.queue.waitingUntil > Date.now())) { clearInterval(countdown); countdown = null; rerender(); }
    }, 1000);
  }
}

/* ---- Watchlist, vigilancia y alertas ---- */

let monitorStatus = null;

function scheduleText() {
  const s = monitorStatus;
  if (!s) return '';
  if (s.running) return 'Comprobando ahora…';
  if (s.reason === 'nokey') return 'Sin clave de API: las alertas no se comprueban.';
  if (s.reason === 'budget') return 'Comprobación automática en pausa: el cupo de hoy está casi agotado.';
  if (s.reason === 'off') return 'Comprobación automática desactivada en Ajustes: las alertas se comprueban al abrir la app o con «Comprobar ahora».';
  if (!s.nextAt) return '';
  return `Última comprobación: ${s.lastRun ? fmtLocalTime(s.lastRun) : '—'}. Próxima automática a las ${fmtLocalTime(s.nextAt)} (cada ${Math.round(s.delay / 60000)} min, según el cupo del plan).`;
}

/** Nombre, bolsa y divisa del valor que se está viendo (para añadirlo a la watchlist). */
function metaFor(id) {
  const q = state.quotes.get(id);
  if (q && !(q instanceof Error) && q.meta) return { name: q.meta.name, exchange: q.meta.exchange, currency: q.meta.currency };
  const info = Aura.data.knownInstrument(id);
  return info ? { name: info.name, exchange: info.exchange, currency: info.currency } : {};
}

function wireMonitor() {
  monitor.onQuotes((quotes) => {
    quotes.forEach((q, id) => {
      state.quotes.set(id, q);
      if (q && !(q instanceof Error) && q.meta) watchlist.learn(id, q.meta);
    });
    panel.renderWatchlist(watchlist.items(), state.quotes);
    // Cotización más reciente del valor que se está viendo
    const cur = quotes.get(state.symbol);
    if (state.view && cur && !(cur instanceof Error)) {
      state.view.quote = cur;
      panel.renderHeader(cur, state.symbol);
      panel.renderStatus({ ...state.view, queue: state.queue });
    }
  });
  monitor.onStatus((s) => {
    monitorStatus = s;
    watchlistUI.renderSchedule(s);
    if ($('#alertsDialog').open) $('#alSchedule').textContent = scheduleText();
  });
  monitor.onFired((ev) => alertsUI.announce(ev));

  watchlist.onChange((items) => {
    panel.renderWatchlist(items, state.quotes);
    watchlistUI.updateStar();
    const missing = items.map((w) => w.id).filter((id) => !state.quotes.has(id));
    if (missing.length) monitor.refreshIds(missing);
    monitor.reschedule();
  });
}

function init() {
  if (!LWC) {
    $('#chartStack').insertAdjacentHTML('beforeend',
      '<div class="chart-error">No se pudo cargar Lightweight Charts desde el CDN.<br>Comprueba la conexión y recarga la página.</div>');
    return;
  }
  // Enlace directo opcional: index.html#t=NVDA&tf=1A (nunca lleva la clave)
  const params = new URLSearchParams(location.hash.slice(1));
  const t = (params.get('t') || '').toUpperCase();
  if (/^[A-Z0-9.\-/:]{1,24}$/.test(t)) state.symbol = t;
  if (TIMEFRAMES[params.get('tf')]) state.tf = params.get('tf');
  const startView = params.get('view') === 'cartera' ? 'portfolio' : 'market';

  charts.init();
  controls.init({ selectTimeframe, selectSymbol });
  watchlistUI.init({ refresh: () => monitor.runCheck({ force: true }), metaFor });
  alertsUI.init({ checkNow: () => monitor.runCheck({ force: true }), evaluateCached: () => monitor.checkAlertsQuick(), scheduleText });
  portfolioUI.init({ openSymbol: selectSymbol });
  compareUI.init({ onChange: loadCompare });
  Aura.drawingTools.init();
  Aura.backtestUI.init();
  initViews();
  wireMonitor();
  settings.init({
    onKeyChange: () => { state.quotes.clear(); load().then(() => monitor.runCheck()); },
    onRefreshChange: () => monitor.reschedule(),
  });
  client.onStatus(onQueueStatus);
  onQueueStatus(client.status());
  if (store.problem) controls.toast(store.problem, 'error');
  setInterval(() => { if (state.view) panel.renderStatus({ ...state.view, queue: state.queue }); }, 30000);
  panel.renderWatchlist(watchlist.items());
  // Primero el valor que se ve; después, la watchlist y las alertas (en lote)
  load().finally(() => monitor.start());
  if (startView === 'portfolio') selectView('portfolio');
}

window.addEventListener('error', (e) => controls.toast(`Error: ${e.message}`, 'error'));
init();
})();
