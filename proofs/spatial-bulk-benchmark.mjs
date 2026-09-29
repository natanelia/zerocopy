import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { performance } from 'node:perf_hooks';
import { SharedList, getWorkerData, resetSharedList } from '../dist/shared.js';
import { countPointsInBox } from '../dist/numeric.js';
const median = xs => [...xs].sort((a, b) => a - b)[xs.length >>> 1];
const modules = Object.fromEntries(['scalar', 'simd'].map(name => [name, new WebAssembly.Module(readFileSync(`numeric-kernels${name === 'simd' ? '-simd' : ''}.wasm`))]));
const results = [];
let sink = 0;
for (const points of [16, 512, 16384, 131072]) {
  resetSharedList();
  const values = Array.from({ length: points * 2 }, (_, i) => ((i >>> 1) * (i & 1 ? 3571 : 7919)) % 10007 - 5000);
  const list = new SharedList('number').pushMany(values);
  const memory = getWorkerData({ list }, { copy: false }).arenas[0].memory;
  const scalar = new WebAssembly.Instance(modules.scalar, { env: { memory } }).exports;
  const selected = new WebAssembly.Instance(modules.simd, { env: { memory } }).exports;
  for (const extent of [1000, 6000]) {
    const box = { minX: -extent, minY: -extent, maxX: extent, maxY: extent };
    // Both compiled modules use scalar spatial code. Only countInRange differs
    // between modules. These labels must not suggest a spatial SIMD gain.
    const fns = {
      'existing-forEach': n => { let total = 0; for (let i = 0; i < n; i++) { let x = 0; list.forEach((value, index) => { if (!(index & 1)) x = value; else total += Number(x >= box.minX && x <= box.maxX && value >= box.minY && value <= box.maxY); }); } return total; },
      'scalar-module': n => { let total = 0; for (let i = 0; i < n; i++) total += scalar.countPointsInBox(list.root, list.depth, list.tail, list.size, box.minX, box.minY, box.maxX, box.maxY); return total; },
      'simd-module-scalar-spatial-code': n => { let total = 0; for (let i = 0; i < n; i++) total += selected.countPointsInBox(list.root, list.depth, list.tail, list.size, box.minX, box.minY, box.maxX, box.maxY); return total; },
      'public-auto': n => { let total = 0; for (let i = 0; i < n; i++) total += countPointsInBox(list, box); return total; },
    };
    const iterations = Math.max(32, Math.floor(1000000 / points));
    const names = Object.keys(fns), samples = Object.fromEntries(names.map(name => [name, []]));
    const expected = fns['existing-forEach'](iterations);
    for (const fn of Object.values(fns)) assert.equal(fn(iterations), expected);
    for (let round = -5; round < 15; round++) for (const name of round % 2 ? [...names].reverse() : names) {
      const start = performance.now(); sink ^= fns[name](iterations); const ms = performance.now() - start;
      if (round >= 0) samples[name].push(ms);
    }
    const ms = Object.fromEntries(names.map(name => [name, median(samples[name])]));
    const row = { points, extent, iterations, ms, samples, publicOverExisting: ms['existing-forEach'] / ms['public-auto'] };
    results.push(row); console.log('SPATIAL-BULK', JSON.stringify({ ...row, samples: undefined }));
  }
}
mkdirSync('proofs/results', { recursive: true });
writeFileSync(`proofs/results/spatial-bulk-${process.versions.bun ? 'bun' : 'node'}-${process.arch}.json`, JSON.stringify({ commit: process.env.GITHUB_SHA, run: process.env.GITHUB_RUN_ID, runtime: process.version, bun: process.versions.bun, arch: process.arch, cpu: cpus()[0].model, spatialSIMD: false, sink, results }, null, 2));
if (process.env.PERF_GATE === '1') for (const row of results.filter(r => r.points >= 512)) {
  assert.ok(row.publicOverExisting > 1.05, `Bulk API did not beat existing at ${row.points}/${row.extent}`);
}
