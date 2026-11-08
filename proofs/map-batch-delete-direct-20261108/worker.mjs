import assert from 'node:assert/strict';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const kind = isMainThread ? process.argv[2] : workerData.kind;
const root = isMainThread ? resolve(process.argv[3] ?? '.') : workerData.root;
assert.ok(kind === 'map' || kind === 'list', 'Usage: node worker.mjs map|list WRITER_ROOT [READER_ROOT]');
const S = await import(pathToFileURL(resolve(root, 'dist/shared.js')));
const all = value => kind === 'list' ? value.toArray() : [...value.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);

if (!isMainThread) {
  let retained, expected;
  parentPort.on('message', async message => {
    try {
      if (message.type === 'initial') {
        retained = (await S.initWorker(message.packet)).before;
        expected = message.expected;
        assert.deepEqual(all(retained), expected);
        parentPort.postMessage({ type: 'ready' });
      } else if (message.type === 'concurrent') {
        const control = new Int32Array(workerData.control);
        Atomics.store(control, 0, 1); Atomics.notify(control, 0);
        let reads = 0;
        const deadline = performance.now() + 20000;
        while (reads < 10000 || !Atomics.load(control, 1)) {
          const index = reads % expected.length;
          if (kind === 'list') assert.ok(Object.is(retained.get(index), expected[index]));
          else assert.deepEqual(retained.get(expected[index][0]), expected[index][1]);
          reads++;
          if (performance.now() > deadline) throw new Error('Owner did not finish mutations');
        }
        parentPort.postMessage({ type: 'concurrent-ok', reads });
      } else if (message.type === 'updated') {
        const attached = await S.initWorker(message.packet);
        assert.deepEqual(all(retained), expected);
        for (const name of Object.keys(message.expected)) {
          assert.deepEqual(all(attached[name]), message.expected[name]);
          assert.equal(attached[name].size, message.expected[name].length);
          assert.ok(Object.isFrozen(attached[name]));
        }
        if (kind === 'list') assert.throws(() => attached.after.set(0, 8), /read-only/);
        else assert.throws(() => attached.after.deleteMany(Array(512).fill('missing')), /read-only/);
        parentPort.postMessage({ type: 'verified' });
      }
    } catch (error) { parentPort.postMessage({ error: error.stack }); }
  });
} else {
  const readerRoot = resolve(process.argv[4] ?? root), results = [];
  for (const copy of [false, true]) {
    if (kind === 'list') S.resetSharedList(); else S.resetMap();
    const count = kind === 'list' ? 32801 : 8192;
    const input = Array.from({ length: count }, (_, i) => i + 0.5);
    input[0] = NaN; input[1] = -0; input[2] = Infinity; input[3] = -Infinity;
    const before = kind === 'list' ? new S.SharedList('number').pushMany(input)
      : new S.SharedMap('number').setMany(input.map((v, i) => [`key/${i}`, v]));
    const initial = S.getWorkerData({ before }, { copy });
    const arena = S.getWorkerData({ before }, { copy: false }).arenas[0];
    const bytes = Buffer.from(arena.memory.buffer, 65536, arena.used - 65536);
    const savedBytes = Buffer.from(bytes), oldCapacity = arena.memory.buffer.byteLength;
    const control = new SharedArrayBuffer(8);
    const worker = new Worker(new URL(import.meta.url), { workerData: { kind, root: readerRoot, control } });
    const timer = setTimeout(() => { console.error('Worker proof timed out'); process.exit(1); }, 30000);
    async function exchange(message) {
      const response = once(worker, 'message'); worker.postMessage(message);
      const [result] = await response; if (result.error) throw new Error(result.error); return result;
    }
    try {
      assert.equal((await exchange({ type: 'initial', packet: initial, expected: all(before) })).type, 'ready');
      const concurrent = once(worker, 'message'); worker.postMessage({ type: 'concurrent' });
      assert.notEqual(Atomics.wait(new Int32Array(control), 0, 0, 10000), 'timed-out');
      let after = before, fork, extra = {}, requestShapes = {};
      if (kind === 'list') {
        for (let i = 0; i < 512; i++) after = after.set((Math.imul(i, 2654435761) >>> 0) % (count - 32), -i - 1);
        fork = before.set(count - 33, -777);
        before.pushMany(Array(200000).fill(9));
      } else {
        after = before.deleteMany(Array.from({ length: 4096 }, (_, i) => `key/${i * 2}`));
        fork = before.deleteMany(Array.from({ length: 2048 }, (_, i) => `key/${i * 2 + 1}`));
        requestShapes = {
          boundary511: Array.from({ length: 511 }, (_, i) => `key/${i}`),
          boundary512: Array.from({ length: 512 }, (_, i) => `key/${i}`),
          lateHits: Array.from({ length: 1000 }, (_, i) => i < 32 ? `missing/${i}` : `key/${i}`),
          sparseHits: Array.from({ length: 1000 }, (_, i) => i % 16 ? `missing/${i}` : `key/${i}`),
          densePrefixMisses: Array.from({ length: 1000 }, (_, i) => i < 32 ? `key/${i}` : `missing/${i}`),
        };
        extra = Object.fromEntries(Object.entries(requestShapes).map(([name, keys]) => [name, before.deleteMany(keys)]));
        before.setMany(Array.from({ length: 24000 }, (_, i) => [`growth/${i}`, i]));
      }
      Atomics.store(new Int32Array(control), 1, 1);
      const [readResult] = await concurrent;
      if (readResult.error) throw new Error(readResult.error);
      assert.equal(readResult.type, 'concurrent-ok');
      assert.ok(arena.memory.buffer.byteLength > oldCapacity, 'The owner must grow its memory during edits');
      assert.deepEqual(Buffer.from(arena.memory.buffer, 65536, savedBytes.length), savedBytes);
      const compacted = S.compact(after), structures = { before, after, fork, compacted, ...extra };
      const expected = Object.fromEntries(Object.entries(structures).map(([name, value]) => [name, all(value)]));
      if (kind === 'list') {
        const oracle = [...input];
        for (let i = 0; i < 512; i++) oracle[(Math.imul(i, 2654435761) >>> 0) % (count - 32)] = -i - 1;
        assert.deepEqual(expected.after, oracle);
        assert.deepEqual(expected.before, input);
      } else {
        assert.deepEqual(expected.after, input.flatMap((value, i) => i % 2 ? [[`key/${i}`, value]] : [])
          .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
        assert.deepEqual(expected.compacted, expected.after);
        const requests = { fork: Array.from({ length: 2048 }, (_, i) => `key/${i * 2 + 1}`), ...requestShapes };
        for (const [name, keys] of Object.entries(requests)) {
          const model = new Map(input.map((value, i) => [`key/${i}`, value]));
          for (const key of keys) model.delete(key);
          assert.deepEqual(expected[name], [...model].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
        }
        assert.equal(before.size, count);
      }
      assert.equal((await exchange({ type: 'updated', packet: S.getWorkerData(structures, { copy }), expected })).type, 'verified');
      results.push({ copy, reads: readResult.reads, sourceCount: count, resultCount: after.size,
        oldCapacity, newCapacity: arena.memory.buffer.byteLength, retainedBytesUnchanged: true,
        checkedSnapshots: Object.keys(structures) });
    } finally { Atomics.store(new Int32Array(control), 1, 1); clearTimeout(timer); await worker.terminate(); }
  }
  console.log(JSON.stringify({ passed: true, kind, writerRoot: root, readerRoot, runtime: process.version, results }, null, 2));
}
