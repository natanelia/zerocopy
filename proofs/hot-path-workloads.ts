/** Cold reads, cache limits, and mixed operations that a warm lookup table misses. */
import assert from 'node:assert/strict';
import { cpus } from 'node:os';
import { writeFileSync } from 'node:fs';
import { Map as ImmutableMap } from 'immutable';
import { Arena, arenaOf } from '../arena';
import { SharedMap, resetMap } from '../shared-map';
const kinds = ['shared', 'immutable', 'native'] as const;
const round = Number(process.env.ROUND ?? 1), samples = Number(process.env.SAMPLES ?? 15);
assert(round >= 1 && round <= 3 && Number.isInteger(samples) && samples > 0);
const tests = ['cold.get', 'beyond-cache.get', 'mixed.set-get-has', 'forks.get'] as const;
const rows: any[] = [];
const sink: { value: any } = { value: undefined };
Object.defineProperty(globalThis, '__hotWorkloadResult', { value: sink, configurable: true });
for (const name of tests) for (let index = 0; index < 3; index++) {
  const kind = kinds[(index + round - 1) % 3];
  const n = name === 'beyond-cache.get' ? 32768 : 10000;
  resetMap();
  let base: any = kind === 'shared' ? new SharedMap('number') : kind === 'immutable' ? ImmutableMap() : new Map();
  for (let i = 0; i < n; i++) base = base.set(`key${i}`, i);
  const keys = Array.from({ length: n }, (_, i) => `key${i}`);
  const expectedSum = n * (n - 1) / 2;
  let other: any = kind === 'native' ? new Map(base) : base;
  other = other.set('key0', -1);
  let value: any;
  function prepare() {
    if (name === 'cold.get' && kind === 'shared') {
      const owner = arenaOf(base);
      value = SharedMap.fromWorkerData(base.root, 'number', n, new Arena({ memory: owner.memory, used: owner.used, readOnly: true }));
    } else value = base;
  }
  function run(): number {
    let sum = 0;
    if (name === 'mixed.set-get-has') {
      // One detached native copy for this batch preserves the retained base.
      let next = kind === 'native' ? new Map(value) : value;
      for (let i = 0; i < 1024; i++) { const key = keys[i]; next = next.set(key, i + 1); sum += next.get(key) + Number(next.has(key)); }
      sink.value = next; return sum;
    }
    if (name === 'forks.get') {
      for (let i = 0; i < n; i++) sum += (i % 2 ? other : base).get(keys[i]); return sum;
    }
    for (let i = 0; i < n; i++) sum += value.get(keys[i]); return sum;
  }
  const expected = name === 'mixed.set-get-has' ? 1024 * 1025 / 2 + 1024 : expectedSum;
  for (let i = 0; i < 10; i++) { prepare(); assert.equal(run(), expected); }
  const times: number[] = [];
  for (let i = 0; i < samples; i++) { prepare(); const start = performance.now(); const result = run(); times.push(performance.now() - start); assert.equal(result, expected); }
  assert.equal(base.get('key0'), 0); assert.equal(other.get('key0'), -1);
  if (name === 'mixed.set-get-has') assert.equal(sink.value.get('key1023'), 1024);
  rows.push({ name, kind, n, operations: name === 'mixed.set-get-has' ? 1024 : n, samplesMs: times });
  value = base = other = sink.value = undefined; resetMap(); Bun.gc(true);
}
writeFileSync(process.argv[2] ?? `proofs/results/hot-workloads-${round}.json`, JSON.stringify({ round, samples, warmups: 10, runtime: Bun.version, cpu: cpus()[0].model, rows }) + '\n');
