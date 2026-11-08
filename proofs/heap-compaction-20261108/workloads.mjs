import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const study = {
  id: 'heap-compaction-20261108',
  baseline: '0ca99c1da67e4d3e36e098b3f0e85d392c9c1d5e',
  changedSources: ['compaction.ts'],
  cases: [
    { name: 'balanced-4096', role: 'target', count: 4096, shape: 'balanced', type: 'number', repetitions: 4 },
    { name: 'spine-4096', role: 'target', count: 4096, shape: 'spine', type: 'number', repetitions: 4 },
    { name: 'forks-4096', role: 'target', count: 4096, shape: 'forks', type: 'number', repetitions: 4 },
    { name: 'objects-1024', role: 'generic-value control', count: 1024, shape: 'balanced', type: 'object', repetitions: 4 },
    { name: 'single-heap', role: 'small-input control', count: 1, shape: 'balanced', type: 'number', repetitions: 48 },
    { name: 'empty-heap', role: 'empty control', count: 0, shape: 'balanced', type: 'number', repetitions: 48 },
    { name: 'map-1024', role: 'unmodified-path control', count: 1024, shape: 'map', type: 'number', repetitions: 4 },
  ],
  pilotCases: ['balanced-4096', 'spine-4096', 'single-heap', 'map-1024'],
  aaCases: ['balanced-4096', 'single-heap', 'map-1024'],
  notes: [
    'One complete public compact() or compactMany() operation per timed iteration; output construction is included.',
    'Fixture construction, independent input validation, full output validation, and source byte comparisons are outside timing.',
    'All output entries, sizes, heap modes, frozen state, copied memory independence, live node allocation and group aliases are checked after each batch.',
    'The candidate only changes the private priority-queue compaction traversal. No package, transport, node layout, or WASM change.',
  ],
};

function heapNodes(queue, source) {
  const view = new DataView(source.memory.buffer), pending = queue.root ? [queue.root] : [], seen = new Set();
  while (pending.length) {
    const node = pending.pop();
    if (seen.has(node)) continue;
    seen.add(node);
    assert.ok(node >= 65536 && node + 32 <= source.used);
    const left = view.getUint32(node + 16, true), right = view.getUint32(node + 20, true);
    assert.equal(view.getUint32(node + 28, true), 1 + (left ? view.getUint32(left + 28, true) : 0) + (right ? view.getUint32(right + 28, true) : 0));
    const leftRank = left ? view.getUint32(left + 24, true) : 0, rightRank = right ? view.getUint32(right + 24, true) : 0;
    assert.ok(leftRank >= rightRank);
    assert.equal(view.getUint32(node + 24, true), rightRank + 1);
    for (const child of [right, left]) if (child) {
      const priority = view.getFloat64(node, true), childPriority = view.getFloat64(child, true);
      assert.ok(queue.isMaxHeap ? priority >= childPriority : priority <= childPriority);
      pending.push(child);
    }
  }
  return seen;
}

export async function createWorkload(root, spec) {
  const S = await import(pathToFileURL(join(root, 'dist/shared.js')));
  S.configureMemory({ maximumBytes: 16 * 1024 * 1024 });
  let source;
  const input = [];
  if (spec.shape === 'map') {
    source = new S.SharedMap('number');
    for (let i = 0; i < spec.count; i++) input.push([`key/${i}`, i]);
    source = source.setMany(input);
    assert.deepEqual(new Map(source.entries()), new Map(input));
  } else {
    source = new S.SharedPriorityQueue(spec.type);
    let seed = 0x12345678;
    for (let i = 0; i < spec.count; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const priority = spec.shape === 'spine' ? -i : seed;
      const value = spec.type === 'object' ? { index: i, text: `row/${i}`, nested: { active: i % 3 === 0 } } : i;
      input.push([value, priority]);
      source = source.enqueue(value, priority);
    }
    const actual = [...source.entries()].sort((a, b) => (spec.type === 'object' ? a[0].index - b[0].index : a[0] - b[0]));
    assert.deepEqual(actual, input);
  }
  const sources = spec.shape === 'forks'
    ? { source, left: source.enqueue(-1, -1), right: source.enqueue(-2, -2), again: source }
    : { source };
  const named = Object.entries(sources), expected = Object.fromEntries(named.map(([name, value]) => [name, [...value.entries()]]));
  const beforePacket = S.getWorkerData(sources, { copy: false });
  assert.equal(beforePacket.arenas.length, 1);
  const beforeArena = beforePacket.arenas[0];
  const beforeBytes = Buffer.from(new Uint8Array(beforeArena.memory.buffer, 65536, beforeArena.used - 65536));
  const expectedNodes = spec.shape === 'map' ? null : new Set(named.flatMap(([, value]) => [...heapNodes(value, beforeArena)])).size;
  const expectedDigest = createHash('sha256').update(JSON.stringify({ expected, expectedNodes, input })).digest('hex');
  const checkInvariant = () => {
    const packet = S.getWorkerData(sources, { copy: false }), arena = packet.arenas[0];
    assert.equal(packet.arenas.length, 1);
    assert.equal(arena.memory, beforeArena.memory);
    assert.equal(arena.used, beforeArena.used);
    assert.deepEqual(Buffer.from(arena.memory.buffer, 65536, beforeBytes.length), beforeBytes);
    for (const [name, value] of named) assert.deepEqual([...value.entries()], expected[name]);
  };
  const verify = result => {
    const output = spec.shape === 'forks' ? result : { source: result };
    if (spec.shape === 'forks') { assert.equal(output.again, output.source); assert.ok(Object.isFrozen(output)); }
    const packet = S.getWorkerData(output, { copy: false });
    assert.equal(packet.arenas.length, 1);
    assert.notEqual(packet.arenas[0].memory, beforeArena.memory);
    let liveNodes;
    if (expectedNodes !== null) liveNodes = new Set();
    for (const [name, value] of Object.entries(output)) {
      assert.ok(Object.isFrozen(value));
      assert.equal(value.size, sources[name].size);
      assert.deepEqual([...value.entries()], expected[name]);
      if (expectedNodes !== null) {
        assert.equal(value.isMaxHeap, sources[name].isMaxHeap);
        for (const node of heapNodes(value, packet.arenas[0])) liveNodes.add(node);
      }
      if (spec.type === 'object') for (const [item] of value.entries()) {
        assert.ok(Object.isFrozen(item)); assert.ok(Object.isFrozen(item.nested));
      }
    }
    if (expectedNodes !== null) {
      assert.equal(liveNodes.size, expectedNodes);
      if (spec.type === 'number') assert.equal(packet.arenas[0].used - 65536, expectedNodes * 32);
    }
  };
  return {
    operation: spec.shape === 'forks' ? () => S.compactMany(sources) : () => S.compact(source),
    verify, checkInvariant, expectedDigest,
    fixture: {
      count: spec.count, shape: spec.shape, type: spec.type,
      inputDigest: createHash('sha256').update(JSON.stringify(input)).digest('hex'),
      sourceUsedBytes: beforeArena.used, sourceCapacityBytes: beforeArena.memory.buffer.byteLength,
      expectedLiveHeapNodes: expectedNodes,
    },
  };
}
