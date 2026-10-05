/* =========================================================================
 * Aura Invest · Interfaz del backtest
 * Pide velas reales (1 crédito por valor), ejecuta Aura.backtest.run sin bloquear la
 * página y muestra los resultados tal cual, aunque sean peores que el azar: de un valor
 * (detalle completo) o de toda la watchlist (tabla comparativa).
 * ========================================================================= */
(() => {
'use strict';

const { $, esc, fmtNum, fmtSigned, fmtDate } = Aura.utils;
const { API } = Aura.config;
const { fetchDailyBars } = Aura.data;
const B = Aura.backtest;
const state = Aura.state;
const store = Aura.store;

const PERIODS = { 2: 800, 5: 1600, 10: 3200, weekly: 5000 };   // velas pedidas (incluye calentamiento)
const LABEL = { buy: 'Alcista', hold: 'Neutral', sell: 'Bajista' };
let ctrl = null;
let last = null;            // { mode, fee, results } del último backtest (para recalcular con otra comisión)

const pct = (v, d = 1) => (v == null || !Number.isFinite(v) ? '—' : `${fmtNum(v * 100, d)} %`);
const spct = (v, d = 2) => (v == null || !Number.isFinite(v) ? '—' : `${fmtSigned(v * 100, d)} %`);
const ciText = (ci, d = 1, signed = true) => (ci ? `[${(signed ? spct : pct)(ci[0], d)}; ${(signed ? spct : pct)(ci[1], d)}]` : 'pocos datos');
const rText = (v) => (v == null || !Number.isFinite(v) ? '—' : `${fmtSigned(v, 2)} R`);

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

/** Comisión del campo (en tanto por uno), o null si no es válida. Admite coma decimal. */
function feeValue() {
  const v = Number(String($('#btFee').value).trim().replace(',', '.'));
  return Number.isFinite(v) && v >= 0 && v <= 5 ? v / 100 : null;
}
const scopeIds = () => ($('#btScope').value === 'watchlist' ? Aura.watchlist.ids() : [state.symbol]);

function renderCost() {
  const n = scopeIds().length;
  $('#btSymbol').textContent = $('#btScope').value === 'watchlist' ? `watchlist (${n})` : state.symbol;
  $('#btCost').textContent = n === 1
    ? `Cuesta 1 crédito (${state.symbol}).`
    : `Cuesta ${n} créditos (1 por valor de la watchlist); con el límite de ${API.perMinute} por minuto puede tardar ${Math.ceil(n / API.perMinute)} min o más.`;
}

/* ---- Lecturas ---- */

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

/** ¿La diferencia con cualquier día es distinguible de cero con el IC del 90 %? */
function edge(action, d) {
  if (!d.n) return 'sin señales';
  if (!d.ci) return 'pocos datos para saberlo';
  const good = action === 'buy' ? d.ci[0] > 0 : d.ci[1] < 0;
  const bad = action === 'buy' ? d.ci[1] < 0 : d.ci[0] > 0;
  return good ? '<b>a favor de la señal</b>' : bad ? '<b>en contra de la señal</b>' : 'no se distingue de cualquier día';
}

const table = (id, caption, head, body) => `<div class="table-wrap" tabindex="0" role="region" aria-labelledby="${id}"><table class="pf-table">
  <caption id="${id}">${caption}</caption><thead>${head}</thead><tbody>${body}</tbody></table></div>`;

/* ---- Un valor: detalle ---- */

function renderOne(r, fee) {
  const { res, meta } = r;
  const s = res.summary, h = res.honest, md = res.mode;
  const days = s.days;
  const short = `${md.hShort} ${md.unitMany}`, long = `${md.hLong} ${md.unitMany}`;
  const row = (k, a) => {
    const b = s[k].by[a];
    return `<td class="num">${b.n}</td><td class="num">${spct(b.mean)}</td><td class="num">${a === 'hold' ? '—' : pct(b.hit)}</td>`;
  };
  const allRow = (k) => `<td class="num">${s[k].all.n}</td><td class="num">${spct(s[k].all.mean)}</td><td class="num">${pct(s[k].all.up)} sube</td>`;
  const t = s.touches.buy;
  const R = h.R;
  return `
    <p class="bt-summary"><b>${esc(meta.symbol)}</b> · ${days} ${md.unitMany} evaluadas (${esc(fmtDate(res.from))} – ${esc(fmtDate(res.to))}, velas ${md.key === 'weekly' ? 'semanales' : 'diarias'}) ·
      señales: Alcista ${s.counts.buy} (${pct(s.counts.buy / days, 0)}), Neutral ${s.counts.hold} (${pct(s.counts.hold / days, 0)}), Bajista ${s.counts.sell} (${pct(s.counts.sell / days, 0)}).
      ${r.stale ? '<br><span class="down-t">Twelve Data no responde: se han usado velas guardadas (antiguas).</span>' : ''}</p>
    <ul class="bt-verdicts">${['buy', 'sell'].map((a) => verdict(a, s.h21, short) + verdict(a, s.h63, long)).join('')}</ul>

    ${table('btT0', `¿Aporta algo la señal? Rentabilidad a ${long} frente a cualquier día`,
    '<tr><th scope="col">Señal</th><th scope="col" class="num">Casos</th><th scope="col" class="num">Diferencia</th><th scope="col" class="num">IC 90 %</th><th scope="col">Lectura</th></tr>',
    ['buy', 'sell'].map((a) => `<tr><th scope="row">${LABEL[a]}</th><td class="num">${h[a].n}</td><td class="num">${spct(h[a].delta)}</td><td class="num">${ciText(h[a].ci)}</td><td>${edge(a, h[a])}</td></tr>`).join(''))}
    <p class="hint">Los días seguidos comparten casi todo su futuro: ${s.h63.all.n} ${md.unitMany} con resultado equivalen a unos <b>${h.independent} periodos independientes</b> de ${long}.
      El intervalo del 90 % remuestrea tramos de ${long} seguidas, así que lo tiene en cuenta; si contiene el 0, la señal no se distingue de no hacer nada.</p>

    ${table('btT1', 'Rentabilidad y acierto tras cada señal',
    `<tr><th scope="col" rowspan="2">Señal</th><th scope="colgroup" colspan="3" class="num">${short} (≈ 1 mes)</th><th scope="colgroup" colspan="3" class="num">${long} (≈ 3 meses)</th></tr>
      <tr><th scope="col" class="num">Casos</th><th scope="col" class="num">Media</th><th scope="col" class="num">Acierto</th><th scope="col" class="num">Casos</th><th scope="col" class="num">Media</th><th scope="col" class="num">Acierto</th></tr>`,
    ['buy', 'hold', 'sell'].map((a) => `<tr><th scope="row">${LABEL[a]}</th>${row('h21', a)}${row('h63', a)}</tr>`).join('')
      + `<tr class="bt-base"><th scope="row">Cualquier día (comprar y mantener)</th>${allRow('h21')}${allRow('h63')}</tr>`)}
    <p class="hint">Acierto: Alcista acierta si el precio sube; Bajista, si baja. Frente a «no operar» (0 %), basta comparar la media con cero.</p>

    ${table('btT2', `Cono de previsión del 80 % a ${long}`,
    '<tr><th scope="col">Casos</th><th scope="col" class="num">Dentro</th><th scope="col" class="num">IC 90 %</th><th scope="col" class="num">Por encima</th><th scope="col" class="num">Por debajo</th></tr>',
    `<tr><td>${s.cone.n}</td><td class="num"><b>${pct(s.cone.inside)}</b> (debería rondar el 80 %)</td><td class="num">${ciText(h.cone.ci, 0, false)}</td><td class="num">${pct(s.cone.above)}</td><td class="num">${pct(s.cone.below)}</td></tr>`)}
    ${md.key === 'weekly' ? '<p class="hint">En semanal se mide a 13 semanas (65 sesiones), lo más cerca de las 63 sesiones del cono.</p>' : ''}

    ${table('btT3', `Qué se tocó antes en las ${long} siguientes`,
    '<tr><th scope="col">Señal</th><th scope="col" class="num">Casos</th><th scope="col" class="num">Objetivo</th><th scope="col" class="num">Stop</th><th scope="col" class="num">Ambos el mismo día</th><th scope="col" class="num">Ninguno</th></tr>',
    `<tr><th scope="row">${LABEL.buy}</th><td class="num">${t.n}</td><td class="num">${pct(t.target)}</td><td class="num">${pct(t.stop)}</td><td class="num">${pct(t.both)}</td><td class="num">${pct(t.none)}</td></tr>`)}
    <p class="hint">Solo cuentan las señales con ${long} ya transcurridas. Bajista no propone operación (ni objetivo ni stop), así que no aparece.
      ${R ? `Resultado medio de esas operaciones: <b>${rText(R.signal)}</b> (en múltiplos del riesgo; si se tocan objetivo y stop el mismo día cuenta como stop).
      La misma operación (stop a ${fmtNum(R.kAtr, 1)} ATR, riesgo/beneficio 1:${fmtNum(R.rr, 1)}) abierta cualquier día: <b>${rText(R.base)}</b>.
      Con un riesgo/beneficio de 1:${fmtNum(R.rr, 1)}, para no perder basta con tocar antes el objetivo un ${pct(1 / (1 + R.rr), 0)} de las veces.` : ''}</p>

    ${renderStrategies(res.strategies, fee, md)}

    <ul class="bt-caveats hint">
      <li>Cada vela se calcula con lo que se sabía entonces (sin datos futuros). Los resultados se muestran tal cual, aunque sean peores que el azar.</li>
      <li>Un periodo concreto; sin impuestos, dividendos ni deslizamiento. Rentabilidades pasadas no garantizan las futuras.</li>
    </ul>`;
}

function renderStrategies(list, fee, md) {
  return `${table('btT4', `Estrategias sencillas con la señal (comisión del ${fmtNum(fee * 100, 2)} % por compra o venta)`,
    '<tr><th scope="col">Estrategia</th><th scope="col" class="num">Rentabilidad anual</th><th scope="col" class="num">Caída máxima</th><th scope="col" class="num">Sharpe</th><th scope="col" class="num">Operaciones</th><th scope="col" class="num">Tiempo invertido</th></tr>',
    list.map((x) => `<tr${x.key === 'hold' ? ' class="bt-base"' : ''}><th scope="row">${esc(x.label)}</th><td class="num">${spct(x.cagr, 1)}</td><td class="num">${spct(x.maxDrawdown, 0)}</td><td class="num">${x.sharpe == null ? '—' : fmtNum(x.sharpe, 2)}</td><td class="num">${x.trades}</td><td class="num">${pct(x.exposure, 0)}</td></tr>`).join(''))}
    <p class="hint">La posición se decide al cierre con la señal de ese ${md.unitOne} y se aplica al siguiente. Sharpe anualizado, sin tipo de interés.</p>`;
}

/* ---- Varios valores: comparación ---- */

function renderMany(results, fee, mode) {
  const md = B.MODES[mode];
  const long = `${md.hLong} ${md.unitMany}`;
  const rows = results.map((r) => {
    if (r.error) return `<tr class="bt-err"><th scope="row">${esc(r.id)}</th><td colspan="7">${esc(r.error.message)}</td></tr>`;
    const s = r.res.summary, h = r.res.honest;
    const st = Object.fromEntries(r.res.strategies.map((x) => [x.key, x]));
    const cell = (a) => `${spct(h[a].delta, 1)}<br><small>${ciText(h[a].ci)}</small>`;
    return `<tr><th scope="row">${esc(r.id)}</th><td class="num">${s.days}</td>
      <td class="num">${pct(s.counts.buy / s.days, 0)} / ${pct(s.counts.hold / s.days, 0)} / ${pct(s.counts.sell / s.days, 0)}</td>
      <td class="num">${cell('buy')}</td><td class="num">${cell('sell')}</td>
      <td class="num">${pct(s.cone.inside, 1)}<br><small>${ciText(h.cone.ci, 0, false)}</small></td>
      <td class="num">${h.R ? `${rText(h.R.signal)}<br><small>base ${rText(h.R.base)}</small>` : '—'}</td>
      <td class="num">${spct(st.buyOnly.cagr, 1)}<br><small>mantener ${spct(st.hold.cagr, 1)}</small></td></tr>`;
  }).join('');
  return `${table('btTM', `Comparación de ${results.length} valores (${md.key === 'weekly' ? 'semanal, todo el histórico' : 'diario'})`,
    `<tr><th scope="col">Valor</th><th scope="col" class="num">${md.unitMany[0].toUpperCase() + md.unitMany.slice(1)}</th><th scope="col" class="num">Señales A/N/B</th>
      <th scope="col" class="num">Tras Alcista</th><th scope="col" class="num">Tras Bajista</th>
      <th scope="col" class="num">Cono 80 %</th><th scope="col" class="num">R Alcista</th><th scope="col" class="num">Solo Alcista</th></tr>`, rows)}
    <ul class="bt-caveats hint">
      <li>«Tras Alcista» y «Tras Bajista»: rentabilidad a ${long} tras la señal menos la de cualquier día, con su intervalo del 90 % debajo; si contiene el 0, la señal no se distingue de no hacer nada en ese valor.</li>
      <li>«Cono 80 %»: veces que el precio acabó dentro del cono (debería rondar el 80 %).</li>
      <li>«R de Alcista»: resultado medio de las operaciones Alcista en múltiplos del riesgo; «base»: la misma operación abierta cualquier día.</li>
      <li>«Solo Alcista»: rentabilidad anual invertido solo con señal Alcista, con una comisión del ${fmtNum(fee * 100, 2)} % por operación; debajo, la de comprar y mantener. Elige «Este valor» para ver el detalle.</li>
    </ul>`;
}

function render() {
  if (!last) return;
  const ok = last.results.filter((r) => !r.error);
  const html = last.results.length === 1
    ? (ok.length ? renderOne(ok[0], last.fee) : '')
    : renderMany(last.results, last.fee, last.mode);
  $('#btResults').innerHTML = html;
}

/** Al cambiar la comisión se recalculan las estrategias con las mismas velas (sin pedir nada). */
function onFee() {
  const fee = feeValue();
  $('#btFee').setAttribute('aria-invalid', String(fee == null));
  if (fee == null || !last) return;
  last.fee = fee;
  for (const r of last.results) if (!r.error) r.res.strategies = B.strategies(r.bars, r.res.rows, { fee, mode: last.mode });
  render();
}

async function runBacktest() {
  if (!store.getApiKey()) { status('Hace falta la clave de Twelve Data (Ajustes) para pedir velas reales.', 'err'); return; }
  const fee = feeValue();
  if (fee == null) { status('La comisión debe ser un número entre 0 y 5 (%).', 'err'); $('#btFee').focus(); return; }
  const period = $('#btPeriod').value;
  const mode = period === 'weekly' ? 'weekly' : 'daily';
  const ids = scopeIds();
  if (!ids.length) { status('La watchlist está vacía.', 'err'); return; }
  const many = ids.length > 1;
  ctrl = new AbortController();
  $('#btRun').disabled = true;
  $('#btCancel').hidden = false;
  $('#btResults').textContent = '';
  progress(0);
  const results = [];
  try {
    for (const [k, id] of ids.entries()) {
      const pre = many ? `(${k + 1}/${ids.length}) ` : '';
      status(`${pre}Pidiendo ${PERIODS[period]} velas ${mode === 'weekly' ? 'semanales' : 'diarias'} de ${id} a Twelve Data…`);
      try {
        const data = await fetchDailyBars(id, PERIODS[period], { interval: B.MODES[mode].interval, ...(many ? { ttl: 0 } : {}) });
        if (ctrl.signal.aborted) throw Object.assign(new Error('Backtest cancelado.'), { name: 'AbortError' });
        status(`${pre}Evaluando ${id} con el modelo…`);
        const res = await B.run(data.bars, data.meta, { mode, fee, signal: ctrl.signal, onProgress: (p) => progress((k + p) / ids.length) });
        results.push({ id, meta: data.meta, bars: data.bars, res, stale: data.source.stale });
      } catch (err) {
        if (err.name === 'AbortError') throw err;
        results.push({ id, error: err });
      }
    }
    last = { mode, fee, results };
    render();
    const failed = results.filter((r) => r.error);
    if (!many && failed.length) status(`No se pudo hacer el backtest: ${failed[0].error.message}`, 'err');
    else status(`Backtest terminado: ${results.length - failed.length} de ${results.length} ${results.length === 1 ? 'valor' : 'valores'}${failed.length ? ` (${failed.length} con error)` : ''}.`, failed.length ? 'err' : 'ok');
    if (results.length - failed.length) $('#btResults').focus();
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
  status('');
  renderCost();
  $('#btDialog').showModal();
  $('#btScope').focus();
}

function init() {
  $('#btOpen').addEventListener('click', open);
  $('#btDialog [data-close]').addEventListener('click', () => { if (ctrl) ctrl.abort(); $('#btDialog').close(); });
  $('#btDialog').addEventListener('close', () => { if (ctrl) ctrl.abort(); });
  $('#btRun').addEventListener('click', runBacktest);
  $('#btCancel').addEventListener('click', () => ctrl && ctrl.abort());
  $('#btScope').addEventListener('change', renderCost);
  $('#btFee').addEventListener('input', onFee);
}

Aura.backtestUI = { init, open };
})();
