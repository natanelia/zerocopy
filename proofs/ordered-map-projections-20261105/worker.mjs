import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import * as S from '../../dist/shared.js';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function withoutCalls(owner, method, action) {
  const original = owner[method]; let calls = 0;
  owner[method] = function (...args) { calls++; return original.apply(this, args); };
  try {
    const result = action(); assert.equal(calls, 0, `Unexpected ${method} while projecting the other field`);
    return result;
  } finally { owner[method] = original; }
}

if (!isMainThread) {
  const { objects, numbers } = await S.initWorker(workerData);
  const keys = objects.keys(), values = numbers.values();
  const firstKey = withoutCalls(JSON, 'parse', () => keys.next().value);
  const firstValue = withoutCalls(TextDecoder.prototype, 'decode', () => values.next().value);
  parentPort.postMessage('ready');
  await once(parentPort, 'message');
  const allKeys = [firstKey, ...withoutCalls(JSON, 'parse', () => [...keys])];
  const allValues = [firstValue, ...withoutCalls(TextDecoder.prototype, 'decode', () => [...values])];
  assert.throws(() => objects.set('forbidden', {}), /read-only/);
  assert.throws(() => numbers.set('forbidden', 1), /read-only/);
  const object = objects.get(allKeys[0]); assert.ok(Object.isFrozen(object));
  parentPort.postMessage({ keys: allKeys, values: allValues, readOnly: true });
} else {
  for (const copy of [false, true]) {
    S.resetOrderedMap();
    let objects = new S.SharedOrderedMap('object'), numbers = new S.SharedOrderedMap('number');
    const objectModel = new Map(), numberModel = new Map();
    const numberKey = i => `界🙂-${i}-${'long-unicode-key-'.repeat(4)}`;
    for (let i = 0; i < 48; i++) {
      const object = { i, text: 'Résumé界🙂'.repeat(24) }, value = [NaN, -0, Infinity, -Infinity, i + 0.25][i % 5];
      objects = objects.set(`object-${i}`, object); objectModel.set(`object-${i}`, object);
      numbers = numbers.set(numberKey(i), value); numberModel.set(numberKey(i), value);
    }
    objects = objects.set('object-0', { replacement: true }).delete('object-1').set('object-1', { reinserted: true });
    objectModel.set('object-0', { replacement: true }); objectModel.delete('object-1'); objectModel.set('object-1', { reinserted: true });
    numbers = numbers.set(numberKey(0), -0).delete(numberKey(1)).set(numberKey(1), NaN);
    numberModel.set(numberKey(0), -0); numberModel.delete(numberKey(1)); numberModel.set(numberKey(1), NaN);
    const source = S.getWorkerData({ objects, numbers }, { copy: false }).arenas[0], before = source.memory.buffer;
    const bytes = digest(new Uint8Array(before, 65536, source.used - 65536));
    const worker = new Worker(new URL(import.meta.url), { workerData: S.getWorkerData({ objects, numbers }, { copy }) });
    const timer = setTimeout(() => { console.error('Ordered projection worker proof timed out'); process.exit(1); }, 15000);
    try {
      assert.deepEqual(await once(worker, 'message'), ['ready']);
      for (let i = 0; i < 96; i++) objects = objects.set(`new-${i}`, { text: 'grow界🙂'.repeat(1024), i });
      numbers = numbers.delete(numberKey(2)).set(numberKey(2), 999);
      assert.notEqual(source.memory.buffer, before);
      S.resetOrderedMap(); new S.SharedOrderedMap('number').set('new arena', 123);
      const reply = once(worker, 'message'); worker.postMessage('resume');
      const [result] = await reply;
      assert.deepEqual(result, { keys: [...objectModel.keys()], values: [...numberModel.values()], readOnly: true });
      assert.equal(digest(new Uint8Array(source.memory.buffer, 65536, source.used - 65536)), bytes);
    } finally { clearTimeout(timer); await worker.terminate(); }
    console.log(`Ordered projections preserved cold decode boundaries and old snapshots after growth/reset (${copy ? 'copy' : 'shared'}).`);
  }
}
