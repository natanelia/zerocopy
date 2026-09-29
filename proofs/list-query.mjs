import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
const entry = process.env.QUERY_PROOF_ENTRY ?? new URL('../dist/shared.js', import.meta.url).href;
const api = await import(entry);
const { SharedList, getWorkerData, initWorker, resetSharedList } = api;
const data = size => Array.from({ length: size }, (_, i) => i % 7 ? i + .25 : -i);
const memoryOf = list => getWorkerData({ list }, { copy: false }).arenas[0].memory;
const rawAt = (list, index) => {
  const d = list.toWorkerData(), view = new DataView(memoryOf(list).buffer);
  let leaf = d.tail;
  if (index < ((d.size - 1) & ~31)) {
    leaf = d.root;
    for (let depth = d.depth; depth > 0; depth--) leaf = view.getUint32(leaf + ((index >>> (depth * 5)) & 31) * 4, true);
  }
  return view.getFloat64(leaf + (index & 31) * 8, true);
};
if (!isMainThread) {
  const state = await initWorker(workerData);
  parentPort.on('message', () => {
    try {
      for (const [key, list] of Object.entries(state)) {
        for (let i = 0; i < list.size; i++) assert.equal(list.get(i), key === 'text' ? `kind-${i % 7}` : i + Number(key.slice(1)));
      }
      parentPort.postMessage({ ok: true });
    } catch (error) { parentPort.postMessage({ error: error.stack }); }
  });
  parentPort.postMessage({ ready: true });
} else {
  test('interleaved frozen columns preserve every leaf and tail across boundaries', async () => {
    for (const size of [0, 1, 31, 32, 33, 1023, 1024, 1025, 32767, 32768, 32769]) {
      resetSharedList();
      const values = data(size);
      const first = new SharedList('number').pushMany(values);
      const second = new SharedList('number').pushMany(values.map(x => x + 100));
      const original = { first, second };
      for (const columns of [original, await initWorker(getWorkerData(original, { copy: false })), await initWorker(getWorkerData(original, { copy: true }))]) {
        assert.ok(Object.isFrozen(columns.first));
        assert.deepEqual(Object.keys(columns.first).sort(), ['depth', 'root', 'size', 'tail', 'type']);
        for (let i = 0; i < size; i++) {
          assert.ok(Object.is(columns.first.get(i), values[i]));
          assert.ok(Object.is(columns.second.get(i), values[i] + 100));
          const reverse = size - i - 1;
          assert.ok(Object.is(columns.first.get(reverse), values[reverse]));
        }
        for (const i of [-1, size, .5, NaN, Infinity, '0', undefined, null, 2 ** 32]) assert.equal(columns.first.get(i), undefined);
      }
    }
  });
  test('forks, pops, resets and memory growth never change a cached read', () => {
    resetSharedList();
    const values = data(1100), original = new SharedList('number').pushMany(values);
    const tail = new SharedList('number').pushMany([NaN, -0, Infinity, -Infinity]);
    for (let i = 0; i < tail.size; i++) assert.ok(Object.is(tail.get(i), [NaN, -0, Infinity, -Infinity][i]));
    original.get(1024); original.get(0); tail.get(0);
    const before = memoryOf(original).buffer;
    const fork = original.set(0, 99).set(1056, 88).pushMany(data(100000));
    assert.ok(memoryOf(original).buffer.byteLength > before.byteLength);
    resetSharedList(); new SharedList('number').pushMany(data(4000));
    assert.equal(original.get(0), values[0]); assert.equal(original.get(1056), values[1056]);
    assert.equal(original.get(1099), values[1099]); assert.equal(fork.get(0), 99); assert.equal(fork.get(1056), 88);
    let popped = original;
    for (let i = values.length - 1; i >= 0; i--) {
      assert.ok(Object.is(popped.get(i), values[i]));
      assert.ok(Object.is(original.get(i), values[i]));
      popped = popped.pop();
    }
    assert.equal(popped.size, 0);
  });
  test('string reuse is bounded, arena-local, and preserves UTF-8 behavior', async () => {
    resetSharedList();
    const text = ['same', '', '\uFEFF', '日本語', 'café', 'e\u0301', '🌏', '\0', '\ud800', '\udfff'];
    const values = Array.from({ length: 4097 }, (_, i) => text[i % text.length]);
    const list = new SharedList('string').pushMany(values);
    for (let i = 0; i < text.length; i++) assert.equal(rawAt(list, i), rawAt(list, i + text.length));
    const decode = value => new TextDecoder('utf-8', { ignoreBOM: true }).decode(new TextEncoder().encode(value));
    for (const restored of [list, (await initWorker(getWorkerData({ list }, { copy: false }))).list, (await initWorker(getWorkerData({ list }, { copy: true }))).list]) {
      for (let i = 0; i < values.length; i++) assert.equal(restored.get(i), decode(values[i]));
    }
    const attached = (await initWorker(getWorkerData({ list }, { copy: false }))).list;
    assert.throws(() => attached.push('same'), /read-only/);
    assert.throws(() => attached.pushMany(['same']), /read-only/);
    const changed = list.set(0, 'changed'); assert.equal(list.get(0), 'same'); assert.equal(changed.get(0), 'changed');
    resetSharedList();
    const unique = new SharedList('string').pushMany(Array.from({ length: 2200 }, (_, i) => `unique-${i}`));
    const full = unique.push('unique-0').push('unique-2199').push('unique-2199');
    assert.equal(rawAt(full, 0), rawAt(full, 2200), 'Previously interned entries remain usable');
    assert.notEqual(rawAt(full, 2201), rawAt(full, 2202), 'Entry limit must not retain new keys');
    resetSharedList();
    const large = 'x'.repeat(90000), uncached = new SharedList('string').push(large).push(large);
    assert.notEqual(rawAt(uncached, 0), rawAt(uncached, 1), 'Byte budget also limits a single key');
    assert.equal(uncached.get(0), large); assert.equal(list.get(0), 'same');
    assert.throws(() => new SharedList('string').push(7), TypeError);
  });
  test('seeded edits and interleaved retained versions match native arrays', () => {
    resetSharedList(); let seed = 0x142857;
    const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
    let list = new SharedList('number'), values = []; const versions = [];
    for (let k = 0; k < 1000; k++) {
      const op = random() % 4;
      if (op === 0 && values.length) { list = list.pop(); values = values.slice(0, -1); }
      else if (op === 1 && values.length) { const i = random() % values.length, n = random(); list = list.set(i, n); values = values.slice(); values[i] = n; }
      else { const append = Array.from({ length: random() % 35 }, () => random()); list = list.pushMany(append); values = values.concat(append); }
      if (k % 19 === 0) versions.push([list, values]);
      for (const [prior, expected] of [[list, values], ...versions.slice(-3)]) {
        if (expected.length) for (let j = 0; j < 20; j++) { const i = random() % expected.length; assert.equal(prior.get(i), expected[i]); }
      }
    }
    for (const [prior, expected] of versions) assert.deepEqual(prior.toArray(), expected);
  });
  test('separate reader workers keep cached snapshots valid after owner growth', { timeout: 30000 }, async () => {
    resetSharedList();
    const lists = Object.fromEntries([0, 1, 2, 3].map(column => [`n${column}`, new SharedList('number').pushMany(Array.from({ length: 1100 }, (_, i) => i + column))]));
    lists.text = new SharedList('string').pushMany(Array.from({ length: 1100 }, (_, i) => `kind-${i % 7}`));
    const payload = getWorkerData(lists, { copy: false });
    const workers = Array.from({ length: 2 }, () => new Worker(new URL(import.meta.url), { workerData: payload, env: { ...process.env, QUERY_PROOF_ENTRY: entry } }));
    const nextMessage = worker => new Promise((resolve, reject) => { worker.once('message', value => value.error ? reject(new Error(value.error)) : resolve(value)); worker.once('error', reject); });
    try {
      await Promise.all(workers.map(nextMessage));
      for (let round = 0; round < 2; round++) {
        const pending = workers.map(nextMessage); for (const worker of workers) worker.postMessage('read');
        await Promise.all(pending);
        if (!round) { lists.n0.pushMany(data(150000)); resetSharedList(); }
      }
    } finally { await Promise.all(workers.map(worker => worker.terminate())); }
  });
}
