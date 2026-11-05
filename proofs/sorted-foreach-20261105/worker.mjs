import assert from 'node:assert/strict';
import { once } from 'node:events';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import * as S from '../../dist/shared.js';

const collect = map => {
  const result = [];
  map.forEach((value, key) => result.push([key, value]));
  return result;
};
const naturalOrder = entries => entries.sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)));

if (!isMainThread) {
  const control = new Int32Array(workerData.control);
  let old;
  parentPort.on('message', async message => {
    try {
      if (message.type === 'initial') {
        old = (await S.initWorker(message.payload)).map;
        const visited = [];
        old.forEach((value, key) => {
          if (!visited.length) {
            parentPort.postMessage({ type: 'paused' });
            assert.notEqual(Atomics.wait(control, 0, 0, 20000), 'timed-out');
          }
          visited.push([key, value]);
        });
        assert.deepEqual(visited, workerData.expected);
        assert.throws(() => old.set('forbidden', {}), /read-only/);
        parentPort.postMessage({ type: 'scanned' });
      } else if (message.type === 'updated') {
        const next = (await S.initWorker(message.payload)).map;
        assert.deepEqual(collect(next), message.expected);
        assert.deepEqual(collect(old), workerData.expected);
        parentPort.postMessage({ type: 'complete' });
      }
    } catch (error) { parentPort.postMessage({ error: error.stack }); }
  });
} else {
  for (const copy of [false, true]) {
    S.resetSortedMap();
    let map = new S.SharedSortedMap('object');
    const native = new Map();
    for (let i = 0; i < 1024; i++) {
      const key = `key/${String((i * 17) % 1024).padStart(4, '0')}`;
      const value = { i, text: `🙂${i}`, child: [null, false, { id: i * 3 }] };
      map = map.set(key, value); native.set(key, value);
    }
    const expected = naturalOrder([...native]);
    const controlBuffer = new SharedArrayBuffer(4), control = new Int32Array(controlBuffer);
    const worker = new Worker(new URL(import.meta.url), { workerData: { expected, control: controlBuffer } });
    const timer = setTimeout(() => { console.error('Sorted forEach worker proof timed out'); process.exit(1); }, 30000);
    const receive = async type => {
      const [result] = await once(worker, 'message');
      if (result.error) throw new Error(result.error);
      assert.equal(result.type, type);
    };
    try {
      const payload = S.getWorkerData({ map }, { copy });
      const memory = S.getWorkerData({ map }).arenas[0].memory;
      assert.ok(memory);
      const beforeBuffer = memory.buffer;
      const ready = receive('paused'); worker.postMessage({ type: 'initial', payload }); await ready;
      const growth = { text: 'x'.repeat(beforeBuffer.byteLength * 2) };
      const next = map.set('growth', growth).set('key/0001', { i: -1 }).delete('key/0002');
      assert.notEqual(memory.buffer, beforeBuffer);
      native.set('growth', growth); native.set('key/0001', { i: -1 }); native.delete('key/0002');
      const scanned = receive('scanned'); Atomics.store(control, 0, 1); Atomics.notify(control, 0); await scanned;
      const completed = receive('complete');
      worker.postMessage({ type: 'updated', payload: S.getWorkerData({ map: next }, { copy }), expected: naturalOrder([...native]) });
      await completed;
      assert.deepEqual(collect(map), expected);
      console.log(`${copy ? 'copy' : 'shared'} sorted forEach worker: preserved old snapshot across owner edits and growth`);
    } finally { clearTimeout(timer); Atomics.store(control, 0, 1); Atomics.notify(control, 0); await worker.terminate(); }
  }
}
