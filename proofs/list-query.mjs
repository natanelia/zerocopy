import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { SharedList, getWorkerData, initWorker, resetSharedList, compact } from '../dist/shared.js';

function rawAt(list, index) {
  const data = getWorkerData({ list }, { copy: false });
  const item = data.structures.list, d = item.data;
  const memory = data.arenas.find(a => a.id === item.arena).memory;
  const view = new DataView(memory.buffer), tailStart = (d.size - 1) & ~31;
  let address = d.tail;
  if (index < tailStart) {
    address = d.root;
    for (let depth = d.depth; depth > 0; depth--) address = view.getUint32(address + ((index >>> (depth * 5)) & 31) * 4, true);
  }
  return view.getFloat64(address + (index & 31) * 8, true);
}

// Use actual built public entry points, including real WASM and shared transport.
test('interleaved list cursors preserve values across tree boundaries, directions, and forks', async () => {
  resetSharedList();
  for (const size of [0, 1, 31, 32, 33, 1023, 1024, 1025, 32767, 32768, 32769]) {
    const values = Array.from({ length: size }, (_, i) => i + .25);
    const a = new SharedList('number').pushMany(values);
    const b = new SharedList('number').pushMany(values.map(x => -x));
    const c = a.push(999), d = size ? a.set(size >>> 1, -123) : a;
    assert.equal(Object.isFrozen(a), true);
    assert.deepEqual(Object.keys(a).sort(), ['depth', 'root', 'size', 'tail', 'type']);
    for (const step of [1, -1]) {
      for (let i = step === 1 ? 0 : size - 1; i >= 0 && i < size; i += step) {
        assert.equal(a.get(i), values[i]); assert.equal(b.get(i), -values[i]);
        assert.equal(c.get(i), values[i]); assert.equal(d.get(i), i === size >>> 1 ? -123 : values[i]);
      }
    }
    const attached = await initWorker(getWorkerData({ a, b, c, d }, { copy: false }));
    const copied = await initWorker(getWorkerData({ a, b, c, d }, { copy: true }));
    for (const snapshot of [attached, copied]) {
      assert.deepEqual(snapshot.a.toArray(), values);
      for (const i of [0, 31, 32, 1023, 1024, size - 1]) assert.equal(snapshot.a.get(i), values[i]);
      assert.throws(() => snapshot.a.push(1), /read-only/);
    }
    assert.deepEqual(c.pop().toArray(), values);
    for (const i of [-1, .5, NaN, Infinity, '0', size, 2 ** 32]) assert.equal(a.get(i), undefined);
  }
});

test('read cursors and interned strings retain numeric, UTF-8, JSON, and boolean semantics', async () => {
  resetSharedList();
  const numbers = [-0, 0, NaN, Infinity, -Infinity, Number.MIN_VALUE, Number.MAX_VALUE];
  const list = new SharedList('number').pushMany(numbers);
  numbers.forEach((n, i) => assert.ok(Object.is(list.get(i), n)));
  const text = ['', '\0', '\ufeffprefix', '日本語', '🚦', 'e\u0301', '\ud800', '\udfff', '<script>', 'request'.repeat(1000)];
  const decode = new TextDecoder('utf-8', { ignoreBOM: true });
  const canonical = text.map(s => decode.decode(new TextEncoder().encode(s)));
  let strings = new SharedList('string').pushMany(text);
  strings = strings.pushMany(text).set(0, text[3]);
  assert.deepEqual(strings.toArray(), [canonical[3], ...canonical.slice(1), ...canonical]);
  assert.equal(rawAt(strings, 3), rawAt(strings, text.length + 3));
  const booleans = new SharedList('boolean').pushMany([true, false, true]);
  assert.deepEqual([booleans.get(0), booleans.get(1), booleans.get(2)], [true, false, true]);
  const object = new SharedList('object').push({ name: '日本語', nested: [1, true] });
  assert.ok(Object.isFrozen(object.get(0))); assert.ok(Object.isFrozen(object.get(0).nested));
  for (const copy of [false, true]) {
    const attached = await initWorker(getWorkerData({ strings, list, object, booleans }, { copy }));
    assert.deepEqual(attached.strings.toArray(), strings.toArray());
    assert.deepEqual(attached.list.toArray(), numbers);
    assert.deepEqual(attached.booleans.toArray(), [true, false, true]);
  }
  assert.throws(() => strings.push(1), /string/);
  assert.throws(() => strings.pushMany(['valid', 1]), /string/);
});

test('string reuse is bounded by entry count and retained text size, without caching JSON as strings', () => {
  resetSharedList();
  const values = Array.from({ length: 2050 }, (_, i) => `value-${i}`);
  const original = new SharedList('string').pushMany(values);
  const next = original.push(values[0]).push(values[2048]);
  assert.equal(rawAt(next, 2050), rawAt(original, 0));
  assert.notEqual(rawAt(next, 2051), rawAt(original, 2048), 'Entries beyond the cap must not be retained');
  assert.equal(next.get(2051), values[2048]);
  resetSharedList();
  const first = 'a'.repeat(50000), second = 'b'.repeat(50000);
  const large = new SharedList('string').pushMany([first, second, first, second]);
  assert.equal(rawAt(large, 0), rawAt(large, 2));
  assert.notEqual(rawAt(large, 1), rawAt(large, 3), 'Retained text must stay inside the byte budget');
  assert.deepEqual(large.toArray(), [first, second, first, second]);
  const json = new SharedList('object').push({ x: 1 });
  const text = new SharedList('string').push('{"x":1}');
  assert.deepEqual(json.get(0), { x: 1 }); assert.equal(text.get(0), '{"x":1}');
  const compacted = compact(original);
  assert.deepEqual(compacted.toArray(), values);
});

test('seeded random immutable operations keep warmed cursors and every retained snapshot correct', () => {
  resetSharedList();
  let state = 0x6e617461;
  const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
  const saved = [[new SharedList('string'), []]];
  for (let round = 0; round < 1000; round++) {
    const [old, before] = saved[random() % saved.length];
    const op = random() % 4, text = ['x', '🚦', '', 'request', `unique-${round}`][random() % 5];
    let next, expected;
    if (op === 0) { next = old.push(text); expected = [...before, text]; }
    else if (op === 1) {
      const delta = Array.from({ length: random() % 80 }, () => text);
      next = old.pushMany(delta); expected = [...before, ...delta];
    } else if (op === 2 && before.length) {
      const index = random() % before.length; next = old.set(index, text); expected = before.slice(); expected[index] = text;
    } else { next = old.pop(); expected = before.slice(0, -1); }
    assert.deepEqual(next.toArray(), expected);
    for (let j = 0; j < 8; j++) { const i = random() % (before.length + 1); assert.equal(old.get(i), before[i]); }
    saved.push([next, expected]);
  }
  for (const [snapshot, expected] of saved) assert.deepEqual(snapshot.toArray(), expected);
});

test('a real worker can keep old read cursors while the owner grows memory and publishes new roots', { timeout: 20000 }, async () => {
  resetSharedList();
  const old = new SharedList('number').pushMany(Array.from({ length: 1057 }, (_, i) => i));
  const texts = new SharedList('string').pushMany(Array(1057).fill('retained 日本語'));
  const library = new URL('../dist/shared.js', import.meta.url).href;
  const worker = new Worker(new URL('data:text/javascript,' + encodeURIComponent(`
    import { parentPort, workerData } from 'node:worker_threads';
    import assert from 'node:assert/strict';
    import { initWorker } from ${JSON.stringify(library)};
    const old = await initWorker(workerData);
    for (let i = 0; i < old.old.size; i++) { assert.equal(old.old.get(i), i); old.texts.get(i); }
    parentPort.postMessage('ready');
    parentPort.on('message', async payload => {
      try {
        const current = await initWorker(payload);
        for (let i = old.old.size - 1; i >= 0; i--) { assert.equal(old.old.get(i), i); assert.equal(old.texts.get(i), 'retained 日本語'); }
        for (let i = 0; i < current.next.size; i++) assert.equal(current.next.get(i), i);
        parentPort.postMessage('verified');
      } catch (error) { parentPort.postMessage({ error: error.stack }); }
    });
  `)), { workerData: getWorkerData({ old, texts }, { copy: false }) });
  try {
    assert.deepEqual(await once(worker, 'message'), ['ready']);
    const next = old.pushMany(Array.from({ length: 100000 }, (_, i) => 1057 + i));
    const response = once(worker, 'message');
    worker.postMessage(getWorkerData({ next }, { copy: false }));
    assert.deepEqual(await response, ['verified']);
  } finally { await worker.terminate(); }
});


test('native numeric reads reject malformed leaf addresses rather than returning undefined', () => {
  resetSharedList();
  const list = new SharedList('number').push(7), data = list.toWorkerData();
  for (const tail of [data.tail + 1, 0, 0x7ffffff8]) {
    assert.throws(() => SharedList.fromWorkerData({ ...data, tail }).get(0), /Invalid list leaf/);
  }
});

test('the explicit little-endian fallback reads the same published bytes', { timeout: 20000 }, async () => {
  const library = new URL('../dist/shared.js', import.meta.url).href;
  const worker = new Worker(new URL('data:text/javascript,' + encodeURIComponent(`
    import { parentPort } from 'node:worker_threads';
    import assert from 'node:assert/strict';
    const NativeUint16Array = globalThis.Uint16Array;
    let probes = 0;
    // Force only the platform probe to choose DataView. Do not modify the
    // stored bytes or the read algorithm. This is not a big-endian host claim.
    globalThis.Uint16Array = class extends NativeUint16Array {
      constructor(input) { super(input); if (Array.isArray(input) && input.length === 1 && input[0] === 1) { probes++; this[0] = 256; } }
    };
    const { SharedList } = await import(${JSON.stringify(library)});
    globalThis.Uint16Array = NativeUint16Array;
    assert.equal(probes, 1);
    const values = Array.from({ length: 32769 }, (_, i) => i + .125);
    values[0] = -0; values[31] = NaN; values[32] = Infinity;
    const list = new SharedList('number').pushMany(values);
    for (let i = 0; i < values.length; i++) assert.ok(Object.is(list.get(i), values[i]));
    const next = list.pushMany(Array(100000).fill(7));
    for (let i = values.length - 1; i >= 0; i--) assert.ok(Object.is(list.get(i), values[i]));
    assert.equal(next.get(next.size - 1), 7);
    parentPort.postMessage('verified');
  `)));
  try { assert.deepEqual(await once(worker, 'message'), ['verified']); }
  finally { await worker.terminate(); }
});
