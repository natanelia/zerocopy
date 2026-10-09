/** Untimed linked/doubly snapshots, append/indexed writes and actual worker transport. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const json = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const snapshotOwner = (api, item) => Object.getPrototypeOf(api.SharedLinkedList).owner(item);
const prefix = owner => new Uint8Array(owner.memory.buffer).slice(65536, owner.used);
const insert = (item, index, value) => index === 0 ? item.prepend(value) : item.insertAfter(index - 1, value);
function fixture(api) {
  const Arena = snapshotOwner(api, new api.SharedLinkedList('number')).constructor;
  const owner = new Arena({ id: 'block-reuse-worker' }), items = {}, expected = {};
  for (const [kind, List] of [['linked', api.SharedLinkedList], ['doubly', api.SharedDoublyLinkedList]]) {
    let item = new List('number', 0, 0, 0, owner);
    items[kind + '0'] = item; expected[kind + '0'] = [];
    for (let i = 0; i < 1024; i++) {
      item = item.append(i);
      if ([31, 32, 33, 1024].includes(item.size)) {
        items[kind + item.size] = item; expected[kind + item.size] = Array.from({ length: item.size }, (_, j) => j);
      }
    }
    const values = Array.from({ length: item.size }, (_, j) => j);
    for (let i = 0; i < 64; i++) {
      const index = i % 3 === 0 ? 0 : i % 3 === 1 ? Math.floor(item.size / 2) : item.size - 1;
      item = insert(item, index, -i - 1); values.splice(index, 0, -i - 1);
    }
    items[kind] = item; expected[kind] = values;
  }
  return { owner, items, expected };
}
function verify(items, expected) {
  assert.deepEqual(Object.keys(items).sort(), Object.keys(expected).sort());
  for (const [name, item] of Object.entries(items)) {
    const values = expected[name];
    assert.deepEqual(item.toArray(), values, name);
    assert.equal(item.size, values.length, name);
    assert.equal(item.getFirst(), values[0], name);
    assert.equal(item.getLast(), values.at(-1), name);
    for (const index of [0, 31, 32, Math.floor(values.length / 2), values.length - 1])
      assert.equal(item.get(index), values[index], `${name}[${index}]`);
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
  let api, items, expected, initial, owner, used, bytes;
  parentPort.on('message', async message => {
    try {
      if (message.command === 'attach') {
        api = await import(message.entry); items = await api.initWorker(message.data);
        expected = message.expected; verify(items, expected);
        owner = snapshotOwner(api, items.linked); used = owner.used; bytes = prefix(owner);
        initial = Object.fromEntries(Object.entries(items).map(([name, item]) => [name, item.toWorkerData()]));
        for (const item of Object.values(items)) assert.throws(() => item.append(0), /read-only/);
        parentPort.postMessage({ stage: 'ready', marker: new Uint8Array(owner.memory.buffer)[60000] });
      } else if (message.command === 'read-during-write') {
        const control = new Int32Array(message.control);
        Atomics.store(control, 0, 1); Atomics.notify(control, 0);
        let reads = 0;
        do {
          assert.equal(items.linked.get(32), expected.linked[32]);
          assert.equal(items.doubly.getLast(), expected.doubly.at(-1));
          if (++reads % 128 === 0) verify(items, expected);
          if (reads > 10000000) throw new Error('Writer did not finish within bounded read loop');
        } while (reads < 1024 || Atomics.load(control, 1) === 0);
        verify(items, expected);
        assert.equal(owner.used, used);
        assert.equal(Buffer.compare(prefix(owner), bytes), 0, 'Old reader arena bytes changed');
        for (const [name, item] of Object.entries(items)) assert.deepEqual(item.toWorkerData(), initial[name]);
        parentPort.postMessage({ stage: 'retained', reads, marker: new Uint8Array(owner.memory.buffer)[60000],
          oldPayloadSha256: digest(bytes) });
      } else if (message.command === 'next') {
        const next = await api.initWorker(message.data);
        verify(next, message.expected); verify(items, expected);
        assert.equal(owner.used, used, 'Attaching new snapshots changed the old reader frontier');
        assert.equal(Buffer.compare(prefix(owner), bytes), 0, 'Reattachment changed old arena bytes');
        parentPort.postMessage({ stage: 'next', linkedSize: next.linked.size, doublySize: next.doubly.size, oldStillValid: true });
      } else throw new Error('Unknown worker message');
    } catch (error) { parentPort.postMessage({ error: String(error.stack ?? error) }); }
  });
}
export async function checkBuiltEntries({ baselineRoot, candidateRoot, evidenceRoot }) {
  mkdirSync(evidenceRoot, { recursive: true });
  const runtime = process.versions.bun ? 'bun' : 'node';
  const roots = { baseline: baselineRoot, candidate: candidateRoot };
  const report = { runtime, node: process.versions.node, bun: process.versions.bun ?? null,
    complete: false, rows: [], latencyCollected: false };
  const path = join(evidenceRoot, `block-reuse-workers-${runtime}.json`), raw = path + '.rows.jsonl';
  writeFileSync(raw, '', { flag: 'wx' }); json(path, report);
  let reference;
  try {
    for (const [writer, root] of Object.entries(roots)) for (const [reader, readerRoot] of Object.entries(roots)) for (const copy of [false, true]) {
      const entry = pathToFileURL(join(resolve(root), 'dist/shared.js')).href, api = await import(entry);
      const readerEntry = pathToFileURL(join(resolve(readerRoot), 'dist/shared.js')).href;
      const { owner, items, expected } = fixture(api);
      if (!reference) reference = expected; else assert.deepEqual(expected, reference, 'Cross-arm logical output differs');
      verify(items, expected);
      const used = owner.used, old = prefix(owner), beforeCapacity = owner.memory.buffer.byteLength;
      new Uint8Array(owner.memory.buffer)[60000] = 17;
      const worker = new Worker(new URL(import.meta.url));
      report.current = { writer, reader, copy }; json(path, report);
      try {
        const data = api.getWorkerData(items, { copy });
        assert(data.arenas.every(a => copy ? a.copy && !a.memory : a.memory && !a.copy));
        const ready = await exchange(worker, { command: 'attach', entry: readerEntry, data, expected });
        assert.equal(ready.stage, 'ready'); assert.equal(ready.marker, 17);
        const control = new SharedArrayBuffer(8), signal = new Int32Array(control);
        const reading = exchange(worker, { command: 'read-during-write', control });
        // Attach a rejection handler while the main thread is doing synchronous
        // writes; the awaited result below remains the authority for success.
        reading.catch(() => {});
        assert.notEqual(Atomics.wait(signal, 0, 0, 10000), 'timed-out');
        const next = { linked: items.linked, doubly: items.doubly };
        const nextExpected = { linked: [...expected.linked], doubly: [...expected.doubly] };
        try {
          for (const kind of ['linked', 'doubly']) {
            for (let i = 0; i < 2048; i++) {
              next[kind] = next[kind].append(10000 + i); nextExpected[kind].push(10000 + i);
            }
            for (let i = 0; i < 256; i++) {
              const index = i % 3 === 0 ? 0 : i % 3 === 1 ? Math.floor(next[kind].size / 2) : next[kind].size - 1;
              next[kind] = insert(next[kind], index, -10000 - i); nextExpected[kind].splice(index, 0, -10000 - i);
            }
          }
          owner.alloc(owner.memory.buffer.byteLength); // Force growth while old readers are active.
          new Uint8Array(owner.memory.buffer)[60000] = 99;
        } finally { Atomics.store(signal, 1, 1); Atomics.notify(signal, 1); }
        const retained = await reading;
        assert.equal(retained.stage, 'retained'); assert(retained.reads >= 1024);
        assert.equal(retained.marker, copy ? 17 : 99);
        assert.equal(retained.oldPayloadSha256, digest(old));
        assert(owner.memory.buffer.byteLength > beforeCapacity);
        assert.equal(Buffer.compare(new Uint8Array(owner.memory.buffer).slice(65536, used), old), 0);
        verify(items, expected); verify(next, nextExpected);
        const attached = await exchange(worker, { command: 'next', data: api.getWorkerData(next, { copy }), expected: nextExpected });
        assert.equal(attached.stage, 'next'); assert.equal(attached.linkedSize, 3392); assert.equal(attached.doublySize, 3392);
        const row = { writer, reader, copy, fixtureSnapshots: Object.keys(items).length, writes: { append: 4096, indexed: 512 },
          beforeCapacity, afterCapacity: owner.memory.buffer.byteLength, usedBefore: used, usedAfter: owner.used, ...retained, ...attached };
        report.rows.push(row); appendFileSync(raw, JSON.stringify(row) + '\n'); json(path, report);
      } finally { await worker.terminate(); }
    }
    delete report.current; report.complete = true; json(path, report);
    console.log(JSON.stringify({ passed: true, runtime, actualWorkers: 8, crossVersion: true, sharedAndCopied: true,
      linkedAndDoubly: true, concurrentAppendAndIndexedInsertion: true, oldBytesPreserved: true, growth: true,
      repeatedAttachment: true, latencyCollected: false }));
    return report;
  } catch (error) { report.error = String(error.stack ?? error); json(path, report); throw error; }
}
if (isMainThread && process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [baselineRoot, candidateRoot, evidenceRoot] = process.argv.slice(2);
  assert(baselineRoot && candidateRoot && evidenceRoot);
  await checkBuiltEntries({ baselineRoot, candidateRoot, evidenceRoot });
}
