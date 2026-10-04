/* =========================================================================
 * Aura Invest · Alertas (lógica y persistencia)
 *
 * Tipos:
 *   price_above  precio ≥ valor              (el umbral exacto cuenta)
 *   price_below  precio ≤ valor
 *   day_change   variación del día ≥ X %      (al alza, a la baja o en cualquier sentido)
 *   ema_cross    cruce EMA 20 / SMA 50         (alcista, bajista o cualquiera)
 *   rsi          RSI 14 > 70 o < 30            (estrictamente)
 *   signal       la señal del modelo pasa a Alcista o Bajista
 *
 * Reglas:
 * - Cada alerta salta UNA vez (estado `triggered`) y se puede reactivar.
 * - Las de nivel (precio, variación, RSI) saltan si la condición se cumple al evaluar.
 * - Las de evento (cruce, señal) necesitan un cambio: la primera evaluación tras
 *   activarlas guarda el estado de partida y saltan cuando cambia hacia el objetivo.
 * - La variación del día solo mira sesiones del día en que se activó la alerta o
 *   posteriores (un +4 % de ayer no dispara una alerta creada hoy).
 * - Sin datos, o con datos antiguos de la caché, no se evalúa (no salta).
 * - Las señales (cruce, RSI, señal del modelo) usan velas diarias, como la vista 6M.
 * ========================================================================= */
(() => {
'use strict';

const { fmtNum, fmtPrice, fmtSigned, utcDay } = Aura.utils;
const { precisionFor } = Aura.data;
const store = Aura.store;

const TYPES = ['price_above', 'price_below', 'day_change', 'ema_cross', 'rsi', 'signal'];
const SIGNAL_TYPES = new Set(['ema_cross', 'rsi', 'signal']);
const ACTION_TEXT = { buy: 'Alcista', hold: 'Neutral', sell: 'Bajista' };
const DIR_TEXT = { any: 'en cualquier sentido', up: 'al alza', down: 'a la baja' };
const ID_FORMAT = /^[A-Za-z0-9.\-/:^]{1,24}$/;

const isQuote = (q) => q && !(q instanceof Error) && !q.stale && Number.isFinite(q.price);
const isSignals = (s) => s && !(s instanceof Error) && !s.stale;
const fmtValue = (v) => fmtNum(v, precisionFor(Math.abs(v)));
let idSeq = 0;
const newId = () => (globalThis.crypto && typeof crypto.randomUUID === 'function'
  ? crypto.randomUUID()
  : `a${Date.now().toString(36)}${(++idSeq).toString(36)}`);

/* ---------------------------------------------------------------------------
 * Validación y descripción
 * ------------------------------------------------------------------------- */

/** Comprueba los datos de un formulario; devuelve el mensaje de error o null. */
function validate(input) {
  if (!input || !ID_FORMAT.test(input.symbol || '')) return 'Elige un valor.';
  if (!TYPES.includes(input.type)) return 'Elige un tipo de alerta.';
  if (input.type === 'price_above' || input.type === 'price_below') {
    if (!(Number.isFinite(input.value) && input.value > 0)) return 'Indica un precio mayor que 0.';
  }
  if (input.type === 'day_change') {
    if (!(Number.isFinite(input.value) && input.value > 0 && input.value <= 100)) return 'Indica una variación entre 0 y 100 %.';
    if (!DIR_TEXT[input.dir]) return 'Elige el sentido de la variación.';
  }
  if (input.type === 'ema_cross' && !DIR_TEXT[input.dir]) return 'Elige el tipo de cruce.';
  if (input.type === 'rsi' && !['above70', 'below30'].includes(input.level)) return 'Elige el nivel de RSI.';
  if (input.type === 'signal' && !['buy', 'sell'].includes(input.target)) return 'Elige la señal (Alcista o Bajista).';
  return null;
}

/** Texto de la condición, p. ej. "AAPL · precio ≥ 340,00". */
function describe(a) {
  const s = a.symbol;
  switch (a.type) {
    case 'price_above': return `${s} · precio ≥ ${fmtValue(a.value)}`;
    case 'price_below': return `${s} · precio ≤ ${fmtValue(a.value)}`;
    case 'day_change': return `${s} · variación del día ≥ ${fmtNum(a.value, 2)} % ${DIR_TEXT[a.dir]}`;
    case 'ema_cross': return `${s} · cruce EMA 20 / SMA 50 ${a.dir === 'up' ? 'alcista' : a.dir === 'down' ? 'bajista' : '(cualquiera)'}`;
    case 'rsi': return `${s} · RSI 14 ${a.level === 'above70' ? '> 70' : '< 30'}`;
    case 'signal': return `${s} · la señal del modelo pasa a ${ACTION_TEXT[a.target]}`;
    default: return s;
  }
}

/* ---------------------------------------------------------------------------
 * Evaluación (pura)
 * ------------------------------------------------------------------------- */

/** Lecturas de señales a partir de un análisis diario (Aura.model.analyze). */
function signalsFrom(m, source = {}) {
  const i = m.bars.length - 1;
  const e = m.ind.ema20[i], s = m.ind.sma50[i], r = m.ind.rsi14[i];
  return {
    emaSign: e != null && s != null ? Math.sign(e - s) : null,
    rsi: r != null ? r : null,
    action: m.adv.action,
    barTime: m.bars[i].time,
    at: source.at ?? null,
    stale: source.stale === true,
  };
}

/**
 * Evalúa una alerta activa con los datos disponibles.
 * @param {object} a       alerta
 * @param {object} ctx     { quote, signals } (cualquiera puede faltar o ser un Error)
 * @returns {{ fire: boolean, reading: string|null, missing: string|null, baseline?: any, message?: string }}
 */
function evaluate(a, { quote, signals } = {}) {
  const missing = (why) => ({ fire: false, reading: null, missing: why });
  const noData = (x) => (x instanceof Error ? `sin datos: ${x.message}` : x && x.stale ? 'datos antiguos de la caché: no se evalúa' : 'sin datos todavía');

  if (a.type === 'price_above' || a.type === 'price_below') {
    if (!isQuote(quote)) return missing(noData(quote));
    const p = quote.price;
    const reading = `precio ${fmtPrice(p, quote.meta)}`;
    const fire = a.type === 'price_above' ? p >= a.value : p <= a.value;
    return { fire, reading, missing: null,
      message: `${a.symbol} cotiza a ${fmtPrice(p, quote.meta)}: ${a.type === 'price_above' ? 'igual o por encima de' : 'igual o por debajo de'} ${fmtValue(a.value)}.` };
  }

  if (a.type === 'day_change') {
    if (!isQuote(quote) || !Number.isFinite(quote.prevClose) || quote.prevClose === 0 || !Number.isFinite(quote.time)) return missing(noData(quote));
    const pct = (quote.price / quote.prevClose - 1) * 100;
    const reading = `variación ${fmtSigned(pct, 2)} %`;
    // Cambio de día: solo cuentan sesiones del día de activación o posteriores
    const sessionDay = new Date(quote.time * 1000).toISOString().slice(0, 10);
    if (sessionDay < utcDay(a.armedAt)) return { fire: false, reading, missing: 'esperando una sesión posterior a la activación' };
    const fire = a.dir === 'up' ? pct >= a.value : a.dir === 'down' ? pct <= -a.value : Math.abs(pct) >= a.value;
    return { fire, reading, missing: null,
      message: `${a.symbol} varía un ${fmtSigned(pct, 2)} % en la sesión (umbral ${fmtNum(a.value, 2)} % ${DIR_TEXT[a.dir]}).` };
  }

  if (!isSignals(signals)) return missing(noData(signals));

  if (a.type === 'rsi') {
    if (signals.rsi == null) return missing('RSI no disponible');
    const reading = `RSI ${fmtNum(signals.rsi, 1)}`;
    const fire = a.level === 'above70' ? signals.rsi > 70 : signals.rsi < 30;
    return { fire, reading, missing: null,
      message: `${a.symbol}: el RSI 14 diario está en ${fmtNum(signals.rsi, 1)} (${a.level === 'above70' ? 'sobrecompra, > 70' : 'sobreventa, < 30'}).` };
  }

  if (a.type === 'ema_cross') {
    const sign = signals.emaSign;
    if (sign == null) return missing('medias no disponibles');
    const reading = sign > 0 ? 'EMA 20 por encima de SMA 50' : sign < 0 ? 'EMA 20 por debajo de SMA 50' : 'EMA 20 = SMA 50';
    if (a.baseline == null || sign === 0) return { fire: false, reading, missing: null, baseline: a.baseline ?? (sign || null) };
    if (sign === a.baseline) return { fire: false, reading, missing: null, baseline: sign };
    const dir = sign > 0 ? 'up' : 'down';
    const fire = a.dir === 'any' || a.dir === dir;
    return { fire, reading, missing: null, baseline: sign,
      message: `${a.symbol}: cruce ${dir === 'up' ? 'alcista' : 'bajista'} de la EMA 20 sobre la SMA 50 (velas diarias).` };
  }

  if (a.type === 'signal') {
    const act = signals.action;
    if (!ACTION_TEXT[act]) return missing('señal no disponible');
    const reading = `señal ${ACTION_TEXT[act]}`;
    const fire = a.baseline != null && a.baseline !== a.target && act === a.target;
    return { fire, reading, missing: null, baseline: act,
      message: `${a.symbol}: la señal del modelo ha pasado de ${ACTION_TEXT[a.baseline] || '—'} a ${ACTION_TEXT[act]} (velas diarias).` };
  }
  return missing('tipo desconocido');
}

/* ---------------------------------------------------------------------------
 * Ciclo de vida (puro): devuelven alertas nuevas
 * ------------------------------------------------------------------------- */

function pickParams(input) {
  const p = { symbol: input.symbol, type: input.type };
  if (['price_above', 'price_below', 'day_change'].includes(input.type)) p.value = input.value;
  if (input.type === 'day_change' || input.type === 'ema_cross') p.dir = input.dir;
  if (input.type === 'rsi') p.level = input.level;
  if (input.type === 'signal') p.target = input.target;
  return p;
}
const armed = (now) => ({ status: 'active', armedAt: now, triggeredAt: null, baseline: null, last: null });

function create(input, now) {
  return { id: newId(), ...pickParams(input), createdAt: now, ...armed(now) };
}
/** Editar una alerta la vuelve a activar desde cero. */
function edit(a, input, now) { return { id: a.id, createdAt: a.createdAt, ...pickParams(input), ...armed(now) }; }
function pause(a) { return { ...a, status: 'paused' }; }
/** Reanudar o reactivar: vuelve a vigilar desde ahora (estado de partida nuevo). */
function rearm(a, now) { return { ...a, ...armed(now) }; }

/** Aplica el resultado de una evaluación. */
function applyResult(a, r, now) {
  const next = { ...a, last: { at: now, reading: r.reading, missing: r.missing } };
  if ('baseline' in r) next.baseline = r.baseline;
  if (r.fire) { next.status = 'triggered'; next.triggeredAt = now; }
  return next;
}

/* ---------------------------------------------------------------------------
 * Estado persistente
 * ------------------------------------------------------------------------- */

const listeners = new Set();
const save = (list) => { store.set('alerts', list); listeners.forEach((f) => f()); };
const list = () => store.get('alerts').filter((a) => TYPES.includes(a.type));

function mutate(id, fn) {
  const all = list();
  const i = all.findIndex((a) => a.id === id);
  if (i < 0) return { ok: false, error: 'La alerta ya no existe.' };
  all[i] = fn(all[i]);
  save(all);
  return { ok: true, alert: all[i] };
}

/**
 * Evalúa todas las alertas activas. `quotes` y `signals` son Map(símbolo → datos | Error).
 * Devuelve las entradas de historial de las que han saltado (ya guardadas).
 */
function evaluateAll({ quotes = new Map(), signals = new Map(), now = Date.now() }) {
  const all = list();
  const fired = [];
  const next = all.map((a) => {
    if (a.status !== 'active') return a;
    const r = evaluate(a, { quote: quotes.get(a.symbol), signals: signals.get(a.symbol) });
    const upd = applyResult(a, r, now);
    if (r.fire) fired.push({ id: `h${now.toString(36)}${fired.length}`, alertId: a.id, symbol: a.symbol, type: a.type, condition: describe(a), message: r.message, at: now });
    return upd;
  });
  save(next);
  if (fired.length) store.set('alertHistory', [...store.get('alertHistory'), ...fired]);
  return fired;
}

Aura.alerts = {
  TYPES, SIGNAL_TYPES, ACTION_TEXT,
  list,
  get: (id) => list().find((a) => a.id === id) || null,
  add(input, now = Date.now()) {
    const err = validate(input);
    if (err) return { ok: false, error: err };
    const a = create(input, now);
    save([...list(), a]);
    return { ok: true, alert: a };
  },
  update(id, input, now = Date.now()) {
    const err = validate(input);
    if (err) return { ok: false, error: err };
    return mutate(id, (a) => edit(a, input, now));
  },
  pause: (id) => mutate(id, pause),
  resume: (id, now = Date.now()) => mutate(id, (a) => rearm(a, now)),
  rearm: (id, now = Date.now()) => mutate(id, (a) => rearm(a, now)),
  remove(id) {
    const all = list();
    if (!all.some((a) => a.id === id)) return { ok: false, error: 'La alerta ya no existe.' };
    save(all.filter((a) => a.id !== id));
    return { ok: true };
  },
  /** Deshacer un borrado: vuelve a guardar la alerta tal como estaba. */
  restore(alert) {
    const all = list();
    if (!alert || all.some((a) => a.id === alert.id)) return { ok: false };
    save([...all, alert]);
    return { ok: true };
  },
  history: () => store.get('alertHistory'),
  clearHistory() { store.set('alertHistory', []); listeners.forEach((f) => f()); },
  needsSignals: (a) => SIGNAL_TYPES.has(a.type),
  evaluateAll,
  validate, describe, signalsFrom,
  onChange(f) { listeners.add(f); return () => listeners.delete(f); },
  // Funciones puras (sin guardar nada), para pruebas
  pure: { validate, describe, evaluate, signalsFrom, create, edit, pause, rearm, applyResult },
};
})();
