/** One checked workload per process. Used by both Bun and Node. */
import assert from 'node:assert/strict';
import { cpus } from 'node:os';
import { Map as ImmutableMap } from 'immutable';
import * as S from '../dist/shared.js';

const kinds = ['shared', 'immutable', 'native'];
const cases = ['insert-string', 'insert-shuffled-string', 'insert-number', 'update-string', 'update-number', 'mixed-number', 'insert-unicode', 'insert-long', 'fork-update-string', 'cold-insert-string'];
const kind = process.env.KIND ?? 'shared', name = process.env.CASE ?? cases[0];
const n = Number(process.env.N ?? 10000), samples = Number(process.env.SAMPLES ?? 15), warmups = 20;
assert(kinds.includes(kind) && cases.includes(name), 'Unknown library or workload');
assert(Number.isSafeInteger(n) && n >= 1000 && n <= 100000);
assert(Number.isSafeInteger(samples) && samples >= 5 && samples <= 100);
const inserts = name.includes('insert'), cold = name.startsWith('cold');
const count = inserts ? n : Math.min(n, 1000), type = name.includes('number') ? 'number' : 'string';
const mixed = name.startsWith('mixed'), fork = name.startsWith('fork');
const keys = Array.from({ length: n }, (_, i) => name.includes('unicode') ? `路段-🙂-${i}` : name.includes('long') ? `high-definition-map/lane/revision/shared-prefix/${i}` : `key${i}`);
const values = keys.map((_, i) => type === 'number' ? i + 0.25 : `val${i}`);
const changed = keys.map((_, i) => type === 'number' ? -i - 0.75 : `changed${i}`);
const order = Array.from({ length: n }, (_, i) => i);
let seed = 0x51a49bc3;
for (let i = n - 1; i > 0; i--) { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; const j = (seed >>> 0) % (i + 1); [order[i], order[j]] = [order[j], order[i]]; }
const indexes = inserts && !name.includes('shuffled') ? Array.from({ length: count }, (_, i) => i) : order.slice(0, count);
const changedIndexes = new Set(indexes);
const expectedSum = mixed ? indexes.reduce((sum, i) => sum + changed[i] + 1, 0) : 0;
let base, other, arena, checksum = 0;
function empty() { return kind === 'shared' ? new S.SharedMap(type) : kind === 'immutable' ? ImmutableMap() : new Map(); }
function setup() {
  if (kind === 'shared') S.resetMap();
  base = empty(); other = undefined; arena = kind === 'shared' ? base.arena : undefined;
  if (!inserts) for (let i = 0; i < n; i++) base = base.set(keys[i], values[i]);
  // Keep a different live branch. The timed writes still start from the base.
  if (fork) other = (kind === 'native' ? new Map(base) : base).set('fork-only', type === 'number' ? 1 : 'fork');
}
function run() {
  let map;
  if (cold && kind === 'shared') { S.resetMap(); map = empty(); arena = map.arena; }
  else map = kind === 'native' && !inserts ? new Map(base) : base;
  let sum = 0;
  for (const i of indexes) {
    map = map.set(keys[i], inserts ? values[i] : changed[i]);
    if (mixed) sum += map.get(keys[i]) + Number(map.has(keys[i]));
  }
  checksum = sum; return map;
}
function check(map) {
  assert.equal(map.size, n); assert.equal(checksum, expectedSum);
  for (let i = 0; i < n; i++) assert.equal(map.get(keys[i]), inserts || !changedIndexes.has(i) ? values[i] : changed[i]);
  if (!inserts) for (let i = 0; i < n; i++) assert.equal(base.get(keys[i]), values[i]);
  if (fork) { assert.equal(other.size, n + 1); assert(!map.has('fork-only')); }
  if (kind === 'shared') {
    assert(Object.isFrozen(map));
    // Diagnostic access: a new read-only WASM instance cannot use writer hints.
    const reader = S.SharedMap.fromWorkerData(map.root, type, map.size,
      new arena.constructor({ memory: arena.memory, used: arena.used, readOnly: true }));
    for (const i of indexes) assert.equal(reader.get(keys[i]), inserts ? values[i] : changed[i]);
  }
}
const samplesMs = [], allocatedBytes = [], reservedBytes = [];
for (let round = -warmups; round < samples; round++) {
  setup(); const before = arena?.used ?? 0;
  const start = performance.now(); const result = run(); const elapsed = performance.now() - start;
  if (round >= 0) {
    samplesMs.push(elapsed); allocatedBytes.push(arena ? arena.used - (cold ? 65536 : before) : null);
    reservedBytes.push(arena?.memory.buffer.byteLength ?? null);
  }
  check(result); base = undefined; other = undefined; arena = undefined;
}
console.log(JSON.stringify({ name, kind, n, operations: count, type, warmups, samplesMs, allocatedBytes, reservedBytes,
  outputChecked: true, retainedBaseChecked: !inserts, independentReaderChecked: kind === 'shared',
  arenaSetupTimed: cold, nativeCopyTimed: kind === 'native' && !inserts,
  runtime: typeof Bun === 'undefined' ? `Node ${process.version}` : `Bun ${Bun.version}`,
  platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model ?? 'unknown' }));
