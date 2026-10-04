/* =========================================================================
 * Aura Invest · Comparar
 * Diálogo para superponer hasta 4 valores al gráfico, en % desde el inicio de la
 * ventana visible. La lista vive en Aura.state.compare (dura lo que la sesión).
 * ========================================================================= */
(() => {
'use strict';

const { $, esc, fmtSigned } = Aura.utils;
const state = Aura.state;

const MAX = 4;
const ID_FORMAT = /^[A-Za-z0-9.\-/:^]{1,24}$/;
let onChange = () => {};
let summary = [];

function setMsg(text, kind = '') {
  const el = $('#cmpMsg');
  el.textContent = text;
  el.className = `key-status ${kind}`;
}

/** Pinta el botón de la barra y la lista del diálogo. `sum` = resumen de charts.renderCompare. */
function render(sum = summary) {
  summary = sum;
  const n = state.compare.length;
  const btn = $('#compareBtn');
  btn.setAttribute('aria-pressed', String(n > 0));
  btn.querySelector('.cmp-count').textContent = n ? ` (${n})` : '';
  btn.setAttribute('aria-label', n ? `Comparar: ${n} valores superpuestos` : 'Comparar con otros valores');
  $('#cmpList').innerHTML = n ? state.compare.map((id) => {
    const s = summary.find((x) => x.id === id);
    const info = !s ? 'Cargando…' : s.error ? `Sin datos: ${s.error.message}` : `${fmtSigned(s.last, 2)} % en la ventana`;
    return `<li data-id="${esc(id)}">
      <div class="ml-main"><b><i class="cmp-sw" style="background:${s ? s.color : 'transparent'}" aria-hidden="true"></i>${esc(id)}</b><span>${esc(info)}</span></div>
      <div class="ml-actions"><button type="button" class="btn btn-sm danger" data-act="remove" aria-label="Quitar ${esc(id)} de la comparación">Quitar</button></div>
    </li>`;
  }).join('') : '<li class="ml-empty">Todavía no comparas ningún valor.</li>';
  $('#cmpClear').disabled = !n;
  const ids = Aura.watchlist.ids().filter((id) => id !== state.symbol && !state.compare.includes(id));
  $('#cmpSymbols').innerHTML = ids.map((id) => `<option value="${esc(id)}"></option>`).join('');
}

function add(raw) {
  const id = String(raw || '').trim().toUpperCase();
  if (!ID_FORMAT.test(id)) return setMsg('Escribe un ticker válido (p. ej. MSFT o SAN:BME).', 'err');
  if (id === state.symbol) return setMsg(`${id} es el valor que ya estás viendo.`, 'err');
  if (state.compare.includes(id)) return setMsg(`${id} ya está en la comparación.`, 'err');
  if (state.compare.length >= MAX) return setMsg(`Puedes comparar como mucho ${MAX} valores a la vez.`, 'err');
  state.compare.push(id);
  $('#cmpInput').value = '';
  setMsg(`${id} añadido: se pide a Twelve Data en la temporalidad actual.`, 'ok');
  render();
  onChange();
}

function remove(id) {
  state.compare = state.compare.filter((x) => x !== id);
  setMsg(`${id} quitado de la comparación.`, 'ok');
  render();
  onChange();
}

function open() {
  setMsg('');
  render();
  $('#compareDialog').showModal();
  $('#cmpInput').focus();
}

function init(h) {
  onChange = h.onChange;
  $('#compareBtn').addEventListener('click', open);
  $('#compareDialog [data-close]').addEventListener('click', () => $('#compareDialog').close());
  $('#cmpForm').addEventListener('submit', (e) => { e.preventDefault(); add($('#cmpInput').value); $('#cmpInput').focus(); });
  $('#cmpList').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act="remove"]');
    if (!b) return;
    const li = b.closest('li');
    const next = li.nextElementSibling || li.previousElementSibling;
    remove(li.dataset.id);
    const target = next && [...$('#cmpList').querySelectorAll('li[data-id]')].find((x) => x.dataset.id === next.dataset.id);
    (target ? target.querySelector('button') : $('#cmpInput')).focus();
  });
  $('#cmpClear').addEventListener('click', () => {
    state.compare = [];
    setMsg('Comparación vaciada: vuelven las velas y los indicadores.', 'ok');
    render();
    onChange();
    $('#cmpInput').focus();
  });
  render();
}

Aura.compareUI = { init, render, open, MAX };
})();
