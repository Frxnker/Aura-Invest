/**
 * Captura respuestas REALES de Twelve Data como fixtures de prueba.
 *
 *   node tests/tools/capture-twelvedata.mjs
 *
 * Usa la clave pública `demo` de Twelve Data (solo sirve para símbolos de ejemplo
 * como AAPL o EUR/USD). La clave va en la cabecera Authorization y no se guarda en
 * ningún archivo: las respuestas de la API no la contienen.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../harness.mjs';

const OUT = path.join(ROOT, 'tests', 'fixtures', 'twelvedata');
const BASE = 'https://api.twelvedata.com';
const KEY = 'demo';

const CAPTURES = [
  ['time_series_AAPL_1day', '/time_series?symbol=AAPL&interval=1day&outputsize=400&timezone=Exchange', true],
  ['time_series_AAPL_1week', '/time_series?symbol=AAPL&interval=1week&outputsize=400&timezone=Exchange', true],
  ['time_series_AAPL_5min', '/time_series?symbol=AAPL&interval=5min&outputsize=260&timezone=Exchange', true],
  ['time_series_AAPL_15min', '/time_series?symbol=AAPL&interval=15min&outputsize=330&timezone=Exchange', true],
  ['time_series_AAPL_1h', '/time_series?symbol=AAPL&interval=1h&outputsize=360&timezone=Exchange', true],
  // Misma sesión que time_series_AAPL_5min (2 oct 2026), en hora de Madrid: alineación en UTC real al comparar
  ['time_series_EURUSD_5min_madrid', '/time_series?symbol=EUR/USD&interval=5min&start_date=2026-10-02%2015:00:00&end_date=2026-10-02%2022:30:00&timezone=Europe/Madrid', true],
  ['quote_AAPL', '/quote?symbol=AAPL', true],
  // Splits de AAPL (7 por 1 el 9 jun 2014; 4 por 1 el 31 ago 2020): cierres tal cual y ajustados
  ['time_series_AAPL_1day_split2014_none', '/time_series?symbol=AAPL&interval=1day&start_date=2014-05-27&end_date=2014-06-20&adjust=none&timezone=Exchange', true],
  ['time_series_AAPL_1day_split2014_splits', '/time_series?symbol=AAPL&interval=1day&start_date=2014-05-27&end_date=2014-06-20&adjust=splits&timezone=Exchange', true],
  ['time_series_AAPL_1day_split2020_none', '/time_series?symbol=AAPL&interval=1day&start_date=2020-08-17&end_date=2020-09-11&adjust=none&timezone=Exchange', true],
  ['time_series_AAPL_1day_split2020_splits', '/time_series?symbol=AAPL&interval=1day&start_date=2020-08-17&end_date=2020-09-11&adjust=splits&timezone=Exchange', true],
  ['symbol_search_SAN', '/symbol_search?symbol=SAN&outputsize=12&show_plan=true', false],
  ['symbol_search_apple', '/symbol_search?symbol=apple&outputsize=12&show_plan=true', false],
  ['error_401_bad_key', '/quote?symbol=AAPL', 'clave-incorrecta'],
  ['error_401_demo_limited', '/time_series?symbol=SAN:BME&interval=1day&outputsize=5', true],
];

mkdirSync(OUT, { recursive: true });
const index = {};
for (const [name, query, auth] of CAPTURES) {
  const headers = auth === true ? { Authorization: `apikey ${KEY}` } : auth ? { Authorization: `apikey ${auth}` } : {};
  const res = await fetch(BASE + query, { headers });
  const body = await res.json();
  writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify(body, null, 1) + '\n');
  index[name] = { query, httpStatus: res.status, capturedAt: new Date().toISOString() };
  console.log(name.padEnd(28), res.status, body.status ?? (Array.isArray(body.data) ? 'ok' : '?'));
  await new Promise((r) => setTimeout(r, 8000));   // respeta el límite por minuto
}
writeFileSync(path.join(OUT, '_index.json'), JSON.stringify({
  note: 'Respuestas reales de api.twelvedata.com capturadas con la clave pública "demo" (sin clave personal).',
  captures: index,
}, null, 2) + '\n');
