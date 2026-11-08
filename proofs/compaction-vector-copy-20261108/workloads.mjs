import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const study = {
  id: 'compaction-vector-copy-20261108',
  baseline: '0ca99c1da67e4d3e36e098b3f0e85d392c9c1d5e',
  changedSources: ['arena.ts', 'compaction.ts', 'shared-list.ts', 'shared-queue.ts'],
  pilotCases: ['compact-number-list-65536', 'compact-number-queue-offset-37', 'compact-number-list-33', 'reset-empty-list-control'],
  aaCases: ['compact-number-list-65536', 'reset-empty-list-control'],
  cases: [
    { name: 'compact-number-list-65536', role: 'target', kind: 'list', type: 'number', count: 65536, repetitions: 8 },
    { name: 'compact-boolean-list-65536', role: 'target', kind: 'list', type: 'boolean', count: 65536, repetitions: 8 },
    { name: 'compact-number-queue-offset-37', role: 'target', kind: 'queue', type: 'number', count: 65536, offset: 37, repetitions: 8 },
    { name: 'compact-number-list-33', role: 'boundary', kind: 'list', type: 'number', count: 33, repetitions: 128 },
    { name: 'compact-number-list-8-control', role: 'control', kind: 'list', type: 'number', count: 8, repetitions: 128 },
    { name: 'compact-string-list-1024-control', role: 'control', kind: 'list', type: 'string', count: 1024, repetitions: 8 },
    { name: 'reset-empty-list-control', role: 'control', kind: 'reset', type: 'number', count: 0, repetitions: 128 },
  ],
};
const HEAP_START = 65536;
const special = [NaN, -0, Infinity, -Infinity, Number.MIN_VALUE, -Number.MIN_VALUE, Number.MAX_VALUE];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => typeof value !== 'number' ? value : Number.isNaN(value) ? ['NaN']
  : Object.is(value, -0) ? ['-0'] : value === Infinity ? ['+Infinity'] : value === -Infinity ? ['-Infinity'] : value;
const align = n => Math.ceil(n / 8) * 8;
function model(type, count) {
  return Array.from({ length: count }, (_, i) => type === 'boolean' ? i % 7 === 2
    : type === 'string' ? `lane/é/界/🙂/${String(i).padStart(5, '0')}`
    : i % 257 === 0 ? special[(i / 257) % special.length | 0] : i / 8 - 4096);
}
function depthOf(prefix) {
  let depth = 0, capacity = 32;
  while (prefix > capacity) { depth++; capacity *= 32; }
  return depth;
}
function expectedBytes(spec, expected) {
  const tail = spec.count ? ((spec.count - 1) & 31) + 1 : 0;
  let nodes = 0, groups = (spec.count - tail) / 32;
  while (groups > 1) { groups = Math.ceil(groups / 32); nodes += groups; }
  const encoder = new TextEncoder();
  const blobs = spec.type === 'string' ? expected.reduce((sum, value) => sum + align(4 + encoder.encode(value).length), 0) : 0;
  return HEAP_START + blobs + spec.count * 8 + nodes * 128;
}
// Independent wire reader: the expected values come from plain JS fixtures.
// Follow every returned tree pointer and check every raw value. This avoids
// allocating 65,536 immutable queue handles merely to inspect one output.
function verifyPrimitive(result, packet, expected, spec) {
  const d = packet.structures.result.data, arena = packet.arenas[0], view = new DataView(arena.memory.buffer);
  const prefix = spec.count ? (spec.count - 1) & ~31 : 0;
  const depth = depthOf(prefix), root = spec.kind === 'queue' ? d.head : d.root;
  const tail = spec.kind === 'queue' ? d.block : d.tail;
  assert.equal(d.depth, depth);
  if (spec.kind === 'queue') assert.equal(d.tail, 0);
  for (let first = 0; first < spec.count; first += 32) {
    let p = tail;
    if (first < prefix) {
      p = root;
      for (let level = depth; level > 0; level--) p = view.getUint32(p + ((first >>> (level * 5)) & 31) * 4, true);
    }
    const end = Math.min(first + 32, spec.count);
    assert.ok(p >= HEAP_START && p + (end - first) * 8 <= arena.used);
    for (let i = first; i < end; i++) {
      const raw = view.getFloat64(p + (i - first) * 8, true);
      const actual = spec.type === 'boolean' ? raw !== 0 : raw;
      if (!Object.is(actual, expected[i])) assert.fail(`Wrong ${spec.kind} value at ${i}`);
    }
  }
  if (spec.kind === 'queue') assert.ok(Object.is(result.peek(), expected[0]));
  else for (const i of [0, 31, 32, spec.count - 1]) {
    if (i >= 0 && i < spec.count) assert.ok(Object.is(result.get(i), expected[i]));
  }
}

export async function createWorkload(directory, spec) {
  const S = await import(pathToFileURL(join(directory, 'dist/shared.js')));
  const all = model(spec.type, spec.count + (spec.offset ?? 0)), expected = all.slice(spec.offset ?? 0);
  let source;
  if (spec.kind === 'queue') {
    S.resetQueue();
    let waste = new S.SharedQueue('number');
    for (let i = 0; i < 4096; i++) waste = waste.enqueue(-99999 - i);
    source = new S.SharedQueue(spec.type);
    for (const value of all) source = source.enqueue(value);
    for (let i = 0; i < (spec.offset ?? 0); i++) source = source.dequeue();
  } else if (spec.kind !== 'reset') {
    S.resetSharedList();
    // Live data follows unreachable history in the same arena. A correct
    // compaction must copy only the selected snapshot, never the whole arena.
    new S.SharedList('number').pushMany(model('number', 32768));
    source = new S.SharedList(spec.type).pushMany(all);
  }
  const sourcePacket = source ? S.getWorkerData({ source }, { copy: false }) : null;
  const sourceArena = sourcePacket?.arenas[0], sourceDescriptor = sourcePacket?.structures.source.data;
  const sourceHash = sourceArena ? hash(new Uint8Array(sourceArena.memory.buffer, HEAP_START, sourceArena.used - HEAP_START)) : null;
  const allocationBytes = expectedBytes(spec, expected);
  if (sourceArena) assert.ok(allocationBytes < sourceArena.used);
  return {
    operation: spec.kind === 'reset' ? () => { S.resetSharedList(); return new S.SharedList('number'); } : () => S.compact(source),
    verify(result) {
      assert.ok(result instanceof (spec.kind === 'queue' ? S.SharedQueue : S.SharedList));
      assert.ok(Object.isFrozen(result)); assert.equal(result.size, spec.count);
      const packet = S.getWorkerData({ result }, { copy: false });
      assert.equal(packet.version, 4); assert.equal(packet.arenas.length, 1);
      const arena = packet.arenas[0];
      assert.equal(arena.used, allocationBytes);
      if (sourceArena) assert.notStrictEqual(arena.memory, sourceArena.memory);
      const descriptor = packet.structures.result.data;
      assert.equal(descriptor.type, spec.type); assert.equal(descriptor.size, spec.count);
      if (spec.type === 'string') assert.deepEqual(result.toArray(), expected);
      else verifyPrimitive(result, packet, expected, spec);
      // Every returned result is a writable owner. Retaining the old handle
      // through this edit also checks that the compacted snapshot stays intact.
      const value = spec.type === 'boolean' ? true : spec.type === 'string' ? 'new' : -0;
      const next = spec.kind === 'queue' ? result.enqueue(value) : result.push(value);
      assert.equal(result.size, spec.count); assert.equal(next.size, spec.count + 1);
      if (spec.kind === 'queue') assert.ok(Object.is(next.peek(), expected[0]));
      else assert.ok(Object.is(next.get(spec.count), value));
    },
    checkInvariant() {
      if (!source) return;
      const packet = S.getWorkerData({ source }, { copy: false });
      assert.deepEqual(packet.structures.source.data, sourceDescriptor);
      assert.equal(packet.arenas[0].id, sourceArena.id);
      assert.equal(packet.arenas[0].used, sourceArena.used);
      assert.strictEqual(packet.arenas[0].memory, sourceArena.memory);
      assert.equal(hash(new Uint8Array(sourceArena.memory.buffer, HEAP_START, sourceArena.used - HEAP_START)), sourceHash);
    },
    expectedDigest: hash(JSON.stringify(expected.map(canonical))),
    fixture: { kind: spec.kind, type: spec.type, count: spec.count, offset: spec.offset ?? 0,
      sourceUsed: sourceArena?.used ?? null, expectedTargetUsed: allocationBytes,
      sourceDescriptor: sourceDescriptor ?? null,
      timedOperation: spec.kind === 'reset' ? 'resetSharedList plus new SharedList(number)' : 'compact(source)',
      oracle: spec.type === 'string' ? 'complete public toArray plus shape, allocation and writable result' : 'every returned wire vector value plus public boundary reads, shape, allocation and writable result' },
  };
}
