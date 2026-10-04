/* =========================================================================
 * Aura Invest · Vista «Cartera»
 * Carga cotizaciones, cierres diarios y tipos de cambio REALES de Twelve Data,
 * calcula con Aura.portfolio (FIFO) y pinta: resumen, posiciones, reparto,
 * evolución y operaciones (alta, edición, borrado con deshacer, importar y
 * exportar). Sin clave de API solo se muestran las operaciones y su coste en
 * la divisa original: nunca precios ni tipos de cambio inventados.
 * ========================================================================= */
(() => {
'use strict';

const { LWC, COLORS, CHART_BG } = Aura.config;
const { $, esc, fmtNum, fmtPct, fmtPrice, fmtSigned, fmtLocalDateTime, fmtLocalTime, fmtAgo, arrow, dirClass, MONTHS } = Aura.utils;
const { fetchQuotes, fetchDailyHistory, precisionFor, knownInstrument } = Aura.data;
const portfolio = Aura.portfolio;
const store = Aura.store;

let handlers = { openSymbol: () => {} };
let editingId = null;
let loaded = null;          // último conjunto de datos de mercado { quotes, fxHist, symHist, at }
let chart = null, valueSeries = null, investedSeries = null, lastPoints = [];
let reqId = 0;

const today = () => new Date().toISOString().slice(0, 10);
const uniq = (a) => [...new Set(a)];
const base = () => portfolio.baseCurrency();
const money = (v, cur = base()) => (Number.isFinite(v) ? fmtPrice(v, { currency: cur, precision: 2 }) : '—');
function smoney(v, cur = base()) {
  if (!Number.isFinite(v)) return '—';
  const r = Number(v.toFixed(2));
  return `${r > 0 ? '+' : r < 0 ? '−' : ''}${fmtPrice(Math.abs(r), { currency: cur, precision: 2 })}`;
}
const qty = (v) => (Number.isFinite(v) ? new Intl.NumberFormat('es-ES', { maximumFractionDigits: 8 }).format(v) : '—');
const dayText = (d) => { const [y, m, dd] = d.split('-').map(Number); return `${dd} ${MONTHS[m - 1]} ${y}`; };
const isErr = (x) => x instanceof Error;
/** Importe en la base o, si no hay tipo de cambio, en su divisa original marcado como tal. */
function baseOrLocal(vBase, vLocal, cur, signed = false) {
  if (Number.isFinite(vBase)) return signed ? smoney(vBase) : money(vBase);
  if (!Number.isFinite(vLocal)) return '—';
  return `${signed ? smoney(vLocal, cur) : money(vLocal, cur)}<br><small class="muted">sin convertir</small>`;
}

/* ---------------------------------------------------------------------------
 * Datos de mercado
 * ------------------------------------------------------------------------- */

async function loadMarket(txs, { force = false } = {}) {
  if (!store.getApiKey() || !txs.length) return null;
  const b = base();
  const first = txs.map((t) => t.date).sort()[0];
  const symbols = uniq(txs.map((t) => t.symbol));
  const currencies = uniq(txs.map((t) => t.currency)).filter((c) => c !== b);
  const pairs = currencies.map((c) => `${b}/${c}`);
  const held = portfolio.ledger(txs, { base: b }).positions.filter((p) => p.quantity > 0).map((p) => p.symbol);

  const quotesP = fetchQuotes([...held, ...pairs], { priority: 2, force });
  const fxHist = new Map(), symHist = new Map();
  for (const c of currencies) fxHist.set(c, await fetchDailyHistory(`${b}/${c}`, first, { priority: 2 }).catch((e) => e));
  for (const s of symbols) symHist.set(s, await fetchDailyHistory(s, first, { priority: 1 }).catch((e) => e));
  return { quotes: await quotesP, fxHist, symHist, pairs, at: Date.now() };
}

/* ---------------------------------------------------------------------------
 * Cálculo con los datos disponibles
 * ------------------------------------------------------------------------- */

function compute() {
  const txs = portfolio.transactions();
  const b = base();
  const m = loaded;
  const fxCloses = (c) => (m && m.fxHist.get(c) && !isErr(m.fxHist.get(c)) ? m.fxHist.get(c).closes : null);
  const fx = (c, date) => portfolio.rateOn(fxCloses(c), date);
  const fxNow = (c) => {
    if (!m) return null;
    const q = m.quotes.get(`${b}/${c}`);
    if (q && !isErr(q) && Number.isFinite(q.price)) return { rate: q.price, at: q.lastQuoteAt, stale: q.stale, source: 'quote' };
    const closes = fxCloses(c);
    return closes && closes.length ? { rate: closes.at(-1).close, date: closes.at(-1).date, source: 'close' } : null;
  };
  const led = portfolio.ledger(txs, { base: b, fx });

  // Cotizaciones por símbolo, comprobando que la divisa coincide con la de las operaciones
  const quotes = new Map();
  const warnings = [];
  for (const p of led.positions.filter((x) => x.quantity > 0)) {
    const q = m ? m.quotes.get(p.symbol) : null;
    if (!q) continue;
    if (isErr(q)) { warnings.push(`${p.symbol}: sin cotización (${q.message})`); continue; }
    if (q.meta && q.meta.currency && q.meta.currency !== p.currency) {
      warnings.push(`${p.symbol}: tus operaciones están en ${p.currency}, pero cotiza en ${q.meta.currency}; no se valora para no mezclar divisas.`);
      continue;
    }
    if (q.stale) warnings.push(`${p.symbol}: cotización antigua (${fmtAgo(q.at)}).`);
    quotes.set(p.symbol, q);
  }
  const val = portfolio.valuate(led, { quotes, fxNow, base: b });

  let evo = { points: [], missing: [] };
  if (m) {
    const closes = new Map(), fxSeries = new Map();
    m.symHist.forEach((h, s) => { if (!isErr(h)) closes.set(s, h.closes); else warnings.push(`${s}: sin histórico diario (${h.message})`); });
    m.fxHist.forEach((h, c) => { if (!isErr(h)) fxSeries.set(c, h.closes); else warnings.push(`${b}/${c}: sin tipos de cambio (${h.message})`); });
    m.symHist.forEach((h, s) => { if (!isErr(h) && !h.complete) warnings.push(`${s}: Twelve Data no llega hasta tu primera operación; la evolución empieza el ${dayText(h.from)}.`); });
    evo = portfolio.evolution(txs, { closes, fxSeries, rows: led.rows, base: b });
  }
  led.errors.forEach((e) => warnings.push(e.message));
  return { txs, led, val, evo, fxNow, warnings };
}

/* ---------------------------------------------------------------------------
 * Pintado
 * ------------------------------------------------------------------------- */

function renderStatus(c) {
  const items = [];
  if (!store.getApiKey()) {
    items.push('<span class="st-warn">Sin clave de API: se muestran tus operaciones y su coste en la divisa original, sin valor actual ni conversión a la moneda base.</span>');
  } else if (loaded) {
    items.push(`Cotizaciones, cierres y tipos de cambio de <b>Twelve Data</b>, obtenidos a las <b>${fmtLocalTime(loaded.at)}</b>.`);
  }
  c.warnings.forEach((w) => items.push(`<span class="st-warn">${esc(w)}</span>`));
  $('#pfStatus').innerHTML = items.map((i) => `<p>${i}</p>`).join('');

  const b = base();
  const curs = uniq(c.txs.map((t) => t.currency)).filter((x) => x !== b);
  $('#pfFx').textContent = !curs.length
    ? `Moneda base: ${b}.`
    : curs.map((cur) => {
      const r = c.fxNow(cur);
      if (!r) return `Sin tipo de cambio ${b}/${cur} disponible.`;
      const when = r.source === 'quote' ? `cotización de ${fmtLocalDateTime(r.at)}${r.stale ? ', antigua' : ''}` : `cierre del ${dayText(r.date)}`;
      return `Valor actual con 1 ${b} = ${fmtNum(r.rate, 4)} ${cur} (Twelve Data, ${when}). Cada operación usa el tipo de su fecha (columna «Tipo»).`;
    }).join(' ');
}

function tile(label, value, sub = '', cls = '') {
  return `<div class="pf-tile"><span class="pf-tile-label">${label}</span><span class="pf-tile-val ${cls}">${value}</span>${sub ? `<span class="pf-tile-sub">${sub}</span>` : ''}</div>`;
}

function renderSummary(c) {
  const t = c.val.totals;
  const ok = c.val.complete && loaded;
  const show = (v) => (ok ? v : '—');
  const why = !store.getApiKey() ? 'sin clave de API' : 'faltan cotizaciones o tipos de cambio';
  $('#pfSummary').innerHTML = [
    tile('Valor actual', show(money(t.value)), ok ? '' : why),
    tile('Coste de lo que tienes', Number.isFinite(t.cost) ? money(t.cost) : '—', Number.isFinite(t.cost) ? '' : `sin convertir a ${base()}`),
    tile('Ganancia latente', show(smoney(t.unrealized)), ok && t.unrealizedPct != null ? fmtPct(t.unrealizedPct) : '', ok ? dirClass(t.unrealized) : ''),
    tile('Ganancia realizada', Number.isFinite(t.realized) ? smoney(t.realized) : '—', '', Number.isFinite(t.realized) ? dirClass(t.realized) : ''),
    tile('Dividendos', Number.isFinite(t.dividends) ? money(t.dividends) : '—'),
    tile('Resultado total', show(smoney(t.total)), 'latente + realizada + dividendos', ok ? dirClass(t.total) : ''),
  ].join('');
}

function renderPositions(c) {
  const b = base();
  const items = c.val.items.slice().sort((x, y) => (y.quantity > 0) - (x.quantity > 0) || (y.valueBase || 0) - (x.valueBase || 0));
  if (!items.length) {
    $('#pfPositions').innerHTML = '<caption class="sr-only">Posiciones</caption><tbody><tr><td class="empty-row">Todavía no hay operaciones. Añade tu primera compra abajo.</td></tr></tbody>';
    return;
  }
  const rows = items.map((i) => {
    const closed = i.quantity === 0;
    const pricePrec = i.price != null ? precisionFor(i.price) : 2;
    return `<tr class="${closed ? 'is-closed' : ''}">
      <th scope="row"><button type="button" class="link-btn sym-btn" data-open="${esc(i.symbol)}" title="Ver ${esc(i.symbol)} en Mercado">${esc(i.symbol)}</button>${closed ? ' <span class="muted">(cerrada)</span>' : ''}</th>
      <td class="num">${qty(i.quantity)}</td>
      <td class="num">${i.price != null ? esc(fmtPrice(i.price, { currency: i.currency, precision: pricePrec })) : '—'}</td>
      <td class="num">${closed ? '—' : money(i.valueBase)}</td>
      <td class="num">${closed ? '—' : baseOrLocal(i.costBase, i.costLocal, i.currency)}</td>
      <td class="num ${i.unrealizedBase != null ? dirClass(i.unrealizedBase) : ''}">${closed ? '—' : `${smoney(i.unrealizedBase)}${i.unrealizedPct != null ? `<br><small>${fmtPct(i.unrealizedPct)}</small>` : ''}`}</td>
      <td class="num ${Number.isFinite(i.realizedBase) && Math.abs(i.realizedBase) >= 0.005 ? dirClass(i.realizedBase) : ''}">${baseOrLocal(i.realizedBase, i.realizedLocal, i.currency, true)}${i.realizedPct != null ? `<br><small>${fmtPct(i.realizedPct)}</small>` : ''}</td>
      <td class="num">${baseOrLocal(i.dividendsBase, i.dividendsLocal, i.currency)}</td>
      <td class="num">${i.weight != null ? `${fmtNum(i.weight, 1)} %` : '—'}</td>
      <td class="num muted">${i.avgCostPerShare != null ? esc(fmtPrice(i.avgCostPerShare, { currency: i.currency, precision: precisionFor(i.avgCostPerShare) })) : '—'}</td>
    </tr>`;
  }).join('');
  const t = c.val.totals;
  $('#pfPositions').innerHTML = `
    <caption class="sr-only">Posiciones de la cartera en ${b}</caption>
    <thead><tr>
      <th scope="col">Valor</th><th scope="col" class="num">Cantidad</th><th scope="col" class="num">Precio</th>
      <th scope="col" class="num">Valor (${b})</th><th scope="col" class="num">Coste FIFO (${b})</th>
      <th scope="col" class="num">Latente</th><th scope="col" class="num">Realizada</th><th scope="col" class="num">Dividendos</th>
      <th scope="col" class="num">Peso</th><th scope="col" class="num" title="Solo informativo">Coste medio*</th>
    </tr></thead>
    <tbody>${rows}</tbody>
    <tfoot><tr>
      <th scope="row">Total</th><td></td><td></td>
      <td class="num">${c.val.complete && loaded ? money(t.value) : '—'}</td><td class="num">${money(t.cost)}</td>
      <td class="num ${dirClass(t.unrealized)}">${c.val.complete && loaded ? smoney(t.unrealized) : '—'}</td>
      <td class="num ${dirClass(t.realized)}">${smoney(t.realized)}</td><td class="num">${money(t.dividends)}</td><td></td><td></td>
    </tr></tfoot>`;
}

function renderAllocation(c) {
  const open = c.val.items.filter((i) => i.quantity > 0 && i.weight != null).sort((a, b) => b.weight - a.weight);
  $('#pfAllocTag').textContent = open.length ? `${open.length} posiciones` : '';
  $('#pfAlloc').innerHTML = open.length ? open.map((i) => `
    <li aria-label="${esc(`${i.symbol}: ${fmtNum(i.weight, 1)} %, ${money(i.valueBase)}`)}">
      <span class="alloc-sym">${esc(i.symbol)}</span>
      <span class="alloc-bar" aria-hidden="true"><i style="width:${Math.max(1, i.weight).toFixed(1)}%"></i></span>
      <span class="alloc-pct mono">${fmtNum(i.weight, 1)} %</span>
      <span class="alloc-val mono">${money(i.valueBase)}</span>
    </li>`).join('') : `<li class="ml-empty">${c.val.items.some((i) => i.quantity > 0) ? 'El reparto necesita cotizaciones y tipos de cambio reales.' : 'Sin posiciones abiertas.'}</li>`;
}

function ensureChart() {
  if (chart || !LWC) return;
  chart = LWC.createChart($('#pfChart'), {
    autoSize: true,
    layout: { background: { type: 'solid', color: CHART_BG }, textColor: COLORS.text, fontFamily: "'JetBrains Mono', ui-monospace, monospace", fontSize: 11, attributionLogo: true },
    grid: { vertLines: { color: COLORS.grid }, horzLines: { color: COLORS.grid } },
    rightPriceScale: { borderColor: COLORS.border },
    timeScale: { borderColor: COLORS.border },
    localization: { locale: 'es-ES', priceFormatter: (v) => fmtNum(v, 0) },
    crosshair: { mode: LWC.CrosshairMode.Magnet },
  });
  valueSeries = chart.addAreaSeries({ lineColor: COLORS.aura, topColor: 'rgba(139,108,240,0.28)', bottomColor: 'rgba(139,108,240,0.02)', lineWidth: 2, priceLineVisible: false });
  investedSeries = chart.addLineSeries({ color: 'rgba(199,203,224,0.6)', lineWidth: 1, lineStyle: LWC.LineStyle.Dashed, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
  chart.subscribeCrosshairMove((param) => {
    const t = param.time;
    const p = t != null ? lastPoints.find((x) => x.time === t) : lastPoints.at(-1);
    legend(p);
  });
}

function legend(p) {
  $('#pfEvoLegend').innerHTML = p
    ? `<span class="lg-item"><i style="background:${COLORS.aura}"></i>Valor <b>${money(p.value)}</b></span>
       <span class="lg-item"><i class="dash" style="border-color:rgba(199,203,224,0.6)"></i>Aportado neto <b>${money(p.invested)}</b></span>
       <span class="muted">${dayText(p.date)}</span>`
    : '';
}

function renderEvolution(c) {
  const pts = c.evo.points;
  $('#pfEvoTag').textContent = pts.length ? `${dayText(pts[0].date)} – ${dayText(pts.at(-1).date)}` : '';
  $('#pfEvoNote').textContent = pts.length
    ? `Valor diario de tus posiciones en ${base()} con cierres y tipos de cambio reales de cada día. «Aportado neto» = compras menos ventas; los dividendos y el efectivo no se incluyen.`
    : (store.getApiKey() ? 'Sin cierres diarios todavía.' : 'La evolución necesita cierres diarios reales (clave de API).');
  if (!pts.length) { $('#pfChart').hidden = true; legend(null); return; }
  $('#pfChart').hidden = false;
  ensureChart();
  if (!chart) return;
  lastPoints = pts.map((p) => ({ ...p, time: Date.parse(`${p.date}T00:00:00Z`) / 1000 }));
  valueSeries.setData(lastPoints.map((p) => ({ time: p.time, value: p.value })));
  investedSeries.setData(lastPoints.map((p) => ({ time: p.time, value: p.invested })));
  chart.timeScale().fitContent();
  legend(lastPoints.at(-1));
  const last = lastPoints.at(-1);
  $('#pfChart').setAttribute('role', 'img');
  $('#pfChart').setAttribute('aria-label', `Evolución del valor de la cartera desde el ${dayText(pts[0].date)}: valor actual ${money(last.value)}, aportado neto ${money(last.invested)}.`);
}

function renderTransactions(c) {
  const txs = portfolio.chronological(c.txs).reverse();
  const b = base();
  if (!txs.length) { $('#pfTxTable').innerHTML = '<caption class="sr-only">Operaciones</caption><tbody><tr><td class="empty-row">Sin operaciones.</td></tr></tbody>'; return; }
  const rows = txs.map((t) => {
    const r = c.led.rows.get(t.id);
    const rate = !r ? '<span class="st-warn">error</span>'
      : r.rateSource === 'base' ? '—'
      : r.rate == null ? 'sin dato'
      : `${fmtNum(r.rate, 4)}<br><small>${r.rateSource === 'manual' ? 'manual' : esc(dayText(r.rateDate))}</small>`;
    const amount = r && Number.isFinite(r.amountBase) ? smoney(r.amountBase, b) : '—';
    const result = r && Number.isFinite(r.realizedBase) ? `<span class="${dirClass(r.realizedBase)}">${smoney(r.realizedBase, b)}</span>` : '';
    return `<tr data-id="${esc(t.id)}">
      <td>${esc(dayText(t.date))}</td><td>${portfolio.TYPE_TEXT[t.type]}</td>
      <th scope="row">${esc(t.symbol)}${t.note ? `<br><small class="muted">${esc(t.note)}</small>` : ''}</th>
      <td class="num">${qty(t.quantity)}</td><td class="num">${esc(fmtPrice(t.price, { currency: t.currency, precision: precisionFor(t.price) }))}</td>
      <td class="num">${esc(fmtPrice(t.fees, { currency: t.currency, precision: 2 }))}</td><td>${esc(t.currency)}</td>
      <td class="num">${rate}</td><td class="num">${amount}</td><td class="num">${result}</td>
      <td class="actions"><button type="button" class="btn btn-sm" data-act="edit" aria-label="Editar ${esc(portfolio.TYPE_TEXT[t.type].toLowerCase())} de ${esc(t.symbol)} del ${esc(dayText(t.date))}">Editar</button>
        <button type="button" class="btn btn-sm danger" data-act="remove" aria-label="Borrar ${esc(portfolio.TYPE_TEXT[t.type].toLowerCase())} de ${esc(t.symbol)} del ${esc(dayText(t.date))}">Borrar</button></td>
    </tr>`;
  }).join('');
  $('#pfTxTable').innerHTML = `
    <caption class="sr-only">Operaciones, de la más reciente a la más antigua</caption>
    <thead><tr><th scope="col">Fecha</th><th scope="col">Tipo</th><th scope="col">Valor</th><th scope="col" class="num">Cantidad</th>
      <th scope="col" class="num">Precio</th><th scope="col" class="num">Comisiones</th><th scope="col">Divisa</th>
      <th scope="col" class="num">Tipo (1 ${b})</th><th scope="col" class="num">Importe (${b})</th><th scope="col" class="num">Resultado</th>
      <th scope="col"><span class="sr-only">Acciones</span></th></tr></thead>
    <tbody>${rows}</tbody>`;
}

function renderUndo() {
  const b = $('#pfUndo');
  b.disabled = !portfolio.canUndo();
  b.textContent = 'Deshacer';
  b.setAttribute('aria-label', portfolio.canUndo() ? `Deshacer: ${portfolio.undoLabel()}` : 'Nada que deshacer');
  b.title = portfolio.canUndo() ? `Deshacer: ${portfolio.undoLabel()}` : '';
}

function render() {
  const c = compute();
  $('#pfBase').value = base();
  renderStatus(c);
  renderSummary(c);
  renderPositions(c);
  renderAllocation(c);
  renderEvolution(c);
  renderTransactions(c);
  renderUndo();
  syncSymbolList();
}

/** Carga datos reales (si hay clave) y pinta. */
async function refresh({ force = false } = {}) {
  const id = ++reqId;
  $('#viewPortfolio').classList.add('is-loading');
  render();                                            // primero lo que se sabe sin red
  try {
    const m = await loadMarket(portfolio.transactions(), { force });
    if (id !== reqId) return;
    loaded = m;
    render();
  } finally {
    if (id === reqId) $('#viewPortfolio').classList.remove('is-loading');
  }
}

/* ---------------------------------------------------------------------------
 * Formulario de operaciones
 * ------------------------------------------------------------------------- */

function setMsg(text, kind = '', withUndo = false) {
  const el = $('#txMsg');
  el.className = `key-status span-all ${kind}`;
  el.textContent = text;
  if (withUndo && portfolio.canUndo()) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'link-btn';
    b.textContent = 'Deshacer';
    b.addEventListener('click', undo);
    el.append(' ', b);
  }
}

function syncSymbolList() {
  const ids = uniq([...portfolio.transactions().map((t) => t.symbol), ...Aura.watchlist.ids()]);
  $('#txSymbols').innerHTML = ids.map((id) => `<option value="${esc(id)}"></option>`).join('');
}

function syncFormLabels() {
  const type = $('#txType').value;
  const cur = $('#txCurrency').value.trim().toUpperCase() || '…';
  const b = base();
  $('#txQtyLabel').textContent = type === 'dividend' ? 'Acciones que cobran' : 'Cantidad (acciones)';
  $('#txPriceLabel').textContent = type === 'dividend' ? `Dividendo por acción (${cur})` : `Precio por acción (${cur})`;
  $('#txFeesLabel').textContent = type === 'dividend' ? `Retenciones y comisiones (${cur})` : `Comisiones (${cur})`;
  $('#txFxLabel').textContent = `Tipo de cambio (opcional): ${cur} por 1 ${b}`;
  $('#txFxHint').textContent = cur === b
    ? ''
    : `Si lo dejas vacío se usa el cierre ${b}/${cur} de Twelve Data de esa fecha (o del día anterior disponible). Rellénalo si tu bróker aplicó otro tipo.`;
}

/** Divisa del valor: de la watchlist, de lo aprendido en búsquedas o de operaciones anteriores. */
function currencyFor(sym) {
  const prev = portfolio.transactions().find((t) => t.symbol === sym);
  if (prev) return prev.currency;
  const w = Aura.watchlist.items().find((x) => x.id === sym);
  if (w && w.currency) return w.currency;
  const info = knownInstrument(sym);
  return info && info.currency ? info.currency : '';
}

function readForm() {
  return {
    type: $('#txType').value, symbol: $('#txSymbol').value, date: $('#txDate').value,
    quantity: $('#txQty').value, price: $('#txPrice').value, fees: $('#txFees').value,
    currency: $('#txCurrency').value, fxRate: $('#txFx').value, note: $('#txNote').value,
  };
}

function resetForm() {
  editingId = null;
  $('#txForm').reset();
  $('#txDate').value = today();
  $('#txDate').max = today();
  $('#txFormTitle').textContent = 'Nueva operación';
  $('#txSave').textContent = 'Añadir operación';
  $('#txCancel').hidden = true;
  syncFormLabels();
}

function startEdit(t) {
  editingId = t.id;
  $('#txType').value = t.type;
  $('#txSymbol').value = t.symbol;
  $('#txDate').value = t.date;
  $('#txQty').value = String(t.quantity).replace('.', ',');
  $('#txPrice').value = String(t.price).replace('.', ',');
  $('#txFees').value = String(t.fees).replace('.', ',');
  $('#txCurrency').value = t.currency;
  $('#txFx').value = t.fxRate != null ? String(t.fxRate).replace('.', ',') : '';
  $('#txNote').value = t.note || '';
  $('#txFormTitle').textContent = 'Editar operación';
  $('#txSave').textContent = 'Guardar cambios';
  $('#txCancel').hidden = false;
  syncFormLabels();
  setMsg('');
  $('#txType').focus();
}

function undo() {
  const res = portfolio.undo();
  if (res.ok) { setMsg(`Deshecho: ${res.label}.`, 'ok'); resetForm(); }
}

/* ---------------------------------------------------------------------------
 * Importar y exportar
 * ------------------------------------------------------------------------- */

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

let pendingImport = null;
async function onImportFile(file) {
  if (!file) return;
  if (file.size > 2_000_000) { setMsg('El archivo es demasiado grande para una cartera (máx. 2 MB).', 'err'); return; }
  const res = portfolio.parseImport(await file.text());
  if (!res.ok) { setMsg(`No se puede importar: ${res.error}`, 'err'); return; }
  pendingImport = res.data;
  const p = res.preview;
  $('#impPreview').innerHTML = `
    <dl class="kv">
      <dt>Operaciones en el archivo</dt><dd>${p.count}</dd>
      <dt>Operaciones actuales que se reemplazan</dt><dd>${p.replaces}</dd>
      <dt>Valores</dt><dd>${esc(p.symbols.join(', ') || '—')}</dd>
      <dt>Fechas</dt><dd>${p.from ? `${esc(dayText(p.from))} – ${esc(dayText(p.to))}` : '—'}</dd>
      <dt>Moneda base</dt><dd>${esc(p.baseCurrency)}</dd>
    </dl>`;
  $('#importDialog').showModal();
  $('#impCancel').focus();
}

/* ---------------------------------------------------------------------------
 * Inicialización
 * ------------------------------------------------------------------------- */

function init(h) {
  handlers = { ...handlers, ...h };
  resetForm();
  portfolio.onChange(() => { if (!$('#viewPortfolio').hidden) refresh(); });

  $('#txType').addEventListener('change', syncFormLabels);
  $('#txCurrency').addEventListener('input', syncFormLabels);
  $('#txSymbol').addEventListener('change', () => {
    const sym = $('#txSymbol').value.trim().toUpperCase();
    $('#txSymbol').value = sym;
    if (!$('#txCurrency').value) { $('#txCurrency').value = currencyFor(sym); syncFormLabels(); }
  });
  $('#txForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = readForm();
    const res = editingId ? portfolio.update(editingId, input) : portfolio.add(input);
    if (!res.ok) { setMsg(res.error, 'err'); return; }
    const verb = editingId ? 'Operación actualizada' : 'Operación añadida';
    const t = res.tx;
    resetForm();
    setMsg(`${verb}: ${portfolio.TYPE_TEXT[t.type].toLowerCase()} de ${qty(t.quantity)} ${t.symbol} el ${dayText(t.date)}.`, 'ok', true);
    $('#txType').focus();
  });
  $('#txCancel').addEventListener('click', () => { resetForm(); setMsg('Edición cancelada.'); $('#txType').focus(); });

  $('#pfTxTable').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const t = portfolio.get(btn.closest('tr').dataset.id);
    if (!t) return;
    if (btn.dataset.act === 'edit') { startEdit(t); return; }
    const res = portfolio.remove(t.id);
    if (!res.ok) { setMsg(res.error, 'err'); return; }
    if (editingId === t.id) resetForm();
    setMsg(`Operación borrada: ${portfolio.TYPE_TEXT[t.type].toLowerCase()} de ${t.symbol} del ${dayText(t.date)}.`, 'ok', true);
    const undoBtn = $('#txMsg button');
    if (undoBtn) undoBtn.focus();
  });
  $('#pfPositions').addEventListener('click', (e) => {
    const b = e.target.closest('[data-open]');
    if (b) handlers.openSymbol(b.dataset.open);
  });

  $('#pfUndo').addEventListener('click', undo);
  $('#pfRefresh').addEventListener('click', () => refresh({ force: true }));
  $('#pfBase').addEventListener('change', (e) => {
    const res = portfolio.setBaseCurrency(e.target.value);
    if (!res.ok) setMsg(res.error, 'err'); else setMsg(`Moneda base: ${e.target.value}.`, 'ok', true);
  });
  $('#pfExportJson').addEventListener('click', () => {
    download(`aura-cartera-${today()}.json`, portfolio.exportJSON(), 'application/json');
    setMsg('Cartera exportada en JSON (sin la clave de API ni otros datos).', 'ok');
  });
  $('#pfExportCsv').addEventListener('click', () => {
    download(`aura-operaciones-${today()}.csv`, portfolio.exportCSV(), 'text/csv;charset=utf-8');
    setMsg('Operaciones exportadas en CSV (separador «;» y coma decimal).', 'ok');
  });
  $('#pfImportBtn').addEventListener('click', () => $('#pfImportFile').click());
  $('#pfImportFile').addEventListener('change', (e) => { onImportFile(e.target.files[0]); e.target.value = ''; });
  $('#impCancel').addEventListener('click', () => { pendingImport = null; $('#importDialog').close(); setMsg('Importación cancelada.'); });
  $('#importDialog [data-close]').addEventListener('click', () => { pendingImport = null; $('#importDialog').close(); });
  $('#impConfirm').addEventListener('click', () => {
    if (!pendingImport) return;
    const res = portfolio.replaceAll(pendingImport);
    pendingImport = null;
    $('#importDialog').close();
    if (res.ok) { resetForm(); setMsg('Cartera importada.', 'ok', true); } else setMsg(`No se puede importar: ${res.error}`, 'err');
    $('#pfImportBtn').focus();
  });
}

Aura.portfolioUI = { init, refresh, render, onImportFile };
})();
