/**
 * Genera las velas fijas de tests/fixtures/candles.json con el simulador
 * (paseo aleatorio determinista) y escribe la huella del modelo.
 *
 *   node tests/tools/make-fixtures.mjs
 *
 * La fecha se congela para que el resultado sea reproducible. Normalmente no hace
 * falta volver a ejecutarlo: las velas son la entrada fija de las pruebas.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadAura, plain, ROOT } from '../harness.mjs';
import { fingerprint } from '../fingerprint.mjs';
import { writeFingerprints } from './update-fingerprint.mjs';

const NOW = Date.UTC(2026, 9, 4, 12);   // dom 4 oct 2026 → última sesión cerrada: vie 2 oct
const CASES = [['AAPL', '6M'], ['MSFT', '1M'], ['MSFT', 'YTD'], ['NVDA', '1D'], ['NVDA', '1A'], ['SAN.MC', '5D'], ['TSLA', '5A']];

const { Aura } = loadAura({ until: 'model', now: NOW, extra: ['tests/tools/simulator.js'] });
const r4 = (v) => Math.round(v * 1e4) / 1e4;
const cases = [];

for (const [symbol, tf] of CASES) {
  const data = await Aura.simulator.fetchOHLCV(symbol, tf);
  const full = Aura.model.analyze(data, tf);
  // Solo se guardan las velas que analyze() usa (ventana + calentamiento)
  const firstUsed = full.bars[0].time;
  const used = data.bars.filter((b) => b.time >= firstUsed);
  const check = Aura.model.analyze({ ...data, bars: used }, tf);
  if (JSON.stringify(fingerprint(check)) !== JSON.stringify(fingerprint(full))) {
    throw new Error(`Recortar las velas altera el resultado de ${symbol} ${tf}`);
  }
  cases.push({
    id: `${symbol}-${tf}`, tf,
    meta: plain(data.meta), barsPerDay: data.barsPerDay,
    bars: used.map((b) => ({ time: b.time, open: r4(b.open), high: r4(b.high), low: r4(b.low), close: r4(b.close), volume: b.volume })),
  });
}

// Una vela por línea para que los diffs sean legibles
const json = '{\n  "note": "Velas sintéticas fijas (simulador determinista, fecha congelada 2026-10-04). Entrada de la huella del modelo.",\n  "cases": [\n'
  + cases.map((c) => {
    const { bars, ...head } = c;
    return `    ${JSON.stringify(head).slice(0, -1)}, "bars": [\n`
      + bars.map((b) => `      ${JSON.stringify(b)}`).join(',\n') + '\n    ]}';
  }).join(',\n') + '\n  ]\n}\n';

const file = path.join(ROOT, 'tests', 'fixtures', 'candles.json');
writeFileSync(file, json);
console.log('Velas escritas en', file, `(${cases.length} casos)`);
console.log('Huella escrita en', writeFingerprints());
