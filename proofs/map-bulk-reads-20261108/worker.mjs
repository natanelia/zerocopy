import assert from 'node:assert/strict';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { types, makeFixture, checkMap, checkReads, checkReadonly, readState, checkReadState, checkBytes } from './read-fixtures.mjs';

// Usage: node worker.mjs WRITER_ROOT [READER_ROOT]. No timings are collected.
const root = isMainThread ? resolve(process.argv[2] ?? '.') : workerData.root;
const S = await import(pathToFileURL(resolve(root, 'dist/shared.js')));
if (!isMainThread) {
  const fixture = makeFixture(workerData.type);
  let retained, saved;
  parentPort.on('message', async message => {
    try {
      if (message.type === 'initial') {
        retained = (await S.initWorker(message.packet)).before;
        saved = readState(S, retained);
        checkMap(retained, fixture.models.before, fixture.queries);
        checkReadState(S, retained, saved); checkReadonly(retained, fixture.readonlyValue);
        parentPort.postMessage({ type: 'ready' });
      } else if (message.type === 'concurrent') {
        const control = new Int32Array(workerData.control), deadline = performance.now() + 20000;
        Atomics.store(control, 0, 1); Atomics.notify(control, 0);
        let reads = 0;
        while (reads < 12288 || !Atomics.load(control, 1)) {
          reads += checkReads(retained, fixture.concurrentKeys, fixture.models.before);
          if (performance.now() > deadline) throw new Error('Owner did not finish mutations');
        }
        parentPort.postMessage({ type: 'concurrent-ok', reads });
      } else if (message.type === 'updated') {
        const attached = await S.initWorker(message.packet);
        checkMap(retained, fixture.models.before, fixture.queries); checkReadState(S, retained, saved);
        for (const [name, model] of Object.entries(fixture.models)) {
          const state = readState(S, attached[name]);
          checkMap(attached[name], model, fixture.queries); checkReadonly(attached[name], fixture.readonlyValue);
          checkReadState(S, attached[name], state);
        }
        // Alternate old and new roots after both caches are warm. A previously
        // absent key must remain absent in retained and present only in after.
        for (let i = 0; i < 4; i++) {
          for (const name of ['before', 'after', 'fork', 'compacted']) {
            checkReads(attached[name], fixture.concurrentKeys, fixture.models[name]);
          }
        }
        parentPort.postMessage({ type: 'verified' });
      }
    } catch (error) { parentPort.postMessage({ error: error.stack }); }
  });
} else {
  const readerRoot = resolve(process.argv[3] ?? root), results = [];
  for (const copy of [false, true]) for (const type of types) {
    S.resetMap();
    const fixture = makeFixture(type), before = new S.SharedMap(type).setMany(fixture.entries);
    const saved = readState(S, before), oldCapacity = saved.arena.memory.buffer.byteLength;
    checkMap(before, fixture.models.before, fixture.queries); checkReadState(S, before, saved);
    const control = new SharedArrayBuffer(8);
    const worker = new Worker(new URL(import.meta.url), { workerData: { root: readerRoot, control, type } });
    const timer = setTimeout(() => { console.error('Read worker proof timed out'); process.exit(1); }, 30000);
    const exchange = async message => {
      const response = once(worker, 'message'); worker.postMessage(message);
      const [result] = await response; if (result.error) throw new Error(result.error); return result;
    };
    try {
      assert.equal((await exchange({ type: 'initial', packet: S.getWorkerData({ before }, { copy }) })).type, 'ready');
      const concurrent = once(worker, 'message'); worker.postMessage({ type: 'concurrent' });
      assert.notEqual(Atomics.wait(new Int32Array(control), 0, 0, 10000), 'timed-out');
      const after = before.setMany(fixture.afterWrites).delete(fixture.deleteAfter);
      const fork = before.setMany(fixture.forkWrites).delete(fixture.deleteFork);
      before.setMany(fixture.growth());
      Atomics.store(new Int32Array(control), 1, 1);
      const [readResult] = await concurrent;
      if (readResult.error) throw new Error(readResult.error);
      assert.equal(readResult.type, 'concurrent-ok');
      assert.ok(saved.arena.memory.buffer.byteLength > oldCapacity, 'Owner memory must grow during reads');
      checkBytes(saved.arena.memory, saved.bytes);
      const compacted = S.compact(after), structures = { before, after, fork, compacted };
      for (const [name, map] of Object.entries(structures)) checkMap(map, fixture.models[name], fixture.queries);
      assert.equal((await exchange({ type: 'updated', packet: S.getWorkerData(structures, { copy }) })).type, 'verified');
      results.push({ copy, valueType: type, reads: readResult.reads, sourceCount: before.size, resultCount: after.size,
        oldCapacity, newCapacity: saved.arena.memory.buffer.byteLength, retainedBytesUnchanged: true,
        readerAllocationsUnchanged: true, oldMissAndNewPresenceVerified: true,
        checkedSnapshots: Object.keys(structures) });
    } finally { Atomics.store(new Int32Array(control), 1, 1); clearTimeout(timer); await worker.terminate(); }
  }
  console.log(JSON.stringify({ passed: true, writerRoot: root, readerRoot, runtime: process.version,
    operations: ['getMany', 'get', 'has'], independentInputOracles: true, results }, null, 2));
}
