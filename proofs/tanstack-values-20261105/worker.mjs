import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { makeRows, oracle } from './fixtures.mjs';

const root = resolve(process.env.TANSTACK_VALUES_BUILD ?? fileURLToPath(new URL('../../', import.meta.url)));
const api = await import(pathToFileURL(join(root, 'dist/shared.js')).href);
const { SharedCollection } = await import(pathToFileURL(join(root, 'dist/tanstack-db-collection.js')).href);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

if (!isMainThread) {
  const { map } = await api.initWorker(workerData.payload), collection = new SharedCollection('rows', map), arena = map.arena;
  const used = arena.used;
  const inspect = () => {
    // Writer scratch can change between phases. A read must not change any byte.
    const beforeHash = hash(new Uint8Array(arena.memory.buffer, 0, used));
    assert.deepEqual(collection.toArray(), workerData.expected);
    assert.deepEqual([...collection.entries()], workerData.keys.map((key, i) => [key, workerData.expected[i]]));
    for (const value of workerData.expected) {
      assert.deepEqual(collection.get(value.id), value);
      const actual = collection.get(value.id);
      assert.equal(Object.isFrozen(actual), true);
      assert.equal(Object.isFrozen(actual.details.coordinates[0]), true);
    }
    assert.throws(() => collection.insert({ id: 'forbidden' }), /read-only/);
    assert.equal(arena.used, used); assert.equal(hash(new Uint8Array(arena.memory.buffer, 0, used)), beforeHash);
  };
  inspect(); parentPort.postMessage({ ready: true, rows: collection.size });
  parentPort.on('message', () => {
    try { inspect(); parentPort.postMessage({ ok: true, rows: collection.size }); }
    catch (error) { parentPort.postMessage({ error: error.stack }); }
  });
} else {
  const Arena = new api.SharedMap('object').arena.constructor, arena = new Arena();
  const rows = makeRows({ size: 257, unicode: true, nested: true });
  const map = new api.SharedMap('object', 0, 0, arena).setMany(rows.map(value => [value.id, value]));
  const keys = [...map.keys()], expected = oracle(rows, keys), oldCapacity = arena.memory.buffer.byteLength;
  function receive(worker) {
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); worker.off('message', message); worker.off('error', error); worker.off('exit', exit); };
      const message = value => { cleanup(); value.error ? reject(new Error(value.error)) : resolve(value); };
      const error = failure => { cleanup(); reject(failure); };
      const exit = code => { cleanup(); reject(new Error(`Worker exited before replying: ${code}`)); };
      const timer = setTimeout(() => { cleanup(); reject(new Error('Worker response timed out')); }, 30000);
      worker.once('message', message); worker.once('error', error); worker.once('exit', exit);
    });
  }
  const workers = [false, true].map(copy => new Worker(new URL(import.meta.url), {
    workerData: { payload: api.getWorkerData({ map }, { copy }), keys, expected }, env: { ...process.env, TANSTACK_VALUES_BUILD: root },
  }));
  try {
    const ready = await Promise.all(workers.map(receive));
    assert.ok(ready.every(value => value.ready && value.rows === rows.length));
    const fork = map.set(rows[0].id, { ...rows[0], rank: -1 }).delete(rows[1].id);
    new api.SharedMap('object', 0, 0, arena).setMany(Array.from({ length: 4096 }, (_, rank) => [`grow-${rank}`, { id: `grow-${rank}`, payload: 'x'.repeat(512) }]));
    assert.ok(arena.memory.buffer.byteLength > oldCapacity);
    assert.equal(new SharedCollection('fork', fork).get(rows[0].id).rank, -1);
    assert.deepEqual(new SharedCollection('original', map).toArray(), expected);
    const pending = workers.map(receive); for (const worker of workers) worker.postMessage('inspect-after-growth');
    const replies = await Promise.all(pending); assert.ok(replies.every(value => value.ok));
    console.log(JSON.stringify({ ok: true, actualWorkers: 2, transports: ['shared', 'copy'], rows: rows.length, retainedAfterGrowth: true, readOnly: true }));
  } finally { await Promise.all(workers.map(worker => worker.terminate())); }
}
