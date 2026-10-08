/** Stratified first gate, fixed before any timing. It is not a full cross-product. */
const cases = [];
const add = (kind, type, size, operation, edited = false) => cases.push(Object.freeze({
  kind, type, size, operation, edited, name: `${kind}/${type}/${size}/${edited ? 'edited' : 'append'}/${operation}`,
}));
export const SCANS = Object.freeze([
  ['linked', 'forEach'], ['linked', 'toArray'], ['doubly', 'forEach'],
  ['doubly', 'toArray'], ['doubly', 'forEachReverse'], ['doubly', 'toArrayReverse'],
].map(Object.freeze));
// Every public scan method gets all three unchanged tail-only sizes.
for (const size of [0, 1, 32]) for (const [kind, operation] of SCANS) add(kind, 'number', size, operation);
// Each value family gets the smallest block-containing list and a large tree.
for (const size of [33, 4097]) {
  add('linked', 'number', size, 'forEach'); add('doubly', 'boolean', size, 'forEachReverse');
  add('linked', 'string', size, 'toArray'); add('doubly', 'object', size, 'toArrayReverse');
}
for (const operation of ['forEach', 'toArray']) add('doubly', 'number', 4097, operation);
// Interior edits produce variable-length blocks and retained old snapshots.
for (const [type, kind, operation] of [
  ['number', 'linked', 'toArray'], ['boolean', 'doubly', 'forEach'],
  ['string', 'doubly', 'forEachReverse'], ['object', 'linked', 'forEach'],
]) add(kind, type, 1057, operation, true);
// Full generic compaction, including fresh Arena construction, is measured.
for (const size of [33, 4097]) for (const kind of ['linked', 'doubly']) for (const type of ['number', 'object']) add(kind, type, size, 'compact');
export const CASES = Object.freeze(cases);
export function equal(actual, expected, label = 'values') {
  if (actual.length !== expected.length) throw new Error(`${label}: length mismatch`);
  for (let i = 0; i < expected.length; i++) {
    const a = actual[i], b = expected[i];
    const same = b !== null && typeof b === 'object' ? JSON.stringify(a) === JSON.stringify(b) : Object.is(a, b);
    if (!same || !Object.hasOwn(actual, i)) throw new Error(`${label}: mismatch at ${i}`);
  }
}
export function fixture(S, workload) {
  const { kind, type, size, edited } = workload;
  const C = S[kind === 'linked' ? 'SharedLinkedList' : 'SharedDoublyLinkedList'];
  const value = i => type === 'number' ? i + 0.25 : type === 'boolean' ? i % 3 === 0
    : type === 'string' ? `界🙂:${i}:value` : { i, values: [i, i + 1], child: { text: `界${i}` } };
  let item = S.compact(new C(type));
  const expected = Array.from({ length: size }, (_, i) => value(i));
  for (const v of expected) item = item.append(v);
  const retained = item;
  if (edited) for (let step = 0; step < 16; step++) {
    const index = 17 + step * 37, v = value(size + step);
    item = item.insertAfter(index, v).removeFirst(); expected.splice(index + 1, 0, v); expected.shift();
  }
  return { item, retained, expected };
}
export function materialize(item, operation) {
  if (operation === 'compact') return item.toArray();
  if (operation === 'forEach' || operation === 'forEachReverse') {
    const values = [], indices = [];
    item[operation]((value, index) => { values.push(value); indices.push(index); });
    const expectedIndices = Array.from({ length: item.size }, (_, i) => operation === 'forEachReverse' ? item.size - 1 - i : i);
    equal(indices, expectedIndices, 'callback indices'); return values;
  }
  return item[operation]();
}
export async function runChecks(S) {
  const passed = [];
  for (const workload of CASES) {
    const { item, expected } = fixture(S, workload), reverse = workload.operation.endsWith('Reverse');
    const target = workload.operation === 'compact' ? S.compact(item) : item;
    equal(materialize(target, workload.operation), reverse ? expected.slice().reverse() : expected, workload.name);
    if (item.size > 32) {
      const memory = S.getWorkerData({ item }, { copy: false }).arenas[0].memory, length = memory.buffer.byteLength;
      const seen = [];
      item.forEach((value, index) => { if (index === 1) memory.grow(1); seen.push(value); });
      if (memory.buffer.byteLength <= length) throw new Error('Correctness fixture did not grow');
      equal(seen, expected); equal(S.compact(item).toArray(), expected);
    }
    for (const copy of [false, true]) {
      const attached = (await S.initWorker(S.getWorkerData({ item }, { copy }))).item;
      equal(materialize(attached, workload.operation === 'compact' ? 'toArray' : workload.operation), reverse ? expected.slice().reverse() : expected);
      if (item.size) {
        let rejected = false; try { attached.append(expected[0]); } catch (error) { rejected = /read-only/.test(error.message); }
        if (!rejected) throw new Error('Read-only attachment accepted a write');
      }
    }
    passed.push(workload.name);
  }
  return passed;
}

export async function checkBrowserWorkers(S, module, workerUrl) {
  const results = [], assert = (value, message) => { if (!value) throw new Error(message); };
  for (const kind of ['linked', 'doubly']) for (const copy of [false, true]) for (const reverse of kind === 'doubly' ? [false, true] : [false]) {
    const C = S[kind === 'linked' ? 'SharedLinkedList' : 'SharedDoublyLinkedList'];
    let item = S.compact(new C('number'));
    const special = [-0, NaN, Infinity, -Infinity, Number.MIN_VALUE, 0.25];
    const expected = Array.from({ length: 129 }, (_, i) => special[i % special.length]);
    for (const value of expected) item = item.append(value);
    const fork = item.prepend(-999), nestedType = `${kind === 'linked' ? 'SharedLinkedList' : 'SharedDoublyLinkedList'}<number>`;
    let nested = S.compact(new C(nestedType));
    for (let i = 0; i < 65; i++) nested = nested.append(i % 2 ? item : fork);
    const data = S.getWorkerData({ item, fork, nested }, { copy });
    const memories = S.getWorkerData({ item, nested }, { copy: false }).arenas.map(a => a.memory), lengths = memories.map(m => m.buffer.byteLength);
    const gate = new SharedArrayBuffer(4), control = new Int32Array(gate), worker = new Worker(workerUrl, { type: 'module' });
    try {
      const result = await new Promise((resolve, reject) => {
        let paused = false;
        const timeout = setTimeout(() => reject(new Error('Browser block worker timed out')), 40000);
        worker.onerror = error => { clearTimeout(timeout); reject(new Error(error.message)); };
        worker.onmessage = ({ data: message }) => {
          try {
            if (message.type === 'paused') {
              assert(!paused, 'Duplicate pause'); paused = true;
              memories.forEach((memory, i) => { memory.grow(2); assert(memory.buffer.byteLength > lengths[i], 'Writer did not grow'); });
              equal(item.append(777).toArray(), [...expected, 777]); Atomics.store(control, 0, 1); Atomics.notify(control, 0);
            } else {
              clearTimeout(timeout);
              if (message.type === 'error') throw new Error(message.error);
              assert(paused && message.type === 'done', 'Missing worker pause'); resolve(message);
            }
          } catch (error) { clearTimeout(timeout); reject(error); }
        };
        worker.postMessage({ module, data, gate, reverse });
      });
      assert(result.writeRejected, 'Worker accepted write');
      equal(result.values, reverse ? expected.slice().reverse() : expected);
      equal(result.indices, Array.from({ length: 129 }, (_, i) => reverse ? 128 - i : i));
      for (const key of ['array', 'compacted']) equal(result[key], expected);
      for (const key of ['fork', 'compactedFork']) equal(result[key], [-999, ...expected]);
      for (const key of ['nested', 'compactedNested']) {
        assert(result[key].length === 65, 'Nested snapshot count');
        for (let i = 0; i < 65; i++) equal(result[key][i], i % 2 ? expected : [-999, ...expected]);
      }
      results.push({ kind, copy, reverse, grownArenas: memories.length, pausedInsideBlocks: true });
    } finally { Atomics.store(control, 0, 1); Atomics.notify(control, 0); worker.terminate(); }
  }
  return results;
}
