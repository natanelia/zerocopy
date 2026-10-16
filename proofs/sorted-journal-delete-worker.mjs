import assert from 'node:assert/strict';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { SharedList, SharedSortedMap, compact, getWorkerData, initWorker } from '../dist/shared.js';

const entries = map => [...map.entries()];
const nestedEntries = map => [...map.entries()].map(([key, value]) => [key, value.toArray()]);
function canonical(packet, name) {
  const descriptor = packet.structures[name], root = descriptor.data.root;
  const source = packet.arenas.find(arena => arena.id === descriptor.arena);
  const view = source.copy ? new DataView(source.copy.buffer, source.copy.byteOffset, source.copy.byteLength)
    : new DataView(source.memory.buffer);
  assert.notEqual(view.getUint32(root, true), 0xffffffff);
}

if (!isMainThread) {
  const { packet, expected } = workerData;
  const snapshots = await initWorker(packet);
  for (const name of ['base', 'pending', 'next']) assert.deepEqual(entries(snapshots[name]), expected[name]);
  assert.deepEqual(nestedEntries(snapshots.nested), expected.nested);
  assert.equal(snapshots.next.get('temporary'), undefined);
  assert.equal(snapshots.pending.get('temporary'), 90);
  assert.equal(snapshots.next.get('key/000'), -1);
  assert.throws(() => snapshots.next.delete('key/001'), /read-only/);
  canonical(packet, 'next');
  parentPort.postMessage({ status: 'passed', snapshots: 4, readOnlyChecked: true });
  parentPort.close();
} else {
  let base = new SharedSortedMap('number');
  for (let i = 0; i < 64; i++) base = base.set(`key/${i.toString().padStart(3, '0')}`, i);
  base = compact(base);
  const pending = base.set('temporary', 90).set('key/000', -1).set('kept', 91);
  const next = pending.delete('temporary');
  const child = new SharedList('number').pushMany([5, 6]);
  const nested = new SharedSortedMap('SharedList<number>').set('first', child).set('temporary', child).set('last', child).delete('temporary');
  const snapshots = { base, pending, next, nested };
  const expected = { base: entries(base), pending: entries(pending), next: entries(next), nested: nestedEntries(nested) };
  for (const copy of [false, true]) {
    const packet = getWorkerData(snapshots, { copy }); canonical(packet, 'next');
    const worker = new Worker(new URL(import.meta.url), { workerData: { packet, expected } });
    try {
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Worker round trip timed out')), 15000);
        worker.once('message', value => { clearTimeout(timer); resolve(value); });
        worker.once('error', error => { clearTimeout(timer); reject(error); });
        worker.once('exit', code => { if (code !== 0) { clearTimeout(timer); reject(new Error(`Worker exited ${code}`)); } });
      });
      assert.deepEqual(result, { status: 'passed', snapshots: 4, readOnlyChecked: true });
    } finally { await worker.terminate(); }
  }
  assert.deepEqual(entries(base), expected.base); assert.deepEqual(entries(pending), expected.pending);
  console.log(JSON.stringify({ status: 'passed', transportModes: ['shared', 'copy'], workerRoundtrips: 2 }));
}
