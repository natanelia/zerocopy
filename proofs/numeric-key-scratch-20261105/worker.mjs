import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { ignoreBOM: true });
const normalize = key => decoder.decode(encoder.encode(key));
const kinds = [['SharedMap', 'resetMap'], ['SharedOrderedMap', 'resetOrderedMap'], ['SharedSortedMap', 'resetSortedMap']];
const keys = ['ascii', '\ufeffkey', '界🙂\ud800', '\udc00', '\ufffd', '界'.repeat(16381),
  '界'.repeat(16379) + '🙂', 'a'.repeat(16381) + '界', '界'.repeat(16381) + 'a', '界'.repeat(16382)];
const specials = [NaN, -0, Infinity, -Infinity, 1.25];

function verify(api, snapshots, expected) {
  let checked = 0;
  for (const [name, modelEntries] of Object.entries(expected)) {
    const item = snapshots[name], model = new Map(modelEntries);
    assert.equal(item.size, model.size); assert.ok(Object.isFrozen(item));
    const actual = [...item.entries()]; assert.equal(actual.length, model.size);
    const seen = new Set();
    for (const [key, value] of actual) { assert.ok(model.has(key) && !seen.has(key)); assert.ok(Object.is(value, model.get(key))); seen.add(key); checked++; }
    if (name.startsWith('SharedOrderedMap')) assert.deepEqual(actual.map(pair => pair[0]), [...model.keys()]);
    if (name.startsWith('SharedSortedMap')) assert.deepEqual(actual.map(pair => pair[0]), [...model.keys()].sort((a, b) => Buffer.compare(encoder.encode(a), encoder.encode(b))));
    for (const [key, value] of model) assert.ok(Object.is(item.get(key), value));
    assert.throws(() => item.set('blocked界', 99), /read-only/);
  }
  const data = api.getWorkerData(snapshots, { copy: false });
  assert.equal(data.arenas.length, 3);
  return checked;
}

if (!isMainThread) {
  const api = await import(workerData.entry);
  const old = await api.initWorker(workerData.payload);
  const used = workerData.payload.arenas.map(arena => arena.used);
  // Writer scratch is mutable. Only published bytes are retained across writes.
  const retained = api.getWorkerData(old, { copy: false }).arenas.map((arena, i) => ({ memory: arena.memory, used: used[i],
    hash: sha(new Uint8Array(arena.memory.buffer, 65536, used[i] - 65536)) }));
  let checks = verify(api, old, workerData.expected);
  parentPort.postMessage({ phase: 'ready', checks });
  parentPort.once('message', async ({ payload, expected }) => {
    try {
      checks += verify(api, old, workerData.expected);
      for (const item of retained) assert.equal(sha(new Uint8Array(item.memory.buffer, 65536, item.used - 65536)), item.hash);
      const fresh = await api.initWorker(payload); checks += verify(api, fresh, expected);
      parentPort.postMessage({ phase: 'complete', checks, transport: workerData.copy ? 'copy' : 'shared' });
    } catch (error) { parentPort.postMessage({ phase: 'failed', error: String(error?.stack ?? error) }); }
  });
} else {
  const entry = pathToFileURL(resolve(process.argv[2] ?? 'dist/shared.js')).href, api = await import(entry);
  const results = [];
  const wait = (worker, phase) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`Worker deadline: ${phase}`)); }, 60000);
    const message = result => { cleanup(); result.phase === phase ? resolve(result) : reject(new Error(JSON.stringify(result))); };
    const error = cause => { cleanup(); reject(cause); };
    const exit = code => { cleanup(); reject(new Error(`Worker exited before ${phase}: ${code}`)); };
    const cleanup = () => { clearTimeout(timer); worker.off('message', message); worker.off('error', error); worker.off('exit', exit); };
    worker.on('message', message); worker.on('error', error); worker.on('exit', exit);
  });
  for (const copy of [false, true]) {
    const snapshots = {}, expected = {};
    for (const [kind, reset] of kinds) {
      api[reset](); let old = new api[kind]('number'); const model = new Map();
      for (const [i, key] of keys.entries()) { old = old.set(key, specials[i % specials.length]); model.set(normalize(key), specials[i % specials.length]); }
      snapshots[`${kind}Old`] = old; expected[`${kind}Old`] = [...model];
      snapshots[`${kind}Fork`] = old.set('fork🙂', -0); expected[`${kind}Fork`] = [...new Map(model).set('fork🙂', -0)];
    }
    const payload = api.getWorkerData(snapshots, { copy }); assert.equal(payload.arenas.length, 3);
    const worker = new Worker(new URL(import.meta.url), { workerData: { entry, payload, expected, copy } });
    try {
      await wait(worker, 'ready');
      const owners = api.getWorkerData(snapshots, { copy: false }).arenas;
      const before = owners.map(arena => ({ memory: arena.memory, used: arena.used,
        bytes: new Uint8Array(arena.memory.buffer, 65536, arena.used - 65536).slice() }));
      for (const owner of owners) owner.memory.grow(2);
      const fresh = {}, nextExpected = {};
      for (const [kind] of kinds) {
        const key = 'larger界' + '路'.repeat(49145), name = `${kind}Next`;
        fresh[name] = snapshots[`${kind}Old`].set(key, 33).set('after🙂', Infinity);
        nextExpected[name] = [...new Map(expected[`${kind}Old`]).set(key, 33).set('after🙂', Infinity)];
      }
      for (const old of before) assert.deepEqual(new Uint8Array(old.memory.buffer, 65536, old.used - 65536), old.bytes);
      const complete = wait(worker, 'complete');
      worker.postMessage({ payload: api.getWorkerData(fresh, { copy }), expected: nextExpected });
      results.push(await complete);
    } finally { await worker.terminate(); }
  }
  console.log(JSON.stringify({ status: 'complete', workers: results, runtime: process.versions }));
}
