import assert from 'node:assert/strict';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import * as S from '../../dist/shared.js';

S.configureMemory({ maximumBytes: 16 * 1024 * 1024 });

if (!isMainThread) {
  const sources = await S.initWorker(workerData);
  const before = Object.fromEntries(Object.entries(sources).map(([name, heap]) => [name, [...heap.entries()]]));
  assert.throws(() => sources.original.enqueue({ id: -1 }, -1), /read-only/);
  const copies = S.compactMany({ ...sources, alias: sources.original });
  assert.equal(copies.alias, copies.original);
  for (const [name, expected] of Object.entries(before)) {
    assert.deepEqual([...copies[name].entries()], expected);
    assert.deepEqual([...sources[name].entries()], expected);
  }
  const output = S.getWorkerData(copies, { copy: false });
  assert.equal(output.arenas.length, 1);
  assert.equal(copies.original.enqueue({ id: -1 }, -1).peek().id, -1);
  parentPort.postMessage({ output, count: copies.original.size });
} else {
  let original = new S.SharedPriorityQueue('object');
  for (let i = 0; i < 4096; i++) original = original.enqueue({ id: i, payload: { text: `row/${i}` } }, (i * 2053) % 4099);
  const fork = original.enqueue({ id: 9000, payload: { text: 'fork' } }, -1);
  const expected = { original: [...original.entries()], fork: [...fork.entries()] };
  for (const copy of [false, true]) {
    const payload = S.getWorkerData({ original, fork }, { copy });
    const worker = new Worker(new URL(import.meta.url), { workerData: payload });
    try {
      const reply = await new Promise((resolve, reject) => {
        worker.once('message', resolve);
        worker.once('error', reject);
        worker.once('exit', code => { if (code !== 0) reject(new Error(`Worker exited with code ${code}`)); });
      });
      const results = await S.initWorker(reply.output);
      assert.equal(reply.count, 4096);
      for (const [name, entries] of Object.entries(expected)) assert.deepEqual([...results[name].entries()], entries);
      assert.deepEqual([...results.alias.entries()], expected.original);
      assert.deepEqual([...original.entries()], expected.original);
      assert.deepEqual([...fork.entries()], expected.fork);
      console.log(`${copy ? 'copied' : 'shared'} worker: compacted source, fork, and alias; retained source verified`);
    } finally { await worker.terminate(); }
  }
}
