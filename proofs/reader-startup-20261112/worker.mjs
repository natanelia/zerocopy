import assert from 'node:assert/strict';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { calculate, deepFreeze, entriesFor, editsFor, queryIds, indexOfId } from '../../website/assets/catalog-core.mjs';
import { reference, verifyAnswer } from '../../website/assets/catalog-reference.mjs';

const [root, workload, count] = isMainThread ? [resolve(process.argv[2]), process.argv[3], Number(process.argv[4])]
  : [workerData.root, workerData.workload, workerData.count];
const api = await import(pathToFileURL(resolve(root, 'dist/shared.js')));
const asMap = collection => workload === 'object-list' ? { get: id => collection.get(indexOfId(id)) } : collection;
function numberQuery(map, ids) {
  let found = 0, missing = 0, sum = 0;
  for (const id of ids) { const value = map.get(id); if (value === undefined) missing++; else { found++; sum += value; } }
  return { found, missing, sum };
}
if (!isMainThread) {
  let current, retained;
  parentPort.on('message', async message => {
    try {
      let result;
      if (message.type === 'attach') {
        current = (await api.initWorker(message.payload)).values;
        retained ??= current; result = current.size;
      } else if (message.type === 'query') {
        const map = asMap(message.frozen ? retained : current);
        result = workload === 'number-map' ? numberQuery(map, message.ids) : calculate(map, message.ids, workerData.task);
      } else throw new Error('Unknown worker operation');
      parentPort.postMessage({ id: message.id, result });
    } catch (error) { parentPort.postMessage({ id: message.id, error: error.stack }); }
  });
  parentPort.postMessage({ id: 0, result: 'ready' });
} else {
  const peers = [];
  function peer(task) {
    const worker = new Worker(new URL(import.meta.url), { workerData: { root, workload, count, task } });
    let nextId = 0;
    const pending = new Map();
    const ready = new Promise((resolve, reject) => pending.set(0, { resolve, reject }));
    const fail = error => { for (const entry of pending.values()) entry.reject(error); pending.clear(); };
    worker.on('message', message => {
      const entry = pending.get(message.id); if (!entry) return;
      pending.delete(message.id); message.error ? entry.reject(new Error(message.error)) : entry.resolve(message.result);
    });
    worker.on('error', fail); worker.on('exit', code => fail(new Error(`Reader exited (${code})`)));
    return { worker, ready, request(type, body) {
      const id = ++nextId;
      return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); worker.postMessage({ id, type, ...body }); });
    } };
  }
  const timeout = setTimeout(() => { console.error('Reader benchmark sample timed out'); process.exit(1); }, 110000);
  try {
    peers.push(peer('lookup'), peer('validate')); await Promise.all(peers.map(peer => peer.ready));
    let entries = entriesFor(count);
    if (workload === 'number-map') entries = entries.map(([key], i) => [key, i + 0.5]);
    const values = workload === 'object-list' ? entries.map(([, value]) => value) : undefined;
    const primitiveExpected = workload === 'number-map' ? new Map(entries) : undefined;
    let start = performance.now();
    // Match feature-storage.build: input freezing is part of construction.
    for (const [, value] of entries) deepFreeze(value);
    let current = workload === 'object-list' ? new api.SharedList('object').pushMany(values)
      : new api.SharedMap(workload === 'number-map' ? 'number' : 'object').setMany(entries);
    const times = { constructionMs: performance.now() - start }, retained = current;
    async function publish() {
      const payload = api.getWorkerData({ values: current }, { copy: false });
      if (payload.arenas.some(arena => arena.copy || !(arena.memory?.buffer instanceof SharedArrayBuffer))) throw new Error('Shared publication required');
      return Promise.all(peers.map(peer => peer.request('attach', { payload })));
    }
    start = performance.now(); const initialSizes = await publish(); times.publicationMs = performance.now() - start;
    assert.deepEqual(initialSizes, [count, count]);
    const ids = queryIds(count);
    async function query(phase, frozen = false, revision = 0) {
      const start = performance.now();
      const replies = await Promise.all(peers.map(peer => peer.request('query', { ids, frozen })));
      times[phase] = performance.now() - start;
      const expected = workload === 'number-map' ? numberQuery(primitiveExpected, ids) : reference(count, revision, ids);
      for (let index = 0; index < replies.length; index++) {
        if (workload === 'number-map') assert.deepEqual(replies[index], expected);
        else verifyAnswer(replies[index], expected, index ? 'validate' : 'lookup');
      }
      return replies;
    }
    const first = await query('firstQueryMs'); await query('repeatQueryMs');
    times.readyMs = times.constructionMs + times.publicationMs + times.firstQueryMs;
    if (workload !== 'number-map') {
      const changes = editsFor(count, 1), listChanges = workload === 'object-list' ? changes.map(([id, value]) => [indexOfId(id), value]) : undefined;
      start = performance.now();
      for (const [, value] of changes) deepFreeze(value);
      current = current.setMany(listChanges ?? changes); times.updateMs = performance.now() - start;
      start = performance.now(); const updatedSizes = await publish(); times.editPublicationMs = performance.now() - start;
      assert.deepEqual(updatedSizes, [count, count]);
      await query('updatedQueryMs', false, 1); await query('retainedQueryMs', true);
    }
    // Full initial output and nested freezing are checked after all timed reads.
    const ownerMap = asMap(retained);
    for (const [id, value] of entries) assert.deepEqual(ownerMap.get(id), value);
    if (workload !== 'number-map') {
      const value = ownerMap.get('product/000000');
      assert.ok(Object.isFrozen(value) && Object.isFrozen(value.metadata) && Object.isFrozen(value.metadata.tags) && Object.isFrozen(value.attributes));
    }
    const verification = workload === 'number-map' ? first[0] : { lookup: first[0].lookup.fingerprint,
      validation: first[1].validation.fingerprint, found: first[0].lookup.found, missing: first[0].lookup.missing };
    console.log(JSON.stringify({ times, verified: true, verification, arenaUsedBytes: current.arena.used,
      arenaCapacityBytes: current.arena.memory.buffer.byteLength }));
  } finally { clearTimeout(timeout); await Promise.all(peers.map(peer => peer.worker.terminate())); }
}
