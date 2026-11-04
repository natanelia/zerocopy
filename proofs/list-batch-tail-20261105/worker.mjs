import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

const value = index => index + .25;
const values = (start, count) => Array.from({ length: count }, (_, i) => value(start + i));
const deadline = () => ({ signal: AbortSignal.timeout(15000) });

if (isMainThread) {
  const S = await import('../../dist/shared.js');
  const Arena = new S.SharedList('number').arena.constructor;
  for (const copy of [false, true]) test(`small bulk appends preserve active readers (${copy ? 'copy' : 'shared'})`, { timeout: 20000 }, async t => {
    const arena = new Arena(), old = new S.SharedList('number', 0, 0, 0, arena).pushMany(values(0, 5));
    const originalEnd = arena.used, originalBuffer = arena.memory.buffer;
    const originalBytes = new Uint8Array(originalBuffer).slice(65536, originalEnd);
    const control = new Int32Array(new SharedArrayBuffer(8));
    const worker = new Worker(new URL(import.meta.url), { workerData: { payload: S.getWorkerData({ old }, { copy }), control: control.buffer } });
    try {
      const [ready] = await once(worker, 'message', deadline()); assert.equal(ready.status, 'ready');
      const concurrent = once(worker, 'message', deadline()); worker.postMessage('read');
      assert.notEqual(Atomics.wait(control, 0, 0, 10000), 'timed-out');
      let next = old.pushMany(values(5, 2));
      assert.equal(arena.used - originalEnd, 16, 'Only the two new values need shared storage');
      for (let start = 7; start < 32775; start += 8) next = next.pushMany(values(start, 8));
      assert.notEqual(arena.memory.buffer, originalBuffer, 'Repeated small batches must really grow memory');
      // A boundary-crossing append can place new tree nodes after the tail.
      // One more in-tail append restores the frontier; the following one reuses it.
      next = next.pushMany(values(next.size, 2));
      const grownEnd = arena.used;
      next = next.pushMany(values(next.size, 2));
      assert.equal(arena.used - grownEnd, 16);
      Atomics.store(control, 1, 1);
      const [read] = await concurrent;
      assert.equal(read.status, 'read-complete'); assert.ok(read.reads >= 10000);
      assert.deepEqual(old.toArray(), values(0, 5));
      assert.deepEqual(new Uint8Array(arena.memory.buffer, 65536, originalBytes.length), originalBytes);

      S.resetSharedList();
      const freshBase = new S.SharedList('number').pushMany(values(100000, 5));
      const freshArena = freshBase.arena, freshEnd = freshArena.used;
      const fresh = freshBase.pushMany(values(100005, 2));
      assert.notEqual(freshArena.id, arena.id);
      assert.equal(freshArena.used - freshEnd, 16);
      const finished = once(worker, 'message', deadline());
      worker.postMessage({ payload: S.getWorkerData({ grown: next, freshBase, fresh }, { copy }) });
      const [result] = await finished;
      assert.deepEqual(result, { status: 'complete', grownSize: 32779, freshSize: 7, readOnly: true, noReaderAllocation: true });
      t.diagnostic(JSON.stringify({ copy, concurrentReads: read.reads, grownSize: next.size,
        initialBackingBytes: originalBuffer.byteLength, grownBackingBytes: arena.memory.buffer.byteLength,
        tailFivePlusTwoBytes: 16, previousCopyBytes: 56, savedBytes: 40 }));
    } finally { Atomics.store(control, 1, 1); await worker.terminate(); }
  });
} else {
  const S = await import('../../dist/shared.js'), { old } = await S.initWorker(workerData.payload);
  const arena = old.arena, oldEnd = arena.used;
  const oldBytes = new Uint8Array(arena.memory.buffer).slice(65536, oldEnd);
  const iterator = old.values(); assert.equal(iterator.next().value, value(0));
  const start = once(parentPort, 'message', deadline()); parentPort.postMessage({ status: 'ready' });
  const [command] = await start; assert.equal(command, 'read');
  const control = new Int32Array(workerData.control);
  Atomics.store(control, 0, 1); Atomics.notify(control, 0);
  let reads = 0;
  do {
    assert.equal(old.get(reads % old.size), value(reads % old.size));
    if ((reads & 31) === 0) assert.deepEqual(old.toArray(), values(0, 5));
    reads++;
  } while (reads < 10000 || Atomics.load(control, 1) === 0);
  assert.deepEqual([...iterator], values(1, 4));
  assert.equal(arena.used, oldEnd);
  assert.deepEqual(new Uint8Array(arena.memory.buffer, 65536, oldBytes.length), oldBytes);
  const attachment = once(parentPort, 'message', deadline()); parentPort.postMessage({ status: 'read-complete', reads });
  const [message] = await attachment;
  const { grown, freshBase, fresh } = await S.initWorker(message.payload);
  const sources = [grown.arena, fresh.arena], ends = sources.map(source => source.used);
  const bytes = sources.map((source, i) => new Uint8Array(source.memory.buffer).slice(65536, ends[i]));
  assert.deepEqual(grown.toArray(), values(0, 32779));
  assert.deepEqual(freshBase.toArray(), values(100000, 5));
  assert.deepEqual(fresh.toArray(), values(100000, 7));
  assert.deepEqual(old.toArray(), values(0, 5));
  for (const list of [old, grown, freshBase, fresh]) {
    assert.throws(() => list.pushMany([9]), /read-only/);
    assert.equal(list.pushMany([]), list);
  }
  sources.forEach((source, i) => {
    assert.equal(source.used, ends[i]);
    assert.deepEqual(new Uint8Array(source.memory.buffer, 65536, bytes[i].length), bytes[i]);
  });
  parentPort.postMessage({ status: 'complete', grownSize: grown.size, freshSize: fresh.size, readOnly: true, noReaderAllocation: true });
}
