import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';

const site = new URL('../_site/', import.meta.url);
const metadata = JSON.parse(readFileSync(new URL('build.json', site)));
const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');

test('benchmark build identifies every copied library chunk and workload', () => {
  assert.match(metadata.sourceCommit, /^[a-f0-9]{40}$/);
  assert.equal(metadata.librarySHA256, metadata.libraryFilesSHA256['shared.js']);
  assert.deepEqual(Object.keys(metadata.libraryFilesSHA256).sort(), readdirSync(new URL('library/', site)).filter(name => name.endsWith('.js')).sort());
  for (const [name, expected] of Object.entries(metadata.libraryFilesSHA256)) {
    assert.equal(sha256(new URL(`library/${name}`, site)), expected, name);
    assert.equal(sha256(new URL(`benchmarks/library/${name}`, site)), expected, `scoped ${name}`);
  }
  for (const name of ['catalog-core.mjs', 'catalog-read-workloads.mjs', 'catalog-read-reference.mjs', 'read-benchmark-reader.mjs', 'read-benchmark-owner.mjs', 'catalog-benchmark-results.mjs', 'benchmark-bars.mjs']) {
    assert.match(metadata.benchmarkFilesSHA256[name], /^[a-f0-9]{64}$/);
  }
  for (const [name, expected] of Object.entries(metadata.benchmarkFilesSHA256)) {
    assert.equal(sha256(new URL(`benchmarks/assets/${name}`, site)), expected, name);
  }
  for (const [name, expected] of Object.entries(metadata.vendorFilesSHA256)) {
    assert.equal(sha256(new URL(`benchmarks/vendor/${name}`, site)), expected, name);
  }
  assert.match(metadata.buildEnvironment.node, /^v\d+\./);
  assert.equal(metadata.buildEnvironment.rustToolchain, /channel\s*=\s*"([^"]+)"/.exec(readFileSync(new URL('../../rust-toolchain.toml', import.meta.url), 'utf8'))[1]);
  assert.ok(Object.keys(metadata.wasmFilesSHA256).includes('persistent-core.wasm'));
});
