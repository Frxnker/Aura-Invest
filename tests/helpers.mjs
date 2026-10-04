/**
 * Utilidades de prueba: fetch sustituto (sin red) y reloj falso.
 */
import { readFixture } from './harness.mjs';

/** Respuesta real de Twelve Data guardada en tests/fixtures/twelvedata/. */
export const td = (name) => readFixture(`twelvedata/${name}.json`);

/**
 * fetch falso. `handler(url: URL, init) → { status?, body } | Promise<…>`.
 * Registra cada llamada en `calls` ({ url, path, params, headers }).
 */
export function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = new URL(url);
    const call = { url: String(url), path: u.pathname, params: Object.fromEntries(u.searchParams), headers: { ...(init.headers || {}) } };
    calls.push(call);
    if (init.signal && init.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    const r = await handler(u, init, call);
    if (r instanceof Error) throw r;
    const status = r.status ?? 200;
    return { ok: status >= 200 && status < 300, status, json: async () => (typeof r.body === 'string' ? JSON.parse(r.body) : r.body) };
  };
  fn.calls = calls;
  return fn;
}

/** Reloj controlable: `wait(ms)` avanza el tiempo al instante, sin esperas reales. */
export function fakeClock(start = Date.UTC(2026, 9, 5, 14, 0, 0)) {
  let t = start;
  const waits = [];
  return {
    now: () => t,
    wait: async (ms) => { waits.push(ms); t += Math.max(0, ms); },
    advance: (ms) => { t += ms; },
    waits,
  };
}
