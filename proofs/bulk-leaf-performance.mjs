/** One workload per fresh process. Arguments: baseline directory, candidate
 * directory, value type, key-length workload. Alternate independent rounds.
 */
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cpus } from 'node:os';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
const comparison = process.env.COMPARISON ?? 'AB';
const importOrder = process.env.IMPORT_ORDER ?? 'baseline-first';
assert(['AB', 'AA'].includes(comparison));
assert(['baseline-first', 'candidate-first'].includes(importOrder));
const roots = [resolve(process.argv[2]), resolve(process.argv[3])], type = process.argv[4], mode = process.argv[5];
assert(['number', 'boolean'].includes(type), 'Choose number or boolean');
assert(['saving', 'control', 'mixed'].includes(mode), 'Choose saving, control, or mixed');
const libraries = [];
for (const index of importOrder === 'baseline-first' ? [0, 1] : [1, 0]) {
  libraries[index] = await import(pathToFileURL(resolve(roots[index], 'dist/shared.js')).href);
}
const count = Number(process.env.COUNT ?? 8192), warmups = Number(process.env.WARMUPS ?? 20), samples = Number(process.env.SAMPLES ?? 32);
assert(count > 0 && count <= 46656 && Number.isInteger(count));
assert(samples >= 5 && warmups >= 5 && Number.isInteger(samples) && Number.isInteger(warmups));
const keyLength = type === 'number' ? 3 : 8;
const entries = Array.from({ length: count }, (_, i) => [
  'x'.repeat((mode === 'mixed' ? 3 + (i % 8) : mode === 'saving' ? keyLength : 7) - 3) + i.toString(36).padStart(3, '0'),
  type === 'number' ? i + 0.25 : i % 2 === 0]);
// Separate lexical callsites keep the two independently bundled class
// identities out of one polymorphic setMany callsite.
const runBaseline = input => input.setMany(entries);
const runCandidate = input => input.setMany(entries);
const runs = [runBaseline, runCandidate];
const times = [[], []], allocatedBytes = [[], []];
for (let round = -warmups; round < samples; round++) {
  const inputs = libraries.map(S => { S.resetMap(); return new S.SharedMap(type); }), outputs = [];
  for (const index of (round + (importOrder === 'candidate-first' ? 1 : 0)) & 1 ? [1, 0] : [0, 1]) {
    const input = inputs[index], before = input.arena.used, start = performance.now();
    const output = runs[index](input), elapsed = performance.now() - start; outputs[index] = output;
    if (round >= 0) { times[index].push(elapsed); allocatedBytes[index].push(input.arena.used - before); }
  }
  for (const output of outputs) { assert.equal(output.size, count); for (const [key, value] of entries) assert.equal(output.get(key), value); }
  globalThis.gc?.(); if (typeof Bun !== 'undefined') Bun.gc(true);
}
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const manifests = roots.map(root => {
  const sourcePaths = ['arena.ts', 'codec.ts', 'freeze-json.ts', 'persistent-core.as.ts', 'shared-map.ts', 'package.json', 'scripts/build-wasm.mjs', 'scripts/build-browser.ts'];
  const bundlePaths = readdirSync(resolve(root, 'dist')).filter(p => p.endsWith('.js')).sort().map(p => `dist/${p}`);
  return Object.fromEntries([...sourcePaths, 'persistent-core.wasm', ...bundlePaths].map(path => [path, sha256(readFileSync(resolve(root, path)))]));
});
if (comparison === 'AA') assert.deepEqual(manifests[0], manifests[1], 'A/A must use identical source and independently copied bundles');
const quantile = (values, p) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor((sorted.length - 1) * p)]; };
console.log(JSON.stringify({ schema: 'zerocopy-bulk-leaf-performance/v4', comparison, importOrder, timestamp: new Date().toISOString(),
  harnessSha256: sha256(readFileSync(new URL(import.meta.url))), sourceManifests: manifests,
  roots, runtime: typeof Bun === 'undefined' ? `Node ${process.version}` : `Bun ${Bun.version}`, cpu: cpus()[0]?.model, platform: process.platform, arch: process.arch,
  outputChecked: true, setupTimed: false, gcTimed: false, type, mode, count, warmups, samples,
  samplesMs: times, allocatedBytes, mediansMs: times.map(x => quantile(x, 0.5)), p10Ms: times.map(x => quantile(x, 0.1)), p90Ms: times.map(x => quantile(x, 0.9)),
  baselineOverCandidate: quantile(times[0], 0.5) / quantile(times[1], 0.5) }, null, 2));
