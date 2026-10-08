import assert from 'node:assert/strict';
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const expected = Array.from({ length: 1057 }, (_, i) => i);
function check(S, items, reuse, changed = false) {
  for (const name of ['source', 'sameTree', 'sameTail']) {
    assert.deepEqual(items[name].toArray(), expected);
    assert.equal(items[name].get(1024), 1024);
    assert.throws(() => items[name].set(0, 0), /read-only/);
    assert.throws(() => items[name].set(1056, 1056), /read-only/);
    assert.equal(items[name].set(-1, 0), items[name]);
  }
  assert.notEqual(items.source, items.sameTree);
  assert.notEqual(items.source, items.sameTail);
  assert.equal(items.sameTree.root === items.source.root, reuse);
  assert.equal(items.sameTree.tail, items.source.tail);
  assert.equal(items.sameTail.root, items.source.root);
  assert.notEqual(items.sameTail.tail, items.source.tail);
  if (changed) {
    const values = expected.slice(); values[1024] = -1024; values[1056] = -1056;
    assert.deepEqual(items.changed.toArray(), values);
    assert.equal(items.grown.size, 101057);
    assert.equal(items.grown.get(101056), 99999);
    assert.deepEqual(items.fork.toArray(), [...expected, -1]);
    assert.deepEqual(S.compact(items.changed).toArray(), values);
  }
}

if (!isMainThread) {
  let S, old, reuse;
  parentPort.on('message', async message => {
    try {
      if (message.phase === 'initial') {
        S = await import(message.moduleURL); old = await S.initWorker(message.data); reuse = message.reuse;
        check(S, old, reuse);
        parentPort.postMessage({ phase: 'ready' });
      } else {
        const next = await S.initWorker(message.data);
        check(S, old, reuse); check(S, next, reuse, true);
        parentPort.postMessage({ phase: 'complete' });
        parentPort.close();
      }
    } catch (error) { parentPort.postMessage({ error: String(error.stack ?? error) }); parentPort.close(); }
  });
} else {
  const moduleURL = pathToFileURL(resolve(process.argv[2] ?? 'dist/shared.js')).href;
  assert.ok(['baseline', 'vector-only'].includes(process.argv[3]), 'Choose baseline or vector-only explicitly');
  const reuse = process.argv[3] === 'vector-only';
  const S = await import(moduleURL);
  const used = list => S.getWorkerData({ list }, { copy: false }).arenas[0].used;
  function receive(worker) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { cleanup(); reject(new Error('Worker response timeout')); }, 30000);
      const onMessage = value => { cleanup(); value.error ? reject(new Error(value.error)) : resolve(value); };
      const onError = error => { cleanup(); reject(error); };
      const onExit = code => { cleanup(); reject(new Error(`Worker exited early (${code})`)); };
      function cleanup() { clearTimeout(timeout); worker.off('message', onMessage); worker.off('error', onError); worker.off('exit', onExit); }
      worker.once('message', onMessage); worker.once('error', onError); worker.once('exit', onExit);
    });
  }
  for (const copy of [false, true]) {
    S.resetSharedList();
    const source = new S.SharedList('number').pushMany(expected);
    const before = used(source), sameTree = source.set(1024, 1024), afterTree = used(source);
    const sameTail = source.set(1056, 1056), afterTail = used(source);
    assert.equal(afterTree - before, reuse ? 0 : 512);
    assert.equal(afterTail - afterTree, 8);
    assert.notEqual(source, sameTree); assert.notEqual(source, sameTail);
    assert.equal(Object.isFrozen(sameTree), true); assert.equal(Object.isFrozen(sameTail), true);
    const initial = S.getWorkerData({ source, sameTree, sameTail }, { copy });
    const originalMemory = S.getWorkerData({ source }, { copy: false }).arenas[0].memory;
    const byteLength = originalMemory.buffer.byteLength;
    const worker = new Worker(new URL(import.meta.url));
    try {
      let response = receive(worker);
      worker.postMessage({ phase: 'initial', moduleURL, data: initial, reuse });
      assert.deepEqual(await response, { phase: 'ready' });
      const changed = sameTree.set(1024, -1024).set(1056, -1056);
      const grown = sameTail.pushMany(Array.from({ length: 100000 }, (_, i) => i));
      const fork = source.push(-1);
      assert.ok(originalMemory.buffer.byteLength > byteLength, 'actual writer memory growth');
      response = receive(worker);
      worker.postMessage({ phase: 'next', data: S.getWorkerData({ source, sameTree, sameTail, changed, grown, fork }, { copy }) });
      assert.deepEqual(await response, { phase: 'complete' });
      console.log(JSON.stringify({ transport: copy ? 'copy' : 'shared', reuseScope: reuse ? 'vector-only' : 'none', treeAllocated: afterTree - before, tailAllocated: afterTail - afterTree, oldAndNewSnapshots: true, actualWriterGrowth: true, readonlyNoopRejected: true, descriptorIdentityChecked: true }));
    } finally { await worker.terminate(); }
  }
}
