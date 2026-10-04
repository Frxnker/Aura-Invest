/* =========================================================================
 * Aura Invest · Interfaz del backtest
 * Pide velas diarias reales (1 crédito), ejecuta Aura.backtest.run sin bloquear la
 * página y muestra los resultados tal cual, aunque sean peores que el azar.
 * ========================================================================= */
(() => {
'use strict';

const { $, esc, fmtNum, fmtSigned, fmtDate } = Aura.utils;
const { fetchDailyBars } = Aura.data;
const state = Aura.state;
const store = Aura.store;

const PERIODS = { 2: 800, 5: 1600, 10: 3200 };          // años → sesiones pedidas (incluye calentamiento)
const LABEL = { buy: 'Alcista', hold: 'Neutral', sell: 'Bajista' };
let ctrl = null;

const pct = (v, d = 1) => (v == null ? '—' : `${fmtNum(v * 100, d)} %`);
const spct = (v, d = 2) => (v == null ? '—' : `${fmtSigned(v * 100, d)} %`);

function status(text, kind = '') {
  const el = $('#btStatus');
  el.textContent = text;
  el.className = `key-status ${kind}`;
}
function progress(p) {
  const el = $('#btProgress');
  el.hidden = p == null;
  if (p == null) return;
  const v = Math.round(p * 100);
  el.setAttribute('aria-valuenow', String(v));
  el.querySelector('i').style.width = `${v}%`;
}

/** Frase neutra que compara una señal con "cualquier día". */
function verdict(action, h, label) {
  const b = h.by[action], all = h.all;
  if (!b.n || b.hit == null) return '';
  const baseHit = action === 'buy' ? all.up : all.down;
  const better = b.hit > baseHit;
  const meanCmp = action === 'buy' ? b.mean > all.mean : b.mean < all.mean;
  return `<li><b>${LABEL[action]}</b> a ${label}: acierta el ${pct(b.hit)} de las veces, frente al ${pct(baseHit)} de días en que el precio ${action === 'buy' ? 'sube' : 'baja'} sin más `
    + `(${better ? 'mejor' : 'igual o peor'} que no hacer nada). Rentabilidad media tras la señal ${spct(b.mean)} frente a ${spct(all.mean)} de cualquier día `
    + `(${meanCmp ? 'a favor de la señal' : 'en contra de la señal'}).</li>`;
}

function render(res, meta) {
  const s = res.summary;
  const days = s.days;
  const row = (h, a) => {
    const b = s[h].by[a];
    return `<td class="num">${b.n}</td><td class="num">${spct(b.mean)}</td><td class="num">${a === 'hold' ? '—' : pct(b.hit)}</td>`;
  };
  const allRow = (h) => `<td class="num">${s[h].all.n}</td><td class="num">${spct(s[h].all.mean)}</td><td class="num">${pct(s[h].all.up)} sube</td>`;
  const t = s.touches;
  $('#btResults').innerHTML = `
    <p class="bt-summary"><b>${esc(meta.symbol)}</b> · ${days} sesiones evaluadas (${esc(fmtDate(res.from))} – ${esc(fmtDate(res.to))}) ·
      señales: Alcista ${s.counts.buy} (${pct(s.counts.buy / days, 0)}), Neutral ${s.counts.hold} (${pct(s.counts.hold / days, 0)}), Bajista ${s.counts.sell} (${pct(s.counts.sell / days, 0)}).</p>
    <ul class="bt-verdicts">${['buy', 'sell'].map((a) => verdict(a, s.h21, '21 sesiones') + verdict(a, s.h63, '63 sesiones')).join('')}</ul>

    <div class="table-wrap" tabindex="0" role="region" aria-labelledby="btT1"><table class="pf-table">
      <caption id="btT1">Rentabilidad y acierto tras cada señal</caption>
      <thead><tr><th scope="col" rowspan="2">Señal</th><th scope="colgroup" colspan="3" class="num">21 sesiones (≈ 1 mes)</th><th scope="colgroup" colspan="3" class="num">63 sesiones (≈ 3 meses)</th></tr>
        <tr><th scope="col" class="num">Casos</th><th scope="col" class="num">Media</th><th scope="col" class="num">Acierto</th><th scope="col" class="num">Casos</th><th scope="col" class="num">Media</th><th scope="col" class="num">Acierto</th></tr></thead>
      <tbody>${['buy', 'hold', 'sell'].map((a) => `<tr><th scope="row">${LABEL[a]}</th>${row('h21', a)}${row('h63', a)}</tr>`).join('')}
        <tr class="bt-base"><th scope="row">Cualquier día (comprar y mantener)</th>${allRow('h21')}${allRow('h63')}</tr></tbody>
    </table></div>
    <p class="hint">Acierto: Alcista acierta si el precio sube; Bajista, si baja. Frente a «no operar» (0 %), basta comparar la media con cero.</p>

    <div class="table-wrap" tabindex="0" role="region" aria-labelledby="btT2"><table class="pf-table">
      <caption id="btT2">Cono de previsión del 80 % a 63 sesiones</caption>
      <thead><tr><th scope="col">Casos</th><th scope="col" class="num">Dentro</th><th scope="col" class="num">Por encima</th><th scope="col" class="num">Por debajo</th></tr></thead>
      <tbody><tr><td>${s.cone.n}</td><td class="num"><b>${pct(s.cone.inside)}</b> (debería rondar el 80 %)</td><td class="num">${pct(s.cone.above)}</td><td class="num">${pct(s.cone.below)}</td></tr></tbody>
    </table></div>

    <div class="table-wrap" tabindex="0" role="region" aria-labelledby="btT3"><table class="pf-table">
      <caption id="btT3">Qué se tocó antes en las 63 sesiones siguientes</caption>
      <thead><tr><th scope="col">Señal</th><th scope="col" class="num">Casos</th><th scope="col" class="num">Objetivo</th><th scope="col" class="num">Stop</th><th scope="col" class="num">Ambos el mismo día</th><th scope="col" class="num">Ninguno</th></tr></thead>
      <tbody>${['buy', 'sell'].map((a) => `<tr><th scope="row">${LABEL[a]}</th><td class="num">${t[a].n}</td><td class="num">${pct(t[a].target)}</td><td class="num">${pct(t[a].stop)}</td><td class="num">${pct(t[a].both)}</td><td class="num">${pct(t[a].none)}</td></tr>`).join('')}</tbody>
    </table></div>

    <ul class="bt-caveats hint">
      <li>Cada día se calcula con lo que se sabía ese día (sin datos futuros). Los resultados se muestran tal cual, aunque sean peores que el azar.</li>
      <li>Las observaciones se solapan (días consecutivos comparten buena parte del futuro): no son independientes y los porcentajes son menos fiables de lo que parece.</li>
      <li>Un solo valor y un solo periodo; sin comisiones, impuestos ni deslizamiento. Rentabilidades pasadas no garantizan las futuras.</li>
    </ul>`;
}

async function runBacktest() {
  if (!store.getApiKey()) { status('Hace falta la clave de Twelve Data (Ajustes) para pedir velas diarias reales.', 'err'); return; }
  const years = Number($('#btPeriod').value);
  const id = state.symbol;
  ctrl = new AbortController();
  $('#btRun').disabled = true;
  $('#btCancel').hidden = false;
  $('#btResults').textContent = '';
  progress(0);
  status(`Pidiendo ${PERIODS[years]} velas diarias de ${id} a Twelve Data…`);
  try {
    const data = await fetchDailyBars(id, PERIODS[years]);
    if (data.source.stale) status('Twelve Data no responde: se usan velas diarias guardadas (antiguas).', 'err');
    status(`Evaluando ${data.bars.length - Aura.backtest.MIN_HISTORY} días con el modelo…`);
    const res = await Aura.backtest.run(data.bars, data.meta, { signal: ctrl.signal, onProgress: progress });
    render(res, data.meta);
    status(`Backtest terminado: ${res.summary.days} sesiones de ${id}.`, 'ok');
    $('#btResults').focus();
  } catch (err) {
    status(err.name === 'AbortError' ? 'Backtest cancelado.' : `No se pudo hacer el backtest: ${err.message}`, 'err');
  } finally {
    progress(null);
    $('#btRun').disabled = false;
    $('#btCancel').hidden = true;
    ctrl = null;
  }
}

function open() {
  $('#btSymbol').textContent = state.symbol;
  status('');
  $('#btDialog').showModal();
  $('#btPeriod').focus();
}

function init() {
  $('#btOpen').addEventListener('click', open);
  $('#btDialog [data-close]').addEventListener('click', () => { if (ctrl) ctrl.abort(); $('#btDialog').close(); });
  $('#btDialog').addEventListener('close', () => { if (ctrl) ctrl.abort(); });
  $('#btRun').addEventListener('click', runBacktest);
  $('#btCancel').addEventListener('click', () => ctrl && ctrl.abort());
}

Aura.backtestUI = { init, open };
})();
