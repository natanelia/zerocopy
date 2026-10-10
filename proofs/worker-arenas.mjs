import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import * as S from '../dist/shared.js';

const count = 48;
let producer;
function create(offset) {
  if (!producer) {
    const leaves = [];
    for (let i = 0; i < count; i++) {
      S.resetMap(); leaves.push(new S.SharedMap('number'));
    }
    S.resetMap(); producer = { leaves, root: new S.SharedMap('SharedMap<number>') };
  }
  producer.leaves = producer.leaves.map((leaf, i) => leaf.set('value', offset + i));
  producer.root = producer.root.setMany(producer.leaves.map((leaf, i) => [`leaf${i}`, leaf]));
  return { root: producer.root };
}
function check({ root }, offset, readCount = count) {
  for (let i = 0; i < readCount; i++) {
    const leaf = root.get(`leaf${i}`);
    assert.equal(leaf.get('value'), offset + i);
    assert.equal(root.get(`leaf${i}`), leaf);
    assert.throws(() => leaf.set('value', -1), /read-only/);
  }
}

if (!isMainThread) {
  let retained;
  parentPort.on('message', async ({ data, offset, copy }) => {
    try {
      const current = await S.initWorker(data);
      if (retained) check(retained, 0);
      // Leave the final old leaf cold until after the next attachment.
      check(current, offset, retained ? count : count - 1);
      retained ??= current;
      const forwarded = S.getWorkerData(current, { copy });
      assert.equal(forwarded.arenas.length, count + 1);
      parentPort.postMessage({ data: forwarded });
    } catch (error) { parentPort.postMessage({ error: error.stack }); }
  });
} else {
  for (const copy of [false, true]) {
    const worker = new Worker(new URL(import.meta.url));
    const timer = setTimeout(() => { console.error('Many-arena worker proof timed out'); process.exit(1); }, 30000);
    try {
      for (const offset of [0, 100]) {
        const data = S.getWorkerData(create(offset), { copy });
        assert.equal(data.arenas.length, count + 1);
        const received = once(worker, 'message'); worker.postMessage({ data, offset, copy });
        const [response] = await received;
        if (response.error) throw new Error(response.error);
        check(await S.initWorker(response.data), offset);
      }
    } finally { clearTimeout(timer); await worker.terminate(); }
  }
  console.log(JSON.stringify({ passed: true, runtime: process.version, arenas: count + 1, copyAndShared: true, reexport: true, retained: true, nestedReadOnly: true, repeatedArenaIds: true, deferredOldRead: true }));
}
