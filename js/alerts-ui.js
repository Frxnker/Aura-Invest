/* =========================================================================
 * Aura Invest · Interfaz de alertas
 * Diálogo con: aviso de que solo funcionan con la app abierta, permiso de
 * notificaciones, formulario (crear/editar), lista (pausar, reanudar, reactivar,
 * editar, borrar con deshacer) e historial. Campana con contador de no vistas.
 * ========================================================================= */
(() => {
'use strict';

const { $, esc, fmtLocalDateTime, fmtLocalTime, fmtAgo } = Aura.utils;
const alerts = Aura.alerts;
const watchlist = Aura.watchlist;
const store = Aura.store;
const state = Aura.state;

const DIRS = {
  day_change: [['any', 'En cualquier sentido'], ['up', 'Al alza'], ['down', 'A la baja']],
  ema_cross: [['any', 'Cualquier cruce'], ['up', 'Alcista (la EMA 20 pasa por encima)'], ['down', 'Bajista (la EMA 20 pasa por debajo)']],
};
const HINTS = {
  price_above: 'Salta cuando la última cotización sea igual o superior al precio indicado.',
  price_below: 'Salta cuando la última cotización sea igual o inferior al precio indicado.',
  day_change: 'Compara el precio con el cierre anterior. Solo cuentan las sesiones desde el día en que se activa la alerta.',
  ema_cross: 'Con velas diarias. Salta en el próximo cruce a partir de ahora, no por cruces pasados.',
  rsi: 'Con velas diarias: RSI 14 estrictamente por encima de 70 o por debajo de 30.',
  signal: 'Con velas diarias (la misma señal que el panel en 6M). Salta cuando la señal cambie a la elegida.',
};
const STATUS_TEXT = { active: 'Activa', paused: 'Pausada', triggered: 'Ha saltado' };

let editingId = null;
let undo = null;                      // última alerta borrada (para deshacer)
let handlers = { checkNow: async () => {}, evaluateCached: () => {}, scheduleText: () => '' };

/* ---- Formulario ---- */

function setMsg(text, kind = '', withUndo = false) {
  const el = $('#alMsg');
  el.className = `key-status ${kind}`;
  el.textContent = text;
  if (withUndo) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'link-btn';
    b.textContent = 'Deshacer';
    b.addEventListener('click', () => {
      if (undo && alerts.restore(undo).ok) { setMsg(`Alerta restaurada: ${alerts.describe(undo)}.`, 'ok'); undo = null; renderList(); }
    });
    el.append(' ', b);
  }
}

function symbolOptions(selected) {
  const ids = [...new Set([state.symbol, ...watchlist.ids(), ...alerts.list().map((a) => a.symbol)])];
  $('#alSymbol').innerHTML = ids.map((id) => `<option value="${esc(id)}" ${id === selected ? 'selected' : ''}>${esc(id)}</option>`).join('');
}

function syncFields() {
  const type = $('#alType').value;
  const show = (k, v) => { $(`.field-wrap[data-for="${k}"]`).hidden = !v; };
  show('value', ['price_above', 'price_below', 'day_change'].includes(type));
  show('dir', Boolean(DIRS[type]));
  show('level', type === 'rsi');
  show('target', type === 'signal');
  if (DIRS[type]) {
    const cur = $('#alDir').value;
    $('#alDir').innerHTML = DIRS[type].map(([v, t]) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${t}</option>`).join('');
    $('#alDirLabel').textContent = type === 'ema_cross' ? 'Tipo de cruce' : 'Sentido';
  }
  const sym = $('#alSymbol').value;
  const w = watchlist.items().find((x) => x.id === sym);
  const cur = (w && w.currency) || '';
  $('#alValueLabel').textContent = type === 'day_change' ? 'Variación (%)' : `Precio${cur ? ` (${cur})` : ''}`;
  $('#alTypeHint').textContent = HINTS[type];
}

/** Rellena el precio con la última cotización conocida (solo si el campo está vacío). */
function suggestPrice() {
  const type = $('#alType').value, input = $('#alValue');
  if (input.value || !['price_above', 'price_below'].includes(type)) return;
  const q = state.quotes.get($('#alSymbol').value);
  if (q && !(q instanceof Error) && Number.isFinite(q.price)) input.value = String(q.price);
}

function readForm() {
  const raw = $('#alValue').value.trim().replace(',', '.');
  return {
    symbol: $('#alSymbol').value, type: $('#alType').value,
    value: raw === '' ? NaN : Number(raw), dir: $('#alDir').value, level: $('#alLevel').value, target: $('#alTarget').value,
  };
}

function resetForm(symbol = state.symbol) {
  editingId = null;
  $('#alFormTitle').textContent = 'Nueva alerta';
  $('#alSave').textContent = 'Crear alerta';
  $('#alCancel').hidden = true;
  $('#alValue').value = '';
  symbolOptions(symbol);
  syncFields();
  suggestPrice();
}

function startEdit(a) {
  editingId = a.id;
  symbolOptions(a.symbol);
  $('#alType').value = a.type;
  syncFields();
  $('#alValue').value = Number.isFinite(a.value) ? String(a.value) : '';
  if (a.dir) $('#alDir').value = a.dir;
  if (a.level) $('#alLevel').value = a.level;
  if (a.target) $('#alTarget').value = a.target;
  $('#alFormTitle').textContent = 'Editar alerta';
  $('#alSave').textContent = 'Guardar cambios';
  $('#alCancel').hidden = false;
  setMsg('Al guardar, la alerta se vuelve a activar desde cero.');
  $('#alSymbol').focus();
}

/* ---- Lista e historial ---- */

function renderList() {
  // Si el foco está en la lista (p. ej. una comprobación automática repinta), se conserva
  const prev = document.activeElement && document.activeElement.closest && document.activeElement.closest('#alList li[data-id]');
  const keep = prev ? { id: prev.dataset.id, act: document.activeElement.dataset.act } : null;
  const list = alerts.list();
  $('#alSchedule').textContent = handlers.scheduleText();
  $('#alList').innerHTML = list.length ? list.map((a) => {
    const reading = a.last
      ? (a.last.missing ? `Última comprobación ${fmtAgo(a.last.at)}: ${a.last.missing}.` : `Última lectura (${fmtAgo(a.last.at)}): ${a.last.reading}.`)
      : 'Todavía no se ha comprobado.';
    const fired = a.status === 'triggered' ? ` Saltó el ${fmtLocalDateTime(a.triggeredAt)}.` : '';
    const main = a.status === 'active'
      ? `<button type="button" class="btn btn-sm" data-act="pause">Pausar</button>`
      : a.status === 'paused'
        ? `<button type="button" class="btn btn-sm" data-act="resume">Reanudar</button>`
        : `<button type="button" class="btn btn-sm" data-act="rearm">Reactivar</button>`;
    const label = alerts.describe(a);
    return `<li data-id="${esc(a.id)}" class="al-item is-${a.status}">
      <div class="ml-main">
        <b>${esc(label)}</b>
        <span><span class="al-status">${STATUS_TEXT[a.status]}</span> · ${esc(reading)}${esc(fired)}</span>
      </div>
      <div class="ml-actions" role="group" aria-label="Acciones de la alerta ${esc(label)}">
        ${main}
        <button type="button" class="btn btn-sm" data-act="edit">Editar</button>
        <button type="button" class="btn btn-sm danger" data-act="remove">Borrar</button>
      </div>
    </li>`;
  }).join('') : '<li class="ml-empty">No hay alertas. Crea una con el formulario.</li>';

  const hist = alerts.history().slice().reverse();
  $('#alHistory').innerHTML = hist.length
    ? hist.slice(0, 50).map((h) => `<li><time>${esc(fmtLocalDateTime(h.at))}</time> ${esc(h.message)}</li>`).join('')
    : '<li class="ml-empty">Ninguna alerta ha saltado todavía.</li>';
  $('#alHistClear').disabled = !hist.length;
  if (keep) {
    const row = [...$('#alList').querySelectorAll('li[data-id]')].find((li) => li.dataset.id === keep.id);
    const btn = row && (row.querySelector(`[data-act="${keep.act}"]`) || row.querySelector('button'));
    if (btn) btn.focus();
  }
}

/* ---- Notificaciones ---- */

/**
 * Service worker mínimo (sw.js) para mostrar notificaciones: Chrome para Android no admite
 * `new Notification()` desde la página. Solo existe en conexiones seguras (https o localhost).
 */
async function registerNotifier() {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator) || !window.isSecureContext) return null;
  try {
    const reg = await navigator.serviceWorker.register('sw.js');
    Aura.monitor.setNotifier(reg);
    return reg;
  } catch {
    return null;                                      // sin service worker se prueba con new Notification()
  }
}

function renderNotif() {
  const N = window.Notification;
  const prefs = store.get('prefs');
  const btn = $('#alNotifBtn'), txt = $('#alNotifText');
  btn.hidden = false;
  if (!window.isSecureContext) {
    txt.textContent = 'Las notificaciones del navegador necesitan una conexión segura (https o localhost): los avisos aparecerán dentro de la app.';
    btn.hidden = true;
  } else if (!N) {
    txt.textContent = 'Este navegador no admite notificaciones (en iPhone solo las tienen las webs añadidas a la pantalla de inicio): los avisos aparecerán dentro de la app.';
    btn.hidden = true;
  } else if (N.permission === 'denied') {
    txt.textContent = 'Las notificaciones están bloqueadas para este sitio: los avisos aparecerán dentro de la app. Puedes permitirlas en la configuración del navegador.';
    btn.hidden = true;
  } else if (N.permission === 'granted' && prefs.notify && Aura.monitor.systemBlocked()) {
    txt.textContent = 'El navegador no ha dejado mostrar la última notificación: los avisos aparecen dentro de la app.';
    btn.textContent = 'Desactivar notificaciones';
  } else if (N.permission === 'granted' && prefs.notify) {
    txt.textContent = 'Recibirás notificaciones del navegador (además del aviso dentro de la app).';
    btn.textContent = 'Desactivar notificaciones';
  } else {
    txt.textContent = 'Los avisos aparecen dentro de la app. También puedes recibir notificaciones del navegador.';
    btn.textContent = 'Activar notificaciones';
  }
}

async function toggleNotif() {
  const N = window.Notification;
  const prefs = store.get('prefs');
  if (N && N.permission === 'granted' && prefs.notify) {
    store.set('prefs', { ...prefs, notify: false });
  } else if (N) {
    const perm = N.permission === 'granted' ? 'granted' : await N.requestPermission();
    store.set('prefs', { ...prefs, notify: perm === 'granted' });
    if (perm === 'granted') await registerNotifier();
  }
  renderNotif();
}

/* ---- Contador de la campana ---- */

function unseenCount() {
  const seen = store.get('prefs').alertsSeenAt || 0;
  return alerts.history().filter((h) => h.at > seen).length;
}
function renderBadge() {
  const n = unseenCount();
  const badge = $('#alertsBadge'), btn = $('#alertsBtn');
  badge.hidden = n === 0;
  badge.textContent = n > 9 ? '9+' : String(n);
  btn.setAttribute('aria-label', n ? `Alertas: ${n} sin ver` : 'Alertas');
}
function markSeen() {
  store.set('prefs', { ...store.get('prefs'), alertsSeenAt: Date.now() });
  renderBadge();
}

/** Aviso dentro de la app cuando saltan alertas (siempre, haya o no notificación del sistema). */
function announce({ entries }) {
  const text = entries.length === 1 ? entries[0].message : `${entries.length} alertas han saltado: ${entries.map((e) => e.symbol).join(', ')}.`;
  Aura.controls.toast(`🔔 ${text}`, 'alert');
  renderBadge();
  if ($('#alertsDialog').open) { renderList(); markSeen(); }
}

/* ---- Apertura e inicialización ---- */

function open(symbol) {
  resetForm(symbol || state.symbol);
  setMsg('');
  renderNotif();
  renderList();
  $('#alertsDialog').showModal();
  markSeen();
  $('#alSymbol').focus();
}

function init(h) {
  handlers = { ...handlers, ...h };
  $('#alertsBtn').addEventListener('click', () => open());
  $('#alertsDialog [data-close]').addEventListener('click', () => $('#alertsDialog').close());
  $('#alType').addEventListener('change', () => { syncFields(); suggestPrice(); });
  $('#alSymbol').addEventListener('change', () => { $('#alValue').value = ''; syncFields(); suggestPrice(); });
  $('#alNotifBtn').addEventListener('click', toggleNotif);
  $('#alCancel').addEventListener('click', () => { resetForm(); setMsg('Edición cancelada.'); $('#alSymbol').focus(); });

  $('#alForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = readForm();
    const res = editingId ? alerts.update(editingId, input) : alerts.add(input);
    if (!res.ok) { setMsg(res.error, 'err'); return; }
    const verb = editingId ? 'Alerta actualizada' : 'Alerta creada';
    resetForm(input.symbol);
    setMsg(`${verb}. Comprobando…`);
    await handlers.evaluateCached();                 // comprobación inmediata con los datos ya disponibles
    const now = alerts.get(res.alert.id);
    const fired = now && now.status === 'triggered';
    setMsg(`${verb}: ${alerts.describe(res.alert)}.${fired ? ' La condición ya se cumple: ha saltado.' : ''}`, 'ok');
    renderList();
    $('#alSymbol').focus();
  });

  $('#alList').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = btn.closest('li').dataset.id;
    const a = alerts.get(id);
    if (!a) return;
    const act = btn.dataset.act;
    if (act === 'edit') { startEdit(a); return; }
    if (act === 'remove') {
      alerts.remove(id);
      undo = a;
      setMsg(`Alerta borrada: ${alerts.describe(a)}.`, 'ok', true);
      renderList();
      $('#alMsg button').focus();
      return;
    }
    if (act === 'pause') { alerts.pause(id); setMsg(`Alerta pausada: ${alerts.describe(a)}.`); }
    if (act === 'resume' || act === 'rearm') {
      alerts[act](id);
      await handlers.evaluateCached();
      const again = alerts.get(id);
      const firedNow = again && again.status === 'triggered';
      setMsg(`Alerta ${act === 'resume' ? 'reanudada' : 'reactivada'}: ${alerts.describe(a)}.${firedNow ? ' La condición se sigue cumpliendo: ha vuelto a saltar.' : ''}`, 'ok');
    }
    renderList();
    const row = [...$('#alList').querySelectorAll('li[data-id]')].find((li) => li.dataset.id === id);
    const again = row && row.querySelector('[data-act="pause"],[data-act="resume"],[data-act="rearm"]');
    if (again) again.focus();
  });

  $('#alCheck').addEventListener('click', async (e) => {
    const b = e.currentTarget;
    b.disabled = true;
    b.setAttribute('aria-busy', 'true');
    setMsg('Comprobando con datos de Twelve Data…');
    try { await handlers.checkNow(); setMsg(`Comprobación terminada a las ${fmtLocalTime(Date.now())}.`, 'ok'); } finally {
      b.disabled = false; b.removeAttribute('aria-busy'); renderList();
    }
  });
  $('#alHistClear').addEventListener('click', () => { alerts.clearHistory(); setMsg('Historial vaciado.'); renderList(); renderBadge(); });

  alerts.onChange(() => { if ($('#alertsDialog').open) renderList(); });
  renderBadge();
  const N = window.Notification;
  if (store.get('prefs').notify && N && N.permission === 'granted') registerNotifier();
}

Aura.alertsUI = { init, open, announce, renderBadge, renderList };
})();
