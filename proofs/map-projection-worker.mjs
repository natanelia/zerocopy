import assert from 'node:assert/strict';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { once } from 'node:events';
import * as S from '../dist/shared.js';

if (!isMainThread) {
  const maps = await S.initWorker(workerData), projections = {};
  for (const [name, map] of Object.entries(maps)) for (const operation of ['keys', 'values', 'entries']) {
    const iterator = map[operation](); projections[`${name}/${operation}`] = { iterator, first: iterator.next().value };
  }
  parentPort.postMessage('ready');
  await once(parentPort, 'message');
  parentPort.postMessage(Object.fromEntries(Object.entries(projections).map(([name, { first, iterator }]) => [name, [first, ...iterator]])));
} else {
  for (const copy of [false, true]) {
    S.resetOrderedMap(); S.resetSortedMap();
    let ordered = new S.SharedOrderedMap('object'), sorted = new S.SharedSortedMap('object');
    for (let i = 0; i < 300; i++) { ordered = ordered.set(`🙂-${i}`, { i }); sorted = sorted.set(`🙂-${i}`, { i }); }
    ordered = ordered.delete('🙂-0').set('🙂-0', { i: -1 });
    sorted = sorted.delete('🙂-10').set('🙂-10', { i: -2 });
    const expected = {};
    for (const [name, map] of Object.entries({ ordered, sorted })) for (const operation of ['keys', 'values', 'entries']) expected[`${name}/${operation}`] = [...map[operation]()];
    const worker = new Worker(new URL(import.meta.url), { workerData: S.getWorkerData({ ordered, sorted }, { copy }) });
    const timer = setTimeout(() => { console.error('Projection worker proof timed out'); process.exit(1); }, 30000);
    try {
      assert.deepEqual(await once(worker, 'message'), ['ready']);
      for (let i = 300; i < 1300; i++) { ordered = ordered.set(`new-${i}`, { text: 'x'.repeat(1024), i }); sorted = sorted.set(`new-${i}`, { text: 'x'.repeat(1024), i }); }
      const reply = once(worker, 'message'); worker.postMessage('resume');
      const [result] = await reply;
      assert.deepEqual(result, expected);
    } finally { clearTimeout(timer); await worker.terminate(); }
  }
  console.log('Map projections retain shared and copied worker snapshots across writer growth.');
}
