/** Untimed built-entry insertion, retention and actual worker transport checks. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const json = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const snapshotOwner = (api, item) => Object.getPrototypeOf(api.SharedPriorityQueue).owner(item);
const prefix = owner => new Uint8Array(owner.memory.buffer).slice(65536, owner.used);
function plain(kind, item) {
  return [...item.entries()].map(([value, priority]) => [kind === 'nested' ? value.get('id') : value, priority]);
}
function fixture(api) {
  const Arena = snapshotOwner(api, new api.SharedPriorityQueue('number')).constructor;
  const owner = new Arena({ id: 'heap-insert-worker' }), nested = new Arena({ id: 'heap-insert-worker-nested' });
  const items = {}, kinds = {}, expected = {};
  for (const [name, kind, n, maxHeap] of [
    ['empty', 'number', 0, false], ['min', 'number', 65, false], ['max', 'number', 65, true],
    ['strings', 'string', 33, false], ['objects', 'object', 33, true], ['nested', 'nested', 17, false],
  ]) {
    let q = new api.SharedPriorityQueue(kind === 'nested' ? api.map('number') : kind, { maxHeap }, owner);
    for (let i = 0; i < n; i++) {
      const value = kind === 'number' ? i : kind === 'string' ? `heap-界-${i}` : kind === 'object' ? { id: i, inner: { n: i * 3 } }
        : new api.SharedMap('number', 0, 0, nested).set('id', i);
      q = q.enqueue(value, ((i * 37) % 31) - 15);
    }
    items[name] = q; kinds[name] = kind; expected[name] = plain(kind, q);
  }
  return { owner, items, kinds, expected };
}
function verify(items, kinds, expected) {
  for (const name of Object.keys(items)) {
    assert.deepEqual(plain(kinds[name], items[name]), expected[name]);
    assert.equal(items[name].size, expected[name].length);
  }
}
function exchange(worker, message) {
  return new Promise((resolveResult, reject) => {
    const timer = setTimeout(() => finish(new Error(`Worker timed out: ${message.command}`)), 30000);
    const onMessage = result => result.error ? finish(new Error(result.error)) : finish(null, result);
    const onError = error => finish(error);
    const onExit = code => finish(new Error(`Worker exited before response (${code})`));
    function finish(error, result) {
      clearTimeout(timer); worker.off('message', onMessage); worker.off('error', onError); worker.off('exit', onExit);
      if (error) reject(error); else resolveResult(result);
    }
    worker.once('message', onMessage); worker.once('error', onError); worker.once('exit', onExit);
    worker.postMessage(message);
  });
}
if (!isMainThread) {
  let api, items, kinds, expected, initial, owner, used, bytes;
  parentPort.on('message', async message => {
    try {
      if (message.command === 'attach') {
        api = await import(message.entry); items = await api.initWorker(message.data);
        kinds = message.kinds; expected = message.expected; verify(items, kinds, expected);
        owner = snapshotOwner(api, items.min); used = owner.used; bytes = prefix(owner);
        initial = Object.fromEntries(Object.entries(items).map(([name, item]) => [name, item.toWorkerData()]));
        for (const item of Object.values(items)) assert.throws(() => item.enqueue(0, 0), /read-only/);
        parentPort.postMessage({ stage: 'ready', marker: new Uint8Array(owner.memory.buffer)[60000] });
      } else if (message.command === 'read-during-write') {
        const control = new Int32Array(message.control);
        Atomics.store(control, 0, 1); Atomics.notify(control, 0);
        let reads = 0;
        do {
          assert.equal(items.min.peek(), expected.min[0][0]);
          assert.equal(items.max.peek(), expected.max[0][0]);
          if (++reads % 128 === 0) verify(items, kinds, expected);
          if (reads > 10000000) throw new Error('Writer did not finish within bounded read loop');
        } while (reads < 1024 || Atomics.load(control, 1) === 0);
        verify(items, kinds, expected);
        assert.equal(owner.used, used);
        assert.equal(Buffer.compare(prefix(owner), bytes), 0, 'Old reader bytes changed');
        for (const [name, item] of Object.entries(items)) assert.deepEqual(item.toWorkerData(), initial[name]);
        parentPort.postMessage({ stage: 'retained', reads, marker: new Uint8Array(owner.memory.buffer)[60000], oldPayloadSha256: digest(bytes) });
      } else if (message.command === 'next') {
        const next = await api.initWorker(message.data);
        assert.deepEqual(plain('number', next.next), message.expected);
        verify(items, kinds, expected);
        parentPort.postMessage({ stage: 'next', size: next.next.size, oldStillValid: true });
      } else throw new Error('Unknown worker message');
    } catch (error) { parentPort.postMessage({ error: String(error.stack ?? error) }); }
  });
}
export async function checkBuiltEntries({ baselineRoot, candidateRoot, evidenceRoot }) {
  mkdirSync(evidenceRoot, { recursive: true });
  const runtime = process.versions.bun ? 'bun' : 'node';
  const report = { runtime, node: process.versions.node, bun: process.versions.bun ?? null, complete: false, rows: [], latencyCollected: false };
  const path = join(evidenceRoot, `heap-insert-workers-${runtime}.json`), raw = path + '.rows.jsonl';
  writeFileSync(raw, '', { flag: 'wx' }); json(path, report);
  let reference;
  try {
    for (const [arm, root] of Object.entries({ baseline: baselineRoot, candidate: candidateRoot })) for (const copy of [false, true]) {
      const entry = pathToFileURL(join(resolve(root), 'dist/shared.js')).href, api = await import(entry);
      const { owner, items, kinds, expected } = fixture(api);
      if (!reference) reference = expected; else assert.deepEqual(expected, reference, 'Cross-arm logical output differs');
      const used = owner.used, old = prefix(owner), beforeCapacity = owner.memory.buffer.byteLength;
      new Uint8Array(owner.memory.buffer)[60000] = 17;
      const worker = new Worker(new URL(import.meta.url));
      report.current = { arm, copy }; json(path, report);
      try {
        const data = api.getWorkerData(items, { copy });
        assert(data.arenas.every(a => copy ? a.copy && !a.memory : a.memory && !a.copy));
        const ready = await exchange(worker, { command: 'attach', entry, data, kinds, expected });
        assert.equal(ready.stage, 'ready'); assert.equal(ready.marker, 17);
        const control = new SharedArrayBuffer(8), signal = new Int32Array(control);
        const reading = exchange(worker, { command: 'read-during-write', control });
        assert.notEqual(Atomics.wait(signal, 0, 0, 10000), 'timed-out');
        let next = items.min;
        try {
          for (let i = 0; i < 2048; i++) next = next.enqueue(10000 + i, -10000 - i);
          owner.alloc(beforeCapacity); // Force growth while the worker retains old roots.
          new Uint8Array(owner.memory.buffer)[60000] = 99;
        } finally { Atomics.store(signal, 1, 1); Atomics.notify(signal, 1); }
        const retained = await reading;
        assert.equal(retained.stage, 'retained'); assert(retained.reads >= 1024);
        assert.equal(retained.marker, copy ? 17 : 99);
        assert.equal(retained.oldPayloadSha256, digest(old));
        assert(owner.memory.buffer.byteLength > beforeCapacity);
        assert.equal(Buffer.compare(new Uint8Array(owner.memory.buffer).slice(65536, used), old), 0);
        verify(items, kinds, expected);
        const attached = await exchange(worker, { command: 'next', data: api.getWorkerData({ next }, { copy }), expected: plain('number', next) });
        assert.equal(attached.stage, 'next'); assert.equal(attached.size, 2113);
        const row = { arm, copy, fixtureQueues: 6, beforeCapacity, afterCapacity: owner.memory.buffer.byteLength, usedBefore: used,
          usedAfter: owner.used, ...retained, ...attached };
        report.rows.push(row); appendFileSync(raw, JSON.stringify(row) + '\n'); json(path, report);
      } finally { await worker.terminate(); }
    }
    delete report.current; report.complete = true; json(path, report);
    console.log(JSON.stringify({ passed: true, runtime, actualWorkers: 4, cases: 24, sharedAndCopied: true, concurrentInsertion: true,
      oldBytesPreserved: true, growth: true, repeatedAttachment: true, latencyCollected: false }));
    return report;
  } catch (error) { report.error = String(error.stack ?? error); json(path, report); throw error; }
}
if (isMainThread && process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [baselineRoot, candidateRoot, evidenceRoot] = process.argv.slice(2);
  assert(baselineRoot && candidateRoot && evidenceRoot);
  await checkBuiltEntries({ baselineRoot, candidateRoot, evidenceRoot });
}
