import assert from 'node:assert/strict';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

if (!isMainThread) {
  const api = await import(workerData.moduleURL);
  const { old, newer, nested } = await api.initWorker(workerData.payload);
  let sum = 0;
  for (let pass = 0; pass < 16; pass++) {
    const a = old.get('key');
    assert.equal(old.get('key'), a);
    const b = newer.get('key');
    assert.equal(newer.get('key'), b);
    const list = nested.get('child');
    assert.equal(a.nested.value, 7);
    assert.equal(b.nested.value, 9);
    assert.equal(old.get('key'), a);
    assert.equal(newer.get('key'), b);
    assert.equal(nested.get('child'), list);
    assert.equal(Object.isFrozen(a.nested), true);
    assert.deepEqual(list.toArray(), [3, 5, 8]);
    assert.equal(old.get('missing'), undefined);
    assert.throws(() => old.set('key', {}), /read-only/);
    sum += a.nested.value + b.nested.value + list.get(2);
  }
  parentPort.postMessage({ passed: true, sum });
} else {
  const moduleURL = pathToFileURL(resolve(process.argv[2] ?? '.', 'dist/shared.js')).href;
  const api = await import(moduleURL);
  const evidence = [];
  for (const name of ['SharedMap', 'SharedOrderedMap', 'SharedSortedMap']) {
    for (const copy of [false, true]) {
      const C = api[name];
      const old = new C('object').set('key', { nested: { value: 7 } }).set('anchor', null);
      const newer = old.set('key', { nested: { value: 9 } });
      const child = new api.SharedList('number').pushMany([3, 5, 8]);
      const nested = new C('SharedList<number>').set('child', child);
      const payload = api.getWorkerData({ old, newer, nested }, { copy });
      const result = await new Promise((resolveResult, reject) => {
        const worker = new Worker(new URL(import.meta.url), { workerData: { moduleURL, payload } });
        const timer = setTimeout(() => { void worker.terminate(); reject(new Error('worker exceeded 30 seconds')); }, 30000);
        let message;
        worker.once('message', value => { message = value; });
        worker.once('error', error => { clearTimeout(timer); reject(error); });
        worker.once('exit', code => {
          clearTimeout(timer);
          if (code !== 0) reject(new Error('worker exited ' + code));
          else resolveResult(message);
        });
      });
      assert.deepEqual(result, { passed: true, sum: 384 });
      evidence.push({ name, copy, result });
    }
  }
  console.log(JSON.stringify({ schema: 1, kind: 'cached-object-real-workers', runtime: process.version, cases: evidence }));
}
