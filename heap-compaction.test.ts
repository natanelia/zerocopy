import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { Arena, arenaOf, HEAP_START } from './arena';
import { SharedPriorityQueue, SharedMap, compact, compactMany, getWorkerData, initWorker } from './shared';

function bytes(a: Arena): Uint8Array { return a.buf.slice(HEAP_START, a.used); }
function unchanged(a: Arena, before: Uint8Array): void {
  assert.deepEqual(a.buf.slice(HEAP_START, HEAP_START + before.length), before);
}
function drain(queue: SharedPriorityQueue<any>): unknown[] {
  const result = [];
  while (queue.size) { result.push([queue.peek(), queue.peekPriority()]); queue = queue.dequeue(); }
  return result;
}
function nodes(queue: SharedPriorityQueue<any>): Set<number> {
  const result = new Set<number>(), pending = queue.root ? [queue.root] : [], view = arenaOf(queue).dv;
  while (pending.length) {
    const node = pending.pop()!;
    if (result.has(node)) continue;
    result.add(node);
    for (const offset of [16, 20]) { const child = view.getUint32(node + offset, true); if (child) pending.push(child); }
  }
  return result;
}

describe('priority-queue compaction', () => {
  test('empty heaps and special number bits keep their values and dequeue order', () => {
    for (const maxHeap of [false, true]) {
      const a = new Arena();
      const empty = new SharedPriorityQueue('number', { maxHeap }, a), emptyCopy = compact(empty);
      assert.equal(emptyCopy.isMaxHeap, maxHeap);
      assert.equal(emptyCopy.size, 0);
      assert.deepEqual([...emptyCopy.entries()], []);
      let queue = empty;
      const values = [NaN, -0, 0, Infinity, -Infinity, Number.MIN_VALUE, -Number.MIN_VALUE, 7];
      const priorities = [-0, 0, -Infinity, Infinity, -Infinity, Infinity, 3, 3];
      values.forEach((value, i) => { queue = queue.enqueue(value, priorities[i]); });
      const before = bytes(a), expected = [...queue.entries()], copy = compact(queue);
      assert.notEqual(arenaOf(copy), a);
      assert.equal(copy.isMaxHeap, maxHeap);
      assert.equal(copy.size, queue.size);
      assert.deepEqual([...copy.entries()], expected);
      assert.deepEqual(drain(copy), drain(queue));
      unchanged(a, before);
      assert.deepEqual([...queue.entries()], expected);
    }
  });

  test('long left spines stay iterative and retain all nodes', () => {
    const a = new Arena();
    let queue = new SharedPriorityQueue('number', undefined, a);
    for (let i = 0; i < 16384; i++) queue = queue.enqueue(i, -i);
    const before = bytes(a), copy = compact(queue);
    assert.deepEqual([...copy.entries()], [...queue.entries()]);
    assert.equal(copy.size, 16384);
    assert.equal(nodes(copy).size, 16384);
    assert.equal(arenaOf(copy).used - HEAP_START, 16384 * 32);
    assert.equal(copy.dequeue().peek(), 16382);
    unchanged(a, before);
  });

  test('compacting forks together retains shared nodes and repeated snapshot identity', () => {
    const a = new Arena();
    let original = new SharedPriorityQueue('number', undefined, a);
    for (let i = 0; i < 128; i++) original = original.enqueue(i, (i * 53) % 137);
    const left = original.enqueue(200, -1), right = original.enqueue(300, -2);
    const expected = [original, left, right].map(queue => [...queue.entries()]);
    const before = bytes(a), copies = compactMany({ original, left, right, again: original });
    assert.equal(copies.again, copies.original);
    assert.equal(arenaOf(copies.original), arenaOf(copies.left));
    assert.equal(arenaOf(copies.left), arenaOf(copies.right));
    const sets = [copies.original, copies.left, copies.right].map(nodes);
    const unique = new Set(sets.flatMap(set => [...set]));
    const sourceUnique = new Set([original, left, right].flatMap(queue => [...nodes(queue)]));
    assert.equal(unique.size, sourceUnique.size);
    assert.ok(unique.size < sets.reduce((sum, set) => sum + set.size, 0));
    assert.equal(arenaOf(copies.original).used - HEAP_START, unique.size * 32);
    [copies.original, copies.left, copies.right].forEach((queue, i) => {
      assert.deepEqual([...queue.entries()], expected[i]);
      assert.ok(Object.isFrozen(queue));
    });
    assert.equal(copies.left.enqueue(400, -3).peek(), 400);
    assert.deepEqual([...copies.original.entries()], expected[0]);
    unchanged(a, before);
  });

  test('strings, booleans and JSON blobs are copied without changing source payloads', () => {
    for (const [type, values] of [
      ['string', ['', '\ufeff', '界🙂', 'long '.repeat(2000)]],
      ['boolean', [true, false, true, false]],
      ['object', [{ x: [1, 2] }, { text: '界🙂' }, null, ['array', { value: 3 }]]],
    ] as const) {
      const a = new Arena();
      let queue: SharedPriorityQueue<any> = new SharedPriorityQueue(type, undefined, a);
      values.forEach((value, i) => { queue = queue.enqueue(value, i % 2); });
      const before = bytes(a), expected = [...queue.entries()], copy = compact(queue);
      assert.deepEqual([...copy.entries()], expected);
      assert.deepEqual(drain(copy), drain(queue));
      if (type === 'object') for (const [value] of copy.entries()) {
        if (value !== null) assert.ok(Object.isFrozen(value));
      }
      unchanged(a, before);
    }
  });

  test('nested values use the common compactor and can grow the destination memory', () => {
    const inner = new SharedMap('string').set('text', '界🙂'.repeat(40000));
    const queue = new SharedPriorityQueue('SharedMap<string>').enqueue(inner, 2).enqueue(inner, 1);
    const sourceArena = arenaOf(queue), before = bytes(sourceArena);
    const result = compactMany({ queue, inner });
    assert.equal(getWorkerData(result, { copy: false }).arenas.length, 1);
    assert.ok(arenaOf(result.queue).memory.buffer.byteLength > 131072);
    for (const [value] of result.queue.entries()) {
      assert.equal(value.get('text'), inner.get('text'));
      assert.equal(arenaOf(value), arenaOf(result.inner));
      assert.deepEqual(value.toWorkerData(), result.inner.toWorkerData());
    }
    unchanged(sourceArena, before);
  });

  test('equal addresses in different source arenas keep separate relocation tables', () => {
    const firstArena = new Arena(), secondArena = new Arena();
    const first = new SharedPriorityQueue('number', undefined, firstArena).enqueue(11, 1).enqueue(22, 2);
    const second = new SharedPriorityQueue('number', undefined, secondArena).enqueue(111, 1).enqueue(222, 2);
    assert.equal(first.root, second.root);
    const copies = compactMany({ first, second });
    assert.notEqual(copies.first.root, copies.second.root);
    assert.deepEqual([...copies.first.entries()], [[11, 1], [22, 2]]);
    assert.deepEqual([...copies.second.entries()], [[111, 1], [222, 2]]);
    assert.equal(arenaOf(copies.first), arenaOf(copies.second));
  });

  test('reentrant nested heap compaction keeps value types and shared children distinct', () => {
    const a = new Arena();
    const inner = new SharedPriorityQueue('number', undefined, a).enqueue(7, 1).enqueue(9, 2);
    const outer = new SharedPriorityQueue('SharedPriorityQueue<number>', undefined, a).enqueue(inner, 1).enqueue(inner, 2);
    const before = bytes(a), copies = compactMany({ outer, inner });
    assert.equal(getWorkerData(copies, { copy: false }).arenas.length, 1);
    for (const [child] of copies.outer.entries()) {
      assert.deepEqual(child.toWorkerData(), copies.inner.toWorkerData());
      assert.deepEqual([...child.entries()], [[7, 1], [9, 2]]);
      assert.equal(arenaOf(child), arenaOf(copies.inner));
    }
    unchanged(a, before);
  });

  test('shared and copied read-only attachments compact into independent writable heaps', async () => {
    const a = new Arena();
    let queue = new SharedPriorityQueue('number', undefined, a);
    for (let i = 0; i < 257; i++) queue = queue.enqueue(i, (i * 131) % 263);
    const expected = [...queue.entries()], before = bytes(a);
    const readers = await Promise.all([false, true].map(copy => initWorker(getWorkerData({ queue }, { copy }))));
    const oldBuffer = a.memory.buffer;
    a.alloc(oldBuffer.byteLength);
    assert.ok(a.memory.buffer.byteLength > oldBuffer.byteLength);
    for (const { queue: attached } of readers) {
      assert.throws(() => attached.enqueue(900, -1), /read-only/);
      const copy = compact(attached), attachedBytes = bytes(arenaOf(attached));
      assert.deepEqual([...copy.entries()], expected);
      assert.equal(copy.enqueue(900, -1).peek(), 900);
      assert.deepEqual([...attached.entries()], expected);
      unchanged(arenaOf(attached), attachedBytes);
    }
    unchanged(a, before);
  });
});
