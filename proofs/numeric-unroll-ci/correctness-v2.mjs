import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

const root = isMainThread ? process.argv[2] : workerData.root;
const fallback = isMainThread ? process.argv[3] === 'scalar' : workerData.fallback;
assert.ok(root, 'An exact worktree path is required');
const api = await import(pathToFileURL(`${root}/dist/shared.js`).href);
const originalValidate = WebAssembly.validate;
let probes = 0;
WebAssembly.validate = bytes => { probes++; return fallback ? false : originalValidate(bytes); };
const numeric = await import(pathToFileURL(`${root}/dist/numeric.js`).href);
const { SharedList, getWorkerData, initWorker, resetSharedList } = api;
const { countInRange, countPointsInBox } = numeric;
const reference = (values, lo, hi) => values.reduce((sum, value) => sum + Number(value >= lo && value <= hi), 0);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

if (!isMainThread) {
  try {
    const { list } = await initWorker(workerData.data);
    assert.throws(() => list.push(1));
    assert.equal(countInRange(list, 1, 1), 33);
    parentPort.on('message', message => {
      try {
        const loops = message === 'during' ? 10000 : 1000;
        let checksum = 0;
        for (let i = 0; i < loops; i++) {
          const result = countInRange(list, 1, 1);
          assert.equal(result, 33);
          checksum += result;
        }
        parentPort.postMessage({ phase: message, loops, checksum, probes, writeRejected: true });
      } catch (error) { parentPort.postMessage({ error: error.stack }); }
    });
    parentPort.postMessage({ phase: 'ready', probes, writeRejected: true });
  } catch (error) { parentPort.postMessage({ error: error.stack }); }
} else {
  const counts = { direct: 0, public: 0, spatial: 0, memoryChecks: 0, attachments: 0, workers: 0, workerCalls: 0 };
  let checksum = 0;
  const check = (actual, expected, category, label) => {
    assert.equal(actual, expected, label);
    counts[category]++;
    checksum = (checksum + actual) >>> 0;
  };
  const exceptional = [NaN, -0, 0, Infinity, -Infinity, Number.MAX_VALUE, -Number.MAX_VALUE, Number.MIN_VALUE, -Number.MIN_VALUE, 1, -1];
  const bounds = [[-Infinity, Infinity], [0, 0], [-0, 0], [1, 1], [-1, 1], [-1000, 1000], [Infinity, Infinity], [-Infinity, -Infinity], [NaN, 1], [1, NaN], [2, 1], [-Number.MIN_VALUE, Number.MIN_VALUE]];
  const memory = new WebAssembly.Memory({ initial: 2, maximum: 65536, shared: true });
  const raw = new DataView(memory.buffer);
  const kernels = ['numeric-kernels.wasm', 'numeric-kernels-simd.wasm'].map(filename => ({
    filename,
    exports: new WebAssembly.Instance(new WebAssembly.Module(readFileSync(`${root}/${filename}`)), { env: { memory } }).exports,
  }));
  function direct(values, atEnd, extraBounds = [], label = '') {
    const size = values.length;
    const p = atEnd ? memory.buffer.byteLength - size * 8 : 256;
    if (!atEnd) for (let i = 0; i < 40; i++) raw.setFloat64(p + i * 8, 1, true);
    values.forEach((value, i) => raw.setFloat64(p + i * 8, value, true));
    const before = hash(new Uint8Array(memory.buffer));
    for (const [lo, hi] of [...bounds, ...extraBounds]) {
      const expected = reference(values, lo, hi);
      for (const kernel of kernels) check(kernel.exports.countInRange(0, 0, p, size, lo, hi), expected, 'direct', `${kernel.filename}/${label}/${size}/${lo}/${hi}`);
    }
    assert.equal(hash(new Uint8Array(memory.buffer)), before, `Direct kernel wrote memory: ${label}`);
    counts.memoryChecks++;
  }
  for (let size = 0; size <= 32; size++) {
    const fixtures = [Array(size).fill(1), Array(size).fill(9001), Array.from({ length: size }, (_, i) => i & 1 ? -1 : 1), Array.from({ length: size }, (_, i) => exceptional[i % exceptional.length])];
    for (const [index, values] of fixtures.entries()) for (const atEnd of [false, true]) direct(values, atEnd, [], `tail-${index}-${atEnd}`);
  }
  for (const value of exceptional) for (let position = 0; position < 32; position++) {
    const values = Array(32).fill(2);
    values[position] = value;
    direct(values, position % 2 === 0, [], `lane-${position}`);
  }
  let state = 0x6d2b79f5;
  const next = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
  for (let trial = 0; trial < 256; trial++) {
    const size = next() % 33;
    const values = Array.from({ length: size }, () => next() % 5 === 0 ? exceptional[next() % exceptional.length] : ((next() % 20001) - 10000) / 8);
    const a = (next() % 2001) - 1000, b = (next() % 2001) - 1000;
    direct(values, Boolean(trial & 1), [[Math.min(a, b), Math.max(a, b)]], `seed-${trial}`);
  }
  for (const kernel of kernels) for (const [size, lo, hi] of [[0, -Infinity, Infinity], [1, NaN, 1], [1, 1, NaN], [1, 2, 1]]) {
    check(kernel.exports.countInRange(0xffffffff, 5, 0xffffffff, size, lo, hi), 0, 'direct', 'No load on invalid bounds or empty input');
  }
  const sizes = [...Array.from({ length: 41 }, (_, i) => i), 63, 64, 65, 95, 96, 97, 1023, 1024, 1025, 1056, 1057, 32767, 32768, 32769, 32800, 32801];
  for (const size of sizes) {
    const values = Array.from({ length: size }, (_, i) => i % 31 === 0 ? exceptional[(i / 31) % exceptional.length] : (i * 7919) % 10007 - 5000);
    const list = new SharedList('number').pushMany(values);
    for (const [lo, hi] of bounds) check(countInRange(list, lo, hi), reference(values, lo, hi), 'public', `public-${size}`);
  }
  assert.throws(() => countInRange(new SharedList('string'), 0, 1), TypeError);
  assert.throws(() => countInRange(null, 0, 1), TypeError);
  assert.throws(() => countInRange(new SharedList('number'), '0', 1), TypeError);
  assert.throws(() => countInRange(new SharedList('number'), 0, null), TypeError);
  const oldValues = Array.from({ length: 1057 }, (_, i) => i % 11 - 5);
  const old = new SharedList('number').pushMany(oldValues);
  const fork = old.set(0, 99).set(1024, -99).pop();
  const forkValues = oldValues.slice(0, -1); forkValues[0] = 99; forkValues[1024] = -99;
  const grown = old.pushMany(Array(32768).fill(1));
  for (const [list, values] of [[old, oldValues], [fork, forkValues], [grown, [...oldValues, ...Array(32768).fill(1)]]]) {
    for (const [lo, hi] of bounds) check(countInRange(list, lo, hi), reference(values, lo, hi), 'public', 'snapshot/fork/growth');
  }
  const boxes = [
    { minX: -Infinity, minY: -Infinity, maxX: Infinity, maxY: Infinity },
    { minX: -0, minY: 0, maxX: 0, maxY: 0 },
    { minX: -2, minY: -1, maxX: 2, maxY: 1 },
    { minX: NaN, minY: 0, maxX: 1, maxY: 1 },
    { minX: 1, minY: 0, maxX: 0, maxY: 1 },
  ];
  for (const size of [0, 2, 4, 6, 8, 14, 16, 18, 30, 32, 34, 62, 64, 66, 1024, 1026, 32768, 32770]) {
    const values = Array.from({ length: size }, (_, i) => i % 13 === 0 ? exceptional[(i / 13) % exceptional.length] : i % 11 - 5);
    const points = new SharedList('number').pushMany(values);
    for (const box of boxes) {
      let expected = 0;
      for (let i = 0; i < size; i += 2) expected += Number(values[i] >= box.minX && values[i] <= box.maxX && values[i + 1] >= box.minY && values[i + 1] <= box.maxY);
      check(countPointsInBox(points, box), expected, 'spatial', `spatial-${size}`);
    }
  }
  assert.throws(() => countPointsInBox(new SharedList('number').push(1), boxes[0]), RangeError);
  for (const copy of [false, true]) {
    const list = new SharedList('number').pushMany([1, 2, NaN, -0, Infinity, -Infinity, 1]);
    const data = getWorkerData({ list }, { copy });
    const storage = data.arenas[0].memory ? new Uint8Array(data.arenas[0].memory.buffer) : data.arenas[0].copy;
    const before = hash(storage);
    const attached = (await initWorker(data)).list;
    const attachedData = getWorkerData({ attached }, { copy: false });
    const attachedMemory = attachedData.arenas[0].memory;
    const attachedBefore = hash(new Uint8Array(attachedMemory.buffer));
    const attachedUsed = attachedData.arenas[0].used;
    for (const [lo, hi] of bounds) check(countInRange(attached, lo, hi), reference([1, 2, NaN, -0, Infinity, -Infinity, 1], lo, hi), 'attachments', `attachment-${copy}`);
    assert.throws(() => attached.push(1));
    assert.equal(hash(storage), before);
    assert.equal(hash(new Uint8Array(attachedMemory.buffer)), attachedBefore);
    assert.equal(getWorkerData({ attached }, { copy: false }).arenas[0].used, attachedUsed);
    counts.memoryChecks++;
  }
  function response(worker) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('Worker correctness safety timeout')), 30000);
      const message = value => value.error ? finish(new Error(value.error)) : finish(null, value);
      const error = reason => finish(reason);
      const exit = code => finish(new Error(`Worker exited before response: ${code}`));
      function finish(reason, value) { clearTimeout(timer); worker.off('message', message); worker.off('error', error); worker.off('exit', exit); reason ? reject(reason) : resolve(value); }
      worker.once('message', message); worker.once('error', error); worker.once('exit', exit);
    });
  }
  for (const copy of [false, true]) {
    resetSharedList();
    let owner = new SharedList('number').pushMany(Array(33).fill(1));
    const snapshot = owner;
    const memory = getWorkerData({ owner }, { copy: false }).arenas[0].memory;
    const initialBytes = memory.buffer.byteLength;
    const worker = new Worker(new URL(import.meta.url), { workerData: { root, fallback, data: getWorkerData({ list: snapshot }, { copy }) } });
    try {
      const ready = await response(worker); assert.equal(ready.phase, 'ready'); assert.equal(ready.writeRejected, true);
      const during = response(worker); worker.postMessage('during');
      owner = owner.pushMany(Array(100000).fill(1)).set(0, 99);
      assert.ok(memory.buffer.byteLength > initialBytes, 'The owner must actually grow memory');
      const first = await during; assert.equal(first.phase, 'during'); assert.equal(first.checksum, 330000); assert.equal(first.writeRejected, true);
      const after = response(worker); worker.postMessage('after-growth');
      const second = await after; assert.equal(second.phase, 'after-growth'); assert.equal(second.checksum, 33000);
      assert.equal(second.probes, 1, 'Each worker selects its module exactly once');
      check(countInRange(snapshot, 1, 1), 33, 'public', 'Old odd-tail snapshot after owner growth');
      check(countInRange(owner, 99, 99), 1, 'public', 'Owner fork edit');
      counts.workers++; counts.workerCalls += first.loops + second.loops + 1;
    } finally { await worker.terminate(); }
  }
  assert.equal(probes, 1, 'The realm chooses its numeric module once');
  console.log(JSON.stringify({ status: 'passed', root, fallback, runtime: process.version, bun: process.versions.bun ?? null, arch: process.arch, seed: '0x6d2b79f5', finalSeed: state >>> 0, counts, checksum, probes }));
}
