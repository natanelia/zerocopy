import assert from 'node:assert/strict';
import test from 'node:test';
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import * as S from '../dist/shared.js';

if (!isMainThread) {
  let readers, first, second, values, firstValue, secondValue, setValue;
  parentPort.on('message', async message => {
    try {
      if (message.type === 'start') {
        readers = await S.initWorker(message.data);
        first = readers.stable.entries(); second = readers.changed.entries(); values = readers.set.values();
        firstValue = first.next().value; secondValue = second.next().value; setValue = values.next().value;
        parentPort.postMessage({ type: 'paused' });
      } else if (message.type === 'finish') {
        const newer = await S.initWorker(message.data);
        assert.throws(() => readers.stable.set('forbidden', 1), /read-only/);
        assert.equal(newer.newer.get('later'), 999);
        parentPort.postMessage({
          type: 'done', stable: [firstValue, ...first], changed: [secondValue, ...second],
          set: [setValue, ...values], again: [...readers.stable.entries()],
        });
      } else throw new Error('Unexpected worker message');
    } catch (error) { parentPort.postMessage({ error: error.stack }); }
  });
} else {
  for (const copy of [false, true]) test(`packed ordered histories in a real worker (copy=${copy})`, { timeout: 20000 }, async () => {
    S.resetOrderedMap();
    let stable = new S.SharedOrderedMap('number'), set = new S.SharedOrderedSet();
    const model = new Map(), setModel = new Set();
    for (let i = 0; i < 8193; i++) { stable = stable.set(`key-${i}`, i); model.set(`key-${i}`, i); }
    for (let i = 0; i < 4097; i++) { const value = i % 2 ? `${i}` : i; set = set.add(value); setModel.add(value); }
    const changed = stable.set('key-4096', -1).delete('key-0').set('key-0', 900);
    const changedModel = new Map(model); changedModel.set('key-4096', -1); changedModel.delete('key-0'); changedModel.set('key-0', 900);
    const data = S.getWorkerData({ stable, changed, set }, { copy });
    assert.ok(data.arenas.every(arena => copy ? arena.copy && !arena.memory : arena.memory && !arena.copy));
    const memories = S.getWorkerData({ stable, set }, { copy: false }).arenas.map(arena => arena.memory);
    const worker = new Worker(new URL(import.meta.url));
    function exchange(message) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => finish(new Error('Ordered worker exchange timed out')), 10000);
        function finish(error, value) {
          clearTimeout(timer); worker.off('message', receive); worker.off('error', failed); worker.off('exit', exited);
          if (error) reject(error); else resolve(value);
        }
        function receive(value) { finish(value.error ? new Error(value.error) : undefined, value); }
        function failed(error) { finish(error); }
        function exited(code) { finish(new Error(`Worker exited before responding (${code})`)); }
        worker.once('message', receive); worker.once('error', failed); worker.once('exit', exited);
        worker.postMessage(message);
      });
    }
    try {
      assert.equal((await exchange({ type: 'start', data })).type, 'paused');
      for (const memory of memories) {
        const before = memory.buffer.byteLength; memory.grow(2);
        assert.ok(memory.buffer.byteLength > before);
      }
      const newer = changed.set('later', 999);
      S.resetOrderedMap();
      const result = await exchange({ type: 'finish', data: S.getWorkerData({ newer }, { copy }) });
      assert.equal(result.type, 'done');
      assert.deepEqual(result.stable, [...model]); assert.deepEqual(result.again, [...model]);
      assert.deepEqual(result.changed, [...changedModel]); assert.deepEqual(result.set, [...setModel]);
      assert.deepEqual([...stable.entries()], [...model]);
      assert.equal(new S.SharedOrderedMap('number').size, 0);
    } finally { await worker.terminate(); }
  });
}
