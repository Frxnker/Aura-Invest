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
const { charts, panel, controls, settings, store } = Aura;
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

let watchlistLoaded = false;   // ¿se ha cotizado ya la watchlist con la clave actual?

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
  try { history.replaceState(null, '', `#t=${encodeURIComponent(sym)}&tf=${tf}`); } catch (_) { /* file:// restringido */ }
  const stale = () => id !== state.reqId;

  if (!store.getApiKey()) {
    panel.renderHeader(null, sym);
    panel.renderWatchlist(state.watchlist);
    showEmpty({ code: 'NO_KEY' }, sym);
    return;
  }

  document.body.classList.add('is-loading');
  // Cotización del valor en paralelo con las velas. La primera vez (o tras cambiar la
  // clave) va en el mismo lote que la watchlist; después solo se pide la del valor
  // actual, para no gastar un crédito por cada valor de la watchlist en cada cambio.
  const ids = watchlistLoaded ? [sym] : [...new Set([sym, ...state.watchlist])];
  watchlistLoaded = true;
  const quotesP = fetchQuotes(ids, { priority: 2 }).then((q) => { q.forEach((v, k) => state.quotes.set(k, v)); return q; });
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
    panel.renderWatchlist(state.watchlist, state.quotes);
    settings.reportKeyOk();
  } catch (err) {
    if (stale()) return;
    if (!err || !err.code) console.error(err);         // errores de programación; nunca incluyen la clave
    if (err && err.code === 'AUTH') settings.reportKeyError(err);
    showEmpty(err, sym);
    const quotes = await quotesP;
    if (stale()) return;
    panel.renderHeader(quotes.get(sym), sym);
    panel.renderWatchlist(state.watchlist, state.quotes);
  } finally {
    if (!stale()) document.body.classList.remove('is-loading');
  }
}

function selectSymbol(sym) {
  if (sym === state.symbol) return;
  state.symbol = sym;
  load();
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

  charts.init();
  controls.init({ selectTimeframe, selectSymbol });
  settings.init({ onKeyChange: () => { watchlistLoaded = false; state.quotes.clear(); load(); } });
  client.onStatus(onQueueStatus);
  onQueueStatus(client.status());
  if (store.problem) controls.toast(store.problem, 'error');
  setInterval(() => { if (state.view) panel.renderStatus({ ...state.view, queue: state.queue }); }, 30000);
  load();
}

window.addEventListener('error', (e) => controls.toast(`Error: ${e.message}`, 'error'));
init();
})();
