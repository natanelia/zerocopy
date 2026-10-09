/** Built-in Node tests only: fake arm directories, read-only installed source.
 * HEAP_REPAIR_CACHE_TEST_DEPENDENCIES may name an existing node_modules directory.
 * No Vitest imports, browser launches, package installation, or shared writes.
 */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { archiveCacheEnd, FRESH_RESULTS, FRESH_RESULTS_SHA256, INSTALLED_SOURCE_SHA256,
  prepareCache, PROJECT_CACHE_KEY, verifyCacheStart } from './heap-repair-screen-cache.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const installed = resolve(process.env.HEAP_REPAIR_CACHE_TEST_DEPENDENCIES ?? join(repo, 'node_modules'));
const temporary = mkdtempSync(join(tmpdir(), 'heap-repair-cache-tests-'));
after(() => rmSync(temporary, { recursive: true, force: true }));
let counter = 0;
function fixture() {
  const base = join(temporary, String(++counter)), shared = join(base, 'shared-node_modules');
  mkdirSync(shared, { recursive: true });
  for (const source of Object.keys(INSTALLED_SOURCE_SHA256)) {
    const to = join(shared, source); mkdirSync(dirname(to), { recursive: true });
    copyFileSync(join(installed, source), to);
  }
  for (const packageName of ['.bin', '@scope/package', 'example']) mkdirSync(join(shared, packageName), { recursive: true });
  writeFileSync(join(shared, 'example/package.json'), '{"name":"example","version":"1.0.0"}');
  const sharedCache = join(shared, '.vite/vitest', PROJECT_CACHE_KEY, 'results.json');
  mkdirSync(dirname(sharedCache), { recursive: true });
  const prior = '{"version":"4.1.11","results":[[":workers.test.ts",{"duration":99,"failed":true}]]}';
  writeFileSync(sharedCache, prior);
  function arm(name) {
    const root = join(base, name); mkdirSync(join(root, 'node_modules'), { recursive: true });
    copyFileSync(join(repo, 'vitest.config.ts'), join(root, 'vitest.config.ts'));
    return root;
  }
  return { base, shared, sharedCache, prior, arm, receipt: name => join(base, `receipt-${name}`) };
}

test('two arms receive identical fresh bytes and keep the shared cache unchanged', () => {
  const f = fixture(), a = f.arm('a'), b = f.arm('b');
  const ra = prepareCache(a, f.shared, f.receipt('a'));
  const rb = prepareCache(b, f.shared, f.receipt('b'));
  assert.deepEqual(ra.seed, { bytes: 33, sha256: FRESH_RESULTS_SHA256 });
  assert.deepEqual(ra.seed, rb.seed);
  for (const [root, receipt] of [[a, ra], [b, rb]]) {
    assert.equal(readFileSync(receipt.resultsPath, 'utf8'), FRESH_RESULTS);
    assert.equal(verifyCacheStart(root, receipt).verified, true);
    assert(!lstatSync(join(root, 'node_modules/.vite')).isSymbolicLink());
    assert(lstatSync(join(root, 'node_modules/.bin')).isSymbolicLink());
    assert.equal(realpathSync(join(root, 'node_modules/@scope')), realpathSync(join(f.shared, '@scope')));
    assert.equal(readFileSync(receipt.sharedBefore.retainedPath, 'utf8'), f.prior);
    for (const source of receipt.implementation) assert.equal(source.sha256, INSTALLED_SOURCE_SHA256[source.path]);
  }
  const simulated = '{"version":"4.1.11","results":[[":example.test.ts",{"duration":7,"failed":false}]]}';
  writeFileSync(ra.resultsPath, simulated);
  assert.throws(() => verifyCacheStart(a, ra), /exact fresh bytes/);
  assert.equal(verifyCacheStart(b, rb).verified, true);
  const end = archiveCacheEnd(a, f.receipt('a'));
  assert.equal(end.parsed.resultCount, 1);
  assert.equal(readFileSync(end.output.retainedPath, 'utf8'), simulated);
  assert.equal(readFileSync(ra.resultsPath, 'utf8'), simulated);
  assert.equal(readFileSync(f.sharedCache, 'utf8'), f.prior);
});

test('refuses a shared node_modules symlink', () => {
  const f = fixture(), root = f.arm('a');
  rmSync(join(root, 'node_modules'), { recursive: true }); symlinkSync(f.shared, join(root, 'node_modules'), 'dir');
  assert.throws(() => prepareCache(root, f.shared, f.receipt('a')), /actual directory/);
  assert.equal(readFileSync(f.sharedCache, 'utf8'), f.prior);
});

test('refuses a shared .vite symlink without changing it', () => {
  const f = fixture(), root = f.arm('a');
  symlinkSync(join(f.shared, '.vite'), join(root, 'node_modules/.vite'), 'dir');
  assert.throws(() => prepareCache(root, f.shared, f.receipt('a')), /real directory/);
  assert.equal(readFileSync(f.sharedCache, 'utf8'), f.prior);
});

test('refuses existing arm results instead of resetting a previous run', () => {
  const f = fixture(), root = f.arm('a'), result = join(root, 'node_modules/.vite/vitest', PROJECT_CACHE_KEY, 'results.json');
  mkdirSync(dirname(result), { recursive: true }); writeFileSync(result, f.prior);
  assert.throws(() => prepareCache(root, f.shared, f.receipt('a')), /already has results/);
  assert.equal(readFileSync(result, 'utf8'), f.prior);
});

test('fails closed if installed implementation or repository config changes', () => {
  const f = fixture(), root = f.arm('a');
  writeFileSync(join(f.shared, 'vitest/package.json'), '{"version":"4.1.12"}');
  assert.throws(() => prepareCache(root, f.shared, f.receipt('a')), /implementation changed/);
  const g = fixture(), other = g.arm('b');
  writeFileSync(join(other, 'vitest.config.ts'), 'export default {};');
  assert.throws(() => prepareCache(other, g.shared, g.receipt('b')), /config changed/);
});

test('start guard rejects wrong receipt, modified seed and swapped cache directory', () => {
  const f = fixture(), root = f.arm('a'), receipt = prepareCache(root, f.shared, f.receipt('a'));
  assert.throws(() => verifyCacheStart(root, { ...receipt, root: f.base }));
  assert.throws(() => verifyCacheStart(root, { ...receipt, seed: { bytes: 0, sha256: '' } }));
  writeFileSync(receipt.resultsPath, FRESH_RESULTS + '\n');
  assert.throws(() => verifyCacheStart(root, receipt), /exact fresh bytes/);
  rmSync(join(root, 'node_modules/.vite'), { recursive: true });
  symlinkSync(join(f.shared, '.vite'), join(root, 'node_modules/.vite'), 'dir');
  assert.throws(() => verifyCacheStart(root, receipt), /real directory/);
  assert.equal(readFileSync(f.sharedCache, 'utf8'), f.prior);
});

test('end archive preserves invalid output and missing output for failure diagnosis', () => {
  const f = fixture(), a = f.arm('a'), ra = prepareCache(a, f.shared, f.receipt('a'));
  writeFileSync(ra.resultsPath, 'partial-json');
  const invalid = archiveCacheEnd(a, f.receipt('a'));
  assert(invalid.parseError);
  assert.equal(readFileSync(invalid.output.retainedPath, 'utf8'), 'partial-json');
  const b = f.arm('b'), rb = prepareCache(b, f.shared, f.receipt('b'));
  rmSync(rb.resultsPath);
  assert.equal(archiveCacheEnd(b, f.receipt('b')).output.state, 'absent');
});

test('preparation and archiving never overwrite earlier evidence', () => {
  const f = fixture(), a = f.arm('a'), b = f.arm('b');
  prepareCache(a, f.shared, f.receipt('a'));
  assert.throws(() => prepareCache(b, f.shared, f.receipt('a')), /fresh receipt directory/);
  const end = archiveCacheEnd(a, f.receipt('a'));
  assert.throws(() => archiveCacheEnd(a, f.receipt('a')), /EEXIST/);
  assert.deepEqual(JSON.parse(readFileSync(join(f.receipt('a'), 'end.json'))), end);
});
