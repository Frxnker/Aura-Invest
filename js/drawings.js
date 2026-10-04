/* =========================================================================
 * Aura Invest · Dibujos (lógica y persistencia)
 * Líneas horizontales { kind: 'hline', price } y de tendencia
 * { kind: 'trend', a: { t, p }, b: { t, p } }, guardadas por símbolo en Aura.store.
 * Los tiempos usan la misma codificación que las velas (hora de la bolsa como UTC),
 * así una línea de tendencia trazada en diario se ve también en otras temporalidades.
 * ========================================================================= */
(() => {
'use strict';

const store = Aura.store;
const { DRAWINGS_MAX, validDrawing } = Aura.storeInternals;

let idSeq = 0;
const newId = () => (globalThis.crypto && typeof crypto.randomUUID === 'function'
  ? crypto.randomUUID()
  : `d${Date.now().toString(36)}${(++idSeq).toString(36)}`);

/* ---------------------------------------------------------------------------
 * Geometría (pura): tiempo ↔ índice lógico del gráfico
 * ------------------------------------------------------------------------- */

/**
 * Índice lógico (fraccionario) de un instante en una serie de tiempos ordenada.
 * Entre dos velas interpola; fuera de la serie extrapola con el paso medio.
 */
function timeToLogical(times, t, step) {
  const n = times.length;
  if (!n) return null;
  if (t <= times[0]) return (t - times[0]) / step;
  if (t >= times[n - 1]) return n - 1 + (t - times[n - 1]) / step;
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (times[mid] <= t) lo = mid; else hi = mid; }
  return lo + (t - times[lo]) / (times[hi] - times[lo]);
}

/** Inverso de timeToLogical. */
function logicalToTime(times, l, step) {
  const n = times.length;
  if (!n || !Number.isFinite(l)) return null;
  if (l <= 0) return times[0] + l * step;
  if (l >= n - 1) return times[n - 1] + (l - (n - 1)) * step;
  const i = Math.floor(l);
  return times[i] + (l - i) * (times[i + 1] - times[i]);
}

/** Paso medio entre velas (para extrapolar fuera de los datos). */
function stepOf(times) {
  const k = Math.min(20, times.length - 1);
  return k > 0 ? (times[times.length - 1] - times[times.length - 1 - k]) / k : 86400;
}

/** Distancia de un punto a un segmento (píxeles). */
function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const u = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return Math.hypot(px - (ax + u * dx), py - (ay + u * dy));
}

/**
 * ¿Qué dibujo hay bajo el puntero? `coords` = [{ id, kind, y } | { id, kind, xa, ya, xb, yb }]
 * Devuelve { id, part: 'line' | 'a' | 'b' } o null. Los extremos tienen prioridad.
 */
function hitTest(coords, x, y, tol = 6) {
  let best = null;
  for (const c of coords) {
    if (c.kind === 'hline') {
      const d = Math.abs(y - c.y);
      if (d <= tol && (!best || d < best.d)) best = { id: c.id, part: 'line', d };
    } else {
      const da = Math.hypot(x - c.xa, y - c.ya), db = Math.hypot(x - c.xb, y - c.yb);
      if (da <= tol + 3 && (!best || da < best.d)) best = { id: c.id, part: 'a', d: da };
      else if (db <= tol + 3 && (!best || db < best.d)) best = { id: c.id, part: 'b', d: db };
      else {
        const d = distToSegment(x, y, c.xa, c.ya, c.xb, c.yb);
        if (d <= tol && (!best || d < best.d)) best = { id: c.id, part: 'line', d };
      }
    }
  }
  return best ? { id: best.id, part: best.part } : null;
}

/** Desplaza un dibujo: en precio (relativo) y, para tendencias, en tiempo (segundos). */
function shift(d, { factor = 1, dt = 0 } = {}) {
  if (d.kind === 'hline') return { ...d, price: d.price * factor };
  return { ...d, a: { t: d.a.t + dt, p: d.a.p * factor }, b: { t: d.b.t + dt, p: d.b.p * factor } };
}

/* ---------------------------------------------------------------------------
 * Persistencia
 * ------------------------------------------------------------------------- */

const listeners = new Set();
const all = () => store.get('drawings');
function save(symbol, list) {
  const d = all();
  if (list.length) d[symbol] = list; else delete d[symbol];
  store.set('drawings', d);
  listeners.forEach((f) => f(symbol));
}

Aura.drawings = {
  MAX: DRAWINGS_MAX,
  list: (symbol) => all()[symbol] || [],
  add(symbol, drawing) {
    const list = Aura.drawings.list(symbol);
    if (list.length >= DRAWINGS_MAX) return { ok: false, error: `Como mucho ${DRAWINGS_MAX} dibujos por valor.` };
    const d = { ...drawing, id: newId() };
    if (!validDrawing(d)) return { ok: false, error: 'Dibujo no válido.' };
    save(symbol, [...list, d]);
    return { ok: true, drawing: d };
  },
  update(symbol, id, next) {
    const list = Aura.drawings.list(symbol);
    const i = list.findIndex((d) => d.id === id);
    if (i < 0) return { ok: false, error: 'El dibujo ya no existe.' };
    const d = { ...next, id };
    if (!validDrawing(d)) return { ok: false, error: 'Precio no válido.' };
    list[i] = d;
    save(symbol, list);
    return { ok: true, drawing: d };
  },
  remove(symbol, id) {
    const list = Aura.drawings.list(symbol);
    if (!list.some((d) => d.id === id)) return { ok: false };
    save(symbol, list.filter((d) => d.id !== id));
    return { ok: true };
  },
  clear(symbol) { save(symbol, []); return { ok: true }; },
  onChange(f) { listeners.add(f); return () => listeners.delete(f); },
  // puras
  timeToLogical, logicalToTime, stepOf, distToSegment, hitTest, shift,
};
})();
