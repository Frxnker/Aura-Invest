/* =========================================================================
 * Aura Invest · Watchlist (lógica y persistencia)
 * Lista ordenada de valores [{ id, name, exchange, currency }] guardada en
 * Aura.store (sección `watchlist`). Las operaciones son funciones puras sobre la
 * lista; la parte con estado solo las aplica y guarda.
 * ========================================================================= */
(() => {
'use strict';

const store = Aura.store;

/** Máximo de valores: cada actualización cuesta 1 crédito por valor (8/min en el plan gratuito). */
const MAX = 12;
const ID_FORMAT = /^[A-Za-z0-9.\-/:^]{1,24}$/;
const clean = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

/* ---- Operaciones puras: devuelven { list, error? } sin modificar la entrada ---- */

function add(list, item) {
  const id = item && item.id;
  if (!ID_FORMAT.test(id || '')) return { list, error: 'El identificador del valor no es válido.' };
  if (list.some((w) => w.id === id)) return { list, error: `${id} ya está en la watchlist.` };
  if (list.length >= MAX) {
    return { list, error: `La watchlist admite como máximo ${MAX} valores: cada actualización cuesta un crédito por valor.` };
  }
  return { list: [...list, { id, name: clean(item.name, 120), exchange: clean(item.exchange, 40), currency: clean(item.currency, 8) }] };
}

function remove(list, id) {
  if (!list.some((w) => w.id === id)) return { list, error: `${id} no está en la watchlist.` };
  return { list: list.filter((w) => w.id !== id) };
}

/** Mueve un valor `delta` posiciones (−1 sube, +1 baja); en los extremos no hace nada. */
function move(list, id, delta) {
  const i = list.findIndex((w) => w.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= list.length) return { list };
  const out = [...list];
  [out[i], out[j]] = [out[j], out[i]];
  return { list: out };
}

/** Completa nombre, bolsa y divisa con lo aprendido de la API, sin reordenar. */
function learn(list, id, meta) {
  return {
    list: list.map((w) => (w.id !== id ? w : {
      ...w,
      name: w.name || clean(meta.name, 120),
      exchange: w.exchange || clean(meta.exchange, 40),
      currency: w.currency || clean(meta.currency, 8),
    })),
  };
}

/* ---- Estado persistente ---- */

const listeners = new Set();
function apply(op, ...args) {
  const before = store.get('watchlist');
  const res = op(before, ...args);
  if (res.error) return { ok: false, error: res.error };
  const changed = JSON.stringify(res.list) !== JSON.stringify(before);
  if (changed) {
    store.set('watchlist', res.list);
    listeners.forEach((f) => f(res.list));
  }
  return { ok: true, changed };
}

Aura.watchlist = {
  MAX,
  items: () => store.get('watchlist'),
  ids: () => store.get('watchlist').map((w) => w.id),
  has: (id) => store.get('watchlist').some((w) => w.id === id),
  add: (item) => apply(add, item),
  remove: (id) => apply(remove, id),
  move: (id, delta) => apply(move, id, delta),
  learn: (id, meta) => apply(learn, id, meta),
  onChange(f) { listeners.add(f); return () => listeners.delete(f); },
  ops: { add, remove, move, learn },
};
})();
