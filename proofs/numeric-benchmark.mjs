import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { performance } from 'node:perf_hooks';
import { SharedList, getWorkerData, resetSharedList } from '../dist/shared.js';
import { countInRange } from '../dist/numeric.js';
const median = xs => [...xs].sort((a, b) => a - b)[xs.length >>> 1];
const compiled = Object.fromEntries(['scalar', 'simd'].map(name => [name, new WebAssembly.Module(readFileSync(new URL(`../numeric-kernels${name === 'simd' ? '-simd' : ''}.wasm`, import.meta.url)))]));
const results = [];
let sink = 0;
for (const size of [32, 1024, 32768, 262144]) {
  resetSharedList();
  const values = Array.from({ length: size }, (_, i) => (i * 7919) % 10007 - 5000);
  const list = new SharedList('number').pushMany(values);
  const memory = getWorkerData({ list }, { copy: false }).arenas[0].memory;
  const scalar = new WebAssembly.Instance(compiled.scalar, { env: { memory } }).exports;
  const simd = new WebAssembly.Instance(compiled.simd, { env: { memory } }).exports;
  const expected = values.reduce((sum, value) => sum + Number(value >= -1000 && value <= 1000), 0);
  assert.equal(countInRange(list, -1000, 1000), expected);
  const fns = {
    'existing-forEach': n => { let total = 0; for (let i = 0; i < n; i++) { const lower = -1000 + (i & 7); list.forEach(v => { total += Number(v >= lower && v <= 1000); }); } return total; },
    'scalar-kernel': n => { let total = 0; for (let i = 0; i < n; i++) total += scalar.countInRange(list.root, list.depth, list.tail, size, -1000 + (i & 7), 1000); return total; },
    'simd-kernel': n => { let total = 0; for (let i = 0; i < n; i++) total += simd.countInRange(list.root, list.depth, list.tail, size, -1000 + (i & 7), 1000); return total; },
    'public-auto': n => { let total = 0; for (let i = 0; i < n; i++) total += countInRange(list, -1000 + (i & 7), 1000); return total; },
  };
  const iterations = Math.max(32, Math.floor(2000000 / size));
  const names = Object.keys(fns), samples = Object.fromEntries(names.map(name => [name, []]));
  const expectedBatch = fns['existing-forEach'](iterations);
  for (const fn of Object.values(fns)) assert.equal(fn(iterations), expectedBatch);
  for (let round = -5; round < 15; round++) for (const name of round % 2 ? [...names].reverse() : names) {
    const start = performance.now(); sink ^= fns[name](iterations); const ms = performance.now() - start;
    if (round >= 0) samples[name].push(ms);
  }
  const ms = Object.fromEntries(names.map(name => [name, median(samples[name])]));
  const row = { size, iterations, ms, samples, simdOverScalar: ms['scalar-kernel'] / ms['simd-kernel'], publicOverExisting: ms['existing-forEach'] / ms['public-auto'] };
  results.push(row); console.log('NUMERIC', JSON.stringify({ ...row, samples: undefined }));
}
const report = { runtime: process.version, v8: process.versions.v8, bun: process.versions.bun, arch: process.arch, cpu: cpus()[0].model, commit: process.env.GITHUB_SHA, run: process.env.GITHUB_RUN_ID, sink, results };
mkdirSync('proofs/results', { recursive: true });
writeFileSync(`proofs/results/numeric-${process.versions.bun ? 'bun' : 'node'}-${process.arch}.json`, JSON.stringify(report, null, 2));
// Performance evidence is generated explicitly, not a noisy default unit-test gate.
if (process.env.PERF_GATE === '1') for (const row of results.filter(row => row.size >= 1024)) {
  assert.ok(row.simdOverScalar > 1.05, `SIMD did not beat scalar at size ${row.size}`);
  assert.ok(row.publicOverExisting > 1.05, `Public API did not beat existing forEach at size ${row.size}`);
}
