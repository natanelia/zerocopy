import assert from 'node:assert/strict';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import test from 'node:test';

const entry = process.env.MEMORY_PROOF_ENTRY ?? new URL('../dist/shared.js', import.meta.url).href;

if (!isMainThread) {
  // Observe actual memory creation in fresh realms. No fake collection engine.
  const allocations = [];
  const Memory = WebAssembly.Memory;
  WebAssembly.Memory = new Proxy(Memory, {
    construct(target, args) {
      allocations.push({ ...args[0] });
      if (args[0].maximum > 4096) throw new RangeError('Out of memory: reservation exceeds the test budget');
      return Reflect.construct(target, args);
    },
  });
  try {
    const api = await import(workerData.entry);
    assert.equal(allocations.length, 0, 'Importing collection factories must not allocate default writers');
    if (workerData.payload) {
      const snapshot = await api.initWorker(workerData.payload);
      assert.equal(snapshot.values.get(0), 42);
      assert.throws(() => snapshot.values.push(1), /read-only/);
      assert.equal(allocations.length, 0, 'Attaching shared memory must not allocate another memory');
      for (let i = 0; i < 10; i++) await api.initWorker(workerData.payload);
      assert.equal(allocations.length, 0, 'Repeated attachment must reuse the supplied memory');
    } else {
      await import(new URL('./worker.js', workerData.entry));
      await import(new URL('./state.js', workerData.entry));
      assert.equal(allocations.length, 0, 'Worker/state entry imports must not allocate writers');
      const original = new api.SharedList('number').push(42);
      const second = new api.SharedList('string').push('example');
      assert.equal(allocations.length, 1, 'Only the used collection type gets a default arena');
      assert.deepEqual(allocations[0], { initial: 2, maximum: 4096, shared: true });
      assert.equal(second.get(0), 'example');
      const shared = api.getWorkerData({ values: original }, { copy: false });
      const copy = api.getWorkerData({ values: original }, { copy: true });
      const restored = await api.initWorker(copy);
      assert.equal(restored.values.get(0), 42);
      assert.equal(allocations.length, 2);
      assert.equal(allocations[1].maximum, allocations[1].initial, 'A read-only copy needs no unused growth reservation');
      let updated = original;
      for (let i = 0; i < 20000; i++) updated = updated.push(i);
      assert.ok(shared.arenas[0].memory.buffer.byteLength > 2 * 65536, 'The memory still grows');
      assert.equal(original.size, 1); assert.equal(original.get(0), 42);
      assert.equal(updated.get(20000), 19999);
      const attached = await api.initWorker(api.getWorkerData({ values: updated }, { copy: false }));
      assert.equal(attached.values.get(20000), 19999);
      assert.equal(allocations.length, 2, 'Growth and attachment must not create a replacement memory');
      for (const value of [undefined, NaN, Infinity, -1, 0, 65536, 131073, 0x80000000]) {
        assert.throws(() => api.configureMemory({ maximumBytes: value }), RangeError);
      }
      api.configureMemory({ maximumBytes: 64 * 1024 * 1024 });
      const map = new api.SharedMap('number').set('a', 7);
      assert.equal(map.get('a'), 7);
      assert.equal(allocations[2].maximum, 1024);
      new api.SharedList('number');
      assert.equal(allocations.length, 3, 'Configuration affects future arenas, not existing defaults');
      api.resetSharedList();
      assert.equal(allocations[3].maximum, 1024);
      assert.equal(original.get(0), 42, 'Reset keeps existing snapshots valid');
    }
    parentPort.postMessage({ ok: true, allocations });
  } catch (error) { parentPort.postMessage({ error: error.stack }); }
} else {
  async function inFreshWorker(data = {}) {
    const worker = new Worker(new URL(import.meta.url), { workerData: { entry, ...data } });
    try {
      return await new Promise((resolve, reject) => {
        worker.once('message', result => result.error ? reject(new Error(result.error)) : resolve(result));
        worker.once('error', reject);
        worker.once('exit', code => reject(new Error(`Worker exited before result (${code})`)));
      });
    } finally { await worker.terminate(); }
  }
  test('lazy imports and bounded arenas work under a 256 MiB reservation budget', { timeout: 30000 }, async () => {
    const result = await inFreshWorker();
    assert.equal(result.ok, true);
  });
  test('fresh read-only workers allocate no default memories', { timeout: 30000 }, async () => {
    const api = await import(entry);
    const values = new api.SharedList('number').push(42);
    const payload = api.getWorkerData({ values }, { copy: false });
    const results = await Promise.all(Array.from({ length: 4 }, () => inFreshWorker({ payload })));
    for (const result of results) assert.deepEqual(result.allocations, []);
  });
}
