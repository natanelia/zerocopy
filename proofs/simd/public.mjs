import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
const names = ['baseline', 'bytes-scalar', 'bytes-simd'];
const apis = Object.fromEntries(await Promise.all(names.map(async name => [name, await import(`../../.simd-lab/public-${name}/shared.mjs`)])));
const median = a => [...a].sort((x, y) => x - y)[a.length >>> 1];
let sink = 0;
const results = [];
function bench(label, factory, iterations) {
  const samples = Object.fromEntries(names.map(n => [n, []]));
  for (let round = -4; round < 15; round++) for (const name of (round % 2 ? [...names].reverse() : names)) {
    global.gc?.();
    const run = factory(apis[name]);
    const start = performance.now(); const result = run(iterations); const duration = performance.now() - start;
    sink ^= typeof result === 'number' ? result : result.size;
    if (round >= 0) samples[name].push(duration);
  }
  const ms = Object.fromEntries(names.map(name => [name, median(samples[name])]));
  results.push({ label, iterations, ms, samples }); console.log('PUBLIC', JSON.stringify({ label, iterations, ms }));
}
for (const length of [8, 36, 128, 512]) {
  const keys = Array.from({ length: 1024 }, (_, i) => 'x'.repeat(length - 8) + i.toString(16).padStart(8, '0'));
  const entries = keys.map((k, i) => [k, i]);
  bench(`map/set-existing/${length}`, api => {
    api.resetMap(); let map = new api.SharedMap('number').setMany(entries);
    return n => { for (let i = 0; i < n; i++) map = map.set(keys[(i * 101) & 1023], i + 10000); assert.equal(map.size, 1024); return map; };
  }, 15000);
  bench(`sorted/set-existing/${length}`, api => {
    api.resetSortedMap(); let map = new api.SharedSortedMap('number'); for (const [k, v] of entries) map = map.set(k, v);
    return n => { for (let i = 0; i < n; i++) map = map.set(keys[(i * 101) & 1023], i + 10000); assert.equal(map.size, 1024); return map; };
  }, 6000);
  bench(`map/warm-get/${length}`, api => {
    api.resetMap(); const map = new api.SharedMap('number').setMany(entries); for (const k of keys) map.get(k);
    return n => { let sum = 0; for (let i = 0; i < n; i++) sum += map.get(keys[(i * 101) & 1023]); return sum; };
  }, 200000);
}
writeFileSync(`.simd-lab/public-results-${process.arch}.json`, JSON.stringify({ runtime: process.version, arch: process.arch, sink, results }, null, 2));
