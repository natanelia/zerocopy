import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { regressionHTML } from './regression-preview.mjs';
const out = new URL('../_site/', import.meta.url);
const meta = JSON.parse(readFileSync(new URL('build.json', out), 'utf8'));
test('test-only comparison retains all four implementations without publishing another page', () => {
  const html = regressionHTML('historical/log-compare/');
  assert.match(html, /id="lane-immutable"/); assert.match(html, /withMutations/);
  assert.match(html, /id="lane-immer"/); assert.match(html, /Immer arrays/); assert.match(html, /produce/);
  assert.match(html, /Load all four paths/); assert.match(html, /Immer was not measured/);
  assert.match(html, /WITHOUT ZEROCOPY/); assert.match(html, /WITH ZEROCOPY/);
  assert.match(html, /Incremental copy is the default/);
  assert.match(html, /Full copy · all events every update/); assert.match(html, /not bytes or measured heap/);
  assert.ok(existsSync(new URL('assets/comparison-reader.mjs', out)));
  assert.ok(existsSync(new URL('assets/isolation-sw.js', out)));
  for (const route of ['historical/log-compare/', 'historical/log-benchmark/']) {
    assert.match(readFileSync(new URL(route + 'index.html', out), 'utf8'), /http-equiv="refresh"/);
    assert.ok(!existsSync(new URL(route + 'assets/', out)), 'No competing live page assets are deployed');
  }
  assert.ok(meta.dependencies.immutable);
  assert.ok(meta.dependencies.immer);
  for (const file of ['immutable.mjs', 'immutable-LICENSE.txt', 'immer.mjs', 'immer-LICENSE.txt']) assert.ok(existsSync(new URL('vendor/' + file, out)));
  assert.ok(existsSync(new URL('assets/immer-storage.mjs', out)));
  const homepage = readFileSync(new URL('index.html', out), 'utf8');
  assert.ok(homepage.includes(`href="${meta.base}benchmarks/"`));
  assert.ok(!homepage.includes(`href="${meta.base}compare/"`));
  if (meta.preview) {
    assert.match(html, /noindex,nofollow/); assert.match(html, /Return to PR/);
    assert.ok(meta.base.includes(meta.preview.headCommit));
  }
});
