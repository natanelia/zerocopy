import assert from 'node:assert/strict';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const root = isMainThread ? resolve(process.argv[2] ?? '.') : workerData.root;
const S = await import(pathToFileURL(resolve(root, 'dist/shared.js')));
const R = await import(pathToFileURL(resolve(root, 'dist/redux.js')));
const codec = R.createZerocopyCodec();

if (!isMainThread) {
  const snapshots = await S.initWorker(workerData.packet);
  const verify = () => {
    for (const [name, heap] of Object.entries(snapshots)) {
      assert.deepEqual(codec.encode(heap), workerData.expected[name]);
      assert.equal(codec.stringify(heap), JSON.stringify(workerData.expected[name]));
      assert.throws(() => heap.enqueue(heap.peek(), 0), /read-only/);
      assert.throws(() => heap.dequeue(), /read-only/);
    }
  };
  verify(); parentPort.postMessage('ready');
  parentPort.once('message', () => {
    try { for (let i = 0; i < 8; i++) verify(); parentPort.postMessage({ ok: true, names: Object.keys(snapshots) }); }
    catch (error) { parentPort.postMessage({ ok: false, error: String(error.stack ?? error) }); }
    finally { parentPort.close(); }
  });
} else {
  let min = new S.SharedPriorityQueue('number'), max = new S.SharedPriorityQueue('boolean', { maxHeap: true });
  let objects = new S.SharedPriorityQueue('object'), nested = new S.SharedPriorityQueue('SharedList<number>');
  const special = [NaN, -0, 0, Infinity, -Infinity, Number.MIN_VALUE];
  for (let i = 0; i < 1025; i++) {
    const priority = i < 4 ? [-0, 0, -Infinity, Infinity][i] : (i * 73) % 127 - 63;
    min = min.enqueue(i < special.length ? special[i] : i / 4, priority);
    max = max.enqueue(i % 3 === 0, priority);
    if (i < 65) {
      objects = objects.enqueue({ id: i, child: [i / 2, '🙂'] }, priority);
      nested = nested.enqueue(new S.SharedList('number').pushMany([i, -0, NaN]), priority);
    }
  }
  const snapshots = { min, max, objects, nested };
  const expected = Object.fromEntries(Object.entries(snapshots).map(([name, heap]) => [name, codec.encode(heap)]));
  const before = S.getWorkerData(snapshots, { copy: true });
  for (const copy of [false, true]) {
    const packet = S.getWorkerData(snapshots, { copy });
    const worker = new Worker(new URL(import.meta.url), { workerData: { root, packet, expected } });
    await new Promise((done, reject) => {
      let ready = false, result;
      const timeout = setTimeout(() => { void worker.terminate(); reject(new Error('Heap worker timed out')); }, 15000);
      worker.on('error', error => { clearTimeout(timeout); reject(error); });
      worker.on('message', message => {
        if (message === 'ready') {
          ready = true;
          for (const arena of S.getWorkerData(snapshots, { copy: false }).arenas) arena.memory.grow(2);
          assert.equal(min.enqueue(9, -Infinity).size, min.size + 1);
          assert.equal(max.enqueue(false, Infinity).size, max.size + 1);
          worker.postMessage('after-growth');
        } else result = message;
      });
      worker.once('exit', code => {
        clearTimeout(timeout);
        try { assert.equal(code, 0); assert.ok(ready); assert.deepEqual(result, { ok: true, names: Object.keys(snapshots) }); done(); }
        catch (error) { reject(error); }
      });
    });
    for (const [name, heap] of Object.entries(snapshots)) assert.deepEqual(codec.encode(heap), expected[name]);
    const after = S.getWorkerData(snapshots, { copy: true });
    for (let i = 0; i < before.arenas.length; i++) {
      assert.equal(after.arenas[i].id, before.arenas[i].id);
      assert.deepEqual(after.arenas[i].copy.subarray(65536, before.arenas[i].used), before.arenas[i].copy.subarray(65536));
    }
    console.log(`Real Node worker: ${copy ? 'copy' : 'shared'}, numeric/boolean/JSON/nested, retained snapshots after growth: passed`);
  }
}
