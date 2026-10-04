/* =========================================================================
 * Aura Invest · Ajustes
 * Diálogo para pegar, mostrar u ocultar y borrar la clave de Twelve Data, y ver el
 * consumo de créditos. La clave solo se guarda en este navegador (Aura.store) y
 * nunca se escribe en la consola, en la URL ni en una exportación.
 * ========================================================================= */
(() => {
'use strict';

const { $, fmtLocalTime } = Aura.utils;
const store = Aura.store;
const { client } = Aura.api;

const KEY_FORMAT = /^[A-Za-z0-9_-]{8,128}$/;
let onKeyChange = () => {};
let onRefreshChange = () => {};

function setStatus(text, kind = '') {
  const el = $('#keyStatus');
  el.textContent = text;
  el.className = `key-status ${kind}`;
}

function describeSavedKey() {
  const k = store.getApiKey();
  return k ? `Hay una clave guardada en este navegador (termina en «${k.slice(-4)}»).` : 'No hay ninguna clave guardada.';
}

function refresh() {
  const input = $('#apiKeyInput');
  input.value = '';
  input.placeholder = store.getApiKey() ? 'Pega otra clave para sustituirla' : 'Pega aquí tu clave';
  $('#keyDelete').disabled = !store.getApiKey();
  $('#refreshSelect').value = String(store.get('prefs').refreshMinutes);
  if (store.problem) setStatus(store.problem, 'err');
  else setStatus(describeSavedKey());
  renderUsage(client.status());
}

function renderUsage(s) {
  if (!$('#settingsDialog').open) return;
  const nextReset = Math.ceil((Date.now() + 1) / 86400000) * 86400000;
  $('#usageList').innerHTML = `
    <dt>Hoy</dt><dd>${s.creditsToday} / ${s.perDay} créditos</dd>
    <dt>Último minuto</dt><dd>${s.minuteUsed} / ${s.perMinute} créditos</dd>
    <dt>Peticiones en cola</dt><dd>${s.queued}</dd>
    <dt>Respuestas en caché</dt><dd>${store.cacheSize()}</dd>`;
  $('#usageHint').textContent = 'Cuenta solo las peticiones hechas desde este navegador. Se asume que el cupo diario '
    + `se reinicia a las 00:00 UTC (las ${fmtLocalTime(nextReset)} en tu hora local). Si usas la misma clave en otro `
    + 'sitio, Twelve Data puede cortar antes.';
}

function open() {
  const dlg = $('#settingsDialog');
  if (!dlg.open) dlg.showModal();
  refresh();
  $('#apiKeyInput').focus();
}

/** Llamado por main.js cuando Twelve Data rechaza la clave. */
function reportKeyError(err) {
  if ($('#settingsDialog').open) setStatus(`${err.message}${err.apiMessage ? ` (${err.apiMessage})` : ''}`, 'err');
}
/** Llamado por main.js cuando la clave funciona. */
function reportKeyOk() {
  if ($('#settingsDialog').open) setStatus('Clave correcta: datos recibidos de Twelve Data.', 'ok');
}

function init({ onKeyChange: cb, onRefreshChange: rc = () => {} }) {
  onKeyChange = cb;
  onRefreshChange = rc;
  $('#refreshSelect').addEventListener('change', (e) => {
    store.set('prefs', { ...store.get('prefs'), refreshMinutes: Number(e.target.value) });
    onRefreshChange();
  });
  $('#settingsBtn').addEventListener('click', open);
  $('#usagePill').addEventListener('click', open);
  $('#settingsClose').addEventListener('click', () => $('#settingsDialog').close());

  $('#keyShow').addEventListener('click', (e) => {
    const input = $('#apiKeyInput');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    e.currentTarget.setAttribute('aria-pressed', String(show));
    e.currentTarget.textContent = show ? 'Ocultar' : 'Mostrar';
  });

  $('#keyForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#apiKeyInput');
    const value = input.value.trim();
    if (!value) { setStatus('Pega una clave antes de guardar.', 'err'); input.focus(); return; }
    if (!KEY_FORMAT.test(value)) {
      setStatus(/^[A-Za-z0-9_-]+$/.test(value)
        ? 'La clave parece incompleta: cópiala entera desde tu cuenta de Twelve Data.'
        : 'La clave solo puede contener letras, números, guiones y guiones bajos (sin espacios).', 'err');
      input.focus();
      return;
    }
    const saved = store.setApiKey(value);
    input.value = '';
    input.type = 'password';
    $('#keyShow').setAttribute('aria-pressed', 'false');
    $('#keyShow').textContent = 'Mostrar';
    $('#keyDelete').disabled = false;
    setStatus(saved ? 'Clave guardada. Comprobando con Twelve Data…' : 'Clave en uso, pero este navegador no permite guardarla: se perderá al cerrar.', saved ? '' : 'err');
    onKeyChange();
  });

  $('#keyDelete').addEventListener('click', () => {
    store.setApiKey('');
    $('#keyDelete').disabled = true;
    setStatus('Clave borrada de este navegador.', 'ok');
    onKeyChange();
  });

  $('#cacheClear').addEventListener('click', () => {
    store.clearCache();
    client.clearMemoryCache();
    renderUsage(client.status());
    setStatus('Caché vaciada: los próximos datos se pedirán de nuevo a Twelve Data.', 'ok');
  });
}

Aura.settings = { init, open, renderUsage, reportKeyError, reportKeyOk };
})();
