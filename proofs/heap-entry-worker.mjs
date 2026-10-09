/** Untimed checks using the actual dist/shared.js portable artifacts.
 * Snapshot.owner is located through the built class prototype solely for fixed
 * fixture IDs and private byte/state/getter checks. Collection and transport
 * calls use the public built entry. No substitute bundle or timing is involved.
 * Run: node|bun heap-entry-worker.mjs baseline-root candidate-root evidence-dir
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { Worker, isMainThread, parentPort } from 'node:worker_threads';

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
const save = (file, value) => writeFileSync(file, JSON.stringify(value, binary64, 2) + '\n');
const append = (file, value) => appendFileSync(file, JSON.stringify(value, binary64) + '\n');

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
if (!isMainThread) {
  let api, item, owner, type, first, second, a, b, bytes, state, descriptor, trace;
  parentPort.on('message', async message => {
    try {
      if (message.command === 'attach') {
        api = await import(message.module); ({ item } = await api.initWorker(message.data));
        owner = ownerOf(api, item); type = message.type;
        bytes = payloadBytes(owner); state = owner.state(); descriptor = item.toWorkerData(); trace = instrument(owner);
        a = item.entries(); b = item.entries(); assert.deepEqual(trace.count, { getters: 0, refreshes: 0, decodes: 0 });
        parentPort.postMessage({ stage: 'created', marker: new Uint8Array(owner.memory.buffer)[60000] });
      } else if (message.command === 'first') {
        first = a.next(); second = b.next(); parentPort.postMessage({ stage: 'paused', done: first.done });
      } else if (message.command === 'finish') {
        const output = plain(type, first.done ? [] : [first.value, ...a]);
        const interleaved = plain(type, second.done ? [] : [second.value, ...b]);
        const count = { ...trace.count }; trace.restore();
        assert.deepEqual(output, interleaved); bytesEqual(payloadBytes(owner), bytes, 'Worker mutated heap bytes');
        assert.deepEqual(owner.state(), state); assert.deepEqual(item.toWorkerData(), descriptor);
        const stopped = item.entries(); stopped.next(); stopped.return(); assert.equal(stopped.next().done, true);
        const thrown = item.entries(); thrown.next(); const sentinel = new Error('stop');
        assert.throws(() => thrown.throw(sentinel), error => error === sentinel); assert.equal(thrown.next().done, true);
        assert.throws(() => item.enqueue(0, 0), /read-only/);
        parentPort.postMessage({ stage: 'done', output, interleaved, count, bytes: digest(bytes), state, descriptor,
          marker: new Uint8Array(owner.memory.buffer)[60000], writeRejected: true });
      } else throw new Error(`Unknown command: ${message.command}`);
    } catch (error) { parentPort.postMessage({ stage: 'error', error: String(error.stack ?? error) }); }
  });
}

export async function checkBuiltEntries({ baselineRoot, candidateRoot, evidenceRoot }) {
  mkdirSync(evidenceRoot, { recursive: true });
  const runtime = typeof Bun === 'undefined' ? 'node' : 'bun';
  const modules = Object.fromEntries(Object.entries({ baseline: baselineRoot, candidate: candidateRoot })
    .map(([arm, root]) => [arm, pathToFileURL(join(resolve(root), 'dist/shared.js')).href]));
  const api = {};
  const matrix = { schema: 'zerocopy-heap-entry-matrix/v1', runtime, node: process.version,
    bun: globalThis.Bun?.version, entries: modules, complete: false, rows: [] };
  const workers = { schema: 'zerocopy-heap-entry-workers/v1', runtime, node: process.version,
    bun: globalThis.Bun?.version, entries: modules, complete: false, rows: [] };
  const matrixPath = join(evidenceRoot, `matrix-${runtime}.json`), workerPath = join(evidenceRoot, `workers-${runtime}.json`);
  const matrixRows = join(evidenceRoot, `matrix-${runtime}.rows.jsonl`), workerRows = join(evidenceRoot, `workers-${runtime}.rows.jsonl`);
  writeFileSync(matrixRows, '', { flag: 'wx' }); writeFileSync(workerRows, '', { flag: 'wx' });
  try {
    for (const arm of ['baseline', 'candidate']) api[arm] = await import(modules[arm]);
    assert.deepEqual(shape(api.baseline), shape(api.candidate)); matrix.shape = shape(api.candidate);
    assert.equal(matrix.shape.tag, '[object GeneratorFunction]');
    assert.equal(matrix.shape.iteratorPrototype, true); assert.equal(matrix.shape.iteratorSelf, true);
    for (const arm of ['baseline', 'candidate']) generatorEdges(api[arm]);
    for (const size of sizes) for (const type of types) for (const maxHeap of [false, true]) {
      matrix.currentCase = label(size, type, maxHeap);
      const data = {}, storage = {};
      for (const arm of ['baseline', 'candidate']) {
        const { item, owner } = fixture(api[arm], size, type, maxHeap);
        storage[arm] = fullStorage(owner); data[arm] = capture(api[arm], item, type);
        assertStorageEqual(fullStorage(owner), storage[arm], 'Reading changed dependency bytes');
      }
      const { count: before, ...a } = data.baseline, { count: after, ...b } = data.candidate;
      assert.deepEqual(b, a, label(size, type, maxHeap));
      assertStorageEqual(storage.candidate, storage.baseline, 'Cross-arm allocated bytes differ'); assertReduction(before, after, size);
      const row = { case: label(size, type, maxHeap), ...data }; matrix.rows.push(row); append(matrixRows, row);
    }
    delete matrix.currentCase; matrix.complete = true; save(matrixPath, matrix);
    for (const arm of ['baseline', 'candidate']) for (const copy of [false, true]) {
      const worker = new Worker(new URL(import.meta.url));
      try {
        for (const size of sizes) for (const type of types) for (const maxHeap of [false, true]) {
          const name = label(size, type, maxHeap); workers.currentCase = { arm, copy, name };
          const { item, owner } = fixture(api[arm], size, type, maxHeap), expected = capture(api[arm], item, type);
          new Uint8Array(owner.memory.buffer)[60000] = 17;
          const transport = api[arm].getWorkerData({ item }, { copy });
          assert(transport.arenas.every(arena => copy ? arena.copy && !arena.memory : arena.memory && !arena.copy));
          const attached = await exchange(worker, { command: 'attach', module: modules[arm], data: transport, type });
          assert.equal(attached.stage, 'created'); assert.equal(attached.marker, 17);
          const initial = owner.memory.buffer.byteLength; owner.memory.grow(1);
          assert(owner.memory.buffer.byteLength > initial, 'No growth before first next');
          const first = await exchange(worker, { command: 'first' }); assert.equal(first.stage, 'paused'); assert.equal(first.done, size === 0);
          const started = owner.memory.buffer.byteLength; owner.alloc(started);
          assert(owner.memory.buffer.byteLength > started, 'No growth while suspended');
          new Uint8Array(owner.memory.buffer)[60000] = 99;
          const result = await exchange(worker, { command: 'finish' }); assert.equal(result.stage, 'done');
          assert.deepEqual(result.output, expected.output, name); assert.equal(result.bytes, expected.bytes);
          assert.deepEqual(result.state, expected.state); assert.deepEqual(result.descriptor, expected.descriptor);
          assert.equal(result.marker, copy ? 17 : 99, 'Shared backing/copy isolation marker mismatch');
          const row = { arm, copy, case: name, ...result }; workers.rows.push(row); append(workerRows, row);
        }
      } finally { await worker.terminate(); save(workerPath, workers); }
    }
    for (const before of workers.rows.filter(row => row.arm === 'baseline')) {
      const after = workers.rows.find(row => row.arm === 'candidate' && row.copy === before.copy && row.case === before.case);
      const { arm: beforeArm, count: a, ...x } = before, { arm: afterArm, count: b, ...y } = after;
      assert.deepEqual(y, x); assertReduction(a, b, before.output.length * 2);
    }
    delete workers.currentCase; workers.complete = true; save(workerPath, workers);
    const summary = { passed: true, runtime, matrixCases: matrix.rows.length, workerCases: workers.rows.length,
      actualWorkers: 4, sharedAndCopied: true, beforeFirstNextAndPausedGrowth: true,
      fullOutputsBytesStateDescriptorsEqual: true, sharedMarkerAndCopyIsolation: true,
      writeRejection: true, earlyReturnAndThrow: true, binary64LiteralOracle: true,
      decoderReceiverReentrantGrowthAndExceptions: true, latencyCollected: false };
    save(join(evidenceRoot, `summary-${runtime}.json`), summary); console.log(JSON.stringify(summary)); return summary;
  } catch (error) {
    const failure = { message: String(error.stack ?? error) };
    if (!matrix.complete) matrix.failure = failure;
    workers.failure = failure; save(matrixPath, matrix); save(workerPath, workers); throw error;
  }
}
if (isMainThread && process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [baselineRoot, candidateRoot, evidenceRoot] = process.argv.slice(2);
  assert(baselineRoot && candidateRoot && evidenceRoot, 'Expected baseline-root candidate-root evidence-dir');
  await checkBuiltEntries({ baselineRoot, candidateRoot, evidenceRoot });
}
