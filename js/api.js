/* =========================================================================
 * Aura Invest · Cliente de Twelve Data
 * - La clave viaja en la cabecera `Authorization: apikey …`, nunca en una URL.
 * - Cola de peticiones con prioridad y límites del plan gratuito:
 *   8 créditos por minuto (ventana deslizante de 60 s, más estricta que la del
 *   servidor) y 800 al día (se asume que el día se reinicia a las 00:00 UTC).
 * - Al recibir un 429 por minuto, espera al minuto siguiente y reintenta UNA vez;
 *   al agotar el cupo diario, deja de pedir hasta el día siguiente.
 * - Caché en memoria y en localStorage (Aura.store) con caducidad por entrada.
 * - Todo lo que depende del tiempo (reloj, esperas) es inyectable para las pruebas.
 * ========================================================================= */
(() => {
'use strict';

const { API } = Aura.config;
const { utcDay } = Aura.utils;

/** Error con un código estable que la interfaz traduce a un mensaje claro. */
class ApiError extends Error {
  constructor(code, message, { httpStatus = null, apiMessage = '' } = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.apiMessage = apiMessage;     // texto original de Twelve Data (escapar al mostrarlo)
  }
}

const MESSAGES = {
  NO_KEY: 'Falta la clave de Twelve Data.',
  AUTH: 'Twelve Data rechaza la clave de API (no es válida o se ha revocado).',
  PLAN: 'Este símbolo o mercado no está incluido en tu plan de Twelve Data.',
  NOT_FOUND: 'Twelve Data no tiene datos para este símbolo.',
  BAD_REQUEST: 'Twelve Data no acepta la petición (parámetros no válidos).',
  MINUTE_LIMIT: `Se ha alcanzado el límite de ${API.perMinute} créditos por minuto.`,
  DAILY_LIMIT: `Se ha alcanzado el límite diario de ${API.perDay} créditos.`,
  SERVER: 'Twelve Data no responde correctamente.',
  NETWORK: 'No hay conexión con Twelve Data.',
  ABORTED: 'Petición cancelada.',
};

const PLAN_TEXT = /\b(plan|upgrade|available (exclusively|starting))\b/i;

/** Traduce el `code`/estado HTTP de Twelve Data a un código interno. */
function classify(httpStatus, body) {
  const code = Number(body && body.code) || httpStatus;
  const msg = String((body && body.message) || '');
  if (code === 401) return 'AUTH';
  if (code === 403) return 'PLAN';
  if (code === 429) return /\b(day|daily)\b/i.test(msg) ? 'DAILY_LIMIT' : 'MINUTE_LIMIT';
  if (code === 404) return PLAN_TEXT.test(msg) ? 'PLAN' : 'NOT_FOUND';
  if (code === 400 || code === 414) return PLAN_TEXT.test(msg) ? 'PLAN' : 'BAD_REQUEST';
  return 'SERVER';
}

/** Construye un ApiError a partir de una respuesta de error de Twelve Data. */
function errorFrom(httpStatus, body) {
  const code = classify(httpStatus, body);
  return new ApiError(code, MESSAGES[code], {
    httpStatus: Number(body && body.code) || httpStatus || null,
    apiMessage: String((body && body.message) || ''),
  });
}

/**
 * @param {object} o
 * @param {Function} o.fetch   fetch del navegador (o sustituto en pruebas)
 * @param {object}   o.store   Aura.store (clave, uso y caché)
 * @param {Function} [o.now]   reloj en ms
 * @param {Function} [o.wait]  espera (ms) → Promise
 */
function createClient({ fetch: fetchFn, store, now = () => Date.now(), wait = (ms) => new Promise((r) => setTimeout(r, ms)), limits = API }) {
  const mem = new Map();          // caché en memoria: clave → { t, ttl, data }
  const inflight = new Map();     // peticiones idénticas en curso
  const queue = [];
  const listeners = new Set();
  let running = false;
  let pausedUntil = 0;            // pausa impuesta por un 429 del servidor
  let waitingUntil = 0;           // la cola espera cupo hasta este instante

  /* ---- Uso de créditos ---- */
  function usage() {
    const u = store.getUsage();
    const day = utcDay(now());
    const cur = u.day === day ? { ...u } : { day, credits: 0, recent: [] };
    cur.recent = cur.recent.filter((r) => now() - r.t < 60000);
    return cur;
  }
  function record(cost) {
    if (!cost) return null;
    const u = usage();
    const entry = { t: now(), cost };
    u.credits += cost;
    u.recent.push(entry);
    store.setUsage(u);
    return entry;
  }
  /** Una petición que no llegó a Twelve Data (sin conexión) no gasta créditos: se devuelven. */
  function refund(entry) {
    if (!entry) return;
    const u = usage();
    u.credits = Math.max(0, u.credits - entry.cost);
    const i = u.recent.findIndex((r) => r.t === entry.t && r.cost === entry.cost);
    if (i >= 0) u.recent.splice(i, 1);
    store.setUsage(u);
  }
  function exhaustDay() {
    const u = usage();
    u.credits = Math.max(u.credits, limits.perDay);
    store.setUsage(u);
  }
  /** Instante en que la ventana de 60 s deja sitio para `cost` créditos (0 = ya). */
  function minuteFreeAt(u, cost) {
    let used = u.recent.reduce((a, r) => a + r.cost, 0);
    if (used + cost <= limits.perMinute) return 0;
    const sorted = [...u.recent].sort((a, b) => a.t - b.t);
    for (const r of sorted) {
      used -= r.cost;
      if (used + cost <= limits.perMinute) return r.t + 60000 + 250;
    }
    return now() + 60000;
  }
  const nextMinute = () => Math.ceil((now() + 1) / 60000) * 60000 + 1500;

  function status() {
    const u = usage();
    return {
      creditsToday: u.credits, perDay: limits.perDay,
      minuteUsed: u.recent.reduce((a, r) => a + r.cost, 0), perMinute: limits.perMinute,
      queued: queue.length, waitingUntil, dailyExhausted: u.credits >= limits.perDay,
    };
  }
  function emit() { const s = status(); listeners.forEach((f) => f(s)); }

  /* ---- Caché ---- */
  const cacheKey = (path, params) => path + '?' + Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&');
  function cacheGet(key) {
    const e = mem.get(key) || store.getCache(key);
    if (e && now() - e.t < e.ttl * 1000) { mem.set(key, e); return e; }
    return null;
  }
  function cachePut(key, data, ttl) {
    const e = { t: now(), ttl, data };
    mem.set(key, e);
    store.setCache(key, e);
    return e;
  }

  /* ---- Envío ---- */
  async function send(job) {
    const url = limits.base + job.path + '?' + new URLSearchParams(job.params).toString();
    const headers = job.auth ? { Authorization: `apikey ${store.getApiKey()}` } : {};
    let res;
    try {
      res = await fetchFn(url, { headers, signal: job.signal });
    } catch (e) {
      if (e && e.name === 'AbortError') throw new ApiError('ABORTED', MESSAGES.ABORTED);
      throw new ApiError('NETWORK', MESSAGES.NETWORK);
    }
    let body = null;
    try { body = await res.json(); } catch { /* cuerpo no JSON */ }
    if (!body) throw errorFrom(res.status >= 400 ? res.status : 500, null);
    if (!res.ok || body.status === 'error') throw errorFrom(res.status, body);
    const at = job.ttl > 0 ? cachePut(job.key, body, job.ttl).t : now();
    return { data: body, cached: false, at };
  }

  function rejectQueuedPaid(err) {
    for (let i = queue.length - 1; i >= 0; i--) {
      if (queue[i].cost > 0) { queue[i].reject(err); queue.splice(i, 1); }
    }
  }

  async function pump() {
    if (running) return;
    running = true;
    try {
      while (queue.length) {
        const job = queue[0];
        const u = usage();
        if (job.cost > 0 && u.credits + job.cost > limits.perDay) {
          queue.shift();
          job.reject(new ApiError('DAILY_LIMIT', MESSAGES.DAILY_LIMIT));
          continue;
        }
        const until = job.cost > 0 ? Math.max(pausedUntil, minuteFreeAt(u, job.cost)) : 0;
        if (until > now()) {
          waitingUntil = until;
          emit();
          await wait(until - now());
          waitingUntil = 0;
          continue;                                  // se reevalúa (puede haber llegado algo más prioritario)
        }
        queue.shift();
        const spent = record(job.cost);
        emit();
        try {
          job.resolve(await send(job));
        } catch (err) {
          if (err.code === 'NETWORK') { refund(spent); emit(); }
          if (err.code === 'MINUTE_LIMIT' && !job.retried) {
            job.retried = true;                      // un único reintento tras el minuto siguiente
            pausedUntil = nextMinute();
            queue.unshift(job);
          } else {
            if (err.code === 'DAILY_LIMIT') { exhaustDay(); rejectQueuedPaid(err); }
            job.reject(err);
          }
        }
      }
    } finally {
      running = false;
      emit();
    }
  }

  /**
   * Petición GET. Devuelve { data, cached, at } (at = cuándo se obtuvo el dato, ms).
   * @param {object} opt  cost (créditos), ttl (s; 0 = sin caché), auth, priority (mayor = antes), signal
   */
  function get(path, params = {}, { cost = 1, ttl = 0, auth = true, priority = 0, signal } = {}) {
    const key = cacheKey(path, params);
    if (ttl > 0) {
      const c = cacheGet(key);
      if (c) return Promise.resolve({ data: c.data, cached: true, at: c.t });
    }
    if (!signal && inflight.has(key)) return inflight.get(key);
    if (auth && !store.getApiKey()) return Promise.reject(new ApiError('NO_KEY', MESSAGES.NO_KEY));

    const p = new Promise((resolve, reject) => {
      const job = { path, params, key, ttl, auth, priority, signal, cost: auth ? cost : 0, resolve, reject, retried: false };
      if (job.cost === 0) { send(job).then(resolve, reject); return; }   // sin coste: no espera cupo
      if (signal) {
        if (signal.aborted) { reject(new ApiError('ABORTED', MESSAGES.ABORTED)); return; }
        signal.addEventListener('abort', () => {
          const i = queue.indexOf(job);
          if (i >= 0) { queue.splice(i, 1); reject(new ApiError('ABORTED', MESSAGES.ABORTED)); emit(); }
        }, { once: true });
      }
      queue.push(job);
      queue.sort((a, b) => b.priority - a.priority);   // orden estable: FIFO dentro de cada prioridad
      pump();
    });
    if (!signal) {
      inflight.set(key, p);
      p.then(() => inflight.delete(key), () => inflight.delete(key));
    }
    return p;
  }

  /** Entrada de caché aunque haya caducado (para mostrar datos antiguos si la API falla). */
  const cacheGetAny = (key) => mem.get(key) || store.getCache(key) || null;

  return {
    get, status, cacheGet, cachePut, cacheGetAny, keyFor: cacheKey,
    onStatus(f) { listeners.add(f); return () => listeners.delete(f); },
    clearMemoryCache: () => mem.clear(),
  };
}

const browserFetch = (url, opts) => window.fetch(url, opts);

Aura.api = {
  client: createClient({ fetch: browserFetch, store: Aura.store }),
  createClient, ApiError, MESSAGES, classify, errorFrom,
};
})();
