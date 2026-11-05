import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { expectedEnvelope, numberValue } from './fixtures.mjs';

const root = resolve(process.env.QUEUE_PORTABLE_BUILD ?? fileURLToPath(new URL('../../', import.meta.url)));
const api = await import(pathToFileURL(join(root, 'dist/shared.js')).href);
const { createZerocopyCodec } = await import(pathToFileURL(join(root, 'dist/redux.js')).href);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const codec = createZerocopyCodec();

if (!isMainThread) {
  const queues = await api.initWorker(workerData.payload);
  const inspect = () => {
    const published = api.getWorkerData(queues, { copy: false });
    const before = published.arenas.map(a => ({ id: a.id, used: a.used, bytes: a.memory.buffer.byteLength,
      hash: sha(new Uint8Array(a.memory.buffer, 0, a.used)) }));
    for (const [name, queue] of Object.entries(queues)) {
      assert.deepEqual(codec.encode(queue), workerData.expected[name]);
      assert.equal(codec.stringify(queue), JSON.stringify(workerData.expected[name]));
      const restored = codec.parse(codec.stringify(queue));
      assert.deepEqual(codec.encode(restored), workerData.expected[name]);
      assert.equal(restored.arena.readOnly, false);
      assert.throws(() => queue.enqueue(queue.peek()), /read-only/);
    }
    const after = api.getWorkerData(queues, { copy: false }).arenas.map(a => ({ id: a.id, used: a.used,
      bytes: a.memory.buffer.byteLength, hash: sha(new Uint8Array(a.memory.buffer, 0, a.used)) }));
    assert.deepEqual(after, before);
  };
  inspect(); parentPort.postMessage({ ready: true });
  parentPort.on('message', () => {
    try { inspect(); parentPort.postMessage({ ok: true }); }
    catch (error) { parentPort.postMessage({ error: error.stack }); }
  });
} else {
  const Arena = new api.SharedQueue('number').arena.constructor, arena = new Arena(), childArena = new Arena();
  const numberValues = Array.from({ length: 1057 }, (_, i) => numberValue(i));
  const stringValues = Array.from({ length: 97 }, (_, i) => `row-${i}-界🙂-\ufeff\0`);
  const objectValues = Array.from({ length: 97 }, (_, i) => ({ i, nested: { coordinates: [[i, i + .5]], label: '界🙂' } }));
  const child = new api.SharedList('number', 0, 0, 0, childArena).pushMany([1, 2, 3]);
  const make = (type, values, offset) => {
    let queue = new api.SharedQueue(type, 0, 0, 0, undefined, arena);
    for (const value of values) queue = queue.enqueue(value);
    for (let i = 0; i < offset; i++) queue = queue.dequeue();
    return queue;
  };
  const queues = {
    numbers: make('number', numberValues, 31), strings: make('string', stringValues, 33),
    objects: make('object', objectValues, 33), nested: make('SharedList<number>', Array.from({ length: 65 }, () => child), 31),
  };
  const expected = {
    numbers: expectedEnvelope('queue', 'number', numberValues.slice(31)),
    strings: expectedEnvelope('queue', 'string', stringValues.slice(33)),
    objects: expectedEnvelope('queue', 'object', JSON.parse(JSON.stringify(objectValues.slice(33)))),
    nested: { $zerocopyRedux: 1, value: ['c', 'SharedQueue', 'SharedList<number>', null,
      Array.from({ length: 34 }, () => ['c', 'SharedList', 'number', null, [1, 2, 3]])] },
  };
  const receive = worker => new Promise((resolveReply, reject) => {
    const cleanup = () => { clearTimeout(timer); worker.off('message', message); worker.off('error', error); worker.off('exit', exit); };
    const message = reply => { cleanup(); reply.error ? reject(new Error(reply.error)) : resolveReply(reply); };
    const error = failure => { cleanup(); reject(failure); };
    const exit = code => { cleanup(); reject(new Error(`Worker exited before replying: ${code}`)); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('Worker response timed out')); }, 30000);
    worker.once('message', message); worker.once('error', error); worker.once('exit', exit);
  });
  const workers = [false, true].map(copy => new Worker(new URL(import.meta.url), {
    workerData: { payload: api.getWorkerData(queues, { copy }), expected }, env: { ...process.env, QUEUE_PORTABLE_BUILD: root },
  }));
  try {
    const replies = await Promise.all(workers.map(receive)); assert.ok(replies.every(reply => reply.ready));
    const capacity = arena.memory.buffer.byteLength, childCapacity = childArena.memory.buffer.byteLength;
    const fork = queues.numbers.dequeue().enqueue(999999); child.push(99);
    arena.alloc(capacity * 2); childArena.alloc(childCapacity * 2);
    assert.ok(arena.memory.buffer.byteLength > capacity); assert.ok(childArena.memory.buffer.byteLength > childCapacity);
    api.resetQueue(); api.resetSharedList();
    assert.deepEqual(codec.encode(queues.numbers), expected.numbers);
    assert.deepEqual(codec.encode(fork), expectedEnvelope('queue', 'number', [...numberValues.slice(32), 999999]));
    const pending = workers.map(receive); for (const worker of workers) worker.postMessage('after-growth');
    assert.ok((await Promise.all(pending)).every(reply => reply.ok));
    console.log(JSON.stringify({ ok: true, workers: 2, transports: ['shared', 'copy'], queues: 4,
      freshAndWarmExports: true, retainedAfterGrowthAndReset: true, readOnly: true }));
  } finally { await Promise.all(workers.map(worker => worker.terminate())); }
}
