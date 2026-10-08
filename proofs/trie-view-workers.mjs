import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const moduleURL = pathToFileURL(resolve(process.argv[2] ?? new URL('../dist/shared.js', import.meta.url).pathname)).href;
const api = await import(moduleURL);
function request(worker, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Trie view worker timed out')), 30000);
    const receive = result => result.type === 'error' ? finish(new Error(result.error)) : finish(null, result);
    const fail = error => finish(error), exit = code => finish(new Error(`Worker exited before replying (${code})`));
    function finish(error, value) {
      clearTimeout(timer); worker.off('message', receive); worker.off('error', fail); worker.off('exit', exit);
      if (error) reject(error); else resolve(value);
    }
    worker.once('message', receive); worker.once('error', fail); worker.once('exit', exit);
    try { worker.postMessage(message); } catch (error) { finish(error); }
  });
}
for (const copy of [false, true]) {
  api.resetMap(); api.resetSortedMap();
  const empty = new api.SharedMap('number'), single = empty.set('only', 1);
  const canonical = empty.setMany(Array.from({ length: 512 }, (_, i) => [`key${i}`, i]));
  let patched = canonical;
  for (let i = 0; i < 47; i++) patched = patched.set(`key${i * 7}`, -i - 1);
  const fork = canonical.delete('key1').set('fork', 7), collision = empty.setMany([['costarring', 1], ['liquid', 2]]);
  const objects = new api.SharedMap('object').setMany([['a', { nested: [1, 2] }], ['🙂', { unicode: 'é\0\ufeff' }]]);
  const strings = new api.SharedMap('string').setMany([['\ud800', '\ufeff🙂'], ['é', ''], ['\0', 'zero']]);
  const booleans = new api.SharedMap('boolean').setMany([['false', false], ['true', true]]);
  const sortedEmpty = new api.SharedSortedMap('number'), sortedSingle = sortedEmpty.set('only', 1);
  let sorted = sortedEmpty;
  for (let i = 0; i < 512; i++) sorted = sorted.set(`key${i}`, i);
  const sortedFork = sorted.set('key17', -17).delete('key3').set('🙂', 17);
  const sortedObjects = new api.SharedSortedMap('object').set('🙂', { a: [1, null] }).set('é', { b: false });
  const nested = new api.SharedMap('SharedMap<number>').set('child', patched);
  const list = new api.SharedSortedMap('SharedList<number>').set('child', new api.SharedList('number').pushMany([1, 2, 3]));
  let set = new api.SharedSet(), sortedSet = new api.SharedSortedSet();
  for (const value of [1, '1', 0, -1, NaN, Infinity, '', '🙂']) { set = set.add(value); sortedSet = sortedSet.add(value); }
  const items = { empty, single, canonical, patched, fork, collision, objects, strings, booleans, sortedEmpty, sortedSingle, sorted, sortedFork, sortedObjects, nested, list, set, sortedSet };
  const expected = {};
  for (const [name, item] of Object.entries(items)) {
    if (['nested', 'list', 'set', 'sortedSet'].includes(name)) continue;
    const entries = [...item.entries()]; expected[name] = { entries, keys: entries.map(([k]) => k), values: entries.map(([, v]) => v), visited: entries };
  }
  expected.nested = [...patched.entries()]; expected.list = [1, 2, 3]; expected.set = [...set.values()]; expected.sortedSet = [...sortedSet.values()];
  const saved = api.getWorkerData(items, { copy: false }).arenas.map(a => ({ memory: a.memory, bytes: new Uint8Array(a.memory.buffer).slice(65536, a.used) }));
  const payload = api.getWorkerData(items, { copy });
  assert.ok(payload.arenas.every(a => copy ? a.copy && !a.memory : a.memory && !a.copy));
  const worker = new Worker(new URL('./trie-view-worker.mjs', import.meta.url));
  try {
    assert.equal((await request(worker, { type: 'attach', data: payload, module: moduleURL })).type, 'created');
    // Grow every writer arena before any reader iterator's first next().
    for (const a of saved) { const old = a.memory.buffer; a.memory.grow(1); assert.notEqual(a.memory.buffer, old); }
    assert.equal((await request(worker, { type: 'first' })).type, 'paused');
    // Ordinary and sorted writers allocate/grow while both readers are paused.
    const lengths = saved.map(a => a.memory.buffer.byteLength);
    new api.SharedMap('string').set('grow', 'x'.repeat(2_000_000));
    new api.SharedSortedMap('string').set('grow', 'y'.repeat(2_000_000));
    assert.ok(saved.filter((a, i) => a.memory.buffer.byteLength > lengths[i]).length >= 2);
    const reply = await request(worker, { type: 'resume' });
    assert.equal(reply.type, 'done'); assert.deepEqual(reply.result, expected); assert.equal(reply.allocatedSharedBytes, 0);
    for (const a of saved) assert.deepEqual(new Uint8Array(a.memory.buffer, 65536, a.bytes.length), a.bytes);
    console.log(JSON.stringify({ transport: copy ? 'copy' : 'shared', structures: Object.keys(items).length, verifiedArenas: reply.verifiedArenas, allocatedSharedBytes: 0, writerGrowthBeforeFirstRead: true, writerGrowthWhilePaused: true, readerSharesWriterMemory: !copy, interleaved: 2, sourceBytesUnchanged: true }));
  } finally { await worker.terminate(); }
}
