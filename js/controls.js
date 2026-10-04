/* =========================================================================
 * Aura Invest · Controles e interacción
 * Temporalidad, toggles de indicadores, buscador de valores (symbol_search real),
 * watchlist y avisos.
 * ========================================================================= */
(() => {
'use strict';

const { TIMEFRAMES } = Aura.config;
const { searchSymbols } = Aura.data;
const { $, clamp, esc } = Aura.utils;
const charts = Aura.charts;
const state = Aura.state;

const SEARCH_DEBOUNCE_MS = 400;

/* ---- Buscador de valores ---- */
function initSearch(selectSymbol) {
  const input = $('#tickerInput'), list = $('#suggest'), live = $('#searchStatus');
  let items = [], active = 0, message = '', timer = null, ctrl = null, seq = 0, lastQuery = '';

  const open = (v) => { list.classList.toggle('open', v); input.setAttribute('aria-expanded', String(v)); };

  function render() {
    if (!items.length) {
      list.innerHTML = message ? `<li class="s-info" role="presentation">${esc(message)}</li>` : '';
      input.setAttribute('aria-activedescendant', '');
      return;
    }
    active = clamp(active, 0, items.length - 1);
    list.innerHTML = items.map((t, k) => {
      const where = [t.exchange, t.currency, t.country].filter(Boolean).map(esc).join(' · ');
      const plan = t.available
        ? '<span class="s-plan ok">Plan gratuito</span>'
        : `<span class="s-plan no">Requiere ${esc(t.plan)}</span>`;
      const label = `${t.symbol}, ${t.name}, ${[t.exchange, t.currency].filter(Boolean).join(', ')}, ${t.available ? 'incluido en el plan gratuito' : `requiere el plan ${t.plan}`}`;
      return `<li role="option" id="opt-${k}" data-k="${k}" aria-selected="${k === active}" aria-label="${esc(label)}">
        <span class="s-sym">${esc(t.symbol)}</span>
        <span class="s-name">${esc(t.name)}<small>${where}</small></span>${plan}</li>`;
    }).join('');
    input.setAttribute('aria-activedescendant', `opt-${active}`);
    const sel = list.querySelector('[aria-selected="true"]');
    if (sel) sel.scrollIntoView({ block: 'nearest' });
  }

  function hint() {
    items = [];
    message = 'Escribe un nombre o un ticker (p. ej. Apple o MSFT).';
    render();
  }

  async function run(q) {
    const my = ++seq;
    lastQuery = q;
    if (ctrl) ctrl.abort();
    ctrl = new AbortController();
    items = [];
    message = 'Buscando en Twelve Data…';
    render();
    open(true);
    try {
      const res = await searchSymbols(q, { signal: ctrl.signal });
      if (my !== seq) return;
      items = res;
      active = 0;
      message = res.length ? '' : `Sin resultados para «${q}».`;
    } catch (err) {
      if (my !== seq || err.code === 'ABORTED') return;
      items = [];
      message = `No se pudo buscar: ${err.message}`;
    }
    render();
    live.textContent = items.length ? `${items.length} resultados. Usa las flechas para elegir.` : message;
  }

  const choose = (item) => {
    input.value = '';
    open(false);
    input.blur();
    selectSymbol(item.id);
  };

  input.addEventListener('focus', () => {
    if (input.value.trim()) { render(); open(true); } else { hint(); open(true); }
  });
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (!q) { seq++; hint(); return; }
    timer = setTimeout(() => run(q), SEARCH_DEBOUNCE_MS);   // espera a que deje de escribir
  });
  input.addEventListener('blur', () => setTimeout(() => open(false), 150));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { if (items.length) { active = Math.min(items.length - 1, active + 1); render(); } e.preventDefault(); }
    else if (e.key === 'ArrowUp') { if (items.length) { active = Math.max(0, active - 1); render(); } e.preventDefault(); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const q = input.value.trim();
      if (items.length && q === lastQuery) choose(items[active]);
      else if (q) { clearTimeout(timer); run(q); }               // Intro sin esperar al retardo
    } else if (e.key === 'Escape') { open(false); input.blur(); }
  });
  list.addEventListener('mousedown', (e) => {
    const li = e.target.closest('li[data-k]');
    if (li) { e.preventDefault(); choose(items[Number(li.dataset.k)]); }
  });
  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement && document.activeElement.tagName);
    if (e.key === '/' && !typing && !document.querySelector('dialog[open]')) { e.preventDefault(); input.focus(); }
  });

  return {
    /** Abre el buscador con un texto ya escrito (p. ej. para buscar alternativas). */
    searchFor(text) { input.value = text; input.focus(); clearTimeout(timer); run(text); },
  };
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

let search = null;

/** Conecta todos los controles; las acciones de cambio las decide main.js. */
function init({ selectTimeframe, selectSymbol }) {
  initToolbar(selectTimeframe, selectSymbol);
  search = initSearch(selectSymbol);
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

Aura.controls = { init, toast, searchFor: (text) => search && search.searchFor(text) };
})();
