/** Format-4 compatibility proof with real workers and both producer/reader
 * revisions. Arguments: built baseline directory and built candidate directory.
 */
import assert from 'node:assert/strict';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const key = i => `${'x'.repeat(i % 8)}${i.toString(36).padStart(3, '0')}`;
const value = i => i === 0 ? -0 : i === 1 ? NaN : i + 0.25;
function checkOld(state) {
  for (let i = 0; i < 257; i++) { assert(Object.is(state.numbers.get(key(i)), value(i))); assert.equal(state.booleans.get(key(i)), i % 2 === 0); }
  assert.equal(state.numbers.get('\ufffd'), 777); assert.equal(state.booleans.get('🙂'), false);
  assert.throws(() => state.numbers.setMany([['new', 1]]), /read-only/);
}
if (!isMainThread) {
  const S = await import(pathToFileURL(resolve(workerData.readerRoot, 'dist/shared.js')).href);
  let old;
  parentPort.on('message', async ({ stage, data }) => {
    try {
      assert.equal(data.version, 4);
      const state = await S.initWorker(data);
      if (stage === 'old') {
        old = state; checkOld(old);
        if (!workerData.copy) {
          const arena = data.arenas.find(a => a.id === data.structures.numbers.arena);
          Atomics.store(new Int32Array(arena.memory.buffer, 64000, 1), 0, 73);
        }
      } else {
        checkOld(old);
        assert.equal(state.numbers.get(key(0)), 10.5); assert.equal(state.numbers.get('中文'), Infinity);
        assert.equal(state.booleans.get(key(1)), true); assert.equal(state.booleans.has(key(2)), false);
        for (let i = 0; i < 4096; i++) assert.equal(state.numbers.get(`growth-${i}`), i + 0.75);
      }
      parentPort.postMessage({ stage, ok: true });
    } catch (error) { parentPort.postMessage({ error: error.stack }); }
  });
} else {
  const roots = [resolve(process.argv[2]), resolve(process.argv[3])], results = [];
  for (const producerRoot of roots) for (const readerRoot of roots) for (const copy of [false, true]) {
    const S = await import(pathToFileURL(resolve(producerRoot, 'dist/shared.js')).href); S.resetMap();
    const numbers = new S.SharedMap('number').setMany([...Array.from({ length: 257 }, (_, i) => [key(i), value(i)]), ['\ud800', 777]]);
    const booleans = new S.SharedMap('boolean').setMany([...Array.from({ length: 257 }, (_, i) => [key(i), i % 2 === 0]), ['🙂', false]]);
    const worker = new Worker(new URL(import.meta.url), { workerData: { readerRoot, copy } });
    const timer = setTimeout(() => { console.error('Bulk alignment worker proof timed out'); process.exit(1); }, 30000);
    async function exchange(stage, data) {
      const pending = once(worker, 'message'); worker.postMessage({ stage, data });
      const [reply] = await pending; if (reply.error) throw new Error(reply.error); assert.deepEqual(reply, { stage, ok: true });
    }
    try {
      const old = S.getWorkerData({ numbers, booleans }, { copy }); await exchange('old', old);
      if (!copy) {
        const arena = old.arenas.find(a => a.id === old.structures.numbers.arena);
        assert.equal(Atomics.load(new Int32Array(arena.memory.buffer, 64000, 1), 0), 73);
      }
      const nextNumbers = numbers.setMany([[key(0), 10.5], ['中文', Infinity], ...Array.from({ length: 4096 }, (_, i) => [`growth-${i}`, i + 0.75])]);
      const nextBooleans = booleans.setMany([[key(1), true]]).delete(key(2));
      await exchange('next', S.getWorkerData({ numbers: nextNumbers, booleans: nextBooleans }, { copy }));
      results.push({ producerRoot, readerRoot, copy, ok: true });
    } finally { clearTimeout(timer); await worker.terminate(); }
  }
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), harnessSha256: createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex'), runtime: process.version, format: 4, cases: results }, null, 2));
}
