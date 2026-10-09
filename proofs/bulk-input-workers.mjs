import assert from 'node:assert/strict';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';

const key = i => `k${String(i).padStart(7, '0')}`;
function checkRuntime(runtime) {
  assert.ok(['node', 'bun'].includes(runtime));
  if (runtime === 'bun') assert.equal(process.versions.bun, '1.4.2');
  else { assert.equal(process.versions.bun, undefined); assert.equal(process.versions.node, '22.23.3'); }
}
function check(s) {
  assert.equal(s.old.size, 12288); assert.equal(s.fallback.size, 12289);
  for (const [i, k] of [0, 6144, 12287].map(i => [i, key(i)])) assert.equal(s.old.get(k), `v${i}`);
  assert.equal(s.fallback.get(key(12288)), 'v12288');
  assert.deepEqual(s.objects.get('a'), { a: 1 });
  assert.deepEqual(s.nested.get('child').toArray(), ['a', '界🙂']);
  assert.equal([...s.old.keys()].length, 12288);
  assert.throws(() => s.old.setMany([['blocked', 'x']]), /read-only/);
  assert.equal(s.old.setMany([]), s.old);
}
if (!isMainThread) {
  checkRuntime(workerData.runtime);
  const S = await import(workerData.reader);
  assert.equal(workerData.payload.version, 4);
  const first = await S.initWorker(workerData.payload); check(first);
  parentPort.postMessage({ phase: 'ready' });
  parentPort.once('message', async payload => {
    try {
      check(first);
      const second = await S.initWorker(payload); check(second);
      assert.equal(second.next.get('large0').length, 100000); assert.equal(first.old.has('large0'), false);
      assert.deepEqual(first.nested.get('child').toArray(), ['a', '界🙂']);
      parentPort.postMessage({ phase: 'done', oldSize: first.old.size, nextSize: second.next.size, runtime: process.versions });
      parentPort.close();
    } catch (error) { console.error(error); process.exitCode = 1; parentPort.close(); }
  });
} else {
  const [root, producer, output, runtime] = process.argv.slice(2);
  assert.ok(root && ['baseline', 'candidate'].includes(producer) && output);
  checkRuntime(runtime);
  const S = await import(pathToFileURL(`${root}/${producer}/dist/shared.js`).href);
  const old = new S.SharedMap('string').setMany(Array.from({ length: 12288 }, (_, i) => [key(i), `v${i}`]));
  const fallback = new S.SharedMap('string').setMany(Array.from({ length: 12289 }, (_, i) => [key(i), `v${i}`]));
  const objects = new S.SharedMap('object').setMany([['a', { a: 1 }], ['b', {}], ['c', {}], ['d', {}], ['e', {}]]);
  const child = new S.SharedList('string').pushMany(['a', '界🙂']);
  const nested = new S.SharedMap('SharedList<string>').setMany([['child', child], ['alias', child]]);
  const rows = [];
  for (const reader of ['baseline', 'candidate']) for (const copy of [false, true]) {
    const payload = S.getWorkerData({ old, fallback, objects, nested }, { copy });
    const worker = new Worker(new URL(import.meta.url), { workerData: { reader: pathToFileURL(`${root}/${reader}/dist/shared.js`).href, payload, runtime } });
    let code;
    const exited = new Promise(resolve => worker.once('exit', value => { code = value; resolve(value); }));
    const phase = expected => new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error(`Worker ${expected} deadline`)), 20000);
      const onMessage = result => finish(result.phase === expected ? null : new Error(`Unexpected phase ${result.phase}`), result);
      const onError = error => finish(error);
      const onExit = value => finish(new Error(`Worker exited ${value} before ${expected}`));
      function finish(error, value) { clearTimeout(timer); worker.off('message', onMessage); worker.off('error', onError); worker.off('exit', onExit); error ? reject(error) : resolve(value); }
      worker.once('message', onMessage); worker.once('error', onError); worker.once('exit', onExit);
    });
    try {
      await phase('ready');
      const next = old.setMany(Array.from({ length: 5 }, (_, i) => [`large${i}`, 'x'.repeat(100000)]));
      const done = phase('done'); worker.postMessage(S.getWorkerData({ old, next, fallback, objects, nested }, { copy }));
      const result = await done;
      const exitDeadline = new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Worker exit deadline')), 20000); exited.then(() => clearTimeout(timer)); });
      assert.equal(await Promise.race([exited, exitDeadline]), 0);
      rows.push({ producer, reader, copy, ...result, exit: code });
    } finally { if (code === undefined) await worker.terminate(); }
  }
  writeFileSync(output, JSON.stringify({ runtime: process.versions, rows }, null, 2) + '\n');
  console.log(JSON.stringify({ producer, completedWorkers: rows.length }));
}
