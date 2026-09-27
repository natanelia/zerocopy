import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
const out = new URL('../_site/', import.meta.url);
const meta = JSON.parse(readFileSync(new URL('build.json', out), 'utf8'));
test('comparison exposes all three real implementations and isolates their scripts', () => {
  const html = readFileSync(new URL('compare/index.html', out), 'utf8');
  assert.match(html, /id="lane-immutable"/); assert.match(html, /withMutations/);
  assert.match(html, /WITHOUT ZEROCOPY/); assert.match(html, /WITH ZEROCOPY/);
  assert.match(html, /Incremental deltas/); assert.match(html, /not bytes or measured heap/);
  assert.ok(existsSync(new URL('compare/assets/comparison-reader.mjs', out)));
  assert.ok(existsSync(new URL('compare/isolation-sw.js', out)));
  for (const route of ['compare/', 'investigation-benchmark/']) {
    assert.ok(existsSync(new URL(route + 'vendor/immutable.mjs', out)));
    assert.ok(existsSync(new URL(route + 'vendor/immutable-LICENSE.txt', out)));
    assert.ok(existsSync(new URL(route + 'assets/immutable-storage.mjs', out)));
  }
  assert.ok(meta.dependencies.immutable);
  assert.match(readFileSync(new URL('index.html', out), 'utf8'), /Compare it live/);
  if (meta.preview) {
    assert.match(html, /noindex,nofollow/); assert.match(html, /Return to PR/);
    assert.ok(meta.base.includes(meta.preview.headCommit));
  }
});
