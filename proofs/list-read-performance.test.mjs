import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { SharedList, SharedMap, initWorker, getWorkerData, resetSharedList } from '../dist/shared.js';

const normalize = text => new TextDecoder('utf-8', { ignoreBOM: true }).decode(new TextEncoder().encode(text));
const dataOf = list => getWorkerData({ list }, { copy: false });
function rawTail(list, index = 0) {
  const payload = dataOf(list);
  return new DataView(payload.arenas[0].memory.buffer).getFloat64(payload.structures.list.data.tail + index * 8, true);
}

test('interleaved forward, reverse and random reads preserve each list and historical root', async () => {
  resetSharedList();
  const sizes = [0, 1, 31, 32, 33, 1023, 1024, 1025, 32767, 32768, 32769, 100001];
  for (const size of sizes) {
    const values = Array.from({ length: size }, (_, i) => i * 0.5 - 17);
    const a = new SharedList('number').pushMany(values);
    const b = new SharedList('number').pushMany(values.map(n => n + 900));
    const fork = size ? a.set(size >>> 1, -999) : a;
    for (const pair of [{ a, b, fork }, await initWorker(getWorkerData({ a, b, fork }, { copy: false }))]) {
      for (let i = 0; i < size; i++) {
        assert.equal(pair.a.get(i), values[i]); assert.equal(pair.b.get(size - i - 1), values[size - i - 1] + 900);
        assert.equal(pair.fork.get(i), i === (size >>> 1) ? -999 : values[i]);
      }
      let random = 71237;
      for (let i = 0; i < Math.min(size, 4096); i++) {
        random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
        const at = random % size;
        assert.equal(pair.a.get(at), values[at]);
        assert.equal(pair.b.get(at), values[at] + 900);
      }
      for (const invalid of [-1, size, 0.1, NaN, Infinity, '0', undefined, 0x100000000]) assert.equal(pair.a.get(invalid), undefined);
    }
    assert.equal(Object.isFrozen(a), true);
    assert.deepEqual(Object.keys(a).sort(), ['root', 'depth', 'size', 'tail', 'type'].sort());
  }
});

test('cached tail and tree leaves survive growth, appends, pops, resets and copies', async () => {
  resetSharedList();
  let original = new SharedList('number').pushMany(Array.from({ length: 1025 }, (_, i) => i));
  const attached = (await initWorker(getWorkerData({ original }, { copy: false }))).original;
  assert.equal(attached.get(1024), 1024); assert.equal(attached.get(31), 31);
  const grown = original.pushMany(Array.from({ length: 100000 }, (_, i) => i + 1025));
  assert.equal(attached.get(31), 31); assert.equal(attached.get(1024), 1024);
  assert.equal(grown.get(101024), 101024);
  let popped = original;
  for (let i = 0; i < 1000; i++) { popped.get(popped.size - 1); popped = popped.pop(); assert.equal(popped.get(popped.size - 1), popped.size - 1); }
  resetSharedList();
  new SharedList('number').pushMany(Array(2000).fill(-1));
  assert.equal(original.get(31), 31); assert.equal(attached.get(31), 31);
  const copied = (await initWorker(getWorkerData({ original }, { copy: true }))).original;
  assert.deepEqual(copied.toArray(), original.toArray());
});

test('bounded string interning reuses immutable payloads but keeps UTF-8 semantics', async () => {
  resetSharedList();
  const strings = ['', 'timeout', '日本語', '\ufeffBOM', '\u0000', 'e\u0301', '😀', '\ud800', '\udc00', '\ufffd', 'x'.repeat(8000)];
  const expected = strings.map(normalize);
  let a = new SharedList('string').pushMany(strings);
  const b = a.pushMany(strings);
  for (const mode of [false, true]) {
    const payload = getWorkerData({ a, b }, { copy: mode });
    const before = JSON.stringify(payload.structures);
    const reader = await initWorker(payload);
    for (let repeat = 0; repeat < 3; repeat++) {
      assert.deepEqual(reader.a.toArray(), expected); assert.deepEqual(reader.b.toArray(), expected.concat(expected));
      for (let i = 0; i < b.size; i++) assert.equal(reader.b.get(i), expected[i % strings.length]);
    }
    assert.equal(JSON.stringify(payload.structures), before);
    assert.throws(() => reader.a.push('timeout'), /read-only/);
  }
  const repeated = new SharedList('string').pushMany(['timeout', 'timeout']);
  assert.equal(rawTail(repeated, 0), rawTail(repeated, 1));
  // A cache hit must never skip the writer check or accept values of another type.
  assert.throws(() => a.push(42), /string/);
  assert.throws(() => a.pushMany([{}]), /string/);
  const retained = a; a = a.set(1, 'changed');
  assert.equal(retained.get(1), 'timeout'); assert.equal(a.get(1), 'changed');
});

test('unique strings remain correct after the entry and character budgets are exhausted', () => {
  for (const length of [8, 9000]) {
    resetSharedList();
    const input = Array.from({ length: 2100 }, (_, i) => String(i).padStart(length, 'x'));
    const a = new SharedList('string').pushMany(input);
    const b = a.pushMany(input);
    for (let i = 0; i < input.length; i++) { assert.equal(a.get(i), input[i]); assert.equal(b.get(input.length + i), input[i]); }
    const first = new SharedList('string').push(input[0]);
    const duplicate = new SharedList('string').push(input[0]);
    assert.equal(rawTail(first), rawTail(duplicate));
    const last = new SharedList('string').push(input.at(-1));
    const lastAgain = new SharedList('string').push(input.at(-1));
    assert.notEqual(rawTail(last), rawTail(lastAgain), 'uncached values must not extend the bounded dictionary');
  }
});

test('numeric edge cases, booleans, JSON and nested lists keep their codecs', async () => {
  const numeric = new SharedList('number').pushMany([NaN, -0, Infinity, -Infinity, Number.MAX_VALUE, Number.MIN_VALUE]);
  assert.deepEqual(numeric.toArray(), [NaN, -0, Infinity, -Infinity, Number.MAX_VALUE, Number.MIN_VALUE]);
  const flags = new SharedList('boolean').pushMany([false, true, false]);
  const input = { name: 'same', data: [1, 2] };
  const objects = new SharedList('object').pushMany([input, input]);
  const maps = new SharedList('SharedMap<number>').push(new SharedMap('number').set('a', 9));
  const read = await initWorker(getWorkerData({ numeric, flags, objects, maps }, { copy: false }));
  for (let i = 0; i < numeric.size; i++) assert.ok(Object.is(read.numeric.get(i), numeric.get(i)));
  assert.deepEqual(read.flags.toArray(), [false, true, false]);
  assert.deepEqual(read.objects.get(0), input); assert.ok(Object.isFrozen(read.objects.get(1).data));
  assert.ok(!Object.isFrozen(input)); assert.equal(read.maps.get(0).get('a'), 9);
});

test('independent Node workers read interleaved published columns exactly after owner growth', async () => {
  resetSharedList();
  const base = { time: new SharedList('number').pushMany(Array.from({ length: 4097 }, (_, i) => i)), message: new SharedList('string').pushMany(Array(4097).fill('timeout')) };
  const library = new URL('../dist/shared.js', import.meta.url).href;
  const code = `const {parentPort}=require('node:worker_threads'); parentPort.on('message',async payload=>{ const {initWorker}=await import(${JSON.stringify(library)}); const s=await initWorker(payload); let sum=0; for(let i=0;i<s.time.size;i++){sum+=s.time.get(i); if(s.message.get(i)!=='timeout')throw Error('mismatch');} parentPort.postMessage(sum); });`;
  const workers = [new Worker(code, { eval: true }), new Worker(code, { eval: true })];
  try {
    const answers = workers.map(worker => once(worker, 'message'));
    const payload = getWorkerData(base, { copy: false }); workers.forEach(worker => worker.postMessage(payload));
    base.time.pushMany(Array(100000).fill(-1));
    const results = await Promise.all(answers); assert.deepEqual(results, [[4096 * 4097 / 2], [4096 * 4097 / 2]]);
  } finally { await Promise.all(workers.map(worker => worker.terminate())); }
});
