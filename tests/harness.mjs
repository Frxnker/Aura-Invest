/**
 * Arnés de pruebas: ejecuta los scripts reales de js/ dentro de un contexto `vm`
 * con un `window` mínimo, en el mismo orden en que los carga index.html.
 * No copia código de la app: lo que se prueba es exactamente lo que se publica.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Scripts de la app (js/*.js) en el orden de index.html. */
export function appScripts() {
  const html = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  return [...html.matchAll(/<script\s+src="(js\/[^"]+\.js)"/g)].map((m) => m[1]);
}

/** localStorage en memoria con la misma interfaz que el del navegador. */
export function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    get length() { return data.size; },
    key: (i) => [...data.keys()][i] ?? null,
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => { data.set(k, String(v)); },
    removeItem: (k) => { data.delete(k); },
    clear: () => data.clear(),
    dump: () => Object.fromEntries(data),
  };
}

/**
 * Carga Aura en un contexto aislado.
 * @param {object} opts
 * @param {string} [opts.until='model']  último módulo a cargar (nombre de archivo sin .js)
 * @param {string[]} [opts.extra=[]]     scripts adicionales (rutas relativas a la raíz) tras los de la app
 * @param {Function} [opts.fetch]        sustituto de fetch
 * @param {object} [opts.localStorage]   sustituto de localStorage (por defecto, en memoria)
 * @param {number} [opts.now]            fija `Date.now()`/`new Date()` (ms epoch)
 * @param {object} [opts.clock]          reloj falso (helpers.fakeClock): `Date` lo lee y
 *                                       `setTimeout(fn, ms)` lo adelanta `ms` sin esperar
 * @returns {{ Aura: object, window: object }}
 */
export function loadAura({ until = 'model', extra = [], fetch, localStorage, now, clock } = {}) {
  const win = {
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    URLSearchParams, AbortController,
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    localStorage: localStorage ?? memoryStorage(),
  };
  if (fetch) win.fetch = fetch;
  win.window = win;
  vm.createContext(win);

  if (clock) {
    win.__auraClock = clock;
    win.setTimeout = (fn, ms = 0) => { clock.advance(Math.max(0, ms)); return setTimeout(fn, 0); };
    vm.runInContext(`(() => {
      const Real = Date;
      class ClockDate extends Real {
        constructor(...a) { super(...(a.length ? a : [globalThis.__auraClock.now()])); }
        static now() { return globalThis.__auraClock.now(); }
      }
      globalThis.Date = ClockDate;
    })();`, win);
  } else if (now != null) {
    vm.runInContext(`(() => {
      const Real = Date, FIXED = ${Number(now)};
      class FixedDate extends Real {
        constructor(...a) { super(...(a.length ? a : [FIXED])); }
        static now() { return FIXED; }
      }
      globalThis.Date = FixedDate;
    })();`, win);
  }

  const scripts = appScripts();
  const stop = scripts.findIndex((f) => path.basename(f, '.js') === until);
  if (stop < 0) throw new Error(`Módulo desconocido: ${until}`);
  for (const file of [...scripts.slice(0, stop + 1), ...extra]) {
    vm.runInContext(readFileSync(path.join(ROOT, file), 'utf8'), win, { filename: file });
  }
  return { Aura: win.Aura, window: win };
}

export function readFixture(name) {
  return JSON.parse(readFileSync(path.join(ROOT, 'tests', 'fixtures', name), 'utf8'));
}

/** Copia "plana" de un valor creado dentro del vm (los prototipos de otro realm rompen deepEqual). */
export const plain = (v) => JSON.parse(JSON.stringify(v));
