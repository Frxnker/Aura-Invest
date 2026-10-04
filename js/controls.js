/* =========================================================================
 * Aura Invest · Controles e interacción
 * Temporalidad, toggles de indicadores, buscador de tickers, watchlist y avisos.
 * ========================================================================= */
(() => {
'use strict';

const { TIMEFRAMES } = Aura.config;
const { TICKERS } = Aura.data;
const { $, clamp, esc, fmtPct, dirClass } = Aura.utils;
const charts = Aura.charts;
const state = Aura.state;

/* ---- Buscador de tickers ---- */
function initSearch(selectSymbol) {
  const input = $('#tickerInput'), list = $('#suggest');
  let items = [], active = 0;

  const open = (v) => { list.classList.toggle('open', v); input.setAttribute('aria-expanded', String(v)); };
  const build = () => {
    const q = input.value.trim().toUpperCase();
    items = Object.values(TICKERS).filter((t) => !q || t.symbol.includes(q) || t.name.toUpperCase().includes(q));
    if (q && !TICKERS[q] && /^[A-Z0-9.\-]{1,12}$/.test(q)) items.push({ symbol: q, name: 'Simular ticker con parámetros genéricos', custom: true });
    active = clamp(active, 0, Math.max(0, items.length - 1));
    list.innerHTML = items.length ? items.map((t, k) => {
      const qt = state.quotes && state.quotes[t.symbol];
      const pct = qt ? (qt.price / qt.prevClose - 1) * 100 : null;
      return `<li role="option" id="opt-${k}" data-sym="${esc(t.symbol)}" aria-selected="${k === active}">
        <span class="s-sym">${esc(t.symbol)}</span><span class="s-name">${esc(t.name)}</span>
        <span class="s-chg ${pct == null ? 'muted' : dirClass(pct)}">${pct == null ? '' : fmtPct(pct)}</span></li>`;
    }).join('') : '<li class="muted" aria-disabled="true">Sin resultados</li>';
    input.setAttribute('aria-activedescendant', items.length ? `opt-${active}` : '');
  };
  const choose = (sym) => { input.value = ''; open(false); input.blur(); selectSymbol(sym); };

  input.addEventListener('focus', () => { active = 0; build(); open(true); });
  input.addEventListener('input', () => { active = 0; build(); open(true); });
  input.addEventListener('blur', () => setTimeout(() => open(false), 120));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { active = Math.min(items.length - 1, active + 1); build(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { active = Math.max(0, active - 1); build(); e.preventDefault(); }
    else if (e.key === 'Enter' && items[active]) { choose(items[active].symbol); }
    else if (e.key === 'Escape') { open(false); input.blur(); }
  });
  list.addEventListener('mousedown', (e) => {
    const li = e.target.closest('li[data-sym]');
    if (li) { e.preventDefault(); choose(li.dataset.sym); }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement !== input) { e.preventDefault(); input.focus(); }
  });
}

/* ---- Barra de herramientas y watchlist ---- */
function initToolbar(selectTimeframe, selectSymbol) {
  $('#tfSeg').innerHTML = Object.keys(TIMEFRAMES).map((k) => `<button data-tf="${k}" aria-pressed="${k === state.tf}">${k}</button>`).join('');
  $('#tfSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tf]');
    if (!b || b.dataset.tf === state.tf) return;
    document.querySelectorAll('#tfSeg button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    selectTimeframe(b.dataset.tf);
  });

  document.querySelectorAll('.tg[data-toggle]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const k = btn.dataset.toggle;
      state.show[k] = !state.show[k];
      btn.setAttribute('aria-pressed', String(state.show[k]));
      charts.applyToggle(k);
    });
  });

  $('#fitBtn').addEventListener('click', charts.fitAll);
  $('#watchlist').addEventListener('click', (e) => {
    const chip = e.target.closest('.wl-chip');
    if (chip) selectSymbol(chip.dataset.sym);
  });
  $('#chartStack').addEventListener('pointerleave', charts.hideTooltip);
}

/** Conecta todos los controles; las acciones de cambio las decide main.js. */
function init({ selectTimeframe, selectSymbol }) {
  initToolbar(selectTimeframe, selectSymbol);
  initSearch(selectSymbol);
}

/* ---- Avisos ---- */
let toastTimer;
function toast(msg, kind = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = `toast ${kind}`; }, 4200);
}

Aura.controls = { init, toast };
})();
