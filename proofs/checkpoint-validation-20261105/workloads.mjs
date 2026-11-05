import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const study = {
  id: 'checkpoint-validation-20261105',
  baseline: 'b07bffe073a7f7d60f1dd7731358c16d1075eb45',
  changedSources: ['redux-checkpoint.ts'],
  aaCases: ['decode-array-8192', 'snapshot-only-control'],
  cases: [
    { name: 'decode-array-8192', role: 'target', fixture: 'array', count: 8192, repetitions: 8 },
    { name: 'decode-record-4096', role: 'target', fixture: 'record', count: 4096, repetitions: 4 },
    { name: 'decode-nested-512', role: 'target', fixture: 'nested', count: 512, repetitions: 4 },
    { name: 'decode-mixed-256', role: 'target', fixture: 'mixed', count: 256, repetitions: 2 },
    { name: 'deserialize-nested-512', role: 'target', fixture: 'nested', count: 512, deserialize: true, repetitions: 4 },
    { name: 'small-empty-trees', role: 'boundary', fixture: 'small', repetitions: 1024 },
    { name: 'snapshot-only-control', role: 'control', fixture: 'snapshot', count: 256, repetitions: 2 },
    { name: 'primitive-control', role: 'control', fixture: 'primitive', repetitions: 16384 },
  ],
};

// The oracle is built from ordinary JavaScript values, independently of either
// checkpoint decoder. Special numbers, holes and prototypes enter its digest.
function canonical(value) {
  if (value === undefined) return ['undefined'];
  if (typeof value === 'number') return ['number', Number.isNaN(value) ? 'NaN'
    : Object.is(value, -0) ? '-0' : value === Infinity ? 'Infinity' : value === -Infinity ? '-Infinity' : value];
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return ['array', Array.from({ length: value.length }, (_, i) =>
    Object.hasOwn(value, i) ? canonical(value[i]) : ['hole'])];
  return [Object.getPrototypeOf(value) === null ? 'null-object' : 'object',
    Object.keys(value).map(key => [key, canonical(value[key])])];
}
function freezeCheck(value) {
  if (value === null || typeof value !== 'object') return;
  assert.ok(Object.isFrozen(value));
  for (const key of Object.keys(value)) freezeCheck(value[key]);
}
function rows(count) {
  return Array.from({ length: count }, (_, i) => ({
    id: `row-${i}`, enabled: i % 3 === 0, position: [i / 4, -i / 8],
    metadata: { label: `marker/é/🙂/${i}`, tags: ['lane', i % 2 ? 'open' : 'closed'] },
  }));
}

export async function createWorkload(directory, spec) {
  const R = await import(pathToFileURL(join(directory, 'dist/redux.js')));
  const S = await import(pathToFileURL(join(directory, 'dist/shared.js')));
  let expected, state, source, expectedEntries;
  if (spec.fixture === 'array') {
    expected = Array.from({ length: spec.count }, (_, i) => i % 2 ? -i / 4 : i / 4);
    expected[1] = -0; expected[3] = NaN; expected[5] = Infinity; expected[7] = -Infinity;
    state = expected;
  } else if (spec.fixture === 'record') {
    expected = Object.fromEntries(Array.from({ length: spec.count }, (_, i) => [i ? `field-${i}` : '__proto__', i - 1024]));
    assert.equal(Object.keys(expected).length, spec.count);
    state = expected;
  } else if (spec.fixture === 'nested') {
    expected = rows(spec.count); state = expected;
  } else if (spec.fixture === 'small') {
    const nullRecord = Object.create(null); nullRecord.constructor = undefined;
    const sparse = new Array(3); sparse[1] = -0;
    expected = [[], {}, nullRecord, sparse, { ready: true, value: null }]; state = expected;
  } else if (spec.fixture === 'primitive') {
    expected = 7; state = expected;
  } else {
    const count = spec.fixture === 'mixed' ? 32 : spec.count;
    expectedEntries = Array.from({ length: count }, (_, i) => [`key-${String(i).padStart(4, '0')}`, i * 3 - 1]);
    source = new S.SharedMap('number').setMany(expectedEntries);
    if (spec.fixture === 'mixed') {
      const ui = { selected: null, version: 7, rows: rows(spec.count) };
      expected = { ui, source: expectedEntries, again: expectedEntries };
      state = { ui, source, again: source };
    } else {
      assert.equal(spec.fixture, 'snapshot'); expected = expectedEntries; state = source;
    }
  }

  const packet = R.encodeZerocopyState(state);
  const text = JSON.stringify(packet);
  const sourceRecords = source ? S.getWorkerData({ source }, { copy: false }).arenas.map(arena => ({
    id: arena.id, used: arena.used, memory: arena.memory,
    bytes: new Uint8Array(arena.memory.buffer, 0, arena.used).slice(),
  })) : [];
  const expectedDigest = createHash('sha256').update(JSON.stringify(canonical(expected))).digest('hex');
  function verifyMap(result) {
    assert.ok(result instanceof S.SharedMap); assert.ok(Object.isFrozen(result));
    assert.equal(result.valueType, 'number'); assert.equal(result.size, expectedEntries.length);
    assert.deepEqual([...result.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0), expectedEntries);
  }
  return {
    operation: spec.deserialize ? () => R.deserializeZerocopyState(text) : () => R.decodeZerocopyState(packet),
    verify(result) {
      if (spec.fixture === 'snapshot') verifyMap(result);
      else if (spec.fixture === 'mixed') {
        assert.deepEqual(Object.keys(result), ['ui', 'source', 'again']);
        assert.strictEqual(result.source, result.again);
        assert.deepEqual(result.ui, expected.ui); freezeCheck(result.ui); assert.ok(Object.isFrozen(result));
        verifyMap(result.source);
      } else { assert.deepEqual(result, expected); freezeCheck(result); }
    },
    checkInvariant() {
      assert.equal(JSON.stringify(packet), text);
      if (source) {
        const current = S.getWorkerData({ source }, { copy: false }).arenas;
        assert.equal(current.length, sourceRecords.length);
        for (let i = 0; i < current.length; i++) {
          const arena = current[i], before = sourceRecords[i];
          assert.equal(arena.id, before.id); assert.equal(arena.used, before.used);
          assert.deepEqual(new Uint8Array(arena.memory.buffer, 0, before.used), before.bytes);
        }
      }
    },
    expectedDigest,
    fixture: { fixture: spec.fixture, count: spec.count ?? null, operation: spec.deserialize ? 'deserializeZerocopyState' : 'decodeZerocopyState',
      sourceEntries: expectedEntries?.length ?? 0, arenaBytes: packet.arenas.map(arena => arena.used) },
  };
}
