/* =========================================================================
 * Aura Invest · Herramientas de dibujo
 * - «Horizontal»: un clic en el gráfico coloca una línea a ese precio.
 * - «Tendencia»: un clic en el punto inicial y otro en el final.
 * - Clic sobre un dibujo para seleccionarlo; arrastrar para moverlo (o mover un
 *   extremo de una tendencia). Mientras se arrastra, el gráfico no se desplaza.
 *   Con el dedo, la zona para agarrar un dibujo es más ancha; si el sistema cancela el
 *   gesto (pointercancel), el arrastre se descarta y el gráfico vuelve a desplazarse.
 * - Teclado: Supr/Retroceso borra el seleccionado; ↑/↓ lo mueven (Mayús: más);
 *   Esc cancela. El diálogo «Dibujos» permite editar precios y borrar sin ratón.
 * Se guardan por valor (Aura.drawings) y no se muestran en el modo Comparar.
 * ========================================================================= */
(() => {
'use strict';

const { $, esc, fmtNum, fmtDate } = Aura.utils;
const drawings = Aura.drawings;
const state = Aura.state;

let mode = null;           // 'hline' | 'trend' | null
let draft = null;          // primer punto de una tendencia
let selectedId = null;
let press = null;          // { x, y } al pulsar en modo dibujo
let drag = null;           // { id, part, start, orig, current }

const api = () => Aura.charts.drawingApi();
const charts = () => Aura.charts;
const find = (id) => drawings.list(state.symbol).find((d) => d.id === id) || null;
const available = () => Boolean(state.model) && !charts().comparing() && state.page === 'market';

function hint(text) { $('#drawHint').textContent = text; }
function refresh(o = {}) { charts().refreshDrawings({ selectedId, ...o }); renderCount(); }

function renderCount() {
  const n = state.model ? drawings.list(state.symbol).length : 0;
  $('#drawListBtn .draw-count').textContent = n ? ` (${n})` : '';
  $('#drawListBtn').setAttribute('aria-label', `Dibujos de ${state.symbol}: ${n}`);
}

function setMode(m) {
  mode = available() ? m : null;
  draft = null;
  document.querySelectorAll('[data-draw]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.draw === mode)));
  $('#paneMain').classList.toggle('is-drawing', Boolean(mode));
  hint(mode === 'hline' ? 'Haz clic en el gráfico para colocar la línea horizontal (Esc para cancelar).'
    : mode === 'trend' ? 'Haz clic en el punto inicial de la tendencia (Esc para cancelar).' : '');
  if (m && !mode) hint(charts().comparing() ? 'Sal del modo Comparar para dibujar (el eje está en %).' : 'Carga un valor para dibujar.');
  refresh({ preview: null });
}

function lock(on) { api().chart.applyOptions({ handleScroll: !on, handleScale: !on }); }

function local(e) {
  const r = $('#chartMain').getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}
function inPane(p) { const a = api(); return p.x >= 0 && p.y >= 0 && p.x <= a.paneWidth() && p.y <= a.paneHeight(); }

const TOUCH_TOL = 16;       // px para agarrar un dibujo con el dedo (con ratón, 6)

function select(id, { touch = false } = {}) {
  selectedId = id;
  if (id) hint(touch ? 'Dibujo seleccionado: arrástralo con el dedo o bórralo desde «Dibujos».'
    : 'Dibujo seleccionado: arrástralo, muévelo con ↑/↓ o bórralo con Supr (Esc para soltarlo).');
  else if (!mode) hint('');
  refresh();
}

/* ---- Puntero ---- */

function onPointerDown(e) {
  if (e.button !== 0 || !available()) return;
  const p = local(e);
  if (!inPane(p)) return;
  if (mode) { press = p; lock(true); return; }
  const touch = e.pointerType === 'touch';
  const hit = drawings.hitTest(api().primitive.coords, p.x, p.y, touch ? TOUCH_TOL : undefined);
  if (hit) {
    const orig = find(hit.id);
    if (!orig) return;
    select(hit.id, { touch });
    drag = { id: hit.id, part: hit.part, start: p, orig, current: null };
    lock(true);
    e.preventDefault();
  } else if (selectedId) {
    select(null);
  }
}

function onPointerMove(e) {
  if (!drag && !(mode === 'trend' && draft)) return;
  const a = api(), p = local(e);
  const t = a.xToTime(p.x), price = a.yToPrice(p.y);
  if (drag) {
    const o = drag.orig;
    let next;
    if (o.kind === 'hline') next = { ...o, price };
    else if (drag.part === 'a') next = { ...o, a: { t, p: price } };
    else if (drag.part === 'b') next = { ...o, b: { t, p: price } };
    else {
      const dt = t - a.xToTime(drag.start.x), dp = price - a.yToPrice(drag.start.y);
      next = { ...o, a: { t: o.a.t + dt, p: o.a.p + dp }, b: { t: o.b.t + dt, p: o.b.p + dp } };
    }
    if ([next.price, next.a && next.a.p, next.b && next.b.p].every((v) => v == null || (Number.isFinite(v) && v > 0))) {
      drag.current = next;
      refresh({ override: next });
    }
  } else if (Number.isFinite(t) && price > 0) {
    refresh({ preview: { kind: 'trend', a: draft, b: { t, p: price } } });
  }
}

function onPointerUp(e) {
  if (drag) {
    if (drag.current) drawings.update(state.symbol, drag.id, drag.current);
    drag = null;
    lock(false);
    refresh({ override: null });
    return;
  }
  if (!mode || !press) return;
  const p = local(e);
  const moved = Math.hypot(p.x - press.x, p.y - press.y) > 5;
  press = null;
  lock(false);
  if (moved) return;                                   // arrastre: no es un clic
  const a = api();
  const t = a.xToTime(p.x), price = a.yToPrice(p.y);
  if (!(price > 0) || !Number.isFinite(t)) return;
  if (mode === 'hline') {
    const res = drawings.add(state.symbol, { kind: 'hline', price });
    setMode(null);
    if (res.ok) { select(res.drawing.id); Aura.controls.toast(`Línea horizontal en ${fmtNum(price, a.precision)}.`); }
    else Aura.controls.toast(res.error, 'error');
  } else if (!draft) {
    draft = { t, p: price };
    hint('Ahora haz clic en el punto final de la tendencia (Esc para cancelar).');
  } else {
    const res = drawings.add(state.symbol, { kind: 'trend', a: draft, b: { t, p: price } });
    setMode(null);
    if (res.ok) { select(res.drawing.id); Aura.controls.toast('Línea de tendencia guardada.'); }
    else Aura.controls.toast(res.error, 'error');
  }
}

/** El navegador o el sistema ha interrumpido el gesto: se descarta y se desbloquea el gráfico. */
function onPointerCancel() {
  if (!drag && !press) return;
  drag = null;
  press = null;
  lock(false);
  refresh({ override: null });
}

/* ---- Teclado ---- */

function onKey(e) {
  const el = document.activeElement;
  if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
  if (document.querySelector('dialog[open]') || state.page !== 'market') return;
  if (e.key === 'Escape' && (mode || selectedId)) { setMode(null); select(null); return; }
  if (!selectedId) return;
  const d = find(selectedId);
  if (!d) { select(null); return; }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    drawings.remove(state.symbol, d.id);
    select(null);
    Aura.controls.toast('Dibujo borrado.');
  } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    e.preventDefault();
    const pct = (e.shiftKey ? 0.01 : 0.002) * (e.key === 'ArrowUp' ? 1 : -1);
    drawings.update(state.symbol, d.id, drawings.shift(d, { factor: 1 + pct }));
    refresh();
  }
}

/* ---- Diálogo «Dibujos» ---- */

function describe(d, p) {
  if (d.kind === 'hline') return 'Línea horizontal';
  const intraday = (t) => t % 86400 !== 0;
  return `Tendencia: ${fmtDate(d.a.t, intraday(d.a.t))} (${fmtNum(d.a.p, p)}) → ${fmtDate(d.b.t, intraday(d.b.t))} (${fmtNum(d.b.p, p)})`;
}

function renderList(msg = '') {
  const list = drawings.list(state.symbol);
  const p = state.model ? state.model.meta.precision : 2;
  const num = (v) => String(Number(v.toFixed(p))).replace('.', ',');
  $('#drawTitle').textContent = `Dibujos de ${state.symbol}`;
  $('#drawItems').innerHTML = list.length ? list.map((d, k) => `
    <li data-id="${esc(d.id)}">
      <div class="ml-main"><b>${esc(describe(d, p))}</b>
        <span class="draw-fields">${d.kind === 'hline'
    ? `<label>Precio <input class="field field-sm" data-f="price" inputmode="decimal" value="${num(d.price)}" aria-label="Precio de la línea ${k + 1}"></label>`
    : `<label>Inicio <input class="field field-sm" data-f="a" inputmode="decimal" value="${num(d.a.p)}" aria-label="Precio inicial de la tendencia ${k + 1}"></label>
       <label>Final <input class="field field-sm" data-f="b" inputmode="decimal" value="${num(d.b.p)}" aria-label="Precio final de la tendencia ${k + 1}"></label>`}</span></div>
      <div class="ml-actions">
        <button type="button" class="btn btn-sm" data-act="save">Guardar</button>
        <button type="button" class="btn btn-sm danger" data-act="remove">Borrar</button>
      </div>
    </li>`).join('') : '<li class="ml-empty">No hay dibujos para este valor. Usa «Horizontal» o «Tendencia» en la barra del gráfico.</li>';
  $('#drawClear').disabled = !list.length;
  const m = $('#drawMsg');
  m.textContent = msg;
  m.className = 'key-status ok';
}

function onListClick(e) {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const li = b.closest('li');
  const d = find(li.dataset.id);
  if (!d) return;
  if (b.dataset.act === 'remove') {
    drawings.remove(state.symbol, d.id);
    if (selectedId === d.id) select(null);
    renderList('Dibujo borrado.');
    $('#drawClear').focus();
    return;
  }
  const val = (f) => Number(String(li.querySelector(`[data-f="${f}"]`).value).replace(',', '.'));
  const next = d.kind === 'hline' ? { ...d, price: val('price') } : { ...d, a: { ...d.a, p: val('a') }, b: { ...d.b, p: val('b') } };
  const res = drawings.update(state.symbol, d.id, next);
  renderList(res.ok ? 'Cambios guardados.' : res.error);
  refresh();
}

function init() {
  const pane = $('#paneMain');
  pane.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerCancel);
  document.addEventListener('keydown', onKey);
  document.querySelectorAll('[data-draw]').forEach((b) => b.addEventListener('click', () => setMode(mode === b.dataset.draw ? null : b.dataset.draw)));
  $('#drawListBtn').addEventListener('click', () => { renderList(); $('#drawDialog').showModal(); ($('#drawItems input') || $('#drawClear')).focus(); });
  $('#drawDialog [data-close]').addEventListener('click', () => $('#drawDialog').close());
  // Se abre desde el menú «Dibujo», que ya está cerrado: el foco vuelve a su botón, no a uno oculto
  $('#drawDialog').addEventListener('close', () => {
    const a = document.activeElement;
    if (!a || a === document.body || a.closest('[hidden]')) $('#drawMenuBtn').focus();
  });
  $('#drawItems').addEventListener('click', onListClick);
  $('#drawClear').addEventListener('click', () => { drawings.clear(state.symbol); select(null); renderList('Todos los dibujos de este valor se han borrado.'); });
  drawings.onChange(() => renderCount());
  renderCount();
}

/** Al cambiar de valor: se suelta la selección y se sale del modo dibujo. */
function reset() { selectedId = null; drag = null; if (mode) setMode(null); renderCount(); }

Aura.drawingTools = { init, reset, setMode };
})();
