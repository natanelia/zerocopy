import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const HEAP_START = 65536;
const special = [-0, 0, NaN, Infinity, -Infinity, Number.MIN_VALUE, Number.MAX_VALUE, 1.25];

function expectedEntries(item, inputs) {
  const byPriority = new Map(inputs.map(({ value, priority }) => [priority, value]));
  assert.equal(byPriority.size, inputs.length);
  const view = new DataView(item.arena.memory.buffer), pending = item.root ? [item.root] : [];
  const result = [], seen = new Set();
  while (pending.length) {
    const node = pending.pop(), priority = view.getFloat64(node, true);
    assert.ok(!seen.has(node)); seen.add(node);
    assert.ok(byPriority.has(priority));
    const value = byPriority.get(priority); byPriority.delete(priority);
    if (item.valueType === 'number') assert.ok(Object.is(view.getFloat64(node + 8, true), value));
    if (item.valueType === 'boolean') assert.equal(view.getFloat64(node + 8, true), value ? 1 : 0);
    result.push([value, priority]);
    const left = view.getUint32(node + 16, true), right = view.getUint32(node + 20, true);
    if (right) pending.push(right); if (left) pending.push(left);
  }
  assert.equal(result.length, item.size); assert.equal(byPriority.size, 0);
  return result;
}

if (isMainThread) {
  const entry = pathToFileURL(resolve(process.argv[2] ?? fileURLToPath(new URL('../../dist/shared.js', import.meta.url)))).href;
  const S = await import(entry), Arena = new S.SharedPriorityQueue('number').arena.constructor;
  for (const copy of [false, true]) test(`paused heap entries retain one snapshot through writer growth (${copy ? 'copy' : 'shared'})`,
    { timeout: 20000 }, async () => {
      const owner = new Arena(), dependency = new Arena(), heaps = {}, records = {}, expected = {};
      const cases = [
        ['numbers', 'number', 1057, false], ['booleans', 'boolean', 65, true],
        ['strings', 'string', 65, false], ['objects', 'object', 65, true],
        ['nested', S.list('number'), 33, false], ['empty', 'number', 0, false],
      ];
      for (const [name, type, size, maxHeap] of cases) {
        let item = new S.SharedPriorityQueue(type, { maxHeap }, owner);
        const inputs = [];
        for (let i = 0; i < size; i++) {
          const native = type === 'number' ? special[i % special.length] : type === 'boolean' ? i % 3 === 0
            : type === 'string' ? `record-${i}-界🙂` : type === 'object' ? { id: i, nested: [i, { flag: i % 2 === 0 }] }
              : [i, -0, NaN, -i];
          const value = name === 'nested' ? new S.SharedList('number', 0, 0, 0, dependency).pushMany(native) : native;
          if (name === 'nested') assert.equal(value.arena, dependency);
          const priority = ((i * 37) % size) - (size >>> 1);
          inputs.push({ value: native, priority }); item = item.enqueue(value, priority);
        }
        heaps[name] = item; records[name] = inputs; expected[name] = expectedEntries(item, inputs);
      }
      heaps.fork = heaps.numbers.enqueue(999, -10000);
      records.fork = [...records.numbers, { value: 999, priority: -10000 }];
      expected.fork = expectedEntries(heaps.fork, records.fork);
      const descriptors = Object.fromEntries(Object.entries(heaps).map(([name, item]) => [name, item.toWorkerData()]));
      const originals = [owner, dependency].map(arena => ({ arena, used: arena.used,
        bytes: arena.buf.slice(HEAP_START, arena.used), buffer: arena.memory.buffer }));
      const payload = S.getWorkerData(heaps, { copy });
      assert.deepEqual(new Set(payload.arenas.map(arena => arena.id)), new Set([owner.id, dependency.id]));
      const worker = new Worker(new URL(import.meta.url), { workerData: { entry, payload } });
      try {
        const [paused] = await once(worker, 'message', { signal: AbortSignal.timeout(15000) });
        assert.equal(paused.status, 'paused'); assert.equal(paused.iterators, cases.length + 1);
        for (const { arena, buffer } of originals) {
          // Append through the writer while the worker retains its first view.
          new S.SharedPriorityQueue('string', undefined, arena).enqueue('growth界'.repeat(buffer.byteLength), 0);
          assert.notEqual(arena.memory.buffer, buffer);
        }
        const fresh = heaps.numbers.enqueue(123456, -20000);
        const freshExpected = expectedEntries(fresh, [...records.numbers, { value: 123456, priority: -20000 }]);
        S.resetPriorityQueue(); S.resetSharedList();
        const reply = once(worker, 'message', { signal: AbortSignal.timeout(15000) });
        worker.postMessage({ payload: S.getWorkerData({ fresh }, { copy }) });
        const [done] = await reply;
        assert.deepEqual(done.entries, expected); assert.deepEqual(done.fresh, freshExpected);
        assert.equal(done.zeroSharedAllocation, true); assert.equal(done.readOnly, true);
        for (const { arena, used, bytes } of originals) assert.deepEqual(arena.buf.subarray(HEAP_START, used), bytes);
        assert.deepEqual(Object.fromEntries(Object.entries(heaps).map(([name, item]) => [name, item.toWorkerData()])), descriptors);
      } finally { await worker.terminate(); }
    });
} else {
  const S = await import(workerData.entry), heaps = await S.initWorker(workerData.payload);
  const sources = S.getWorkerData(heaps, { copy: false }).arenas;
  assert.equal(sources.length, 2);
  const originals = sources.map(source => ({ source, bytes: new Uint8Array(source.memory.buffer).slice(HEAP_START, source.used) }));
  function flatten(name, [value, priority]) {
    if (name === 'objects') {
      assert.ok(Object.isFrozen(value)); assert.ok(Object.isFrozen(value.nested)); assert.ok(Object.isFrozen(value.nested[1]));
    }
    if (name === 'nested') {
      assert.ok(Object.isFrozen(value)); assert.throws(() => value.push(0), /read-only/);
      value = value.toArray();
    }
    return [value, priority];
  }
  const pending = Object.fromEntries(Object.entries(heaps).map(([name, item]) => {
    const iterator = item.entries(), first = iterator.next();
    return [name, { iterator, entries: first.done ? [] : [flatten(name, first.value)] }];
  }));
  const resume = once(parentPort, 'message');
  parentPort.postMessage({ status: 'paused', iterators: Object.keys(pending).length });
  const [{ payload }] = await resume;
  // A fresh attachment must not replace any suspended iterator's owner/view.
  const { fresh } = await S.initWorker(payload), freshEntries = [...fresh.entries()];
  let active = true;
  while (active) {
    active = false;
    for (const [name, state] of Object.entries(pending)) {
      const next = state.iterator.next();
      if (!next.done) { state.entries.push(flatten(name, next.value)); active = true; }
    }
  }
  for (const item of [...Object.values(heaps), fresh]) {
    assert.throws(() => item.enqueue(undefined, 0), /read-only/);
    if (item.size) assert.throws(() => item.dequeue(), /read-only/);
  }
  const after = new Map(S.getWorkerData(heaps, { copy: false }).arenas.map(source => [source.id, source]));
  for (const { source, bytes } of originals) {
    const current = after.get(source.id); assert.ok(current); assert.equal(current.used, source.used);
    assert.deepEqual(new Uint8Array(current.memory.buffer, HEAP_START, bytes.length), bytes);
  }
  parentPort.postMessage({ entries: Object.fromEntries(Object.entries(pending).map(([name, state]) => [name, state.entries])),
    fresh: freshEntries, zeroSharedAllocation: true, readOnly: true });
}
