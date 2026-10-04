/* =========================================================================
 * Aura Invest · Interfaz de la watchlist
 * - Diálogo para reordenar (Subir/Bajar) y quitar valores, usable con teclado.
 * - Estrella de la cabecera: añade o quita el valor que se está viendo.
 * - Botón de actualizar y texto con la última y la próxima actualización.
 * ========================================================================= */
(() => {
'use strict';

const { $, esc, fmtLocalTime } = Aura.utils;
const watchlist = Aura.watchlist;
const state = Aura.state;

let handlers = { refresh: async () => {}, metaFor: () => ({}) };

function setMsg(text, kind = '') {
  const el = $('#wlMsg');
  el.textContent = text;
  el.className = `key-status ${kind}`;
}

/** Pinta la lista del diálogo. `focus` = { id, act } para devolver el foco tras una acción. */
function renderList(focus) {
  const items = watchlist.items();
  $('#wlHint').textContent = `Hasta ${watchlist.MAX} valores (ahora ${items.length}). Cada actualización cuesta 1 crédito por valor. `
    + 'Añade valores desde el buscador (Alt + Intro sobre un resultado) o con la estrella de la cabecera.';
  const list = $('#wlList');
  list.innerHTML = items.length ? items.map((w, i) => `
    <li data-id="${esc(w.id)}">
      <div class="ml-main"><b>${esc(w.id)}</b><span>${esc([w.name, w.exchange, w.currency].filter(Boolean).join(' · '))}</span></div>
      <div class="ml-actions">
        <button type="button" class="icon-btn" data-act="up" ${i === 0 ? 'disabled' : ''} aria-label="Subir ${esc(w.id)}" title="Subir">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="m6 15 6-6 6 6"/></svg></button>
        <button type="button" class="icon-btn" data-act="down" ${i === items.length - 1 ? 'disabled' : ''} aria-label="Bajar ${esc(w.id)}" title="Bajar">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button>
        <button type="button" class="icon-btn danger" data-act="remove" aria-label="Quitar ${esc(w.id)} de la watchlist" title="Quitar">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
      </div>
    </li>`).join('') : '<li class="ml-empty">La watchlist está vacía.</li>';

  if (focus) {
    const rows = [...list.querySelectorAll('li[data-id]')];
    const row = rows.find((li) => li.dataset.id === focus.id) || (focus.index != null ? rows[Math.min(focus.index, rows.length - 1)] : null);
    const target = row && row.querySelector(`[data-act="${focus.act}"]:not([disabled])`);
    (target || (row && row.querySelector('button:not([disabled])')) || list.querySelector('button:not([disabled])') || $('#wlRefreshNow')).focus();
  }
}

/** Estrella de la cabecera según el valor que se está viendo. */
function updateStar() {
  const btn = $('#watchBtn');
  const on = watchlist.has(state.symbol);
  btn.setAttribute('aria-pressed', String(on));
  const label = on ? `Quitar ${state.symbol} de la watchlist` : `Añadir ${state.symbol} a la watchlist`;
  btn.setAttribute('aria-label', label);
  btn.title = label;
}

/** Texto de la próxima actualización automática (barra y diálogo). */
function renderSchedule(s) {
  const bar = $('#wlStatus'), dlg = $('#wlSchedule');
  if (!s) return;
  if (s.running) { bar.textContent = 'Actualizando…'; dlg.textContent = 'Actualizando cotizaciones…'; return; }
  const last = s.lastRun ? `actualizada a las ${fmtLocalTime(s.lastRun)}` : 'sin actualizar todavía';
  let next;
  switch (s.reason) {
    case 'nokey': next = 'sin clave de API, no se actualiza'; break;
    case 'empty': next = 'no hay nada que vigilar'; break;
    case 'off': next = 'actualización automática desactivada en Ajustes (se actualiza al abrir la app o con el botón)'; break;
    case 'budget': next = 'actualización automática en pausa: el cupo de hoy está casi agotado (se reservan créditos para usar la app)'; break;
    default: next = s.nextAt ? `próxima a las ${fmtLocalTime(s.nextAt)} (cada ${Math.round(s.delay / 60000)} min, según el cupo del plan)` : '';
  }
  bar.textContent = s.lastRun ? `Act. ${fmtLocalTime(s.lastRun)}` : '';
  dlg.textContent = `Watchlist ${last}; ${next}. Solo se actualiza con la app abierta.`;
}

async function refresh(btn) {
  btn.disabled = true;
  btn.setAttribute('aria-busy', 'true');
  try { await handlers.refresh(); } finally { btn.disabled = false; btn.removeAttribute('aria-busy'); }
}

function open() {
  setMsg('');
  renderList();
  $('#watchlistDialog').showModal();
  const first = $('#wlList button:not([disabled])');
  (first || $('#wlRefreshNow')).focus();
}

function init(h) {
  handlers = { ...handlers, ...h };
  $('#wlEdit').addEventListener('click', open);
  $('#watchlistDialog [data-close]').addEventListener('click', () => $('#watchlistDialog').close());
  $('#wlRefresh').addEventListener('click', (e) => refresh(e.currentTarget));
  $('#wlRefreshNow').addEventListener('click', (e) => refresh(e.currentTarget));

  $('#wlList').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = btn.closest('li').dataset.id;
    const act = btn.dataset.act;
    if (act === 'remove') {
      const index = watchlist.ids().indexOf(id);
      watchlist.remove(id);
      setMsg(`${id} quitado de la watchlist.`, 'ok');
      renderList({ id: null, index, act: 'remove' });             // foco en el valor que ocupa su lugar
    } else {
      watchlist.move(id, act === 'up' ? -1 : 1);
      setMsg(`${id} ${act === 'up' ? 'sube' : 'baja'} una posición.`);
      renderList({ id, act });
    }
  });

  $('#watchBtn').addEventListener('click', () => {
    const id = state.symbol;
    if (watchlist.has(id)) {
      watchlist.remove(id);
      Aura.controls.toast(`${id} quitado de la watchlist.`);
    } else {
      const res = watchlist.add({ id, ...handlers.metaFor(id) });
      Aura.controls.toast(res.ok ? `${id} añadido a la watchlist.` : res.error, res.ok ? '' : 'error');
    }
    updateStar();
  });
  updateStar();
}

Aura.watchlistUI = { init, open, renderList, renderSchedule, updateStar };
})();
