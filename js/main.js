/* =========================================================================
 * Aura Invest · Arranque y ciclo de carga
 * datos → indicadores/modelo → gráficos → panel, cada vez que cambia ticker o temporalidad.
 * ========================================================================= */
(() => {
'use strict';

const { LWC, TIMEFRAMES } = Aura.config;
const { TICKERS, fetchMarketData, fetchQuote } = Aura.data;
const { $ } = Aura.utils;
const { analyze } = Aura.model;
const { charts, panel, controls } = Aura;
const state = Aura.state;

/** Ciclo completo: datos → indicadores/modelo → gráficos → panel. */
async function load() {
  const id = ++state.reqId;
  document.body.classList.add('is-loading');
  try { history.replaceState(null, '', `#t=${encodeURIComponent(state.symbol)}&tf=${state.tf}`); } catch (_) { /* file:// restringido */ }
  try {
    const [data, quote] = await Promise.all([fetchMarketData(state.symbol, state.tf), fetchQuote(state.symbol)]);
    if (id !== state.reqId) return;                    // descarta respuestas obsoletas
    if (!data.bars || data.bars.length < 30) throw new Error('histórico insuficiente');
    const m = analyze(data, state.tf);
    state.model = m;
    panel.renderHeader(quote);
    charts.render(m);
    panel.renderPerf(m);
    panel.renderPanel(m);
    panel.renderWatchlist();
  } catch (err) {
    console.error(err);
    controls.toast(`No se pudieron cargar los datos de ${state.symbol}: ${err.message}`, 'error');
  } finally {
    if (id === state.reqId) document.body.classList.remove('is-loading');
  }
}

function selectSymbol(sym) {
  if (sym === state.symbol) return;
  state.symbol = sym;
  if (!TICKERS[sym]) controls.toast(`${sym} no está en el universo de ejemplo: se simula con parámetros genéricos.`);
  load();
}

function selectTimeframe(tf) {
  state.tf = tf;
  load();
}

function init() {
  if (!LWC) {
    $('#chartStack').insertAdjacentHTML('beforeend',
      '<div class="chart-error">No se pudo cargar Lightweight Charts desde el CDN.<br>Comprueba la conexión y recarga la página.</div>');
    return;
  }
  // Enlace directo opcional: index.html#t=NVDA&tf=1A
  const params = new URLSearchParams(location.hash.slice(1));
  const t = (params.get('t') || '').toUpperCase();
  if (/^[A-Z0-9.\-]{1,12}$/.test(t)) state.symbol = t;
  if (TIMEFRAMES[params.get('tf')]) state.tf = params.get('tf');

  charts.init();
  controls.init({ selectTimeframe, selectSymbol });
  load();
}

window.addEventListener('error', (e) => controls.toast(`Error: ${e.message}`, 'error'));
init();
})();
