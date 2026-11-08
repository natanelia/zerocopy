import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const study = {
  id: 'redux-heap-read-view-v3-20261108',
  baseline: '0ca99c1da67e4d3e36e098b3f0e85d392c9c1d5e',
  changedSources: ['arena.ts', 'redux-heap-codec.ts'],
  aaCases: ['min-4096-number-encode', 'min-256-object-control', 'reset-empty-list-control'],
  pilotCases: ['min-4096-number-encode', 'max-4096-boolean-encode', 'min-4096-number-stringify',
    'min-32-number-boundary', 'min-8-number-control', 'min-256-object-control'],
  cases: [
    { name: 'min-4096-number-encode', role: 'target', type: 'number', max: false, count: 4096, method: 'encode', repetitions: 32 },
    { name: 'max-4096-boolean-encode', role: 'target', type: 'boolean', max: true, count: 4096, method: 'encode', repetitions: 32 },
    { name: 'min-32768-number-encode', role: 'target', type: 'number', max: false, count: 32768, method: 'encode', repetitions: 4 },
    { name: 'min-4096-number-stringify', role: 'target', type: 'number', max: false, count: 4096, method: 'stringify', repetitions: 16 },
    { name: 'min-32-number-boundary', role: 'fast-path boundary', type: 'number', max: false, count: 32, method: 'encode', repetitions: 1024 },
    { name: 'min-8-number-control', role: 'small fallback control', type: 'number', max: false, count: 8, method: 'encode', repetitions: 4096 },
    { name: 'min-256-object-control', role: 'object fallback control', type: 'object', max: false, count: 256, method: 'encode', repetitions: 16 },
    { name: 'reset-empty-list-control', role: 'Arena construction control', kind: 'reset', type: 'number', count: 0, repetitions: 32 },
  ],
};

// An independent JavaScript leftist heap supplies the expected topology. No
// values or child indexes are obtained from either implementation's encoder.
function insert(root, value, priority, max) {
  if (!root || (max ? priority > root.priority : priority < root.priority)) {
    return { value, priority, left: root, right: null, rank: 1 };
  }
  let left = root.left, right = insert(root.right, value, priority, max);
  if ((left?.rank ?? 0) < right.rank) [left, right] = [right, left];
  return { value: root.value, priority: root.priority, left, right, rank: (right?.rank ?? 0) + 1 };
}
function encodeValue(value) {
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return ['n', 'NaN'];
    if (!Number.isFinite(value)) return ['n', value > 0 ? 'Infinity' : '-Infinity'];
    return Object.is(value, -0) ? ['n', '-0'] : value;
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (Array.isArray(value)) return ['a', value.map(encodeValue)];
  return ['o', Object.keys(value).map(key => [key, encodeValue(value[key])])];
}
function valueAt(type, index) {
  if (type === 'number') return index < 6 ? [NaN, -0, 0, Infinity, -Infinity, Number.MIN_VALUE][index] : index * 0.25 - 100;
  if (type === 'boolean') return index % 3 === 0;
  return { id: index, label: `feature/${index}/é/🙂`, nested: [index % 3 === 0, { value: index / 2 }] };
}
function priorityAt(index) {
  return index < 4 ? [-0, 0, Infinity, -Infinity][index] : (Math.imul(index, 73) >>> 0) % 2047 - 1023;
}

export async function createWorkload(directory, spec) {
  if (spec.kind === 'reset') return createConstructorWorkload(directory, spec);
  const S = await import(pathToFileURL(join(directory, 'dist/shared.js')));
  const R = await import(pathToFileURL(join(directory, 'dist/redux.js')));
  const codec = R.createZerocopyCodec();
  let source = new S.SharedPriorityQueue(spec.type, { maxHeap: spec.max }), root = null;
  for (let i = 0; i < spec.count; i++) {
    const value = valueAt(spec.type, i), priority = priorityAt(i);
    source = source.enqueue(value, priority);
    root = insert(root, value, priority, spec.max);
  }
  const nodes = root ? [root] : [], rows = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i], leftIndex = node.left ? nodes.push(node.left) - 1 : -1;
    const rightIndex = node.right ? nodes.push(node.right) - 1 : -1;
    rows.push([encodeValue(node.value), encodeValue(node.priority), leftIndex, rightIndex]);
  }
  assert.equal(rows.length, spec.count);
  const envelope = { $zerocopyRedux: 1, value: ['c', 'SharedPriorityQueue', spec.type, spec.max, rows] };
  const expectedText = JSON.stringify(envelope), expected = spec.method === 'stringify' ? expectedText : envelope;
  const copied = S.getWorkerData({ source }, { copy: true });
  const shared = S.getWorkerData({ source }, { copy: false });
  assert.equal(copied.arenas.length, 1); assert.equal(shared.arenas.length, 1);
  const original = copied.arenas[0], memory = shared.arenas[0].memory, descriptor = source.toWorkerData();
  assert.ok(memory instanceof WebAssembly.Memory);
  return {
    operation: () => codec[spec.method](source),
    verify(result) {
      assert.deepEqual(result, expected);
      if (spec.method === 'encode') assert.ok(Object.isFrozen(result));
    },
    expectedDigest: createHash('sha256').update(expectedText).digest('hex'),
    checkInvariant() {
      assert.equal(source.size, spec.count); assert.ok(Object.isFrozen(source));
      assert.deepEqual(source.toWorkerData(), descriptor);
      assert.equal(S.getWorkerData({ source }, { copy: false }).arenas[0].used, original.used);
      assert.deepEqual(new Uint8Array(memory.buffer, 0, original.used), original.copy);
    },
    fixture: { type: spec.type, max: spec.max, count: spec.count, method: spec.method, arenaBytes: original.used,
      values: spec.type === 'object' ? 'JSON decode cache warmed by normal public calls' : 'native primitives including special values',
      oracle: 'independent JavaScript leftist heap and wire encoder; breadth-first child indexes and value/priority associations' },
  };
}


// Public constructor control for the extra native-WASM identity field. Its
// fixed 32-result batch and writable-output check match the compaction study.
async function createConstructorWorkload(directory, spec) {
  const S = await import(pathToFileURL(join(directory, 'dist/shared.js')));
  const descriptor = { root: 0, depth: 0, size: 0, type: 'number', tail: 0 };
  return {
    operation() { S.resetSharedList(); return new S.SharedList('number'); },
    verify(result) {
      assert.ok(result instanceof S.SharedList); assert.ok(Object.isFrozen(result));
      assert.deepEqual(result.toWorkerData(), descriptor); assert.deepEqual(result.toArray(), []);
      const packet = S.getWorkerData({ result }, { copy: false });
      assert.equal(packet.version, 4); assert.equal(packet.arenas.length, 1);
      assert.equal(packet.arenas[0].used, 65536);
      const next = result.push(-0);
      assert.equal(result.size, 0); assert.equal(next.size, 1); assert.ok(Object.is(next.get(0), -0));
    },
    expectedDigest: createHash('sha256').update(JSON.stringify([])).digest('hex'),
    fixture: { kind: 'reset', type: 'number', count: 0, expectedTargetUsed: 65536,
      timedOperation: 'resetSharedList plus new SharedList(number)',
      oracle: 'empty public descriptor and values, used bytes, writable result and retained empty snapshot' },
  };
}
