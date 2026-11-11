import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const study = {
  id: 'worker-constructor-dispatch-20261105',
  baseline: '0ca99c1da67e4d3e36e098b3f0e85d392c9c1d5e',
  changedSources: ['shared.ts'],
  aaCases: ['early-map-128-control'],
  pilotCases: ['mixed-128-shared', 'late-128-shared', 'early-map-128-control', 'small-four-control', 'single-map-shared'],
  cases: [
    { name: 'mixed-128-shared', role: 'primary target', count: 128, kind: 'mixed', copy: false, repetitions: 128 },
    { name: 'late-128-shared', role: 'primary target', count: 128, kind: 'late', copy: false, repetitions: 128 },
    { name: 'mixed-128-copied', role: 'copy transport target', count: 128, kind: 'mixed', copy: true, repetitions: 64 },
    { name: 'late-128-copied', role: 'copy transport target', count: 128, kind: 'late', copy: true, repetitions: 64 },
    { name: 'early-map-128-control', role: 'early constructor control', count: 128, kind: 'early', copy: false, repetitions: 128 },
    { name: 'small-four-control', role: 'small record control', count: 4, kind: 'small', copy: false, repetitions: 2048 },
    { name: 'single-map-shared', role: 'single early constructor control', count: 1, kind: 'early', copy: false, repetitions: 8192 },
    { name: 'single-late-shared', role: 'single late constructor boundary', count: 1, kind: 'late', copy: false, repetitions: 8192 },
    { name: 'single-map-copied', role: 'single copy transport control', count: 1, kind: 'early', copy: true, repetitions: 512 },
  ],
};
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function fixtures(S, kind) {
  const factories = [
    ['SharedMap', () => new S.SharedMap('number').set('one', 1).set('two', 2)],
    ['SharedList', () => new S.SharedList('number').pushMany([1, 2])],
    ['SharedSet', () => new S.SharedSet().add('one').add(2)],
    ['SharedStack', () => new S.SharedStack('number').push(1).push(2)],
    ['SharedQueue', () => new S.SharedQueue('number').enqueue(1).enqueue(2)],
    ['SharedLinkedList', () => new S.SharedLinkedList('number').append(1).append(2)],
    ['SharedDoublyLinkedList', () => new S.SharedDoublyLinkedList('number').append(1).append(2)],
    ['SharedOrderedMap', () => new S.SharedOrderedMap('number').set('two', 2).set('one', 1)],
    ['SharedOrderedSet', () => new S.SharedOrderedSet().add('two').add(1)],
    ['SharedSortedMap', () => new S.SharedSortedMap('number').set('two', 2).set('one', 1)],
    ['SharedSortedSet', () => new S.SharedSortedSet().add('two').add(1)],
    ['SharedPriorityQueue', () => new S.SharedPriorityQueue('number').enqueue(2, 20).enqueue(1, 10)],
  ];
  const selected = kind === 'early' ? [factories[0]] : kind === 'late' ? [factories[11]]
    : kind === 'small' ? [factories[0], factories[1], factories[9], factories[11]] : factories;
  return selected.map(([type, create]) => ({ type, value: create() }));
}

export async function createWorkload(directory, spec) {
  const S = await import(pathToFileURL(join(directory, 'dist/shared.js')));
  const pool = fixtures(S, spec.kind), input = Object.create(null), expected = [];
  const arenas = [], byId = new Map(), originals = new Map();
  for (const item of pool) {
    // Individual public exports supply arena identity only; expected wire type
    // and complete descriptor data are derived independently of the dispatcher.
    const packet = S.getWorkerData({ source: item.value }, { copy: false });
    assert.equal(packet.arenas.length, 1);
    const arena = packet.arenas[0];
    if (!byId.has(arena.id)) {
      byId.set(arena.id, arenas.length);
      arenas.push({ id: arena.id, used: arena.used, memory: arena.memory,
        bytes: new Uint8Array(arena.memory.buffer, 0, arena.used).slice() });
    }
    originals.set(item.value, { arena: arena.id, data: item.value.toWorkerData() });
  }
  for (let index = 0; index < spec.count; index++) {
    const name = `structure-${String(index).padStart(3, '0')}`, item = pool[index % pool.length], original = originals.get(item.value);
    input[name] = item.value;
    expected.push({ name, type: item.type, arena: original.arena, data: original.data, fields: Object.keys(original.data) });
  }
  Object.freeze(input);
  const names = Object.keys(input), options = { copy: spec.copy };
  const normalized = {
    structures: expected.map(({ name, type, arena, data }) => ({ name, type, arena: byId.get(arena), data })),
    arenas: arenas.map(arena => ({ used: arena.used, bytes: hash(arena.bytes) })),
  };
  return {
    operation() { return S.getWorkerData(input, options); },
    verify(packet) {
      assert.ok(Object.isFrozen(packet)); assert.equal(packet.__shared, true); assert.equal(packet.version, 4);
      assert.ok(Object.isFrozen(packet.structures)); assert.equal(Object.getPrototypeOf(packet.structures), null);
      assert.deepEqual(Object.keys(packet.structures), names);
      for (const item of expected) {
        const actual = packet.structures[item.name];
        assert.ok(Object.isFrozen(actual)); assert.equal(Object.keys(actual).length, 3);
        assert.equal(actual.type, item.type); assert.equal(actual.arena, item.arena);
        assert.ok(Object.isFrozen(actual.data)); assert.equal(Object.keys(actual.data).length, item.fields.length);
        for (const key of item.fields) assert.equal(actual.data[key], item.data[key]);
      }
      assert.ok(Object.isFrozen(packet.arenas)); assert.equal(packet.arenas.length, arenas.length);
      arenas.forEach((arena, index) => {
        const actual = packet.arenas[index];
        assert.ok(Object.isFrozen(actual)); assert.equal(Object.keys(actual).length, 3);
        assert.equal(actual.id, arena.id); assert.equal(actual.used, arena.used);
        if (spec.copy) { assert.equal(actual.memory, undefined); assert.deepEqual(actual.copy, arena.bytes); }
        else { assert.equal(actual.copy, undefined); assert.equal(actual.memory, arena.memory); }
      });
    },
    checkInvariant() {
      assert.ok(Object.isFrozen(input)); assert.deepEqual(Object.keys(input), names);
      expected.forEach((item, index) => assert.equal(input[item.name], pool[index % pool.length].value));
      for (const arena of arenas) assert.deepEqual(new Uint8Array(arena.memory.buffer, 0, arena.used), arena.bytes);
      const current = S.getWorkerData(input, { copy: false });
      assert.deepEqual(current.arenas.map(arena => [arena.id, arena.used]), arenas.map(arena => [arena.id, arena.used]));
    },
    expectedDigest: hash(JSON.stringify(normalized)),
    fixture: { count: spec.count, kind: spec.kind, copy: spec.copy, types: pool.map(item => item.type),
      arenas: arenas.length, usedBytes: arenas.reduce((total, arena) => total + arena.used, 0),
      operation: 'one complete getWorkerData(input, options) call; every returned payload retained until full verification',
      normalization: 'arena IDs are checked within each process and mapped to first-seen indices for cross-process output hashes',
      input: 'frozen record, populated immutable collections, repeated aliases, no custom hooks' },
  };
}
