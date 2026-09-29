import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { SharedList, SharedStack, getWorkerData, initWorker, resetSharedList, json, list } from '../dist/shared.js';

if (!isMainThread) {
  try {
    const state = await initWorker(workerData);
    let checksum = 0;
    for (let i = 0; i < state.a.size; i++) {
      assert.equal(state.a.get(i), i);
      assert.equal(state.b.get(i), -i);
      assert.equal(state.message.get(i), `event ${i % 7}`);
      checksum += state.a.get(i);
    }
    assert.throws(() => state.message.push('event 0'), /read-only/);
    parentPort.postMessage({ checksum });
  } catch (error) { throw error; }
} else {
  const normalize = value => new TextDecoder('utf-8', { ignoreBOM: true }).decode(new TextEncoder().encode(value));

  test('interleaved columns, both directions, random access, and vector boundaries', async () => {
    for (const size of [0, 1, 31, 32, 33, 1023, 1024, 1025, 32767, 32768, 32769, 100000]) {
      resetSharedList();
      const a = new SharedList('number').pushMany(Array.from({ length: size }, (_, i) => i));
      const b = new SharedList('number').pushMany(Array.from({ length: size }, (_, i) => -i));
      for (const copy of [false, true]) {
        const attached = await initWorker(getWorkerData({ a, b }, { copy }));
        for (const step of [1, -1]) for (let i = step === 1 ? 0 : size - 1; i >= 0 && i < size; i += step) {
          assert.equal(attached.a.get(i), i); assert.equal(attached.b.get(i), -i);
        }
        let seed = 17;
        for (let j = 0; size && j < 1000; j++) {
          seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
          const i = seed % size; assert.equal(attached.a.get(i), i); assert.equal(attached.b.get(i), -i);
        }
        for (const index of [-1, size, 1.5, NaN, Infinity, '0', 2 ** 32]) assert.equal(attached.a.get(index), undefined);
      }
    }
  });

  test('frozen snapshots retain their own cursor through set, pop, pushMany, growth, and reset', async () => {
    resetSharedList();
    const old = new SharedList('number').pushMany(Array.from({ length: 1057 }, (_, i) => i));
    const attached = (await initWorker(getWorkerData({ old }, { copy: false }))).old;
    const versions = [old, old.set(31, 900), old.set(1024, 800), old.pop(), old.pushMany([1057, 1058])];
    for (const version of versions) assert.ok(Object.isFrozen(version));
    attached.get(0); attached.get(1056);
    const grown = old.pushMany(Array.from({ length: 100000 }, (_, i) => i + 1057));
    resetSharedList(); new SharedList('number').pushMany([7, 8, 9]);
    for (let round = 0; round < 4; round++) for (const [v, index, expected] of [
      [old, 31, 31], [versions[1], 31, 900], [old, 1024, 1024], [versions[2], 1024, 800],
      [versions[3], 1056, undefined], [versions[3], 1055, 1055], [versions[4], 1058, 1058],
      [grown, 100000, 100000], [attached, 1056, 1056], [attached, 0, 0],
    ]) assert.equal(v.get(index), expected);
  });

  test('string interning preserves UTF-8 normalization and old roots; JSON values remain distinct', async () => {
    resetSharedList();
    const inputs = ['', '\u0000', '\ufeffBOM', 'ASCII', 'café', 'e\u0301', '😀', '\ud800', '\udfff', 'x\ud800y', 'x\ufffdy', '<script>'];
    const expected = Array.from({ length: 1057 }, (_, i) => normalize(inputs[i % inputs.length]));
    const original = new SharedList('string').pushMany(Array.from({ length: expected.length }, (_, i) => inputs[i % inputs.length]));
    const next = original.set(31, 'changed').push('ASCII');
    for (const copy of [false, true]) {
      const restored = await initWorker(getWorkerData({ original, next }, { copy }));
      assert.deepEqual(restored.original.toArray(), expected);
      for (let i = expected.length - 1; i >= 0; i--) assert.equal(restored.original.get(i), expected[i]);
      assert.equal(restored.next.get(31), 'changed'); assert.equal(restored.next.get(1057), 'ASCII');
      assert.throws(() => restored.original.push('ASCII'), /read-only/);
      assert.throws(() => restored.original.pushMany(['ASCII']), /read-only/);
    }
    const obj = { value: 1 }, before = new SharedList(json()).push(obj);
    obj.value = 2;
    const after = before.push(obj);
    assert.equal(after.get(0).value, 1); assert.equal(after.get(1).value, 2);
    assert.ok(Object.isFrozen(after.get(0)));
    assert.throws(() => original.push(17), /string/);
    assert.throws(() => original.pushMany(['ASCII', {}]), /string/);
    const nested = new SharedList(list('number')).push(new SharedList('number').push(7));
    assert.equal((await initWorker(getWorkerData({ nested }, { copy: false }))).nested.get(0).get(0), 7);
  });

  test('repeated strings reduce actual shared allocation; cache limits do not change values', () => {
    resetSharedList();
    const repeated = new SharedList('string').pushMany(Array(10000).fill('repeated payload'));
    const bytes = getWorkerData({ repeated }, { copy: true }).arenas[0].used;
    // Includes the 64 KiB arena header, all 10k pointer cells, and vector nodes.
    assert.ok(bytes < 180000, `Repeated data used ${bytes} bytes`);
    const diverse = Array.from({ length: 6000 }, (_, i) => `${i}:${'x'.repeat(i % 100)}`);
    const big = 'z'.repeat(131073);
    const state = repeated.pushMany(diverse).push(big).push(big);
    for (let i = 0; i < diverse.length; i++) assert.equal(state.get(10000 + i), diverse[i]);
    assert.equal(state.get(state.size - 1), big); assert.equal(state.get(0), 'repeated payload');
  });

  test('special numeric values and booleans use the same snapshot reads', async () => {
    const data = [NaN, -0, 0, Infinity, -Infinity, Number.MIN_VALUE, Number.MAX_VALUE];
    const numbers = new SharedList('number').pushMany(Array.from({ length: 65 }, (_, i) => data[i % data.length]));
    const flags = new SharedList('boolean').pushMany(Array.from({ length: 65 }, (_, i) => i % 2 === 0));
    const restored = await initWorker(getWorkerData({ numbers, flags }, { copy: false }));
    for (let i = 0; i < 65; i++) { assert.ok(Object.is(restored.numbers.get(i), data[i % data.length])); assert.equal(restored.flags.get(i), i % 2 === 0); }
    // String interning is arena-local and also safe for other vector collections.
    const stack = new SharedStack('string').push('same').push('same');
    assert.equal(stack.peek(), 'same');
  });

  test('real workers attach without changing output or writer ownership', async () => {
    resetSharedList();
    const state = {
      a: new SharedList('number').pushMany(Array.from({ length: 10000 }, (_, i) => i)),
      b: new SharedList('number').pushMany(Array.from({ length: 10000 }, (_, i) => -i)),
      message: new SharedList('string').pushMany(Array.from({ length: 10000 }, (_, i) => `event ${i % 7}`)),
    };
    await Promise.all([0, 1].map(() => new Promise((resolve, reject) => {
      const worker = new Worker(new URL(import.meta.url), { workerData: getWorkerData(state, { copy: false }) });
      worker.once('message', value => { try { assert.equal(value.checksum, 49995000); resolve(); } catch (e) { reject(e); } finally { worker.terminate(); } });
      worker.once('error', reject);
    })));
  });
}
