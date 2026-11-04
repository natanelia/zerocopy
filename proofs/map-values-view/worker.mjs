import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

if (isMainThread) {
  const entry = pathToFileURL(resolve(process.argv[2] ?? new URL('../../dist/shared.js', import.meta.url).pathname)).href;
  const S = await import(entry);
  for (const copy of [false, true]) test(`paused primitive map values survive writer growth (${copy ? 'copy' : 'shared'})`, { timeout: 15000 }, async () => {
    S.resetMap();
    const numbers = new S.SharedMap('number').setMany(Array.from({ length: 257 }, (_, i) => [`key-${i}`, i + 0.25]));
    const booleans = new S.SharedMap('boolean').setMany(Array.from({ length: 257 }, (_, i) => [`key-${i}`, i % 3 === 0]));
    const fork = numbers.set('key-7', -7).delete('key-9');
    const maps = { numbers, booleans, fork };
    const expected = Object.fromEntries(Object.entries(maps).map(([name, map]) => [name, [...map.entries()].map(([, value]) => value)]));
    const source = S.getWorkerData(maps, { copy: false }).arenas[0];
    const bytes = new Uint8Array(source.memory.buffer).slice(65536, source.used), beforeBuffer = source.memory.buffer;
    const worker = new Worker(new URL(import.meta.url), { workerData: { entry, payload: S.getWorkerData(maps, { copy }) } });
    try {
      const [first] = await once(worker, 'message', { signal: AbortSignal.timeout(10000) }); assert.equal(first.status, 'paused');
      new S.SharedMap('string').set('grow', 'x'.repeat(beforeBuffer.byteLength * 2));
      numbers.set('key-7', 1000); booleans.set('key-0', false);
      assert.notEqual(source.memory.buffer, beforeBuffer);
      const ready = once(worker, 'message', { signal: AbortSignal.timeout(10000) }); worker.postMessage('resume');
      const [done] = await ready;
      assert.deepEqual(done.values, expected); assert.equal(done.zeroSharedAllocation, true);
      assert.deepEqual(new Uint8Array(source.memory.buffer, 65536, bytes.length), bytes);
    } finally { await worker.terminate(); }
  });
} else {
  const S = await import(workerData.entry), maps = await S.initWorker(workerData.payload);
  const source = S.getWorkerData(maps, { copy: false }).arenas[0];
  const bytes = new Uint8Array(source.memory.buffer).slice(65536, source.used);
  const pending = Object.fromEntries(Object.entries(maps).map(([name, map]) => {
    const iterator = map.values(); return [name, { iterator, values: [iterator.next().value] }];
  }));
  const resumed = once(parentPort, 'message'); parentPort.postMessage({ status: 'paused' });
  await resumed;
  let active = true;
  while (active) {
    active = false;
    for (const { iterator, values } of Object.values(pending)) {
      const next = iterator.next(); if (!next.done) { values.push(next.value); active = true; }
    }
  }
  for (const map of Object.values(maps)) assert.throws(() => map.set('forbidden', 1), /read-only/);
  const after = S.getWorkerData(maps, { copy: false }).arenas[0];
  assert.equal(after.used, source.used);
  assert.deepEqual(new Uint8Array(after.memory.buffer, 65536, bytes.length), bytes);
  parentPort.postMessage({ values: Object.fromEntries(Object.entries(pending).map(([name, entry]) => [name, entry.values])), zeroSharedAllocation: true });
}
