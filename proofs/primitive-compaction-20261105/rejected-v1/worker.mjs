import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import * as S from '../../dist/shared.js';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const special = i => [NaN, -0, Infinity, -Infinity, i + 0.25][i % 5];
function drain(queue) {
  const values = [];
  while (queue.size) { values.push(queue.peek()); queue = queue.dequeue(); }
  return values;
}
if (!isMainThread) {
  const attached = await S.initWorker(workerData);
  const source = S.getWorkerData(attached, { copy: false });
  const before = source.arenas.map(a => digest(new Uint8Array(a.memory.buffer, 65536, a.used - 65536)));
  parentPort.postMessage('ready');
  await once(parentPort, 'message');
  const rebuilt = S.compactMany({ ...attached, alias: attached.list });
  assert.equal(rebuilt.list, rebuilt.alias);
  assert.equal(rebuilt.queue.tail, 0);
  assert.equal(S.getWorkerData(rebuilt).arenas.length, 1);
  assert.throws(() => attached.list.push(99), /read-only/);
  assert.throws(() => attached.queue.enqueue(true), /read-only/);
  assert.equal(rebuilt.list.push(99).get(rebuilt.list.size), 99);
  assert.equal(rebuilt.queue.enqueue(true).size, rebuilt.queue.size + 1);
  const values = rebuilt.list.toArray(), booleans = drain(rebuilt.queue);
  assert.deepEqual(attached.list.toArray(), values);
  assert.deepEqual(drain(attached.queue), booleans);
  for (let i = 0; i < source.arenas.length; i++) {
    const a = source.arenas[i];
    assert.equal(digest(new Uint8Array(a.memory.buffer, 65536, a.used - 65536)), before[i]);
  }
  parentPort.postMessage({ values, booleans, readOnly: true, aliasRetained: true });
} else {
  for (const copy of [false, true]) {
    S.resetSharedList(); S.resetQueue();
    const expected = Array.from({ length: 4097 }, (_, i) => special(i));
    let list = new S.SharedList('number').pushMany(expected);
    const bools = Array.from({ length: 2098 }, (_, i) => i % 3 === 0);
    let queue = new S.SharedQueue('boolean');
    for (const value of bools) queue = queue.enqueue(value);
    for (let i = 0; i < 47; i++) queue = queue.dequeue();
    const sources = S.getWorkerData({ list, queue }, { copy: false });
    const sourceBytes = sources.arenas.map(a => digest(new Uint8Array(a.memory.buffer, 65536, a.used - 65536)));
    const worker = new Worker(new URL(import.meta.url), { workerData: S.getWorkerData({ list, queue }, { copy }) });
    const timer = setTimeout(() => { console.error('Primitive compaction worker timed out'); process.exit(1); }, 15000);
    try {
      assert.deepEqual(await once(worker, 'message'), ['ready']);
      for (const a of sources.arenas) a.memory.grow(4);
      list = list.set(32, 123).pushMany(Array(8193).fill(42));
      queue = queue.enqueue(false).dequeue();
      S.resetSharedList(); S.resetQueue();
      const result = once(worker, 'message'); worker.postMessage('continue');
      assert.deepEqual((await result)[0], { values: expected, booleans: bools.slice(47), readOnly: true, aliasRetained: true });
      for (let i = 0; i < sources.arenas.length; i++) {
        const a = sources.arenas[i];
        assert.equal(digest(new Uint8Array(a.memory.buffer, 65536, a.used - 65536)), sourceBytes[i]);
      }
    } finally { clearTimeout(timer); await worker.terminate(); }
    console.log(`Primitive compaction preserved old bytes, aliases and read-only source boundaries after growth/reset (${copy ? 'copy' : 'shared'}).`);
  }
}
