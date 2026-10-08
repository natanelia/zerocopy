import assert from 'node:assert/strict';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

// Run: node proofs/json-read-correctness.mjs
// Bun: bun test ./proofs/json-read-correctness.mjs
// Use the portable build, or point JSON_READ_ENTRY at another build.
const selected = workerData?.entry ?? process.env.JSON_READ_ENTRY;
const entry = selected ? (selected.startsWith('file:') ? selected : pathToFileURL(resolve(selected)).href)
  : new URL('../dist/shared.js', import.meta.url).href;
const S = await import(entry);
const classes = {
  map: 'SharedMap', list: 'SharedList', stack: 'SharedStack', queue: 'SharedQueue',
  linked: 'SharedLinkedList', doubly: 'SharedDoublyLinkedList', ordered: 'SharedOrderedMap',
  sorted: 'SharedSortedMap', heap: 'SharedPriorityQueue',
};
const roundTrip = value => JSON.parse(JSON.stringify(value));
const key = index => `key-${String(index).padStart(6, '0')}`;

function append(name, source, value) {
  if (name === 'map' || name === 'ordered' || name === 'sorted') return source.set(key(source.size), value);
  if (name === 'list' || name === 'stack') return source.push(value);
  if (name === 'queue') return source.enqueue(value);
  if (name === 'heap') return source.enqueue(value, source.size);
  return source.append(value);
}
function create(values) {
  const result = {};
  for (const [name, className] of Object.entries(classes)) {
    let source = new S[className]('object');
    for (const value of values) source = append(name, source, value);
    result[name] = source;
  }
  return result;
}
function read(name, source) {
  if (name === 'map' || name === 'ordered' || name === 'sorted') {
    return Array.from({ length: source.size }, (_, index) => source.get(key(index)));
  }
  if (name === 'heap') return [...source.entries()].sort((a, b) => a[1] - b[1]).map(([value]) => value);
  if (name !== 'stack' && name !== 'queue') return Array.from({ length: source.size }, (_, index) => source.get(index));
  const values = [];
  for (let current = source; current.size; current = name === 'stack' ? current.pop() : current.dequeue()) values.push(current.peek());
  return name === 'stack' ? values.reverse() : values;
}
function resetAll() {
  for (const name of ['resetMap', 'resetSharedList', 'resetStack', 'resetQueue', 'resetLinkedList',
    'resetDoublyLinkedList', 'resetOrderedMap', 'resetSortedMap', 'resetPriorityQueue']) S[name]();
}

// Use own property descriptors as an independent oracle for the changed walk.
// This also checks array elements and literal own keys such as __proto__.
function checkFrozen(value, frozen) {
  const pending = [value];
  let objects = 0;
  while (pending.length) {
    const current = pending.pop();
    if (current === null || typeof current !== 'object') continue;
    objects++;
    assert.equal(Object.isFrozen(current), frozen);
    if (frozen) assert.equal(Reflect.set(current, '__jsonReadMutationProbe__', 1), false);
    for (const ownKey of Reflect.ownKeys(current)) {
      const descriptor = Object.getOwnPropertyDescriptor(current, ownKey);
      assert.ok(descriptor && 'value' in descriptor, 'JSON has only own data properties');
      pending.push(descriptor.value);
    }
  }
  return objects;
}
function verify(snapshots, expected, readOnly = false) {
  let objects = 0;
  for (const [name, source] of Object.entries(snapshots)) {
    assert.equal(source.size, expected.length, name);
    const values = read(name, source);
    assert.deepEqual(values, expected, name);
    for (const value of values) objects += checkFrozen(value, true);
    if (readOnly) assert.throws(() => append(name, source, { forbidden: true }), /read-only/);
  }
  return objects;
}
function payloadBytes(payload) {
  return payload.arenas.map(source => Buffer.from(source.copy
    ? source.copy.subarray(65536, source.used)
    : new Uint8Array(source.memory.buffer, 65536, source.used - 65536)));
}

function corpus() {
  let state = 0x9e3779b9;
  const next = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
  const scalar = () => [null, true, false, 0, -0, NaN, Infinity, -Infinity, next() / 97,
    'ASCII', '東京🙂\u0000\ufeff', '\ud800'][next() % 12];
  function make(depth) {
    if (!depth || next() % 3 === 0) return scalar();
    const length = next() % 6;
    if (next() & 1) return Array.from({ length }, () => make(depth - 1));
    const object = Object.create(null);
    for (let i = 0; i < length; i++) object[['__proto__', 'constructor', 'hasOwnProperty', 'toString', `field${i}`][i % 5]] = make(depth - 1);
    return object;
  }
  return [
    null, false, 42, 'top-level text', [], {}, [[], {}, null, [1, { point: [2, 3] }]],
    JSON.parse('{"__proto__":{"child":[{"x":1}]},"constructor":{"value":2},"hasOwnProperty":{"value":3}}'),
    { absent: undefined, numbers: [NaN, Infinity, -Infinity, -0], sparse: [1, , undefined, 4] },
    ...Array.from({ length: 64 }, () => make(5)),
  ];
}

if (!isMainThread) {
  let retained, initialExpected, initialValues;
  parentPort.on('message', async message => {
    try {
      const before = payloadBytes(message.payload);
      const snapshots = await S.initWorker(message.payload);
      const objects = verify(snapshots, message.expected, true);
      assert.deepEqual(payloadBytes(message.payload), before, 'reads preserve all published arena bytes');
      if (!retained) {
        retained = snapshots; initialExpected = message.expected;
        initialValues = Object.fromEntries(Object.entries(retained).map(([name, source]) => [name, read(name, source)]));
      } else {
        verify(retained, initialExpected, true);
        for (const [name, source] of Object.entries(retained)) {
          const values = read(name, source);
          for (let i = 0; i < values.length; i++) assert.strictEqual(values[i], initialValues[name][i]);
        }
      }
      parentPort.postMessage({ passed: true, objects, structures: Object.keys(snapshots).length });
    } catch (error) { parentPort.postMessage({ error: error.stack }); }
  });
} else {
  test('all nine JSON collections match native JSON and freeze every decoded object', () => {
    resetAll();
    const inputs = corpus(), expected = inputs.map(roundTrip), snapshots = create(inputs);
    const before = S.getWorkerData(snapshots, { copy: true });
    assert.ok(verify(snapshots, expected) > 1000);
    for (const value of inputs) checkFrozen(value, false);
    assert.deepEqual(payloadBytes(S.getWorkerData(snapshots, { copy: true })), payloadBytes(before));
  });

  test('caller ownership and inherited properties remain separate from decoded JSON', () => {
    resetAll();
    const input = { geometry: { coordinates: [[1, 2], [3, 4]] }, attributes: [{ name: 'original' }] };
    const expected = [roundTrip(input)], snapshots = create([input]);
    input.geometry.coordinates[0][0] = 99;
    input.attributes.push({ name: 'caller change' });
    const inherited = { mutable: [{ value: 1 }] };
    Object.defineProperty(Object.prototype, '__jsonReadInheritedGetter__', {
      enumerable: true, configurable: true, get() { throw new Error('Inherited getter must not run'); },
    });
    Object.defineProperty(Array.prototype, '__jsonReadInheritedObject__', {
      enumerable: true, configurable: true, value: inherited,
    });
    try {
      verify(snapshots, expected);
      checkFrozen(input, false);
      checkFrozen(inherited, false);
    } finally {
      delete Object.prototype.__jsonReadInheritedGetter__;
      delete Array.prototype.__jsonReadInheritedObject__;
    }
  });

  test('retained snapshots and forks remain correct after growth, reset, and compaction', async () => {
    resetAll();
    const initial = [{ points: [[1, 2], [3, 4]], properties: { live: true } }];
    const snapshots = create(initial), expected = initial.map(roundTrip);
    const before = S.getWorkerData(snapshots, { copy: false });
    const lengths = before.arenas.map(source => source.memory.buffer.byteLength);
    const retainedBytes = payloadBytes(before);
    const growth = { text: '東京🙂'.repeat(40000), nested: [{ values: [1, null, {}] }] };
    const forkValue = { fork: [{ values: [[5, 6]] }] };
    const next = {}, forks = {};
    for (const [name, source] of Object.entries(snapshots)) {
      next[name] = append(name, source, growth);
      forks[name] = append(name, source, forkValue);
    }
    assert.ok(before.arenas.every((source, index) => source.memory.buffer.byteLength > lengths[index]));
    resetAll();
    verify(snapshots, expected);
    verify(next, [...expected, roundTrip(growth)]);
    verify(forks, [...expected, roundTrip(forkValue)]);
    assert.deepEqual(payloadBytes(before), retainedBytes, 'growth does not rewrite retained payloads');
    const compacted = S.compactMany(next);
    verify(compacted, [...expected, roundTrip(growth)]);
    const reader = await S.initWorker(S.getWorkerData(compacted, { copy: true }));
    verify(reader, [...expected, roundTrip(growth)], true);
  });

  test('cache hits preserve JSON scalars, strings, and identities across growth and forks', async () => {
    resetAll();
    const values = [null, false, 0, '', 'text', '東京🙂', { points: [[1, 2], [3, 4]] }];
    const snapshots = create(values), reader = await S.initWorker(S.getWorkerData(snapshots, { copy: false }));
    const strings = new S.SharedList('string').pushMany(['', 'text', '東京🙂']);
    const retained = [snapshots, reader].map(group => Object.fromEntries(Object.entries(group).map(([name, source]) => [name, read(name, source)])));
    assert.deepEqual(strings.toArray(), ['', 'text', '東京🙂']);
    const growth = { text: '🙂'.repeat(80000), points: [[5, 6]] }, next = {}, forks = {};
    for (const [name, source] of Object.entries(snapshots)) {
      next[name] = append(name, source, growth);
      forks[name] = append(name, source, { fork: [[7, 8]] });
    }
    for (let repeat = 0; repeat < 3; repeat++) {
      for (const [index, group] of [snapshots, reader].entries()) {
        for (const [name, source] of Object.entries(group)) {
          const current = read(name, source);
          assert.deepEqual(current, values);
          for (let i = 0; i < current.length; i++) assert.strictEqual(current[i], retained[index][name][i]);
        }
      }
      assert.deepEqual(strings.toArray(), ['', 'text', '東京🙂']);
    }
    verify(next, [...values, growth]);
    verify(forks, [...values, { fork: [[7, 8]] }]);
  });

  test('cached nested JSON-list wrappers retain identity and their original child values', async () => {
    resetAll();
    const value = { points: [[1, 2]], attributes: [{ live: true }] };
    const inner = new S.SharedList(S.json()).push(value);
    const outer = new S.SharedList(S.list(S.json())).push(inner);
    const retained = [outer];
    for (const copy of [false, true]) retained.push((await S.initWorker(S.getWorkerData({ outer }, { copy }))).outer);
    const wrappers = retained.map(source => source.get(0)), children = wrappers.map(source => source.get(0));
    const grown = inner.push({ text: '🙂'.repeat(80000), points: [[3, 4]] });
    const fork = inner.set(0, { points: [[9, 8]], attributes: [{ live: false }] });
    const next = outer.set(0, grown), branch = outer.set(0, fork);
    for (let repeat = 0; repeat < 3; repeat++) {
      for (let i = 0; i < retained.length; i++) {
        assert.strictEqual(retained[i].get(0), wrappers[i]);
        assert.strictEqual(wrappers[i].get(0), children[i]);
        assert.deepEqual(children[i], value);
        assert.equal(wrappers[i].size, 1);
        checkFrozen(children[i], true);
      }
    }
    assert.equal(next.get(0).size, 2);
    assert.notStrictEqual(next.get(0), wrappers[0]);
    assert.strictEqual(next.get(0).get(0), children[0]);
    assert.deepEqual(branch.get(0).get(0), { points: [[9, 8]], attributes: [{ live: false }] });
    assert.notStrictEqual(branch.get(0).get(0), children[0]);
  });

  for (const copy of [false, true]) {
    test(`actual worker freezes JSON using ${copy ? 'copy' : 'shared-memory'} transport`, {
      timeout: 30000, skip: !copy && typeof Bun !== 'undefined' ? 'Bun worker transport uses the supported copy path' : false,
    }, async () => {
      resetAll();
      const inputs = corpus(), expected = inputs.map(roundTrip), snapshots = create(inputs);
      const worker = new Worker(new URL(import.meta.url), { workerData: { entry } });
      async function exchange(payload, expectedValues) {
        const response = once(worker, 'message');
        worker.postMessage({ payload, expected: expectedValues });
        const [result] = await response;
        if (result.error) throw new Error(result.error);
        assert.equal(result.structures, 9);
        assert.ok(result.objects > 1000);
      }
      try {
        const first = S.getWorkerData(snapshots, { copy });
        assert.ok(first.arenas.every(source => copy ? source.copy && !source.memory : source.memory && !source.copy));
        await exchange(first, expected);
        const growth = { coordinates: [[9, 8], [7, 6]], text: '🙂'.repeat(80000) };
        const next = {};
        for (const [name, source] of Object.entries(snapshots)) next[name] = append(name, source, growth);
        resetAll();
        await exchange(S.getWorkerData(next, { copy }), [...expected, roundTrip(growth)]);
        verify(snapshots, expected);
      } finally { await worker.terminate(); }
    });
  }
}
