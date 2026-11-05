import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ordered = entries => [...entries].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);

if (isMainThread) {
  const entry = pathToFileURL(resolve(process.argv[2] ?? new URL('../../dist/shared.js', import.meta.url).pathname)).href;
  const S = await import(entry);
  for (const copy of [false, true]) test(`bulk map deletion preserves paused ${copy ? 'copy' : 'shared'} readers`, { timeout: 20000 }, async () => {
    S.resetMap();
    const input = Array.from({ length: 4096 }, (_, i) => [`key-${i}`, i + 0.25]);
    const base = new S.SharedMap('number').setMany(input), original = ordered(input);
    const source = S.getWorkerData({ base }, { copy: false }).arenas[0];
    const bytes = new Uint8Array(source.memory.buffer, 65536, source.used - 65536).slice();
    const oldBuffer = source.memory.buffer;
    const worker = new Worker(new URL(import.meta.url), { workerData: { entry, payload: S.getWorkerData({ base }, { copy }) } });
    try {
      const [paused] = await once(worker, 'message', { signal: AbortSignal.timeout(15000) });
      assert.equal(paused.status, 'paused');
      const keys = Array.from({ length: 2048 }, (_, i) => `key-${(i * 73) % 4096}`);
      const next = base.deleteMany(keys), model = new Map(input); for (const key of keys) model.delete(key);
      const fork = next.set('after', -1), forkModel = new Map(model); forkModel.set('after', -1);
      // Force shared growth while the worker retains its old iterator view.
      new S.SharedMap('string').set('grow', 'x'.repeat(oldBuffer.byteLength * 2));
      assert.ok(source.memory.buffer.byteLength > oldBuffer.byteLength);
      const ready = once(worker, 'message', { signal: AbortSignal.timeout(15000) });
      worker.postMessage(S.getWorkerData({ next, fork }, { copy }));
      const [result] = await ready;
      assert.deepEqual(result.original, original);
      assert.deepEqual(result.next, ordered(model)); assert.deepEqual(result.fork, ordered(forkModel));
      assert.equal(result.readOnly, true); assert.equal(result.noReaderAllocation, true);
      assert.deepEqual(new Uint8Array(source.memory.buffer, 65536, bytes.length), bytes);
      assert.deepEqual(ordered(base.entries()), original); assert.deepEqual(ordered(next.entries()), ordered(model));
    } finally { await worker.terminate(); }
  });
} else {
  const S = await import(workerData.entry), { base } = await S.initWorker(workerData.payload);
  const iterator = base.entries(), saved = [iterator.next().value];
  const before = S.getWorkerData({ base }, { copy: false }).arenas[0];
  const message = once(parentPort, 'message'); parentPort.postMessage({ status: 'paused' });
  const [packet] = await message, { next, fork } = await S.initWorker(packet);
  saved.push(...iterator);
  assert.throws(() => next.deleteMany(['key-0']), /read-only/);
  assert.throws(() => base.deleteMany([]), /read-only/);
  const after = S.getWorkerData({ base }, { copy: false }).arenas[0];
  assert.equal(after.used, before.used);
  parentPort.postMessage({ original: ordered(saved), next: ordered(next.entries()), fork: ordered(fork.entries()),
    readOnly: true, noReaderAllocation: true });
}
