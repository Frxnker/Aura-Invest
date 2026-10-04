/**
 * Regenera tests/fixtures/model-fingerprint.json a partir de tests/fixtures/candles.json.
 *
 *   node tests/tools/update-fingerprint.mjs
 *
 * Úsalo SOLO cuando se haya decidido cambiar el modelo a propósito: la huella es
 * la referencia que protege contra cambios involuntarios.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadAura, readFixture, ROOT } from '../harness.mjs';
import { fingerprint } from '../fingerprint.mjs';

export function computeFingerprints() {
  const { Aura } = loadAura({ until: 'model' });
  const { cases } = readFixture('candles.json');
  return Object.fromEntries(cases.map((c) => [
    c.id,
    fingerprint(Aura.model.analyze({ meta: c.meta, bars: c.bars, barsPerDay: c.barsPerDay }, c.tf)),
  ]));
}

export function writeFingerprints() {
  const file = path.join(ROOT, 'tests', 'fixtures', 'model-fingerprint.json');
  writeFileSync(file, JSON.stringify(computeFingerprints(), null, 2) + '\n');
  return file;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log('Huella escrita en', writeFingerprints());
}
