import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

if (isMainThread) {
  const entry = pathToFileURL(resolve(process.argv[2] ?? new URL('../../dist/shared.js', import.meta.url).pathname)).href;
  const S = await import(entry);
  for (const copy of [false, true]) test(`paused primitive values and JSON views survive writer growth (${copy ? 'copy' : 'shared'})`, { timeout: 15000 }, async () => {
    S.resetMap();
    const numbers = new S.SharedMap('number').setMany(Array.from({ length: 257 }, (_, i) => [`key-${i}`, i + 0.25]));
    const booleans = new S.SharedMap('boolean').setMany(Array.from({ length: 257 }, (_, i) => [`key-${i}`, i % 3 === 0]));
    const fork = numbers.set('key-7', -7).delete('key-9');
    const keys = ['costarring', 'liquid', 'full-collision-0-U<EY?', 'full-collision-1-kJ5Nk', '道路', 'é', 'e\u0301', '🚗', '', ...Array.from({ length: 257 }, (_, i) => 'object-' + i)];
    const objects = new S.SharedMap('object').setMany(keys.map((key, i) => [key, { id: i, nested: { text: key }, array: [i, null] }]));
    const objectFork = objects.set(keys[0], { id: 999 }).delete(keys[1]).set('new', { id: 1000 });
    const maps = { numbers, booleans, fork, objects, objectFork };
    const expected = Object.fromEntries(Object.entries(maps).map(([name, map]) => [name, [...map.entries()].map(([, value]) => value)]));
    const source = S.getWorkerData(maps, { copy: false }).arenas[0];
    const bytes = new Uint8Array(source.memory.buffer).slice(65536, source.used), beforeBuffer = source.memory.buffer;
    const worker = new Worker(new URL(import.meta.url), { workerData: { entry, payload: S.getWorkerData(maps, { copy }) } });
    try {
      const [first] = await once(worker, 'message', { signal: AbortSignal.timeout(10000) }); assert.equal(first.status, 'paused');
      new S.SharedMap('string').set('grow', 'x'.repeat(beforeBuffer.byteLength * 2));
      numbers.set('key-7', 1000); booleans.set('key-0', false); objects.set(keys[0], { id: -1 });
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
    const json = map.valueType === 'object';
    const iterator = json ? map.valuesView() : map.values();
    const first = iterator.next().value;
    if (json) {
      const independent = map.valuesView().next().value;
      assert.notEqual(first, independent);
      assert.deepEqual(first.toObject(), independent.toObject());
    }
    return [name, { iterator, values: [json ? first.toObject() : first], held: json ? first : undefined }];
  }));
  const resumed = once(parentPort, 'message'); parentPort.postMessage({ status: 'paused' });
  await resumed;
  let active = true;
  while (active) {
    active = false;
    for (const { iterator, values, held } of Object.values(pending)) {
      const next = iterator.next(); if (!next.done) { values.push(held ? next.value.toObject() : next.value); active = true; }
    }
  }
  for (const { held, values } of Object.values(pending)) if (held) assert.deepEqual(held.toObject(), values[0]);
  for (const map of Object.values(maps)) assert.throws(() => map.set('forbidden', 1), /read-only/);
  const after = S.getWorkerData(maps, { copy: false }).arenas[0];
  assert.equal(after.used, source.used);
  assert.deepEqual(new Uint8Array(after.memory.buffer, 65536, bytes.length), bytes);
  parentPort.postMessage({ values: Object.fromEntries(Object.entries(pending).map(([name, entry]) => [name, entry.values])), zeroSharedAllocation: true });
}
