import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
const HEAP_START = 65536;
export const sizes = [0, 1, 31, 32, 33, 65, 1057, 4097];
export const types = ['number', 'boolean', 'string', 'object', 'nested'];
const special = [-0, 0, NaN, Infinity, -Infinity, Number.MIN_VALUE, Number.MAX_VALUE, 1.25];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const label = (size, type, maxHeap) => `${size}/${type}/${maxHeap ? 'max' : 'min'}`;
const plain = (type, output) => output.map(([value, priority]) => {
  if (type === 'object') {
    assert(Object.isFrozen(value)); assert(Object.isFrozen(value.nested)); assert(Object.isFrozen(value.flags));
  }
  return [type === 'nested' ? value.get('id') : value, priority];
});
const payloadBytes = owner => new Uint8Array(owner.memory.buffer).slice(HEAP_START, owner.used);
const bytesEqual = (actual, expected, message) => assert.equal(Buffer.compare(actual, expected), 0, message);
const binary64 = (_, value) => typeof value === 'number' && (Object.is(value, -0) || !Number.isFinite(value))
  ? { binary64: Object.is(value, -0) ? '-0' : String(value) } : value;

function ownerOf(api, item) {
  const base = Object.getPrototypeOf(api.SharedPriorityQueue);
  assert.equal(typeof base.owner, 'function', 'Built Snapshot.owner instrumentation seam changed');
  return base.owner(item);
}
function fixture(api, size, type, maxHeap) {
  const Arena = ownerOf(api, new api.SharedPriorityQueue('number')).constructor;
  const owner = new Arena({ id: 'fixture' }), nested = new Arena({ id: 'nested' });
  let item = new api.SharedPriorityQueue(type === 'nested' ? api.map('number') : type, { maxHeap }, owner);
  for (let i = 0; i < size; i++) {
    const value = type === 'number' ? special[i % special.length] : type === 'boolean' ? i % 3 === 0
      : type === 'string' ? `界🙂${i}` : type === 'object' ? { id: i, nested: { text: `界🙂${i}` }, flags: [i % 3 === 0, i] }
        : new api.SharedMap('number', 0, 0, nested).set('id', i);
    const priority = i % 19 === 0 ? Infinity : i % 19 === 1 ? -Infinity : i % 19 === 2 ? -0 : (i * 37) % 17;
    item = item.enqueue(value, priority);
  }
  return { item, owner };
}
function instrument(owner) {
  const getter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(owner), 'dv').get;
  const refresh = owner.refresh, decode = owner.decode;
  const count = { getters: 0, refreshes: 0, decodes: 0 };
  Object.defineProperty(owner, 'dv', { configurable: true, get() { count.getters++; return getter.call(this); } });
  owner.refresh = function () { count.refreshes++; return refresh.call(this); };
  owner.decode = function (type, raw) { count.decodes++; return decode.call(this, type, raw); };
  return { count, restore() { delete owner.dv; owner.refresh = refresh; owner.decode = decode; } };
}
function capture(api, item, type) {
  const owner = ownerOf(api, item), bytes = payloadBytes(owner), state = owner.state(), descriptor = item.toWorkerData();
  const trace = instrument(owner), iterator = item.entries();
  assert.deepEqual(trace.count, { getters: 0, refreshes: 0, decodes: 0 });
  let output, count;
  try { output = plain(type, [...iterator]); count = { ...trace.count }; } finally { trace.restore(); }
  bytesEqual(payloadBytes(owner), bytes, 'Reader mutated heap bytes');
  assert.deepEqual(owner.state(), state); assert.deepEqual(item.toWorkerData(), descriptor);
  return { output, count, bytes: digest(bytes), byteLength: bytes.length, state, descriptor };
}
function shape(api) {
  const fn = api.SharedPriorityQueue.prototype.entries;
  const descriptor = Object.getOwnPropertyDescriptor(api.SharedPriorityQueue.prototype, 'entries');
  const iterator = new api.SharedPriorityQueue('number').entries();
  return { name: fn.name, length: fn.length, tag: Object.prototype.toString.call(fn), own: Object.getOwnPropertyNames(fn),
    prototypeOwn: Object.getOwnPropertyNames(fn.prototype), enumerable: descriptor.enumerable,
    writable: descriptor.writable, configurable: descriptor.configurable,
    iteratorPrototype: Object.getPrototypeOf(iterator) === fn.prototype, iteratorSelf: iterator[Symbol.iterator]() === iterator };
}
function fullStorage(owner) {
  return [owner, ...owner.dependencies.values()].map(arena => ({ id: arena.id, state: arena.state(), bytes: payloadBytes(arena) }));
}
function assertStorageEqual(actual, expected, message) {
  assert.equal(actual.length, expected.length, message);
  for (let i = 0; i < actual.length; i++) {
    assert.equal(actual[i].id, expected[i].id, message); assert.deepEqual(actual[i].state, expected[i].state, message);
    bytesEqual(actual[i].bytes, expected[i].bytes, message);
  }
}
function assertReduction(before, after, visited) {
  assert.equal(before.getters - after.getters, 3 * visited, 'Expected three fewer view requests per visited entry');
  assert.equal(before.refreshes - after.refreshes, 3 * visited, 'Expected three fewer refreshes per visited entry');
  assert.equal(before.decodes, after.decodes, 'Decoder work changed');
}
function generatorEdges(api) {
  for (const value of special) for (const priority of [-0, Number.MIN_VALUE, 0.125, Infinity, -Infinity]) {
    const item = new api.SharedPriorityQueue('number').enqueue(value, priority);
    const output = [...item.entries()]; assert.deepEqual(output, [[value, priority]]);
    output[0][0] = 42; output[0][1] = 43;
    assert(Object.is(item.peek(), value)); assert(Object.is(item.peekPriority(), priority));
  }
  const { item, owner } = fixture(api, 33, 'number', false), expected = [...item.entries()];
  const decode = owner.decode, calls = [];
  let nested = false;
  owner.decode = function (type, raw) {
    assert.equal(this, owner); assert.equal(type, 'number');
    if (!nested) {
      calls.push(raw);
      if (calls.length === 1) {
        owner.memory.grow(1); nested = true;
        const reentrant = new api.SharedPriorityQueue('number', undefined, owner).enqueue(100, -Infinity);
        assert.deepEqual(reentrant.entries().next().value, [100, -Infinity]); nested = false;
      }
    }
    return decode.call(this, type, raw);
  };
  try {
    assert.deepEqual([...item.entries()], expected); assert.deepEqual(calls, expected.map(([value]) => value));
    const sentinel = new Error('decoder rejected value'); let seen = 0;
    owner.decode = () => { if (++seen === 3) throw sentinel; return seen; };
    const iterator = item.entries();
    assert.deepEqual(iterator.next().value, [1, expected[0][1]]); assert.deepEqual(iterator.next().value, [2, expected[1][1]]);
    assert.throws(() => iterator.next(), error => error === sentinel);
    assert.deepEqual(iterator.next(), { done: true, value: undefined }); assert.equal(seen, 3);
  } finally { owner.decode = decode; }
  const trace = instrument(owner);
  try {
    item.entries().return(); const sentinel = new Error('before first next');
    assert.throws(() => item.entries().throw(sentinel), error => error === sentinel);
    assert.deepEqual(trace.count, { getters: 0, refreshes: 0, decodes: 0 });
  } finally { trace.restore(); }
}
function exchange(worker, message) {
  return new Promise((resolveResult, reject) => {
    const timer = setTimeout(() => finish(new Error(`Worker timed out: ${message.command}`)), 30000);
    const onMessage = result => result.stage === 'error' ? finish(new Error(result.error)) : finish(null, result);
    const onError = error => finish(error);
    const onExit = code => finish(new Error(`Worker exited before response (${code}): ${message.command}`));
    function finish(error, result) {
      clearTimeout(timer); worker.off('message', onMessage); worker.off('error', onError); worker.off('exit', onExit);
      if (error) reject(error); else resolveResult(result);
    }
    worker.once('message', onMessage); worker.once('error', onError); worker.once('exit', onExit);
    try { worker.postMessage(message); } catch (error) { finish(error); }
  });
}

export async function semanticChecks(moduleURL, copy) {
  const api = await import(moduleURL), generator = shape(api);
  assert.equal(generator.tag, '[object GeneratorFunction]');
  assert.equal(generator.name, 'entries'); assert.equal(generator.length, 0);
  assert.equal(generator.iteratorPrototype, true); assert.equal(generator.iteratorSelf, true);
  assert.equal(generator.enumerable, false); assert.equal(generator.writable, true); assert.equal(generator.configurable, true);
  generatorEdges(api);
  const cases = [[0, 'number', false], [33, 'number', false], [65, 'nested', false], [1057, 'number', false], [4097, 'string', false]];
  const worker = new Worker(new URL('./heap-entry-worker.mjs', import.meta.url)), rows = [];
  try {
    for (const [size, type, maxHeap] of cases) {
      const { item, owner } = fixture(api, size, type, maxHeap), expected = capture(api, item, type);
      new Uint8Array(owner.memory.buffer)[60000] = 17;
      const data = api.getWorkerData({ item }, { copy });
      assert(data.arenas.every(arena => copy ? arena.copy && !arena.memory : arena.memory && !arena.copy));
      const attached = await exchange(worker, { command: 'attach', module: moduleURL, data, type });
      assert.equal(attached.stage, 'created'); assert.equal(attached.marker, 17);
      const initial = owner.memory.buffer.byteLength; owner.memory.grow(1);
      assert(owner.memory.buffer.byteLength > initial);
      const first = await exchange(worker, { command: 'first' });
      assert.equal(first.stage, 'paused'); assert.equal(first.done, size === 0);
      const paused = owner.memory.buffer.byteLength; owner.alloc(paused);
      assert(owner.memory.buffer.byteLength > paused);
      new Uint8Array(owner.memory.buffer)[60000] = 99;
      const result = await exchange(worker, { command: 'finish' });
      assert.equal(result.stage, 'done'); assert.deepEqual(result.output, expected.output);
      assert.deepEqual(result.interleaved, expected.output); assert.equal(result.bytes, expected.bytes);
      assert.deepEqual(result.state, expected.state); assert.deepEqual(result.descriptor, expected.descriptor);
      assert.equal(result.marker, copy ? 17 : 99); assert.equal(result.writeRejected, true);
      // Nested-value cache warming may make the two interleaved passes differ
      // from twice a single owner pass. Compare the mechanism across arms in
      // the controller; preserve each raw count instead of assuming additivity.
      if (size === 0) {
        assert.deepEqual(expected.count, { getters: 0, refreshes: 0, decodes: 0 });
        assert.deepEqual(result.count, { getters: 0, refreshes: 0, decodes: 0 });
      }
      rows.push({ size, type, maxHeap, expected, result });
    }
  } finally { await worker.terminate(); }
  return { status: 'completed', generator, copy, rows, actualWorkers: 1,
    generatorLazyAccess: true, customDecoderOrderReceiverReentrantGrowthExceptions: true,
    sharedCopyMarkers: true, growthBeforeFirstNextAndWhilePaused: true, bytesStateDescriptorsUnchanged: true };
}
