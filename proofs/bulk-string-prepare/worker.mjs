import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

const order = entries => [...entries].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
if (isMainThread) {
  const entry = new URL('../../dist/shared.js', import.meta.url).href, S = await import(entry);
  const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { ignoreBOM: true });
  const normalized = value => decoder.decode(encoder.encode(value));
  const expected = entries => order(new Map(entries.map(([key, value]) => [normalized(key), normalized(value)])));
  for (const copy of [false, true]) test(`bulk Unicode snapshots survive growth and reset in a worker (${copy ? 'copy' : 'shared'})`, { timeout: 15000 }, async () => {
    S.resetMap();
    const input = Array.from({ length: 257 }, (_, i) => [`key-${i}`, ['界🙂', '\ufeffsame', '', '\ud800'][i % 4]]);
    const edits = [['key-3', 'fork🙂'], ['fork', 'fork🙂']];
    const old = new S.SharedMap('string').setMany(input), fork = old.setMany(edits);
    const source = S.getWorkerData({ old, fork }, { copy: false }).arenas[0];
    const bytes = new Uint8Array(source.memory.buffer).slice(65536, source.used), buffer = source.memory.buffer;
    const worker = new Worker(new URL(import.meta.url), { workerData: { entry, payload: S.getWorkerData({ old, fork }, { copy }) } });
    try {
      const [ready] = await once(worker, 'message', { signal: AbortSignal.timeout(10000) }); assert.equal(ready, 'paused');
      const nextInput = Array.from({ length: 513 }, (_, i) => [`key-${i}`, '界🙂'.repeat(512)]);
      const next = old.setMany(nextInput), payload = S.getWorkerData({ next }, { copy });
      assert.notEqual(source.memory.buffer, buffer);
      S.resetMap(); new S.SharedMap('string').setMany([['reset', 'replacement🙂']]);
      const reply = once(worker, 'message', { signal: AbortSignal.timeout(10000) }); worker.postMessage(payload);
      const [actual] = await reply;
      assert.deepEqual(actual.old, expected(input));
      assert.deepEqual(actual.fork, expected([...input, ...edits]));
      assert.deepEqual(actual.next, expected(nextInput));
      assert.equal(actual.zeroSharedAllocation, true);
      assert.deepEqual(new Uint8Array(source.memory.buffer, 65536, bytes.length), bytes);
    } finally { await worker.terminate(); }
  });
} else {
  const S = await import(workerData.entry), maps = await S.initWorker(workerData.payload);
  const iterator = maps.old.entries(), first = iterator.next().value;
  const source = S.getWorkerData(maps, { copy: false }).arenas[0];
  const resumed = once(parentPort, 'message'); parentPort.postMessage('paused');
  const [payload] = await resumed, newer = await S.initWorker(payload);
  const old = order([first, ...iterator]), fork = order(maps.fork.entries()), next = order(newer.next.entries());
  for (const map of [maps.old, maps.fork, newer.next]) assert.throws(() => map.setMany([['forbidden', '界']]), /read-only/);
  assert.equal(S.getWorkerData(maps, { copy: false }).arenas[0].used, source.used);
  parentPort.postMessage({ old, fork, next, zeroSharedAllocation: true });
}
