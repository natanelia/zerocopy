import { describe, expect, test } from 'vitest';
import { Arena, HEAP_START, MAX_SIZE, arenaOf } from './arena';
import { SharedPriorityQueue } from './shared-priority-queue';
import { SharedMap } from './shared-map';
import { compact, getWorkerData, initWorker } from './shared';

function queue(priorities: number[], maxHeap = false, arena = new Arena()) {
  let q = new SharedPriorityQueue('number', { maxHeap }, arena);
  for (let i = 0; i < priorities.length; i++) q = q.enqueue(i, priorities[i]!);
  return q;
}
function published(a: Arena) { return a.buf.slice(HEAP_START, a.used); }
function unchanged(a: Arena, old: Uint8Array) {
  expect(a.buf.slice(HEAP_START, HEAP_START + old.length)).toEqual(old);
}

for (const maxHeap of [false, true]) describe(`heap insertion (max=${maxHeap})`, () => {
  const sign = maxHeap ? -1 : 1;
  test('allocates only reachable path nodes for empty, root, interior and tied insertion', () => {
    const a = new Arena();
    let q = queue([], maxHeap, a), mark = a.used;
    q = q.enqueue(0, 0);
    expect(a.used - mark).toBe(32);
    mark = a.used;
    const promoted = q.enqueue(1, -sign);
    expect(a.used - mark).toBe(32);
    expect(a.dv.getUint32(promoted.root + 16, true)).toBe(q.root);
    expect(a.dv.getUint32(promoted.root + 20, true)).toBe(0);
    mark = a.used;
    const tied = q.enqueue(2, 0);
    expect(a.used - mark).toBe(64);
    expect(tied.peek()).toBe(0);
    q = queue([0, sign, 2 * sign], maxHeap, a);
    const original = published(a), entries = [...q.entries()];
    mark = a.used;
    const interior = q.enqueue(3, 1.5 * sign);
    expect(a.used - mark).toBe(64);
    expect([...interior.entries()]).toEqual([[0, 0], [1, sign], [3, 1.5 * sign], [2, 2 * sign]]);
    unchanged(a, original);
    expect([...q.entries()]).toEqual(entries);
    mark = a.used;
    q.enqueue(4, 3 * sign);
    expect(a.used - mark).toBe(96);
    unchanged(a, original);
  });

  test('keeps signed-zero, equal and infinite priorities and old snapshots', () => {
    const a = new Arena();
    let q = queue([], maxHeap, a);
    const priorities = [-0, 0, -Infinity, Infinity, -Infinity, Infinity, -0, 0, -1, 1];
    const old = [];
    for (let i = 0; i < priorities.length; i++) {
      const bytes = published(a), before = q;
      q = q.enqueue(i, priorities[i]!);
      unchanged(a, bytes);
      old.push(before);
    }
    const entries = [...q.entries()];
    for (let i = 0; i < priorities.length; i++) {
      expect(Object.is(entries.find(([value]) => value === i)![1], priorities[i])).toBe(true);
      expect(old[i]!.size).toBe(i);
    }
    const actual = [];
    while (q.size) { actual.push(q.peekPriority()!); q = q.dequeue(); }
    // Equal priorities have no stable dequeue order; the value/bit association
    // was checked above, and the numeric order is checked here.
    expect(actual.map(p => p === 0 ? 0 : p)).toEqual([...priorities].map(p => p === 0 ? 0 : p).sort((a, b) => maxHeap ? b - a : a - b));
  });

  test('uses normal allocator alignment after a four-byte-aligned record', () => {
    const a = new Arena(), q = queue([0], maxHeap, a);
    a.wasm.mapLeaf(1, 0);
    expect(a.used % 8).toBe(4);
    const mark = a.used, bytes = published(a);
    q.enqueue(1, -sign);
    expect(a.used - mark).toBe(36);
    unchanged(a, bytes);
  });

  test('can use the final available node and preserves snapshots after later failure', () => {
    const memory = new WebAssembly.Memory({ initial: 2, maximum: 2, shared: true });
    const a = new Arena({ memory }), q = queue([0], maxHeap, a);
    a.alloc(memory.buffer.byteLength - a.used - 32);
    const bytes = published(a);
    const next = q.enqueue(1, -sign);
    expect(a.used).toBe(memory.buffer.byteLength);
    expect(next.peek()).toBe(1);
    unchanged(a, bytes);
    const filled = published(a);
    expect(() => next.enqueue(2, -2 * sign)).toThrow(WebAssembly.RuntimeError);
    unchanged(a, filled);
    expect(next.peek()).toBe(1);
    expect(q.peek()).toBe(0);
  });

  test('failed multi-node insertion changes only unpublished allocation bytes', () => {
    const memory = new WebAssembly.Memory({ initial: 2, maximum: 2, shared: true });
    const a = new Arena({ memory }), q = queue([0, sign, 2 * sign], maxHeap, a);
    a.alloc(memory.buffer.byteLength - a.used - 64);
    const bytes = published(a), entries = [...q.entries()];
    expect(() => q.enqueue(4, 3 * sign)).toThrow(WebAssembly.RuntimeError);
    expect(a.used).toBe(memory.buffer.byteLength);
    unchanged(a, bytes);
    expect([...q.entries()]).toEqual(entries);
  });

  test('shared/copy readers and compaction retain the shape across growth', async () => {
    const a = new Arena(), q = queue([0, sign, 2 * sign], maxHeap, a);
    const shared = await initWorker(getWorkerData({ q }, { copy: false }));
    const copied = await initWorker(getWorkerData({ q }, { copy: true }));
    const initial = [...q.entries()], bytes = published(a), oldBuffer = a.memory.buffer;
    a.alloc(oldBuffer.byteLength);
    const next = q.enqueue(3, 1.5 * sign);
    expect(a.memory.buffer.byteLength).toBeGreaterThan(oldBuffer.byteLength);
    unchanged(a, bytes);
    for (const reader of [shared.q, copied.q]) {
      expect([...reader.entries()]).toEqual(initial);
      expect(() => reader.enqueue(8, 0)).toThrow(/read-only/);
      expect(() => reader.dequeue()).toThrow(/read-only/);
    }
    expect([...compact(next).entries()]).toEqual([...next.entries()]);
  });
});

test('validation and serialization failures precede heap node allocation', () => {
  const a = new Arena(), q = queue([0], false, a), bytes = published(a), mark = a.used;
  expect(() => q.enqueue(2, NaN)).toThrow(TypeError);
  expect(() => q.enqueue(2, '1' as any)).toThrow(TypeError);
  expect(() => q.enqueue('bad' as any, 0)).toThrow(TypeError);
  const tooLarge = SharedPriorityQueue.fromWorkerData({ ...q.toWorkerData(), size: MAX_SIZE }, a);
  expect(() => tooLarge.enqueue(2, 0)).toThrow(RangeError);
  const object = new SharedPriorityQueue('object', undefined, a);
  expect(() => object.enqueue({ toJSON() { throw new Error('serialization failed'); } }, -1)).toThrow('serialization failed');
  expect(a.used).toBe(mark);
  unchanged(a, bytes);
});

test('encoded strings, objects and nested values keep their payloads on promotion', async () => {
  const map = new SharedMap('string').set('key', 'value');
  const string = new SharedPriorityQueue('string').enqueue('tail', 1).enqueue('🙂 head', 0);
  const object = new SharedPriorityQueue('object').enqueue({ id: 'tail' }, 1).enqueue({ id: 'head' }, 0);
  const nested = new SharedPriorityQueue('SharedMap<string>').enqueue(map, 1).enqueue(map, 0);
  for (const copy of [false, true]) {
    const read = await initWorker(getWorkerData({ string, object, nested }, { copy }));
    expect([...read.string.entries()]).toEqual([['🙂 head', 0], ['tail', 1]]);
    expect([...read.object.entries()]).toEqual([[{ id: 'head' }, 0], [{ id: 'tail' }, 1]]);
    expect([...read.nested.entries()].map(([v, p]) => [v.get('key'), p])).toEqual([['value', 0], ['value', 1]]);
  }
  expect(arenaOf(nested).dependencies.size).toBe(1);
});
