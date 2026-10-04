import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { appScripts, loadAura, ROOT } from './harness.mjs';

test('index.html carga todos los js/*.js y solo esos', () => {
  const onDisk = readdirSync(path.join(ROOT, 'js')).filter((f) => f.endsWith('.js')).map((f) => `js/${f}`).sort();
  assert.deepEqual([...appScripts()].sort(), onDisk);
});

test('index.html no contiene JS ni CSS en línea', () => {
  const html = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.equal(/<script(?![^>]*\bsrc=)[^>]*>/.test(html), false, 'hay un <script> sin src');
  assert.equal(/<style[\s>]/.test(html), false, 'hay un <style> en línea');
});

test('los módulos de cálculo se cargan sin DOM y publican su API', () => {
  const { Aura } = loadAura({ until: 'model' });
  for (const ns of ['config', 'utils', 'data', 'indicators', 'model']) assert.ok(Aura[ns], `falta Aura.${ns}`);
  assert.equal(typeof Aura.model.analyze, 'function');
  assert.equal(typeof Aura.data.fetchMarketData, 'function');
});
