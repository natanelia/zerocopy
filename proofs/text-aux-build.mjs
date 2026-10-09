/** Reproducible build bytes and compatibility checks; no performance samples. */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { resolve, join, relative, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const baseline = resolve(process.argv[2] ?? 'build/text-aux-baseline');
const candidate = resolve('.');
const roots = {
  baseline: join(baseline, 'dist'),
  scalar: resolve('build/text-aux-experiment/scalar'),
  simd: resolve('build/text-aux-experiment/simd'),
};
const sha256 = data => createHash('sha256').update(data).digest('hex');
function walk(root) {
  return readdirSync(root).flatMap(name => statSync(join(root, name)).isDirectory() ? walk(join(root, name)) : [join(root, name)]);
}
const identicalWasm = readdirSync(baseline).filter(name => name.endsWith('.wasm')).sort().map(name => {
  const original = readFileSync(join(baseline, name)), current = readFileSync(join(candidate, name));
  assert.deepEqual(current, original, name);
  return { name, bytes: current.length, sha256: sha256(current) };
});
const baselineTypes = join(baseline, 'dist/types'), candidateTypes = join(candidate, 'dist/types');
const identicalDeclarations = walk(baselineTypes).filter(path => path.endsWith('.d.ts')).map(path => {
  const name = relative(baselineTypes, path), current = readFileSync(join(candidateTypes, name));
  assert.deepEqual(current, readFileSync(path), name);
  return { name, sha256: sha256(current) };
});
const names = new Set(identicalDeclarations.map(file => file.name));
const addedDeclarations = walk(candidateTypes).map(path => relative(candidateTypes, path)).filter(path => !names.has(path));
assert.deepEqual(addedDeclarations.sort(), ['text-kernel.d.ts', 'text-wasm.d.ts']);
const bundles = {};
for (const [arm, root] of Object.entries(roots)) {
  const files = new Set();
  function visit(path) {
    if (files.has(path)) return;
    files.add(path);
    for (const match of readFileSync(path, 'utf8').matchAll(/(?:\bfrom\s*|\bimport\s*)["'](\.\/[^"']+\.js)["']/g)) visit(resolve(dirname(path), match[1]));
  }
  visit(join(root, 'shared.js'));
  const reachable = [...files].sort().map(path => {
    const data = readFileSync(path);
    return { name: relative(root, path), bytes: data.length, gzipBytes: gzipSync(data).length, sha256: sha256(data) };
  });
  bundles[arm] = {
    totalJavaScriptBytes: readdirSync(root).filter(name => name.endsWith('.js')).reduce((sum, name) => sum + statSync(join(root, name)).size, 0),
    ordinaryReachableBytes: reachable.reduce((sum, file) => sum + file.bytes, 0),
    ordinaryReachableGzipBytes: reachable.reduce((sum, file) => sum + file.gzipBytes, 0),
    files: reachable,
    publicExports: Object.keys(await import(pathToFileURL(join(root, 'shared.js')).href)).sort(),
  };
}
for (const arm of ['scalar', 'simd']) assert.deepEqual(bundles[arm].publicExports, bundles.baseline.publicExports);
const auxiliary = ['scalar', 'simd'].map(arm => {
  const data = readFileSync(`text-aux-${arm}.wasm`);
  return { arm, wasmBytes: data.length, base64Characters: data.toString('base64').length, sha256: sha256(data) };
});
console.log(JSON.stringify({ identicalWasm, identicalDeclarations, addedDeclarations, bundles, auxiliary }, null, 2));
