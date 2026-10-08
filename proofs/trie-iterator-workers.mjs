import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const modulePath = process.argv[2] ?? new URL('../dist/shared.js', import.meta.url).pathname;
const moduleURL = pathToFileURL(resolve(modulePath)).href;
const api = await import(moduleURL);
function request(worker, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Trie iterator worker timed out')), 30000);
    const receive = result => result.type === 'error' ? finish(new Error(result.error)) : finish(null, result);
    const fail = error => finish(error);
    const exit = code => finish(new Error(`Worker exited before replying (${code})`));
    function finish(error, value) {
      clearTimeout(timer); worker.off('message', receive); worker.off('error', fail); worker.off('exit', exit);
      if (error) reject(error); else resolve(value);
    }
    worker.once('message', receive); worker.once('error', fail); worker.once('exit', exit);
    try { worker.postMessage(message); } catch (error) { finish(error); }
  });
}

for (const copy of [false, true]) {
  // A fresh writer per transport also proves iterator state is payload-local.
  api.resetMap();
  const empty = new api.SharedMap('number');
  const single = empty.set('only', 1);
  const canonical = empty.setMany(Array.from({ length: 512 }, (_, i) => [`key${i}`, i]));
  let patched = canonical;
  for (let i = 0; i < 47; i++) patched = patched.set(`key${i * 7}`, -i - 1);
  const fork = canonical.delete('key1').set('fork', 7);
  const collision = empty.setMany([['costarring', 1], ['liquid', 2]]);
  const objects = new api.SharedMap('object').setMany([['a', { nested: [1, 2] }], ['b', { unicode: '🙂' }]]);
  const nested = new api.SharedMap('SharedMap<number>').set('child', patched);
  let set = new api.SharedSet(); for (const value of [1, '1', 0, -1, NaN, Infinity, '', '🙂']) set = set.add(value);
  const items = { empty, single, canonical, patched, fork, collision, objects, nested, set };
  const expected = {};
  for (const [name, item] of Object.entries(items)) {
    if (name === 'nested' || name === 'set') continue;
    const entries = [...item.entries()];
    expected[name] = { entries, keys: entries.map(([k]) => k), values: entries.map(([, v]) => v), visited: entries, rejected: true };
  }
  expected.nested = [...patched.entries()]; expected.set = [...set.values()];
  const shared = api.getWorkerData(items, { copy: false });
  const saved = shared.arenas.map(a => ({ memory: a.memory, length: a.memory.buffer.byteLength, bytes: new Uint8Array(a.memory.buffer).slice(65536, a.used) }));
  const payload = api.getWorkerData(items, { copy });
  assert.ok(payload.arenas.every(a => copy ? a.copy && !a.memory : a.memory && !a.copy));
  const worker = new Worker(new URL('./trie-iterator-worker.mjs', import.meta.url));
  try {
    assert.equal((await request(worker, { type: 'attach', data: payload, module: moduleURL })).type, 'paused');
    new api.SharedMap('string').set('grown', 'x'.repeat(2_000_000));
    assert.ok(saved.some(a => a.memory.buffer.byteLength > a.length), 'writer must grow while worker iterators are paused');
    const reply = await request(worker, { type: 'resume' });
    assert.equal(reply.type, 'done'); assert.deepEqual(reply.result, expected);
    for (const a of saved) assert.deepEqual(new Uint8Array(a.memory.buffer, 65536, a.bytes.length), a.bytes);
    console.log(`${copy ? 'copied' : 'shared'}: real worker, paused growth, snapshots, forks, collision, nested values, sets, callback reentry, early termination, read-only bytes passed`);
  } finally { await worker.terminate(); }
}
