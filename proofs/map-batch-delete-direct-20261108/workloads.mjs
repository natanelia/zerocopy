import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const study = {
  id: 'map-batch-delete-direct-20261108',
  baseline: 'a4265a0608ec25eec5719496225212db6b251989',
  changedSources: ['arena.ts', 'persistent-core.as.ts', 'shared-map.ts'],
  pilotCases: ['delete-4096-of-8192', 'delete-cold-1000-of-8192', 'delete-511-boundary', 'delete-512-boundary', 'delete-missing-1000',
    'delete-late-hits-1000', 'delete-sparse-hits-1000', 'delete-dense-prefix-missing-1000'],
  aaCases: ['delete-4096-of-8192', 'delete-1-control'],
  cases: [
    { name: 'delete-100-of-4096', role: 'control', kind: 'delete', count: 4096, requested: 100, pattern: 'spread', repetitions: 256 },
    { name: 'delete-1000-of-8192', role: 'target', kind: 'delete', count: 8192, requested: 1000, pattern: 'spread', repetitions: 16 },
    { name: 'delete-4096-of-8192', role: 'target', kind: 'delete', count: 8192, requested: 4096, pattern: 'spread', repetitions: 8 },
    { name: 'delete-cold-1000-of-8192', role: 'target', kind: 'delete', count: 8192, requested: 1000, pattern: 'spread', mode: 'cold', repetitions: 16 },
    { name: 'delete-unicode-1000-of-8192', role: 'target', kind: 'delete', count: 8192, requested: 1000, pattern: 'spread', unicode: true, repetitions: 16 },
    { name: 'delete-32-control', role: 'control', kind: 'delete', count: 512, requested: 32, pattern: 'spread', repetitions: 512 },
    { name: 'delete-511-boundary', role: 'boundary', kind: 'delete', count: 8192, requested: 511, pattern: 'spread', repetitions: 64 },
    { name: 'delete-512-boundary', role: 'boundary', kind: 'delete', count: 8192, requested: 512, pattern: 'spread', repetitions: 64 },
    { name: 'delete-1-control', role: 'control', kind: 'delete', count: 64, requested: 1, pattern: 'spread', repetitions: 32768 },
    { name: 'delete-empty-control', role: 'control', kind: 'delete', count: 64, requested: 0, pattern: 'spread', repetitions: 262144 },
    { name: 'delete-missing-1000', role: 'adverse', kind: 'delete', count: 4096, requested: 1000, pattern: 'missing', repetitions: 64 },
    { name: 'delete-late-hits-1000', role: 'adverse', kind: 'delete', count: 8192, requested: 1000, pattern: 'late-hits', repetitions: 32 },
    { name: 'delete-sparse-hits-1000', role: 'adverse', kind: 'delete', count: 8192, requested: 1000, pattern: 'sparse-hits', repetitions: 64 },
    { name: 'delete-dense-prefix-missing-1000', role: 'adverse', kind: 'delete', count: 8192, requested: 1000, pattern: 'dense-prefix-missing', repetitions: 64 },
    { name: 'delete-duplicate-1000', role: 'adverse', kind: 'delete', count: 4096, requested: 1000, pattern: 'duplicate', repetitions: 64 },
    { name: 'delete-all-4096', role: 'target', kind: 'delete', count: 4096, requested: 4096, pattern: 'all', repetitions: 16 },
    { name: 'get-many-control', role: 'control', kind: 'get', count: 128, requested: 64, pattern: 'spread', repetitions: 4096 },
    { name: 'set-one-control', role: 'control', kind: 'set', count: 64, requested: 1, pattern: 'spread', repetitions: 4096 },
  ],
};

const HEAP_START = 65536;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => Number.isNaN(value) ? ['NaN'] : Object.is(value, -0) ? ['-0']
  : value === Infinity ? ['+Infinity'] : value === -Infinity ? ['-Infinity'] : value;
const specials = [NaN, -0, Infinity, -Infinity, Number.MIN_VALUE, Number.MAX_VALUE];
const key = i => `lane/${String(i).padStart(5, '0')}`;
function fnv(text) {
  let result = 2166136261;
  for (const byte of new TextEncoder().encode(text)) result = Math.imul(result ^ byte, 16777619);
  return result >>> 0;
}
function order(ah, bh) {
  for (let shift = 0; shift < 32; shift += 4) {
    const difference = ((ah >>> shift) & 15) - ((bh >>> shift) & 15);
    if (difference) return difference;
  }
  return 0;
}
function verifyMap(result, expected) {
  assert.ok(Object.isFrozen(result)); assert.equal(result.size, expected.length);
  let position = 0;
  for (const [name, value] of result.entries()) {
    assert.ok(position < expected.length, 'Unexpected additional entry');
    assert.equal(name, expected[position][0]);
    assert.ok(Object.is(value, expected[position][1]), `Value mismatch for ${name}`);
    position++;
  }
  assert.equal(position, expected.length);
}

export function makeFixture(spec) {
  const keyAt = spec.unicode ? i => `路/é/🙂/${String(i).padStart(5, '0')}` : key;
  const initial = Array.from({ length: spec.count }, (_, i) => [keyAt(i), i % 257 === 0 ? specials[(i / 257 | 0) % specials.length] : i + 0.25]);
  const hashes = new Map(initial.map(([name]) => [name, fnv(name)]));
  assert.equal(new Set(hashes.values()).size, initial.length, 'Fixture expects unique full hashes');
  const compare = (a, b) => order(hashes.get(a[0]), hashes.get(b[0]));
  const keys = Array.from({ length: spec.requested }, (_, i) => spec.pattern === 'missing'
    || spec.pattern === 'late-hits' && i < 32
    || spec.pattern === 'sparse-hits' && i % 16 !== 0
    || spec.pattern === 'dense-prefix-missing' && i >= 32 ? `missing/${i}`
    : spec.pattern === 'duplicate' ? keyAt(7) : spec.pattern === 'all' ? keyAt(i) : keyAt((i * 8191) % spec.count));
  const model = new Map(initial), original = [...initial].sort(compare);
  if (spec.kind === 'delete') for (const name of keys) model.delete(name);
  if (spec.kind === 'set') model.set(keyAt(0), -99.5);
  const expected = [...model].sort(compare), expectedReads = keys.map(name => model.get(name));
  return { initial, keys, original, expected, expectedReads };
}

export async function createWorkload(directory, spec) {
  const S = await import(pathToFileURL(join(directory, 'dist/shared.js')));
  const { initial, keys, original, expected, expectedReads } = makeFixture(spec);
  let source, sources = [], records = [], position = 0;
  function prepareBatch(repetitions = 1) {
    sources = []; records = []; position = 0;
    for (let i = 0; i < (spec.mode === 'cold' ? repetitions : 1); i++) {
      S.resetMap();
      const value = new S.SharedMap('number').setMany(initial);
      // Read controls measure an already-populated value cache. Mutation cases
      // start with the native bulk-built source and do not warm key lookups here.
      if (spec.kind === 'get') value.getMany(keys);
      if (spec.kind === 'set') value.get(key(0));
      const packet = S.getWorkerData({ source: value }, { copy: false }), arena = packet.arenas[0];
      sources.push(value);
      records.push({ arena, descriptor: packet.structures.source.data,
        hash: hash(new Uint8Array(arena.memory.buffer, HEAP_START, arena.used - HEAP_START)) });
    }
    source = sources[0];
  }
  prepareBatch();
  const sourceHash = records[0].hash;
  const nextSource = () => spec.mode === 'cold' ? sources[position++] : source;
  return {
    prepareBatch,
    operation: spec.kind === 'get' ? () => source.getMany(keys)
      : spec.kind === 'set' ? () => source.set(key(0), -99.5) : () => nextSource().deleteMany(keys),
    verify(result) {
      if (spec.kind === 'get') {
        assert.equal(result.length, expectedReads.length);
        for (let i = 0; i < result.length; i++) assert.ok(Object.is(result[i], expectedReads[i]));
        return;
      }
      assert.ok(result instanceof S.SharedMap);
      // These operations return the already-verified immutable source. Check
      // each identity here; checkInvariant verifies its complete contents once
      // after the batch, avoiding repeated validation of the same handle.
      if (spec.kind === 'delete' && (!keys.length || spec.pattern === 'missing')) {
        assert.strictEqual(result, source); return;
      }
      verifyMap(result, expected);
      if (spec.kind === 'delete') {
        for (const name of [keys[0], keys[keys.length - 1]]) if (name !== undefined) assert.equal(result.has(name), false);
      } else assert.ok(Object.is(result.get(key(0)), -99.5));
    },
    checkInvariant() {
      for (let i = 0; i < sources.length; i++) {
        const value = sources[i], saved = records[i], sourceArena = saved.arena;
        verifyMap(value, original);
        const packet = S.getWorkerData({ source: value }, { copy: false });
        assert.deepEqual(packet.structures.source.data, saved.descriptor);
        assert.equal(packet.arenas[0].id, sourceArena.id);
        assert.strictEqual(packet.arenas[0].memory, sourceArena.memory);
        assert.ok(packet.arenas[0].used >= sourceArena.used);
        assert.equal(hash(new Uint8Array(sourceArena.memory.buffer, HEAP_START, sourceArena.used - HEAP_START)), saved.hash);
      }
    },
    expectedDigest: hash(JSON.stringify(spec.kind === 'get' ? expectedReads.map(canonical) : expected.map(([name, value]) => [name, canonical(value)]))),
    fixture: {
      kind: spec.kind, count: spec.count, requested: spec.requested, pattern: spec.pattern, unicode: spec.unicode ?? false,
      resultCount: spec.kind === 'get' ? expectedReads.length : expected.length,
      sourceConstruction: spec.mode === 'cold' ? 'one independent new arena and source per operation, all built outside timed batch'
        : 'one new arena/source per timed batch; repeated operations fork that same immutable source',
      timedOperation: spec.kind === 'get' ? 'source.getMany(keys)' : spec.kind === 'set' ? 'source.set(key0, -99.5)' : 'source.deleteMany(keys)',
      oracle: 'every public entry in independently computed HAMT order, exact values, size, frozen handles, complete retained source and original bytes',
      sourceHash,
    },
  };
}
