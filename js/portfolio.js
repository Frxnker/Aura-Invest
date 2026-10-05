/* =========================================================================
 * Aura Invest · Cartera (cálculos y persistencia)
 *
 * Operaciones manuales: compra, venta y dividendo, con fecha, cantidad, precio,
 * comisiones y divisa (y, opcionalmente, el tipo de cambio aplicado por el bróker).
 *
 * Reglas de cálculo:
 * - Coste FIFO (decisión del usuario): cada venta consume primero las acciones más
 *   antiguas. El coste incluye las comisiones de compra; las comisiones de venta
 *   reducen el importe obtenido. El coste medio se calcula aparte, solo como dato.
 * - Orden: por fecha; dentro del mismo día, compras, después dividendos y después
 *   ventas (no se conoce la hora), y en caso de empate, el orden en que se anotaron.
 * - Divisas: los importes se pasan a la moneda base (EUR por defecto) con el tipo
 *   del día de cada operación (`fxRate` manual o el cierre de Twelve Data de ese día
 *   o el anterior disponible). El valor actual usa el tipo actual. Un tipo de cambio
 *   r significa "r unidades de la divisa por 1 unidad de la base" (EUR/USD = 1,17).
 * - No se puede vender más de lo que se tiene en esa fecha, tampoco al editar o
 *   borrar operaciones anteriores.
 * ========================================================================= */
(() => {
'use strict';

const store = Aura.store;

const EPS = 1e-9;
const TX_TYPES = ['buy', 'sell', 'dividend'];
const TYPE_ORDER = { buy: 0, dividend: 1, sell: 2 };
const TYPE_TEXT = { buy: 'Compra', sell: 'Venta', dividend: 'Dividendo' };
const ID_FORMAT = /^[A-Za-z0-9.\-/:^]{1,24}$/;
const CUR_FORMAT = /^[A-Z]{3}$/;
const EXPORT_KIND = 'aura-portfolio';
const EXPORT_VERSION = 1;
const UNDO_MAX = 20;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
let idSeq = 0;
const newId = () => (globalThis.crypto && typeof crypto.randomUUID === 'function'
  ? crypto.randomUUID()
  : `t${Date.now().toString(36)}${(++idSeq).toString(36)}`);
const todayISO = () => new Date().toISOString().slice(0, 10);
const validDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '') && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
const decimals = (v) => { const s = String(v); const i = s.indexOf('.'); return i < 0 || /e/i.test(s) ? 0 : s.length - i - 1; };
const fmtQ = (v) => new Intl.NumberFormat('es-ES', { maximumFractionDigits: 8 }).format(v);
const fmtDay = (d) => { const [y, m, dd] = d.split('-').map(Number); return `${dd} ${Aura.utils.MONTHS[m - 1]} ${y}`; };

/* ---------------------------------------------------------------------------
 * Validación
 * ------------------------------------------------------------------------- */

/** Normaliza lo que llega de un formulario o de un archivo. */
function normalize(t) {
  const num = (v) => (typeof v === 'number' ? v : v === '' || v == null ? NaN : Number(String(v).replace(',', '.')));
  const out = {
    id: typeof t.id === 'string' && t.id ? t.id : newId(),
    type: t.type, symbol: String(t.symbol || '').trim().toUpperCase(), date: String(t.date || '').trim(),
    quantity: num(t.quantity), price: num(t.price), fees: t.fees === '' || t.fees == null ? 0 : num(t.fees),
    currency: String(t.currency || '').trim().toUpperCase(),
  };
  const fx = t.fxRate === '' || t.fxRate == null ? null : num(t.fxRate);
  if (fx != null) out.fxRate = fx;
  const note = typeof t.note === 'string' ? t.note.trim().slice(0, 200) : '';
  if (note) out.note = note;
  return out;
}

/** Comprueba una operación aislada. Devuelve el mensaje de error o null. */
function validateTx(t, today = todayISO()) {
  if (!TX_TYPES.includes(t.type)) return 'Elige el tipo de operación.';
  if (!ID_FORMAT.test(t.symbol || '')) return 'Indica el valor (ticker), p. ej. AAPL.';
  if (!validDate(t.date)) return 'Indica una fecha válida.';
  if (t.date > today) return 'La fecha no puede ser futura.';
  if (!(Number.isFinite(t.quantity) && t.quantity > 0)) {
    return t.type === 'dividend' ? 'Indica cuántas acciones cobraron el dividendo.' : 'Indica una cantidad mayor que 0.';
  }
  if (decimals(t.quantity) > 8) return 'La cantidad admite como mucho 8 decimales.';
  if (!(Number.isFinite(t.price) && t.price > 0)) {
    return t.type === 'dividend' ? 'Indica el dividendo por acción (mayor que 0).' : 'Indica un precio mayor que 0.';
  }
  if (!(Number.isFinite(t.fees) && t.fees >= 0)) return 'Las comisiones no pueden ser negativas.';
  if (t.type === 'sell' && t.fees >= t.quantity * t.price) return 'Las comisiones no pueden superar el importe de la venta.';
  if (t.type === 'dividend' && t.fees >= t.quantity * t.price) return 'Las comisiones o retenciones no pueden superar el dividendo bruto.';
  if (!CUR_FORMAT.test(t.currency || '')) return 'Indica la divisa con su código de 3 letras (p. ej. USD o EUR).';
  if (t.fxRate != null && !(Number.isFinite(t.fxRate) && t.fxRate > 0)) return 'El tipo de cambio debe ser mayor que 0.';
  return null;
}

/* ---------------------------------------------------------------------------
 * Libro FIFO
 * ------------------------------------------------------------------------- */

function chronological(txs) {
  return txs.map((t, i) => ({ t, i }))
    .sort((a, b) => a.t.date.localeCompare(b.t.date) || TYPE_ORDER[a.t.type] - TYPE_ORDER[b.t.type] || a.i - b.i)
    .map((x) => x.t);
}

/**
 * Recorre las operaciones y calcula posiciones, resultados y el tipo de cambio usado.
 * @param {object[]} txs
 * @param {object} opts
 * @param {string} [opts.base='EUR']
 * @param {(currency:string, date:string) => ({rate:number, date:string}|null)} [opts.fx]
 *        tipo de cambio de Twelve Data para una divisa y fecha (o null si no hay)
 * @returns {{ positions: object[], rows: Map, errors: object[] }}
 */
function ledger(txs, { base = 'EUR', fx = () => null } = {}) {
  const pos = new Map();
  const rows = new Map();          // id → { rate, rateDate, rateSource, amountLocal, amountBase, realizedBase }
  const errors = [];

  const position = (t) => {
    if (!pos.has(t.symbol)) {
      pos.set(t.symbol, {
        symbol: t.symbol, currency: t.currency, lots: [],
        avgQty: 0, avgCostLocal: 0,                                   // coste medio (informativo)
        realizedLocal: 0, realizedBase: 0, realizedCostBase: 0,
        dividendsLocal: 0, dividendsBase: 0, feesLocal: 0,
      });
    }
    return pos.get(t.symbol);
  };

  for (const t of chronological(txs)) {
    const p = position(t);
    if (p.currency !== t.currency) {
      errors.push({ txId: t.id, message: `${t.symbol} el ${fmtDay(t.date)}: la divisa (${t.currency}) no coincide con la de sus otras operaciones (${p.currency}).` });
      continue;
    }
    const rateInfo = t.currency === base ? { rate: 1, date: t.date, source: 'base' }
      : t.fxRate ? { rate: t.fxRate, date: t.date, source: 'manual' }
      : (() => { const r = fx(t.currency, t.date); return r ? { ...r, source: 'twelvedata' } : null; })();
    const rate = rateInfo ? rateInfo.rate : NaN;
    const toBase = (v) => v / rate;                                  // NaN si no hay tipo de cambio
    const row = { rate: rateInfo ? rateInfo.rate : null, rateDate: rateInfo ? rateInfo.date : null, rateSource: rateInfo ? rateInfo.source : null };
    p.feesLocal += t.fees;

    if (t.type === 'buy') {
      const local = t.quantity * t.price + t.fees;
      p.lots.push({ qty: t.quantity, costLocal: local, costBase: toBase(local), date: t.date, txId: t.id });
      p.avgQty += t.quantity;
      p.avgCostLocal += local;
      Object.assign(row, { amountLocal: -local, amountBase: -toBase(local) });
    } else if (t.type === 'sell') {
      const held = p.lots.reduce((a, l) => a + l.qty, 0);
      if (t.quantity > held + EPS) {
        errors.push({ txId: t.id, message: `Venta de ${fmtQ(t.quantity)} ${t.symbol} el ${fmtDay(t.date)}: en esa fecha solo tenías ${fmtQ(held)}.` });
        continue;
      }
      let left = t.quantity, costLocal = 0, costBase = 0;
      while (left > EPS && p.lots.length) {
        const lot = p.lots[0];
        const take = Math.min(lot.qty, left);
        const share = take / lot.qty;
        const partLocal = lot.costLocal * share, partBase = lot.costBase * share;
        costLocal += partLocal; costBase += partBase;
        lot.qty -= take; lot.costLocal -= partLocal; lot.costBase -= partBase;
        left -= take;
        if (lot.qty <= EPS) p.lots.shift();
      }
      // Coste medio (informativo): la venta retira coste en proporción
      const avgShare = p.avgQty > EPS ? Math.min(1, t.quantity / p.avgQty) : 1;
      p.avgCostLocal -= p.avgCostLocal * avgShare;
      p.avgQty = Math.max(0, p.avgQty - t.quantity);
      const proceedsLocal = t.quantity * t.price - t.fees;
      const proceedsBase = toBase(proceedsLocal);
      p.realizedLocal += proceedsLocal - costLocal;
      p.realizedBase += proceedsBase - costBase;
      p.realizedCostBase += costBase;
      Object.assign(row, { amountLocal: proceedsLocal, amountBase: proceedsBase, realizedBase: proceedsBase - costBase, costBase });
    } else {
      const incomeLocal = t.quantity * t.price - t.fees;
      p.dividendsLocal += incomeLocal;
      p.dividendsBase += toBase(incomeLocal);
      Object.assign(row, { amountLocal: incomeLocal, amountBase: toBase(incomeLocal) });
    }
    rows.set(t.id, row);
  }

  const positions = [...pos.values()].map((p) => {
    const qty = p.lots.reduce((a, l) => a + l.qty, 0);
    const open = qty > EPS;
    return {
      symbol: p.symbol, currency: p.currency,
      quantity: open ? qty : 0,
      costLocal: open ? p.lots.reduce((a, l) => a + l.costLocal, 0) : 0,
      costBase: open ? p.lots.reduce((a, l) => a + l.costBase, 0) : 0,
      avgCostPerShare: open && p.avgQty > EPS ? p.avgCostLocal / p.avgQty : null,
      fifoCostPerShare: open ? p.lots.reduce((a, l) => a + l.costLocal, 0) / qty : null,
      lots: p.lots.map((l) => ({ ...l })),
      realizedLocal: p.realizedLocal, realizedBase: p.realizedBase, realizedCostBase: p.realizedCostBase,
      dividendsLocal: p.dividendsLocal, dividendsBase: p.dividendsBase,
      feesLocal: p.feesLocal,
    };
  });
  return { positions, rows, errors };
}

/**
 * Valora las posiciones con cotizaciones y tipo de cambio actuales.
 * @param {object} led        resultado de ledger()
 * @param {Map} quotes        símbolo → { price } (o Error)
 * @param {(currency) => ({rate:number}|null)} fxNow
 */
function valuate(led, { quotes = new Map(), fxNow = () => null, base = 'EUR' } = {}) {
  const items = led.positions.map((p) => {
    const q = quotes.get(p.symbol);
    const price = q && !(q instanceof Error) && Number.isFinite(q.price) ? q.price : null;
    const r = p.currency === base ? { rate: 1 } : fxNow(p.currency);
    const rate = r ? r.rate : null;
    const valueLocal = p.quantity > 0 && price != null ? p.quantity * price : p.quantity > 0 ? null : 0;
    const valueBase = valueLocal == null || rate == null ? (p.quantity > 0 ? null : 0) : valueLocal / rate;
    const unrealizedBase = valueBase == null || !Number.isFinite(p.costBase) ? null : valueBase - p.costBase;
    return {
      ...p, price, rate, valueLocal, valueBase, unrealizedBase,
      unrealizedPct: unrealizedBase == null || p.costBase <= 0 ? null : (unrealizedBase / p.costBase) * 100,
      realizedPct: p.realizedCostBase > 0 ? (p.realizedBase / p.realizedCostBase) * 100 : null,
    };
  });
  const open = items.filter((i) => i.quantity > 0);
  const complete = open.every((i) => i.valueBase != null) && items.every((i) => Number.isFinite(i.costBase) && Number.isFinite(i.realizedBase) && Number.isFinite(i.dividendsBase));
  // Si algún sumando no se puede calcular (p. ej. falta el tipo de cambio), el total
  // tampoco: NaN en lugar de un cero falso.
  const sum = (k, list = items) => list.reduce((a, i) => a + i[k], 0);
  const value = sum('valueBase', open.filter((i) => i.valueBase != null));
  open.forEach((i) => { i.weight = complete && value > 0 && i.valueBase != null ? (i.valueBase / value) * 100 : null; });
  const cost = sum('costBase', open);
  const unrealized = sum('unrealizedBase', open.filter((i) => i.unrealizedBase != null));
  const realized = sum('realizedBase'), dividends = sum('dividendsBase');
  return {
    items, complete,
    totals: {
      value, cost, unrealized, realized, dividends,
      unrealizedPct: cost > 0 ? (unrealized / cost) * 100 : null,
      total: unrealized + realized + dividends,
    },
  };
}

/* ---------------------------------------------------------------------------
 * Tipos de cambio y evolución
 * ------------------------------------------------------------------------- */

/** Cierre de una serie diaria [{ date, close }] (ordenada) en esa fecha o la anterior disponible. */
function rateOn(series, date) {
  if (!series || !series.length || date < series[0].date) return null;
  let lo = 0, hi = series.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (series[mid].date <= date) lo = mid; else hi = mid - 1;
  }
  return { rate: series[lo].close, date: series[lo].date };
}

/* ---------------------------------------------------------------------------
 * Splits (Twelve Data no da /splits en el plan gratuito: se deducen de los cierres)
 * ------------------------------------------------------------------------- */

/** Fracción sencilla p/q (q ≤ 10) a menos de un 3 % de `x`: 4 → 4/1, 1,5 → 3/2, 0,1 → 1/10. */
function splitRatio(x) {
  let best = null;
  for (let q = 1; q <= 10; q++) {
    const p = Math.round(x * q);
    const err = p >= 1 ? Math.abs(p / q / x - 1) : Infinity;
    if (!best || err < best.err - 1e-9) best = { p, q, err };
  }
  return best.err < 0.03 ? { p: best.p, q: best.q } : null;
}

/**
 * Splits a partir de los cierres tal cual cotizaron (`raw`) y ajustados por splits (`adj`):
 * antes de un split de 4 por 1, raw/adj = 4; desde ese día, 1. El cociente debe ser estable la
 * sesión anterior y la siguiente al salto (un dato erróneo de un solo día no es un split).
 * @returns {{date, factor, p, q}[]}  factor = acciones nuevas por cada antigua (p por q)
 */
function detectSplits(raw, adj) {
  const adjBy = new Map(adj.map((x) => [x.date, x.close]));
  const r = raw.filter((x) => x.close > 0 && adjBy.get(x.date) > 0).map((x) => ({ date: x.date, v: x.close / adjBy.get(x.date) }));
  const out = [];
  for (let i = 1; i < r.length; i++) {
    const f = r[i - 1].v / r[i].v;
    if (f < 1.2 && f > 1 / 1.2) continue;
    if (i + 1 < r.length && Math.abs(r[i + 1].v / r[i].v - 1) > 0.02) continue;
    if (i >= 2 && Math.abs(r[i - 1].v / r[i - 2].v - 1) > 0.02) continue;
    const ratio = splitRatio(f);
    if (ratio) out.push({ date: r[i].date, factor: ratio.p / ratio.q, ...ratio });
  }
  return out;
}

/**
 * Compras y ventas anotadas en acciones de antes de un split: su precio, dividido por el cierre
 * ajustado de ese día, da el factor que les falta (1 si ya están ajustadas). Con varios splits
 * se busca la combinación de los posteriores que encaja (p. ej. solo se corrigió el primero).
 * @returns {{factor, count, splits: object[]}[]}  agrupado por el factor que hay que aplicar
 */
function splitAdvice(txs, raw, adj) {
  const splits = detectSplits(raw, adj);
  if (!splits.length) return [];
  const groups = new Map();
  for (const t of txs) {
    if (t.type === 'dividend') continue;
    const after = splits.filter((s) => s.date > t.date).slice(0, 6);
    const a = after.length ? rateOn(adj, t.date) : null;
    if (!a) continue;
    const k = t.price / a.rate;
    let best = { f: 1, err: Math.abs(Math.log(k)) };
    for (let mask = 1; mask < 1 << after.length; mask++) {
      const f = after.reduce((acc, s, i) => (mask & (1 << i) ? acc * s.factor : acc), 1);
      const err = Math.abs(Math.log(k / f));
      if (err < best.err) best = { f, err, used: after.filter((_, i) => mask & (1 << i)) };
    }
    if (best.f === 1 || best.err > Math.log(1.2)) continue;      // ya ajustada (o un precio que no encaja con nada)
    const key = best.f.toFixed(6);
    const g = groups.get(key) || { factor: best.f, count: 0, splits: best.used };
    g.count++;
    groups.set(key, g);
  }
  return [...groups.values()];
}

/**
 * Valor diario de la cartera en la moneda base y capital aportado neto.
 * @param {object[]} txs
 * @param {object} o  closes: Map(símbolo → [{date, close}]), fxSeries: Map(divisa → [{date, close}]),
 *                    rows: Map(id → { rate }) (tipos de cada operación, de ledger), base
 * @returns {{ points: {date, value, invested}[], missing: string[] }}
 */
function evolution(txs, { closes = new Map(), fxSeries = new Map(), rows = new Map(), base = 'EUR', to = todayISO() } = {}) {
  if (!txs.length) return { points: [], missing: [] };
  const ordered = chronological(txs);
  const from = ordered[0].date;
  const dates = new Set();
  closes.forEach((s) => s.forEach((b) => { if (b.date >= from && b.date <= to) dates.add(b.date); }));
  const days = [...dates].sort();
  const missing = new Set();
  const qty = new Map();
  let invested = 0, k = 0;
  const points = [];
  for (const d of days) {
    for (; k < ordered.length && ordered[k].date <= d; k++) {
      const t = ordered[k];
      const r = rows.get(t.id);
      if (!r) continue;                                   // operación con error: no cuenta
      if (t.type === 'buy') qty.set(t.symbol, (qty.get(t.symbol) || 0) + t.quantity);
      if (t.type === 'sell') qty.set(t.symbol, (qty.get(t.symbol) || 0) - t.quantity);
      if (t.type !== 'dividend' && Number.isFinite(r.amountBase)) invested -= r.amountBase;
    }
    let value = 0, ok = true;
    for (const [sym, q] of qty) {
      if (q <= EPS) continue;
      const cur = (ordered.find((t) => t.symbol === sym) || {}).currency;
      const px = rateOn(closes.get(sym), d);
      const fx = cur === base ? { rate: 1 } : rateOn(fxSeries.get(cur), d);
      if (!px) { missing.add(sym); ok = false; continue; }
      if (!fx) { missing.add(`${base}/${cur}`); ok = false; continue; }
      value += (q * px.rate) / fx.rate;
    }
    if (ok) points.push({ date: d, value, invested });
  }
  return { points, missing: [...missing] };
}

/* ---------------------------------------------------------------------------
 * Exportar e importar
 * ------------------------------------------------------------------------- */

const exportable = (t) => {
  const o = { id: t.id, type: t.type, symbol: t.symbol, date: t.date, quantity: t.quantity, price: t.price, fees: t.fees, currency: t.currency };
  if (t.fxRate != null) o.fxRate = t.fxRate;
  if (t.note) o.note = t.note;
  return o;
};

/** JSON de la cartera (solo cartera: nunca la clave de API ni otros datos). */
function toJSON({ baseCurrency, transactions }, now = new Date()) {
  return JSON.stringify({
    kind: EXPORT_KIND, version: EXPORT_VERSION, app: 'Aura Invest', exportedAt: now.toISOString(),
    baseCurrency, transactions: transactions.map(exportable),
  }, null, 2);
}

/**
 * Valida un JSON importado. Devuelve { ok, error } o { ok, data, preview }.
 * No modifica nada: la sustitución la hace replaceAll() tras confirmar.
 */
function parseImport(text, current = [], today = todayISO()) {
  let raw;
  try { raw = JSON.parse(text); } catch { return { ok: false, error: 'El archivo no es un JSON válido.' }; }
  if (!isObj(raw) || raw.kind !== EXPORT_KIND) return { ok: false, error: 'El archivo no es una exportación de cartera de Aura Invest.' };
  if (!Number.isInteger(raw.version) || raw.version > EXPORT_VERSION) return { ok: false, error: 'La exportación es de una versión no compatible.' };
  if (!Array.isArray(raw.transactions)) return { ok: false, error: 'El archivo no contiene operaciones.' };
  const baseCurrency = CUR_FORMAT.test(raw.baseCurrency || '') ? raw.baseCurrency : 'EUR';
  const seen = new Set();
  const txs = [];
  for (let i = 0; i < raw.transactions.length; i++) {
    if (!isObj(raw.transactions[i])) return { ok: false, error: `Operación ${i + 1}: formato no válido.` };
    const t = normalize(raw.transactions[i]);
    if (seen.has(t.id)) t.id = newId();
    seen.add(t.id);
    const err = validateTx(t, today);
    if (err) return { ok: false, error: `Operación ${i + 1} (${t.symbol || '?'} ${t.date || ''}): ${err}` };
    txs.push(t);
  }
  const led = ledger(txs, { base: baseCurrency });
  if (led.errors.length) return { ok: false, error: `El archivo no es coherente: ${led.errors[0].message}` };
  const dates = txs.map((t) => t.date).sort();
  return {
    ok: true,
    data: { baseCurrency, transactions: txs },
    preview: {
      count: txs.length, replaces: current.length,
      symbols: [...new Set(txs.map((t) => t.symbol))].sort(),
      from: dates[0] || null, to: dates.at(-1) || null, baseCurrency,
    },
  };
}

/** CSV de las operaciones para hojas de cálculo en español (separador ;, coma decimal, BOM UTF-8). */
function toCSV(transactions) {
  const n = (v, d = 8) => (Number.isFinite(v) ? String(Number(v.toFixed(d))).replace('.', ',') : '');
  const cell = (v) => {
    let s = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;                       // evita fórmulas al abrirlo
    return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = ['Fecha', 'Tipo', 'Valor', 'Cantidad', 'Precio', 'Comisiones', 'Divisa', 'Tipo de cambio', 'Importe', 'Nota'];
  const lines = chronological(transactions).map((t) => {
    const gross = t.type === 'buy' ? t.quantity * t.price + t.fees : t.quantity * t.price - t.fees;
    return [t.date, TYPE_TEXT[t.type], t.symbol, n(t.quantity), n(t.price), n(t.fees, 4), t.currency,
      t.fxRate != null ? n(t.fxRate, 6) : '', n(gross, 4), t.note || ''].map(cell).join(';');
  });
  return '﻿' + [header.join(';'), ...lines].join('\r\n') + '\r\n';
}

/* ---------------------------------------------------------------------------
 * Estado persistente (con deshacer)
 * ------------------------------------------------------------------------- */

const listeners = new Set();
const undoStack = [];
const data = () => store.get('portfolio');

function commit(next, label) {
  const prev = data();
  const led = ledger(next.transactions, { base: next.baseCurrency });
  if (led.errors.length) return { ok: false, error: led.errors[0].message };
  undoStack.push({ label, snapshot: prev });
  if (undoStack.length > UNDO_MAX) undoStack.shift();
  store.set('portfolio', next);
  listeners.forEach((f) => f());
  return { ok: true };
}

Aura.portfolio = {
  TYPE_TEXT,
  baseCurrency: () => data().baseCurrency,
  transactions: () => data().transactions,
  get: (id) => data().transactions.find((t) => t.id === id) || null,

  add(input, today = todayISO()) {
    const t = normalize({ ...input, id: undefined });
    const err = validateTx(t, today);
    if (err) return { ok: false, error: err };
    const d = data();
    const res = commit({ ...d, transactions: [...d.transactions, t] }, `añadir ${TYPE_TEXT[t.type].toLowerCase()} de ${t.symbol}`);
    return res.ok ? { ok: true, tx: t } : res;
  },
  update(id, input, today = todayISO()) {
    const d = data();
    const i = d.transactions.findIndex((t) => t.id === id);
    if (i < 0) return { ok: false, error: 'La operación ya no existe.' };
    const t = normalize({ ...input, id });
    const err = validateTx(t, today);
    if (err) return { ok: false, error: err };
    const txs = [...d.transactions];
    txs[i] = t;
    const res = commit({ ...d, transactions: txs }, `editar ${TYPE_TEXT[t.type].toLowerCase()} de ${t.symbol}`);
    return res.ok ? { ok: true, tx: t } : res;
  },
  remove(id) {
    const d = data();
    const t = d.transactions.find((x) => x.id === id);
    if (!t) return { ok: false, error: 'La operación ya no existe.' };
    const res = commit({ ...d, transactions: d.transactions.filter((x) => x.id !== id) }, `borrar ${TYPE_TEXT[t.type].toLowerCase()} de ${t.symbol}`);
    return res.ok ? { ok: true, tx: t } : { ok: false, error: `No se puede borrar: ${res.error}` };
  },
  setBaseCurrency(cur) {
    if (!CUR_FORMAT.test(cur)) return { ok: false, error: 'Divisa no válida.' };
    return commit({ ...data(), baseCurrency: cur }, `cambiar la moneda base a ${cur}`);
  },
  replaceAll(imported) { return commit({ baseCurrency: imported.baseCurrency, transactions: imported.transactions }, 'importar la cartera'); },
  canUndo: () => undoStack.length > 0,
  undoLabel: () => (undoStack.length ? undoStack.at(-1).label : null),
  undo() {
    const last = undoStack.pop();
    if (!last) return { ok: false };
    store.set('portfolio', last.snapshot);
    listeners.forEach((f) => f());
    return { ok: true, label: last.label };
  },
  exportJSON: () => toJSON(data()),
  exportCSV: () => toCSV(data().transactions),
  parseImport: (text, today) => parseImport(text, data().transactions, today),
  onChange(f) { listeners.add(f); return () => listeners.delete(f); },
  // Funciones puras (para la vista y las pruebas)
  normalize, validateTx, ledger, valuate, evolution, rateOn, toJSON, toCSV, chronological,
  detectSplits, splitAdvice,
};
})();
