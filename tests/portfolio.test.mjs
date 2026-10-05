import test from 'node:test';
import assert from 'node:assert/strict';
import { loadAura, memoryStorage, plain } from './harness.mjs';
import { td } from './helpers.mjs';

const fresh = () => loadAura({ until: 'portfolio', localStorage: memoryStorage() }).Aura;
const A = fresh();
const P = A.portfolio;
const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);
const tx = (o) => P.normalize({ fees: 0, currency: 'EUR', ...o });
const TODAY = '2026-10-04';

/* ---- FIFO ---- */

test('venta parcial FIFO con comisiones (calculado a mano)', () => {
  const txs = [
    tx({ id: 'b1', type: 'buy', symbol: 'XYZ', date: '2026-01-05', quantity: 10, price: 100, fees: 5 }),
    tx({ id: 'b2', type: 'buy', symbol: 'XYZ', date: '2026-02-02', quantity: 10, price: 120, fees: 5 }),
    tx({ id: 's1', type: 'sell', symbol: 'XYZ', date: '2026-03-02', quantity: 15, price: 130, fees: 10 }),
  ];
  const led = P.ledger(txs);
  assert.deepEqual(plain(led.errors), []);
  const p = led.positions[0];
  close(p.quantity, 5);
  close(p.costBase, 602.5);                 // 5 acciones del 2.º lote: 1205 × 5/10
  close(p.fifoCostPerShare, 120.5);
  close(p.avgCostPerShare, 110.5);          // coste medio (informativo): 2210 / 20
  close(p.realizedBase, 332.5);             // 1940 − (1005 + 602,5)
  close(led.rows.get('s1').realizedBase, 332.5);

  const v = P.valuate(led, { quotes: new Map([['XYZ', { price: 140 }]]) });
  const i = v.items[0];
  close(i.valueBase, 700);
  close(i.unrealizedBase, 97.5);
  close(i.unrealizedPct, (97.5 / 602.5) * 100);
  close(i.realizedPct, (332.5 / 1607.5) * 100);
  close(i.weight, 100);
  close(v.totals.total, 97.5 + 332.5);
});

test('varias ventas hasta cerrar la posición; el coste restante queda a 0', () => {
  const led = P.ledger([
    tx({ id: 'a', type: 'buy', symbol: 'Q', date: '2026-01-02', quantity: 3, price: 10.1 }),
    tx({ id: 'b', type: 'buy', symbol: 'Q', date: '2026-01-03', quantity: 2, price: 10.2 }),
    tx({ id: 'c', type: 'sell', symbol: 'Q', date: '2026-01-05', quantity: 4, price: 11, fees: 1 }),
    tx({ id: 'd', type: 'sell', symbol: 'Q', date: '2026-01-06', quantity: 1, price: 12 }),
  ]);
  const p = led.positions[0];
  assert.equal(p.quantity, 0);
  assert.equal(p.costBase, 0);
  close(led.rows.get('c').realizedBase, 43 - (30.3 + 10.2));     // 3 del 1.er lote y 1 del 2.º
  close(led.rows.get('d').realizedBase, 12 - 10.2);
  close(p.realizedBase, 4.3);
  assert.equal(P.valuate(led).items[0].valueBase, 0, 'cerrada: vale 0, no "sin datos"');
});

test('redondeos: fracciones de acción sin restos fantasma', () => {
  const led = P.ledger([
    tx({ id: 'a', type: 'buy', symbol: 'BTC/USD', date: '2026-01-02', quantity: 0.1, price: 100, currency: 'USD' }),
    tx({ id: 'b', type: 'buy', symbol: 'BTC/USD', date: '2026-01-02', quantity: 0.2, price: 100, currency: 'USD' }),
    tx({ id: 'c', type: 'sell', symbol: 'BTC/USD', date: '2026-01-03', quantity: 0.3, price: 110, currency: 'USD', fxRate: 1 }),
  ], { base: 'USD' });
  assert.deepEqual(plain(led.errors), [], '0,1 + 0,2 se pueden vender como 0,3');
  assert.equal(led.positions[0].quantity, 0);
  close(led.positions[0].realizedBase, 3);
  assert.equal(A.utils.fmtNum(led.positions[0].realizedBase, 2), '3,00');
  assert.equal(A.utils.fmtSigned(-1e-12, 2), '0,00', 'nunca "−0,00"');
});

/* ---- Dividendos y divisas ---- */

test('dividendos: bruto menos retenciones, en la moneda base con el tipo del día', () => {
  const fx = (cur, date) => (date === '2026-05-15' ? { rate: 1.06, date } : { rate: 1.1, date });
  const led = P.ledger([
    tx({ id: 'b', type: 'buy', symbol: 'KO', date: '2026-01-05', quantity: 10, price: 50, currency: 'USD' }),
    tx({ id: 'd', type: 'dividend', symbol: 'KO', date: '2026-05-15', quantity: 10, price: 0.25, fees: 0.38, currency: 'USD' }),
  ], { fx });
  const p = led.positions[0];
  close(p.dividendsLocal, 2.12);
  close(p.dividendsBase, 2);                                         // 2,12 USD / 1,06
  assert.equal(led.rows.get('d').rate, 1.06);
  close(p.quantity, 10, 1e-12);
});

test('divisas: coste con el tipo de cada operación y valor con el tipo actual', () => {
  const rates = { '2026-01-05': 1.1, '2026-03-02': 1.2 };
  const fx = (cur, date) => ({ rate: rates[date], date });
  const led = P.ledger([
    tx({ id: 'b', type: 'buy', symbol: 'AAPL', date: '2026-01-05', quantity: 10, price: 200, fees: 1, currency: 'USD' }),
    tx({ id: 's', type: 'sell', symbol: 'AAPL', date: '2026-03-02', quantity: 5, price: 240, fees: 1, currency: 'USD' }),
  ], { fx });
  const p = led.positions[0];
  close(led.rows.get('b').amountBase, -2001 / 1.1);
  close(led.rows.get('s').realizedBase, 1199 / 1.2 - (2001 / 1.1) / 2);
  close(p.costBase, (2001 / 1.1) / 2);
  const v = P.valuate(led, { quotes: new Map([['AAPL', { price: 250 }]]), fxNow: () => ({ rate: 1.25 }) });
  close(v.items[0].valueBase, (5 * 250) / 1.25);
  close(v.items[0].unrealizedBase, 1000 - (2001 / 1.1) / 2);
});

test('tipo de cambio manual: tiene prioridad sobre el de Twelve Data', () => {
  const led = P.ledger([tx({ id: 'b', type: 'buy', symbol: 'AAPL', date: '2026-01-05', quantity: 1, price: 110, currency: 'USD', fxRate: 1.1 })],
    { fx: () => ({ rate: 9, date: '2026-01-05' }) });
  const r = led.rows.get('b');
  assert.deepEqual([r.rate, r.rateSource], [1.1, 'manual']);
  close(led.positions[0].costBase, 100);
});

test('sin tipo de cambio la posición se calcula en su divisa y la base queda sin dato', () => {
  const led = P.ledger([tx({ id: 'b', type: 'buy', symbol: 'AAPL', date: '2026-01-05', quantity: 1, price: 110, currency: 'USD' })]);
  assert.ok(Number.isNaN(led.positions[0].costBase));
  const v = P.valuate(led, { quotes: new Map([['AAPL', { price: 120 }]]) });
  assert.equal(v.items[0].valueBase, null);
  assert.equal(v.complete, false);
});

test('rateOn: cierre del día o del anterior disponible (fines de semana y festivos)', () => {
  const s = [{ date: '2026-01-02', close: 1.1 }, { date: '2026-01-05', close: 1.12 }];
  assert.deepEqual(plain(P.rateOn(s, '2026-01-03')), { rate: 1.1, date: '2026-01-02' });
  assert.deepEqual(plain(P.rateOn(s, '2026-01-05')), { rate: 1.12, date: '2026-01-05' });
  assert.deepEqual(plain(P.rateOn(s, '2026-02-01')), { rate: 1.12, date: '2026-01-05' });
  assert.equal(P.rateOn(s, '2025-12-31'), null);
});

/* ---- Splits ---- */

const closesOf = (name) => A.data.parseSeries(td(name)).map((b) => ({ date: new Date(b.time * 1000).toISOString().slice(0, 10), close: b.close }));
const RAW = [...closesOf('time_series_AAPL_1day_split2014_none'), ...closesOf('time_series_AAPL_1day_split2020_none')];
const ADJ = [...closesOf('time_series_AAPL_1day_split2014_splits'), ...closesOf('time_series_AAPL_1day_split2020_splits')];
const on = (series, date) => series.find((x) => x.date === date).close;

test('splits con cierres reales de AAPL: 7 por 1 (9 jun 2014) y 4 por 1 (31 ago 2020)', () => {
  assert.deepEqual(plain(P.detectSplits(RAW, ADJ)).map((s) => [s.date, s.p, s.q, s.factor]), [['2014-06-09', 7, 1, 7], ['2020-08-31', 4, 1, 4]]);
});

test('aviso de splits: solo las operaciones anotadas en acciones de antes, con el factor que les falta', () => {
  const t = (id, date, price, type = 'buy') => tx({ id, type, symbol: 'AAPL', date, quantity: 10, price, currency: 'USD' });
  const advice = plain(P.splitAdvice([
    t('a', '2014-05-28', on(RAW, '2014-05-28') * 1.01),      // tal cual cotizaba: le faltan 7 × 4
    t('b', '2014-05-29', on(RAW, '2014-05-29') / 7),         // corregida solo por el split de 2014: le falta el de 2020
    t('c', '2020-08-20', on(RAW, '2020-08-20') * 0.99),      // anterior al de 2020, sin ajustar
    t('d', '2020-08-21', on(ADJ, '2020-08-21')),             // ya ajustada: nada
    t('e', '2020-09-02', on(RAW, '2020-09-02')),             // posterior a los dos: nada
    t('f', '2014-05-28', 2, 'dividend'),                     // dividendos: no se comparan con el precio
  ], RAW, ADJ));
  assert.deepEqual(advice.map((g) => [g.factor, g.count, g.splits.map((s) => s.date)]), [
    [28, 1, ['2014-06-09', '2020-08-31']],
    [4, 2, ['2020-08-31']],
  ]);
});

test('splits: contrasplit 1 por 10, sin splits y un dato erróneo de un día', () => {
  const days = ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09'];
  const adj = days.map((date) => ({ date, close: 50 }));
  const reverse = days.map((date, i) => ({ date, close: i < 2 ? 5 : 50 }));       // antes valía 5; tras el contrasplit, 50
  assert.deepEqual(plain(P.detectSplits(reverse, adj)).map((s) => [s.date, s.p, s.q]), [['2026-01-07', 1, 10]]);
  assert.deepEqual(plain(P.detectSplits(adj, adj)), []);
  const glitch = days.map((date, i) => ({ date, close: i === 2 ? 150 : 50 }));      // un solo día ×3
  assert.deepEqual(plain(P.detectSplits(glitch, adj)), []);
});

/* ---- Validación y reglas ---- */

test('validación de operaciones', () => {
  const ok = { type: 'buy', symbol: 'AAPL', date: '2026-01-05', quantity: 1, price: 10, fees: 0, currency: 'USD' };
  assert.equal(P.validateTx(ok, TODAY), null);
  assert.match(P.validateTx({ ...ok, date: '2026-10-05' }, TODAY), /futura/);
  assert.match(P.validateTx({ ...ok, date: '2026-02-30' }, TODAY), /fecha válida/);
  assert.match(P.validateTx({ ...ok, quantity: 0 }, TODAY), /mayor que 0/);
  assert.match(P.validateTx({ ...ok, quantity: 0.123456789 }, TODAY), /8 decimales/);
  assert.match(P.validateTx({ ...ok, fees: -1 }, TODAY), /negativas/);
  assert.match(P.validateTx({ ...ok, currency: 'dólar' }, TODAY), /3 letras/);
  assert.match(P.validateTx({ ...ok, type: 'sell', fees: 10 }, TODAY), /superar el importe/);
  assert.match(P.validateTx({ ...ok, type: 'dividend', price: 0 }, TODAY), /dividendo por acción/);
  assert.equal(P.normalize({ ...ok, currency: 'usd', fees: '' }).currency, 'USD');
  assert.equal(P.normalize({ ...ok, price: '10,5' }).price, 10.5, 'admite coma decimal');
});

test('no se puede vender más de lo que se tiene (al añadir, editar o borrar)', () => {
  const S = fresh().portfolio;
  const buy = S.add({ type: 'buy', symbol: 'AAPL', date: '2026-01-05', quantity: 10, price: 200, currency: 'USD' }, TODAY).tx;
  assert.match(S.add({ type: 'sell', symbol: 'AAPL', date: '2026-02-01', quantity: 11, price: 210, currency: 'USD' }, TODAY).error, /solo tenías 10/);
  assert.match(S.add({ type: 'sell', symbol: 'AAPL', date: '2026-01-04', quantity: 1, price: 210, currency: 'USD' }, TODAY).error, /solo tenías 0/);
  assert.equal(S.add({ type: 'sell', symbol: 'AAPL', date: '2026-01-05', quantity: 10, price: 210, currency: 'USD' }, TODAY).ok, true, 'el mismo día: primero la compra');
  assert.match(S.update(buy.id, { ...buy, quantity: 5 }, TODAY).error, /solo tenías 5/);
  assert.match(S.remove(buy.id).error, /No se puede borrar/);
  assert.match(S.add({ type: 'buy', symbol: 'AAPL', date: '2026-03-01', quantity: 1, price: 180, currency: 'EUR' }, TODAY).error, /no coincide/);
  assert.equal(S.transactions().length, 2);
});

test('deshacer: añadir, editar y borrar vuelven atrás en orden', () => {
  const S = fresh().portfolio;
  assert.equal(S.canUndo(), false);
  const a = S.add({ type: 'buy', symbol: 'MSFT', date: '2026-01-05', quantity: 2, price: 500, currency: 'USD' }, TODAY).tx;
  S.update(a.id, { ...a, quantity: 3 }, TODAY);
  S.remove(a.id);
  assert.equal(S.transactions().length, 0);
  assert.equal(S.undoLabel(), 'borrar compra de MSFT');
  S.undo();
  assert.equal(S.get(a.id).quantity, 3);
  S.undo();
  assert.equal(S.get(a.id).quantity, 2);
  S.undo();
  assert.equal(S.transactions().length, 0);
  assert.equal(S.canUndo(), false);
});

/* ---- Exportar / importar ---- */

test('exportar JSON: solo la cartera, nunca la clave de API', () => {
  const { Aura } = loadAura({ until: 'portfolio', localStorage: memoryStorage() });
  Aura.store.setApiKey('clave-secreta-123456');
  Aura.portfolio.add({ type: 'buy', symbol: 'KO', date: '2026-01-05', quantity: 4, price: 60, fees: 1, currency: 'USD', note: 'primera' }, TODAY);
  const json = Aura.portfolio.exportJSON();
  assert.equal(json.includes('clave-secreta'), false);
  const o = JSON.parse(json);
  assert.deepEqual(Object.keys(o).sort(), ['app', 'baseCurrency', 'exportedAt', 'kind', 'transactions', 'version']);
  assert.equal(o.kind, 'aura-portfolio');
  assert.deepEqual(Object.keys(o.transactions[0]).sort(), ['currency', 'date', 'fees', 'id', 'note', 'price', 'quantity', 'symbol', 'type']);
});

test('importar: valida, enseña qué reemplaza y se puede deshacer', () => {
  const S = fresh().portfolio;
  S.add({ type: 'buy', symbol: 'AAPL', date: '2026-01-05', quantity: 1, price: 200, currency: 'USD' }, TODAY);
  const file = JSON.stringify({ kind: 'aura-portfolio', version: 1, baseCurrency: 'EUR', transactions: [
    { id: 'x1', type: 'buy', symbol: 'KO', date: '2026-02-02', quantity: 5, price: 60, fees: 0, currency: 'USD' },
    { id: 'x2', type: 'sell', symbol: 'KO', date: '2026-03-02', quantity: 2, price: 65, fees: 1, currency: 'USD' },
    { id: 'x3', type: 'buy', symbol: 'SAN', date: '2026-01-15', quantity: 100, price: 9.5, fees: 2, currency: 'USD' },
  ] });
  const res = S.parseImport(file, TODAY);
  assert.equal(res.ok, true);
  assert.deepEqual(plain(res.preview), { count: 3, replaces: 1, symbols: ['KO', 'SAN'], from: '2026-01-15', to: '2026-03-02', baseCurrency: 'EUR' });
  assert.equal(S.transactions().length, 1, 'validar no cambia nada');
  S.replaceAll(res.data);
  assert.deepEqual(plain(S.transactions().map((t) => t.id)), ['x1', 'x2', 'x3']);
  S.undo();
  assert.deepEqual(plain(S.transactions().map((t) => t.symbol)), ['AAPL']);
});

test('importar: rechaza archivos no válidos con un motivo claro', () => {
  const S = fresh().portfolio;
  const wrap = (txs, extra = {}) => JSON.stringify({ kind: 'aura-portfolio', version: 1, transactions: txs, ...extra });
  const good = { type: 'buy', symbol: 'KO', date: '2026-02-02', quantity: 5, price: 60, currency: 'USD' };
  assert.match(S.parseImport('{roto', TODAY).error, /JSON válido/);
  assert.match(S.parseImport(JSON.stringify({ kind: 'otra-cosa' }), TODAY).error, /no es una exportación/);
  assert.match(S.parseImport(wrap([], { version: 9 }), TODAY).error, /no compatible/);
  assert.match(S.parseImport(wrap([{ ...good, price: -3 }]), TODAY).error, /Operación 1 .*precio mayor que 0/);
  assert.match(S.parseImport(wrap([good, { ...good, type: 'sell', quantity: 6 }]), TODAY).error, /no es coherente.*solo tenías 5/);
  assert.match(S.parseImport(wrap([{ ...good, date: '2027-01-01' }]), TODAY).error, /futura/);
});

test('exportar → importar devuelve exactamente las mismas operaciones', () => {
  const S = fresh().portfolio;
  S.add({ type: 'buy', symbol: 'AAPL', date: '2026-01-05', quantity: 1.5, price: 200.25, fees: 0.99, currency: 'USD', fxRate: 1.0875, note: 'con tipo manual' }, TODAY);
  S.add({ type: 'dividend', symbol: 'AAPL', date: '2026-02-12', quantity: 1.5, price: 0.26, fees: 0.06, currency: 'USD' }, TODAY);
  const back = S.parseImport(S.exportJSON(), TODAY);
  assert.deepEqual(plain(back.data.transactions), plain(S.transactions()));
});

test('CSV: separador ;, coma decimal, BOM y protección contra fórmulas', () => {
  const csv = P.toCSV([
    tx({ id: 'a', type: 'buy', symbol: 'AAPL', date: '2026-01-05', quantity: 1.5, price: 200.25, fees: 0.99, currency: 'USD', note: '=HYPERLINK("x")' }),
    tx({ id: 'b', type: 'sell', symbol: 'AAPL', date: '2026-02-05', quantity: 1, price: 210, fees: 1, currency: 'USD', note: 'venta; "parcial"' }),
  ]);
  const lines = csv.split('\r\n');
  assert.equal(csv.charCodeAt(0), 0xfeff);
  assert.equal(lines[0].slice(1), 'Fecha;Tipo;Valor;Cantidad;Precio;Comisiones;Divisa;Tipo de cambio;Importe;Nota');
  assert.equal(lines[1], `2026-01-05;Compra;AAPL;1,5;200,25;0,99;USD;;301,365;"'=HYPERLINK(""x"")"`);
  assert.equal(lines[2], '2026-02-05;Venta;AAPL;1;210;1;USD;;209;"venta; ""parcial"""');
});

/* ---- Evolución ---- */

test('evolución diaria: valor con cierres y tipos del día (o el anterior), y capital aportado', () => {
  const closes = new Map([['AAPL', [
    { date: '2026-01-02', close: 190 }, { date: '2026-01-05', close: 200 }, { date: '2026-01-06', close: 210 }, { date: '2026-01-07', close: 220 },
  ]]]);
  const fxSeries = new Map([['USD', [{ date: '2026-01-02', close: 1.1 }, { date: '2026-01-05', close: 1.25 }, { date: '2026-01-07', close: 1.1 }]]]);
  const txs = [
    tx({ id: 'b', type: 'buy', symbol: 'AAPL', date: '2026-01-05', quantity: 10, price: 200, currency: 'USD' }),
    tx({ id: 's', type: 'sell', symbol: 'AAPL', date: '2026-01-07', quantity: 4, price: 220, currency: 'USD' }),
  ];
  const fx = (cur, date) => P.rateOn(fxSeries.get(cur), date);
  const led = P.ledger(txs, { fx });
  const { points } = P.evolution(txs, { closes, fxSeries, rows: led.rows, to: '2026-01-07' });
  assert.deepEqual(plain(points.map((p) => p.date)), ['2026-01-05', '2026-01-06', '2026-01-07'], 'empieza en la primera operación');
  close(points[0].value, 2000 / 1.25);
  close(points[1].value, 2100 / 1.25, 1e-6);               // el 6 no hay tipo: se usa el del 5
  close(points[2].value, (6 * 220) / 1.1);
  close(points[0].invested, 1600);
  close(points[2].invested, 1600 - 880 / 1.1);
});

/* ---- Con datos reales de Twelve Data ---- */

test('datos reales: AAPL comprada en septiembre de 2025, con EUR/USD real de cada día', () => {
  const series = (name) => A.data.parseSeries(td(name)).map((b) => ({ date: new Date(b.time * 1000).toISOString().slice(0, 10), close: b.close }));
  const aapl = series('time_series_AAPL_1day');
  const eur = series('time_series_EURUSD_1day');
  const buyDay = aapl.find((b) => b.date >= '2025-09-15');
  const txs = [tx({ id: 'b', type: 'buy', symbol: 'AAPL', date: buyDay.date, quantity: 10, price: buyDay.close, fees: 1, currency: 'USD' })];
  const fx = (cur, date) => P.rateOn(eur, date);
  const led = P.ledger(txs, { fx });
  const fxBuy = P.rateOn(eur, buyDay.date);
  assert.equal(led.rows.get('b').rateDate, fxBuy.date);
  close(led.positions[0].costBase, (10 * buyDay.close + 1) / fxBuy.rate);

  const quote = A.data.parseQuote(td('quote_AAPL'));
  const fxNow = eur.at(-1).close;                            // 1,1258 (4 oct 2026)
  const v = P.valuate(led, { quotes: new Map([['AAPL', quote]]), fxNow: () => ({ rate: fxNow }) });
  close(v.items[0].valueBase, 3336.9 / fxNow);
  const { points } = P.evolution(txs, { closes: new Map([['AAPL', aapl]]), fxSeries: new Map([['USD', eur]]), rows: led.rows, to: '2026-10-04' });
  assert.equal(points[0].date, buyDay.date);
  close(points.at(-1).value, (10 * aapl.at(-1).close) / P.rateOn(eur, aapl.at(-1).date).rate);
});

test('sin tipo de cambio, los totales en la moneda base no se inventan (NaN, no 0)', () => {
  const led = P.ledger([
    tx({ id: 'b', type: 'buy', symbol: 'AAPL', date: '2026-01-05', quantity: 10, price: 200, currency: 'USD' }),
    tx({ id: 's', type: 'sell', symbol: 'AAPL', date: '2026-02-02', quantity: 4, price: 210, currency: 'USD' }),
    tx({ id: 'e', type: 'buy', symbol: 'SAN', date: '2026-01-05', quantity: 10, price: 9, currency: 'EUR' }),
  ]);
  const v = P.valuate(led, { quotes: new Map([['SAN', { price: 10 }]]) });
  assert.ok(Number.isNaN(v.totals.realized), 'la venta en USD no tiene conversión');
  assert.ok(Number.isNaN(v.totals.cost));
  assert.equal(v.totals.dividends, 0, 'sin dividendos sí es un 0 real');
  assert.equal(v.complete, false);
});
