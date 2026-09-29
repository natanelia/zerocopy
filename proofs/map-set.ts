/** Scalar Map.set workloads. Every timed write publishes an immutable version. */
import assert from 'node:assert/strict';
import { cpus } from 'node:os';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Map as ImmutableMap } from 'immutable';
import { Arena, arenaOf, HEAP_START } from '../arena';
import { SharedMap } from '../shared-map';

const scenario = process.env.MAP_CASE ?? 'build.string';
const kind = process.env.MAP_KIND ?? 'shared';
const n = Number(process.env.MAP_N ?? 10000), samples = Number(process.env.SAMPLES ?? 15);
assert(['shared', 'immutable', 'native'].includes(kind));
assert(Number.isInteger(n) && n >= 1000 && n <= 100000);
assert(Number.isInteger(samples) && samples > 0 && samples <= 100);
const cases = ['build.string', 'build.number', 'build.unicode', 'build.long-prefix', 'overwrite.string', 'overwrite.number', 'overwrite.after-read', 'forks.set', 'mixed.set-get-has', 'build.first-use'];
assert(cases.includes(scenario));
let state = 0x41c6ce57;
const order = Array.from({length: n}, (_, i) => i);
for (let i = n - 1; i > 0; i--) { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; const j = (state >>> 0) % (i + 1); [order[i], order[j]] = [order[j], order[i]]; }
const numeric = !['build.string', 'build.unicode', 'build.long-prefix', 'overwrite.string', 'build.first-use'].includes(scenario);
const type = numeric ? 'number' : 'string';
const keys = order.map(i => scenario === 'build.unicode' ? `路/${i}/🙂` : scenario === 'build.long-prefix' ? `${'segment/'.repeat(16)}${i}` : `key${i}`);
const values = keys.map((_, i) => numeric ? i : scenario === 'build.unicode' ? `值/${i}/🙂` : `val${i}`);
const build = scenario.startsWith('build.'), count = build ? n : scenario === 'forks.set' ? 64 : Math.min(n, 1000);
const changed = keys.slice(0, count).map((_, i) => numeric ? i + n : `changed${i}`);
let base: any, empty: any, result: any, checkSum = 0;
const sink: {value: any} = {value: undefined};
Object.defineProperty(globalThis, '__mapSetProofSink', {value: sink, configurable: true});
function makeEmpty() { return kind === 'shared' ? new SharedMap(type, 0, 0, new Arena()) : kind === 'immutable' ? ImmutableMap() : new Map(); }
function prepare() {
  empty = makeEmpty(); base = empty;
  if (!build) for (let i = 0; i < n; i++) base = base.set(keys[i], values[i]);
  if (scenario === 'overwrite.after-read') for (let i = 0; i < n; i++) assert.equal(base.get(keys[i]), values[i]);
}
function run() {
  if (build) {
    let map = scenario === 'build.first-use' ? makeEmpty() : empty;
    for (let i = 0; i < n; i++) map = map.set(keys[i], values[i]);
    return map;
  }
  if (scenario === 'forks.set') {
    const forks = new Array(count);
    for (let i = 0; i < count; i++) forks[i] = (kind === 'native' ? new Map(base) : base).set(keys[i], changed[i]);
    return forks;
  }
  let map = kind === 'native' ? new Map(base) : base;
  if (scenario === 'mixed.set-get-has') {
    let sum = 0;
    for (let i = 0; i < count; i++) { map = map.set(keys[i], changed[i]); sum += map.get(keys[i]) + Number(map.has(keys[i])); }
    checkSum = sum;
  } else for (let i = 0; i < count; i++) map = map.set(keys[i], changed[i]);
  return map;
}
function validate(map: any) {
  if (scenario === 'forks.set') {
    assert.equal(map.length, count);
    for (let i = 0; i < count; i++) {
      assert.equal(map[i].size, n); assert.equal(map[i].get(keys[i]), changed[i]);
      assert.equal(map[i].get(keys[(i + 1) % n]), values[(i + 1) % n]);
    }
  } else {
    assert.equal(map.size, n);
    for (let i = 0; i < n; i++) assert.equal(map.get(keys[i]), !build && i < count ? changed[i] : values[i]);
  }
  if (!build) for (let i = 0; i < n; i++) assert.equal(base.get(keys[i]), values[i]);
  else assert.equal(empty.size, kind === 'native' && scenario !== 'build.first-use' ? n : 0);
  if (scenario === 'mixed.set-get-has') assert.equal(checkSum, count * n + count * (count - 1) / 2 + count);
}
const warmups = 10, times: number[] = [], allocations: number[] = [];
let payloadSHA256: string | undefined;
for (let sample = -warmups; sample < samples; sample++) {
  prepare();
  const used = kind === 'shared' ? arenaOf(base).used : 0;
  const start = performance.now(); result = run(); const ms = performance.now() - start;
  sink.value = result;
  if (sample >= 0) {
    times.push(ms);
    if (kind === 'shared') {
      const owner = arenaOf(scenario === 'forks.set' ? result[0] : result);
      allocations.push(owner.used - (build ? HEAP_START : used));
      // Same fixed input has deterministic payload bytes. The comparison driver
      // requires equal output hashes when the binary layout is unchanged.
      payloadSHA256 = createHash('sha256').update(owner.buf.subarray(HEAP_START, owner.used)).digest('hex');
    }
  }
  validate(result);
  result = base = empty = sink.value = undefined;
  if (sample % 5 === 0) Bun.gc(true);
}
console.log(JSON.stringify({scenario, kind, n, count, samples, warmups, type,
  runtime: Bun.version, immutable: JSON.parse(readFileSync(new URL('../node_modules/immutable/package.json', import.meta.url),'utf8')).version,
  cpu: cpus()[0].model, samplesMs: times, allocatedBytes: allocations, payloadSHA256,
  method: 'Fresh input per sample; randomized fixed key order. Each scalar Shared/Immutable write returns a snapshot. Native existing-map updates copy once, or once per fork. Full final values and retained bases checked outside timing. First-use includes arena creation; other build rows exclude it.'}));
