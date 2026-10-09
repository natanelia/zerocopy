import assert from 'node:assert/strict';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';

const special = [NaN, -0, 0, Infinity, -Infinity, Number.MIN_VALUE, -Number.MIN_VALUE, Number.MAX_VALUE, -Number.MAX_VALUE];
const expected = Array.from({ length: 1057 }, (_, index) => special[index % special.length]);
function verify(queue) {
  assert.equal(queue.size, expected.length);
  const old = queue;
  for (let index = 0; index < expected.length; index++) {
    assert(Object.is(queue.peek(), expected[index]), `front ${index}`);
    assert(Object.is(queue.peek(), expected[index]), `repeated front ${index}`);
    if (index % 31 === 0) assert(Object.is(old.peek(), expected[0]), 'retained front');
    queue = queue.dequeue();
  }
  assert.equal(queue.peek(), undefined);
  assert.equal(queue.dequeue(), queue);
  assert(Object.is(old.dequeue().peek(), -0), 'retained signed zero');
}

if (!isMainThread) {
  const api = await import(workerData.consumer);
  const { queue } = await api.initWorker(workerData.data);
  const source = workerData.data.arenas.find(arena => arena.id === workerData.data.structures.queue.arena);
  assert(source);
  if (workerData.copy) {
    assert(source.copy && !source.memory);
    assert.equal(new DataView(source.copy.buffer, source.copy.byteOffset, source.copy.byteLength).getInt32(64000, true), 0);
  } else {
    assert(source.memory && !source.copy);
  }
  // Test-only header scratch is outside the published collection bytes.
  Atomics.store(new Int32Array(queue.arena.memory.buffer, 64000, 1), 0, 91);
  verify(queue);
  assert.throws(() => queue.enqueue(1), /read-only/);
  parentPort.postMessage({ passed: true, entries: expected.length, objectIsChecks: expected.length * 2 + Math.ceil(expected.length / 31) + 1 });
  parentPort.close();
} else {
  // With no arguments, validate the local build. Two checkout arguments also
  // exercise unchanged-wire compatibility in both producer/consumer directions.
  const roots = process.argv.slice(2, 4);
  if (!roots.length) roots.push(fileURLToPath(new URL('..', import.meta.url)));
  const modules = roots.map(root => pathToFileURL(resolve(root, 'dist/shared.js')).href);
  const apis = await Promise.all(modules.map(module => import(module))), rows = [];
  for (let producer = 0; producer < apis.length; producer++) for (let consumer = 0; consumer < apis.length; consumer++) for (const copy of [false, true]) {
    const api = apis[producer]; api.resetQueue();
    let queue = new api.SharedQueue('number');
    for (const value of expected) queue = queue.enqueue(value);
    const data = api.getWorkerData({ queue }, { copy });
    const source = data.arenas.find(arena => arena.id === data.structures.queue.arena);
    assert(source);
    const writerData = api.getWorkerData({ queue }, { copy: false });
    const writerMemory = writerData.arenas.find(arena => arena.id === writerData.structures.queue.arena).memory;
    const worker = new Worker(new URL(import.meta.url), { workerData: { consumer: modules[consumer], data, copy } });
    const timer = setTimeout(() => { console.error('Queue special-number worker timed out'); process.exit(1); }, 10000);
    try {
      const [result] = await once(worker, 'message');
      assert.equal(result.passed, true);
      if (copy) assert.equal(new DataView(source.copy.buffer, source.copy.byteOffset, source.copy.byteLength).getInt32(64000, true), 0);
      else assert.equal(Atomics.load(new Int32Array(source.memory.buffer, 64000, 1), 0), 91);
      assert.equal(Atomics.load(new Int32Array(writerMemory.buffer, 64000, 1), 0), copy ? 0 : 91);
      verify(queue);
      rows.push({ producer: roots[producer], consumer: roots[consumer], transport: copy ? 'copy' : 'shared', ...result, writerSnapshotPreserved: true, backingModeVerified: true });
    } finally { clearTimeout(timer); await worker.terminate(); }
  }
  const result = { runtime: process.versions.node, timings: false, specialValues: ['NaN', '-0', '+0', '+Infinity', '-Infinity', '+MIN_VALUE', '-MIN_VALUE', '+MAX_VALUE', '-MAX_VALUE'], rows };
  if (process.env.QUEUE_SPECIAL_OUTPUT) writeFileSync(process.env.QUEUE_SPECIAL_OUTPUT, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ passed: true, runtime: process.versions.node, cases: rows.length, entriesPerCase: expected.length, timings: false }));
}
