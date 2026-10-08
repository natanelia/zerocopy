/** Isolated vector operation. A/A uses physical copies with identical hashes. */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cpus } from 'node:os';
const roots = [resolve(process.argv[2]), resolve(process.argv[3])], name = process.argv[4];
const cases = { 'append-empty': 0, 'append-tail-only': 32, 'append-existing-1k': 1057, 'append-existing-8k': 8192, 'set-control': 8192 };
assert(Object.hasOwn(cases, name)); const n = cases[name], set = name === 'set-control';
const comparison = process.env.COMPARISON ?? 'AB', importOrder = process.env.IMPORT_ORDER ?? 'baseline-first';
assert(['AB', 'AA'].includes(comparison)); assert(['baseline-first', 'candidate-first'].includes(importOrder));
const count = Number(process.env.COUNT ?? 4096), repeats = Number(process.env.REPEATS ?? 32), samples = Number(process.env.SAMPLES ?? 32), warmups = Number(process.env.WARMUPS ?? 20);
assert(count > 0 && repeats > 0 && samples >= 5 && warmups >= 5);
const reverse = importOrder === 'candidate-first', libraries = [];
for (const index of reverse ? [1, 0] : [0, 1]) libraries[index] = await import(pathToFileURL(resolve(roots[index], 'dist/shared.js')).href);
const values = Array.from({ length: n }, (_, i) => i + 0.25), append = Array.from({ length: count }, (_, i) => -i - 0.25);
const runBaseline = base => { const results = []; for (let i = 0; i < repeats; i++) results.push(set ? base.set((n >>> 1) + (i & 31), -i - 0.25) : base.pushMany(append)); return results; };
const runCandidate = base => { const results = []; for (let i = 0; i < repeats; i++) results.push(set ? base.set((n >>> 1) + (i & 31), -i - 0.25) : base.pushMany(append)); return results; };
const runs = [runBaseline, runCandidate], times = [[], []], allocations = [[], []];
for (let round = -warmups; round < samples; round++) {
  const inputs = libraries.map(S => { S.resetSharedList(); return new S.SharedList('number').pushMany(values); }), outputs = [];
  globalThis.gc?.(); if (typeof Bun !== 'undefined') Bun.gc(true);
  for (const index of (round + Number(reverse)) & 1 ? [1, 0] : [0, 1]) {
    const before = inputs[index].arena.used, start = performance.now(); outputs[index] = runs[index](inputs[index]); const elapsed = performance.now() - start;
    if (round >= 0) { times[index].push(elapsed); allocations[index].push(inputs[index].arena.used - before); }
  }
  for (let index = 0; index < 2; index++) {
    assert.deepEqual(inputs[index].toArray(), values);
    for (let i = 0; i < repeats; i++) {
      const output = outputs[index][i]; assert.equal(output.size, set ? n : n + count);
      assert.equal(output.get(set ? (n >>> 1) + (i & 31) : n + count - 1), set ? -i - 0.25 : append[count - 1]);
    }
    for (const i of [0, repeats - 1]) {
      const expected = set ? values.slice() : [...values, ...append]; if (set) expected[(n >>> 1) + (i & 31)] = -i - 0.25;
      assert.deepEqual(outputs[index][i].toArray(), expected);
    }
  }
  assert.equal(inputs[0].arena.used, inputs[1].arena.used, 'The optimization must not change allocation');
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const source = roots.map(root => Object.fromEntries(['persistent-core.as.ts', 'arena.ts', 'codec.ts', 'freeze-json.ts', 'shared-list.ts', 'package.json', 'scripts/build-wasm.mjs', 'scripts/build-browser.ts', 'persistent-core.wasm', ...readdirSync(resolve(root, 'dist')).filter(p => p.endsWith('.js')).sort().map(p => `dist/${p}`)].map(p => [p, hash(readFileSync(resolve(root, p)))])));
if (comparison === 'AA') assert.deepEqual(source[0], source[1], 'A/A requires independent identical source and bundles');
const quantile = (x, p) => [...x].sort((a, b) => a - b)[Math.floor((x.length - 1) * p)];
console.log(JSON.stringify({ schema: 'zerocopy-link-range-diagnostic/v1', timestamp: new Date().toISOString(), harnessSha256: hash(readFileSync(new URL(import.meta.url))), source,
  runtime: typeof Bun === 'undefined' ? `Node ${process.version}` : `Bun ${Bun.version}`, cpu: cpus()[0]?.model, platform: process.platform, arch: process.arch,
  name, comparison, importOrder, n, count, repeats, samples, warmups, samplesMs: times, allocatedBytes: allocations,
  mediansMs: times.map(x => quantile(x, 0.5)), p10Ms: times.map(x => quantile(x, 0.1)), p90Ms: times.map(x => quantile(x, 0.9)),
  baselineOverCandidate: quantile(times[0], 0.5) / quantile(times[1], 0.5), outputChecked: true, retainedBaseChecked: true, setupTimed: false, gcTimed: false }, null, 2));
