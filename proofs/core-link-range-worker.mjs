/** Real-worker baseline/candidate compatibility, old snapshots and bulk appends. */
import assert from 'node:assert/strict';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const original = Array.from({ length: 1057 }, (_, i) => i < 5 ? [0, -0, NaN, Infinity, -Infinity][i] : i + 0.25);
const appended = Array.from({ length: 4096 }, (_, i) => -i - 0.25), strings = Array.from({ length: 33 }, (_, i) => `值🙂-${i}`), addedStrings = Array.from({ length: 1057 }, (_, i) => `new-中文-${i}`);
function checkOld(state) {
  assert.deepEqual(state.numbers.toArray(), original); assert.deepEqual(state.strings.toArray(), strings);
  assert.throws(() => state.numbers.pushMany([1]), /read-only/);
}
if (!isMainThread) {
  const S = await import(pathToFileURL(resolve(workerData.readerRoot, 'dist/shared.js')).href); let old;
  parentPort.on('message', async ({ stage, data }) => {
    try {
      assert.equal(data.version, 4); const state = await S.initWorker(data);
      if (stage === 'old') {
        old = state; checkOld(old);
        if (!workerData.copy) {
          const arena = data.arenas.find(a => a.id === data.structures.numbers.arena);
          Atomics.store(new Int32Array(arena.memory.buffer, 64000, 1), 0, 73);
        }
      } else {
        checkOld(old); assert.deepEqual(state.numbers.toArray(), [...original, ...appended]);
        assert.deepEqual(state.strings.toArray(), [...strings, ...addedStrings]);
        assert.deepEqual(state.fork.toArray(), [...original, ...Array(33).fill(-2.5)]);
        assert.throws(() => state.numbers.pushMany([2]), /read-only/);
      }
      parentPort.postMessage({ stage, ok: true });
    } catch (error) { parentPort.postMessage({ error: error.stack }); }
  });
} else {
  const roots = [resolve(process.argv[2]), resolve(process.argv[3])], results = [];
  for (const producerRoot of roots) for (const readerRoot of roots) for (const copy of [false, true]) {
    const S = await import(pathToFileURL(resolve(producerRoot, 'dist/shared.js')).href); S.resetSharedList();
    const numbers = new S.SharedList('number').pushMany(original), text = new S.SharedList('string').pushMany(strings);
    const worker = new Worker(new URL(import.meta.url), { workerData: { readerRoot, copy } });
    const timer = setTimeout(() => { console.error('Vector branch worker proof timed out'); process.exit(1); }, 30000);
    async function exchange(stage, data) {
      const pending = once(worker, 'message'); worker.postMessage({ stage, data });
      const [reply] = await pending; if (reply.error) throw new Error(reply.error); assert.deepEqual(reply, { stage, ok: true });
    }
    try {
      const old = S.getWorkerData({ numbers, strings: text }, { copy }); await exchange('old', old);
      if (!copy) {
        const arena = old.arenas.find(a => a.id === old.structures.numbers.arena);
        assert.equal(Atomics.load(new Int32Array(arena.memory.buffer, 64000, 1), 0), 73);
      }
      const next = { numbers: numbers.pushMany(appended), strings: text.pushMany(addedStrings), fork: numbers.pushMany(Array(33).fill(-2.5)) };
      numbers.arena.alloc(262144); // The owning writer grows after old snapshots are attached.
      await exchange('next', S.getWorkerData(next, { copy }));
      assert.deepEqual(numbers.toArray(), original); results.push({ producerRoot, readerRoot, copy, ok: true });
    } finally { clearTimeout(timer); await worker.terminate(); }
  }
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), harnessSha256: createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex'), runtime: process.version, format: 4, cases: results }, null, 2));
}
