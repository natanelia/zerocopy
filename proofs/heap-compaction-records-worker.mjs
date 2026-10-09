import assert from 'node:assert/strict';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const hash = data => createHash('sha256').update(data).digest('hex');
function rows(s) { return [...s.entries()].map(([v, p]) => [v && typeof v.entries === 'function' ? rows(v) : v, p]); }
function checkGroup(group, expected) {
  for (const [name, value] of Object.entries(expected)) assert.deepEqual(rows(group[name]), value);
  assert.equal(group.heap.root, group.again.root);
}
function assertReadOnly(group) {
  assert.throws(() => group.heap.enqueue('forbidden', 0), /read-only/);
  assert.throws(() => group.nested.peek().enqueue('forbidden', 0), /read-only/);
}
function probe(payload, copy) {
  const arena = payload.arenas.find(a => a.id === payload.structures.heap.arena);
  assert(arena);
  if (copy) { assert(arena.copy && !arena.memory); return new Int32Array(arena.copy.buffer, arena.copy.byteOffset, arena.copy.byteLength >> 2); }
  assert(arena.memory && !arena.copy); return new Int32Array(arena.memory.buffer);
}
if (!isMainThread) {
  const S = await import(workerData.bundle);
  let retained, expected;
  parentPort.on('message', async message => {
    try {
      if (message.kind === 'initial') {
        retained = await S.initWorker(message.payload); expected = message.expected;
        checkGroup(retained, expected); assertReadOnly(retained);
        // Word 15000 is reserved test scratch below the 65536-byte collection start.
        probe(message.payload, workerData.copy)[15000] = 911;
        const compacted = S.compactMany(retained);
        checkGroup(compacted, expected); assert.equal(compacted.heap, compacted.again);
        const packed = S.getWorkerData(compacted, { copy: workerData.copy });
        assert.equal(packed.arenas.length, 1);
        const updated = compacted.heap.enqueue('worker-local', -Infinity);
        assert.equal(updated.peek(), 'worker-local'); checkGroup(retained, expected); checkGroup(compacted, expected);
        const single = S.getWorkerData({ heap: S.compact(retained.heap) }, { copy: true });
        parentPort.postMessage({ kind: 'initial-ok', packed, primitiveBytesHash: hash(single.arenas[0].copy), primitiveUsed: single.arenas[0].used });
      } else if (message.kind === 'later') {
        const later = await S.initWorker(message.payload); assert.equal(later.heap.peek(), 'owner-later');
        checkGroup(retained, expected); assertReadOnly(retained);
        parentPort.postMessage({ kind: 'later-ok', oldSnapshotsReadable: true });
      }
    } catch (error) { parentPort.postMessage({ error: String(error.stack) }); }
  });
} else {
  const results = [];
  for (const arm of ['baseline', 'candidate']) for (const copy of [false, true]) {
    const bundle = new URL(`../.proof-tools/heap-compaction-records/build/${arm}/shared.js`, import.meta.url).href;
    const S = await import(bundle);
    S.resetPriorityQueue();
    let heap = new S.SharedPriorityQueue('string');
    for (let i = 0; i < 257; i++) heap = heap.enqueue(`value-${i % 31}`, (i * 37) % 101);
    const fork = heap.enqueue('fork', -1);
    const nested = new S.SharedPriorityQueue('SharedPriorityQueue<string>').enqueue(heap, 2).enqueue(heap, 1).enqueue(fork, 0);
    const group = { heap, fork, nested, again: heap }, expected = Object.fromEntries(Object.entries(group).map(([name, value]) => [name, rows(value)]));
    const payload = S.getWorkerData(group, { copy });
    const witness = probe(payload, copy); witness[15000] = 73;
    const worker = new Worker(new URL(import.meta.url), { workerData: { bundle, copy } });
    async function exchange(message) { const pending = once(worker, 'message'); worker.postMessage(message); const [reply] = await pending; if (reply.error) throw new Error(reply.error); return reply; }
    try {
      const reply = await exchange({ kind: 'initial', payload, expected });
      assert.equal(reply.kind, 'initial-ok'); assert.equal(witness[15000], copy ? 73 : 911);
      const returned = await S.initWorker(reply.packed); checkGroup(returned, expected); assertReadOnly(returned);
      assert.equal(reply.packed.arenas.length, 1);
      const sourceBytes = S.getWorkerData(group, { copy: true }).arenas.map(a => ({ id: a.id, data: a.copy.slice(65536, a.used) }));
      const next = heap.enqueue('owner-later', -Infinity).enqueue('x'.repeat(200000), 999);
      S.resetPriorityQueue();
      const later = await exchange({ kind: 'later', payload: S.getWorkerData({ heap: next }, { copy }) });
      assert.equal(later.kind, 'later-ok'); checkGroup(group, expected); checkGroup(returned, expected);
      const after = S.getWorkerData(group, { copy: true });
      for (const before of sourceBytes) assert.deepEqual(after.arenas.find(a => a.id === before.id).copy.slice(65536, 65536 + before.data.length), before.data);
      results.push({ arm, copy, passed: true, actualWorker: true, sharedOrCopyWitness: true, workerCompaction: true, returnAttachment: true, readOnlyEnforced: true, sourceGrowthAndResetPreserveOldSnapshots: true, nestedCompactionSingleArena: true, primitiveBytesHash: reply.primitiveBytesHash, primitiveUsed: reply.primitiveUsed });
    } finally { await worker.terminate(); }
  }
  assert(results.every(r => r.primitiveBytesHash === results[0].primitiveBytesHash));
  const output = { passed: true, runtime: process.version, results };
  writeFileSync('.proof-tools/heap-compaction-records/workers.json', JSON.stringify(output, null, 2) + '\n');
  console.log(JSON.stringify({ passed: true, actualWorkers: results.length, allPrimitiveCompactedBytesIdentical: true, runtime: process.version }));
}
