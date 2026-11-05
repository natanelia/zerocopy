import assert from 'node:assert/strict';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

const waitMessage = worker => once(worker, 'message', { signal: AbortSignal.timeout(15000) }).then(([message]) => {
  if (message.error) throw new Error(message.error);
  return message;
});
function checkAll(collections, expected) {
  assert.deepEqual(Object.keys(collections).sort(), Object.keys(expected).sort());
  for (const [name, list] of Object.entries(collections)) {
    assert.deepEqual(list.toArray(), expected[name]);
    assert.ok(Object.isFrozen(list));
    assert.throws(() => list.set(0, expected[name][0]), /read-only/);
    assert.equal(list.set(-1, 'invalid index'), list);
  }
}

if (!isMainThread) {
  try {
    const api = await import(workerData.entry), old = await api.initWorker(workerData.payload);
    checkAll(old, workerData.expected);
    const readers = Object.fromEntries(Object.entries(old).map(([name, list]) => {
      const iterator = list.values(); return [name, { iterator, values: [iterator.next().value] }];
    }));
    const arena = old.originalNumber.arena, originalUsed = arena.used;
    const originalBytes = new Uint8Array(arena.memory.buffer).slice(65536, originalUsed);
    // A test-only scratch word below HEAP_START distinguishes a shared attachment
    // from an equal copied payload. No collection payload is modified.
    Atomics.store(new Int32Array(arena.memory.buffer), 15000, 37);
    const start = once(parentPort, 'message'); parentPort.postMessage({ phase: 'ready' });
    await start;
    const control = new Int32Array(workerData.control);
    Atomics.store(control, 0, 1); Atomics.notify(control, 0);
    let reads = 0;
    while (reads < 4096 || Atomics.load(control, 1) === 0) {
      for (const [name, list] of Object.entries(old)) {
        const index = reads % list.size;
        assert.ok(Object.is(list.get(index), workerData.expected[name][index]));
      }
      reads++;
    }
    for (const [name, reader] of Object.entries(readers)) {
      reader.values.push(...reader.iterator); assert.deepEqual(reader.values, workerData.expected[name]);
    }
    checkAll(old, workerData.expected);
    assert.equal(arena.used, originalUsed);
    assert.deepEqual(new Uint8Array(arena.memory.buffer, 65536, originalBytes.length), originalBytes);
    const nextMessage = once(parentPort, 'message'); parentPort.postMessage({ phase: 'retained', reads });
    const [message] = await nextMessage, next = await api.initWorker(message.payload);
    checkAll(next, message.expected); checkAll(old, workerData.expected);
    parentPort.postMessage({ phase: 'complete', reads, oldAndNewChecked: true, readOnlyChecked: true });
  } catch (error) { parentPort.postMessage({ error: String(error?.stack ?? error) }); }
} else {
  const writerEntry = pathToFileURL(resolve(process.argv[2] ?? 'dist/shared.js')).href;
  const entries = [{ name: 'current', entry: writerEntry }];
  if (process.argv[3]) entries.push({ name: 'baseline', entry: pathToFileURL(resolve(process.argv[3])).href });
  const api = await import(writerEntry), Arena = new api.SharedList('number').arena.constructor;
  for (const reader of entries) for (const copy of [false, true]) {
    const arena = new Arena({ memory: new WebAssembly.Memory({ initial: 2, maximum: 1024, shared: true }) });
    const number = Array.from({ length: 1057 }, (_, i) => i + .25), boolean = Array.from({ length: 65 }, (_, i) => !!(i & 1));
    const string = Array.from({ length: 65 }, (_, i) => `界🙂-${i % 4}`);
    const originalNumber = new api.SharedList('number', 0, 0, 0, arena).pushMany(number);
    const originalBoolean = new api.SharedList('boolean', 0, 0, 0, arena).pushMany(boolean);
    const originalString = new api.SharedList('string', 0, 0, 0, arena).pushMany(string);
    const used = arena.used;
    const noopNumber = originalNumber.set(511, number[511]).set(0, number[0]);
    const noopBoolean = originalBoolean.set(31, boolean[31]).set(0, boolean[0]);
    const noopString = originalString.set(31, string[31]).set(0, string[0]);
    assert.equal(arena.used, used);
    for (const [original, noop] of [[originalNumber, noopNumber], [originalBoolean, noopBoolean], [originalString, noopString]]) {
      assert.notEqual(original, noop); assert.deepEqual(original.toWorkerData(), noop.toWorkerData());
    }
    const tailControl = noopNumber.set(1056, number[1056]);
    assert.notEqual(tailControl.tail, noopNumber.tail); assert.equal(arena.used - used, 8);
    const changedNumber = noopNumber.set(511, -1).set(1056, -0), changedBoolean = noopBoolean.set(31, false), changedString = noopString.set(31, string[0]);
    const changedNumbers = [...number]; changedNumbers[511] = -1; changedNumbers[1056] = -0;
    const changedBooleans = [...boolean]; changedBooleans[31] = false;
    const changedStrings = [...string]; changedStrings[31] = string[0];
    const collections = { originalNumber, originalBoolean, originalString, noopNumber, noopBoolean, noopString, changedNumber, changedBoolean, changedString };
    const expected = { originalNumber: number, originalBoolean: boolean, originalString: string, noopNumber: number, noopBoolean: boolean,
      noopString: string, changedNumber: changedNumbers, changedBoolean: changedBooleans, changedString: changedStrings };
    const publishedEnd = arena.used, published = new Uint8Array(arena.memory.buffer).slice(65536, publishedEnd), initialBuffer = arena.memory.buffer;
    const control = new SharedArrayBuffer(8);
    const worker = new Worker(new URL(import.meta.url), { workerData: { entry: reader.entry, payload: api.getWorkerData(collections, { copy }), expected, control } });
    try {
      assert.equal((await waitMessage(worker)).phase, 'ready');
      assert.equal(Atomics.load(new Int32Array(arena.memory.buffer), 15000), copy ? 0 : 37);
      const retained = waitMessage(worker); worker.postMessage('start');
      assert.notEqual(Atomics.wait(new Int32Array(control), 0, 0, 10000), 'timed-out');
      const grownString = new api.SharedList('string', 0, 0, 0, arena).push('界'.repeat(initialBuffer.byteLength));
      const added = Array.from({ length: 128 }, (_, i) => 2000 + i), grown = changedNumber.pushMany(added);
      const fork = originalNumber.set(0, -99), frontier = noopString.push('frontier');
      assert.notEqual(arena.memory.buffer, initialBuffer); assert.equal(grownString.size, 1);
      api.resetSharedList();
      Atomics.store(new Int32Array(control), 1, 1);
      const retainedResult = await retained; assert.equal(retainedResult.phase, 'retained'); assert.ok(retainedResult.reads >= 4096);
      const done = waitMessage(worker);
      worker.postMessage({ payload: api.getWorkerData({ grown, fork, frontier }, { copy }), expected: {
        grown: [...changedNumbers, ...added], fork: [-99, ...number.slice(1)], frontier: [...string, 'frontier'],
      } });
      assert.equal((await done).phase, 'complete');
      assert.deepEqual(new Uint8Array(arena.memory.buffer, 65536, published.length), published);
      for (const [name, list] of Object.entries(collections)) assert.deepEqual(list.toArray(), expected[name]);
      console.log(JSON.stringify({ passed: true, runtime: process.version, reader: reader.name, copy,
        zeroAllocationTreeNoops: true, originalTailCopy: true, originalChangedPathFormat: true, signedZero: true, suspendedIterators: true,
        concurrentReadsAtLeast: 4096, writerGrew: true, resetAndForks: true, oldAndNewAttachments: true }));
    } finally { await worker.terminate(); }
  }
}
