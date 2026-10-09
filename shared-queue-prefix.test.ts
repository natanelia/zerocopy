import { describe, expect, test } from 'vitest';
import { Arena, arenaOf, HEAP_START } from './arena';
import { SharedQueue, resetQueue } from './shared-queue';
import { getWorkerData, initWorker } from './shared';

function numbers(values: readonly number[], source = new Arena()): SharedQueue<'number'> {
  let queue = new SharedQueue('number', 0, 0, 0, undefined, source);
  for (const value of values) queue = queue.enqueue(value);
  return queue;
}
function values<T extends string>(queue: SharedQueue<T>): unknown[] {
  const result: unknown[] = [];
  while (!queue.isEmpty) {
    const front = queue.peek();
    expect(queue.peek()).toEqual(front);
    result.push(front); queue = queue.dequeue();
  }
  expect(queue.peek()).toBeUndefined(); expect(queue.dequeue()).toBe(queue);
  return result;
}

describe('queue persistent-prefix reads', () => {
  test.each([0, 1, 31, 32, 33, 63, 64, 65, 1024, 1025, 1056, 1057, 4097])(
    'preserves repeated reads and old snapshots across %i entries', count => {
      const expected = Array.from({ length: count }, (_, i) => i);
      const queue = numbers(expected), old = queue;
      expect(values(queue)).toEqual(expected);
      expect(old.size).toBe(count); expect(old.peek()).toBe(expected[0]);
      expect(values(old)).toEqual(expected);
    });

  test('switches roots, depths and blocks between queues in the same arena', () => {
    const arena = new Arena();
    const queues = [33, 65, 1057].map((count, group) => numbers(Array.from({ length: count }, (_, i) => group * 10000 + i), arena));
    const starts = [0, 1, 31, 32, 63, 64, 1023, 1024, 1055, 1056];
    const snapshots = queues.flatMap((queue, group) => starts.filter(start => start < queue.size).map(start => {
      for (let i = 0; i < start; i++) queue = queue.dequeue();
      const snapshot = queue;
      queue = queues[group];
      return { snapshot, expected: group * 10000 + start };
    }));
    for (let pass = 0; pass < 3; pass++) for (const { snapshot, expected } of snapshots) expect(snapshot.peek()).toBe(expected);
    for (const { snapshot, expected } of snapshots.toReversed()) expect(snapshot.peek()).toBe(expected);
  });

  test('retains byte-identical old prefixes while forks diverge at linked blocks', () => {
    const expected = Array.from({ length: 64 }, (_, i) => i), base = numbers(expected), arena = arenaOf(base);
    expect(base.peek()).toBe(0);
    const before = arena.buf.slice(HEAP_START, arena.used);
    let left = base, right = base;
    for (let i = 64; i < 129; i++) { left = left.enqueue(i); right = right.enqueue(-i); }
    for (let i = 0; i < 64; i++) { left = left.dequeue(); right = right.dequeue(); }
    for (let i = 64; i < 129; i++) {
      expect(left.peek()).toBe(i); expect(right.peek()).toBe(-i); expect(base.peek()).toBe(0);
      left = left.dequeue(); right = right.dequeue();
    }
    expect(values(base)).toEqual(expected);
    expect(arena.buf.slice(HEAP_START, HEAP_START + before.length)).toEqual(before);
  });

  test('cached old views survive explicit shared growth and newly allocated roots', () => {
    const memory = new WebAssembly.Memory({ initial: 2, maximum: 64, shared: true }), arena = new Arena({ memory });
    const expected = Array.from({ length: 1057 }, (_, i) => i), old = numbers(expected, arena);
    expect(old.peek()).toBe(0);
    const oldBuffer = memory.buffer, oldView = arena.dv;
    memory.grow(2);
    expect(memory.buffer).not.toBe(oldBuffer); expect(oldView.byteLength).toBe(oldBuffer.byteLength);
    expect(old.peek()).toBe(0);
    arena.alloc(memory.buffer.byteLength);
    const newer = numbers(Array.from({ length: 65 }, (_, i) => -i), arena);
    expect(newer.head).toBeGreaterThan(oldView.byteLength);
    expect(newer.peek()).toBe(-0); expect(old.peek()).toBe(0);
    expect(values(newer)).toEqual(Array.from({ length: 65 }, (_, i) => -i));
    expect(values(old)).toEqual(expected);
  });

  test.each([false, true])('old and fresh read-only attachments survive writer growth (copy=%s)', async copy => {
    const expected = Array.from({ length: 1057 }, (_, i) => i), old = numbers(expected), arena = arenaOf(old);
    const attached = (await initWorker(getWorkerData({ queue: old }, { copy }))).queue;
    const readerArena = arenaOf(attached), readerBuffer = readerArena.memory.buffer;
    expect(attached.peek()).toBe(0);
    const published = arena.buf.slice(HEAP_START, arena.used);
    arena.alloc(arena.memory.buffer.byteLength * 2);
    const newer = numbers(Array.from({ length: 65 }, (_, i) => 5000 + i), arena);
    const fresh = (await initWorker(getWorkerData({ old, newer }, { copy })));
    expect(readerArena.memory.buffer.byteLength > readerBuffer.byteLength).toBe(!copy);
    if (copy) expect(() => readerArena.memory.grow(1)).toThrow(RangeError);
    expect(values(attached)).toEqual(expected); expect(values(fresh.old)).toEqual(expected);
    expect(values(fresh.newer)).toEqual(Array.from({ length: 65 }, (_, i) => 5000 + i));
    expect(() => attached.enqueue(1)).toThrow(/read-only/);
    expect(() => fresh.newer.enqueue(1)).toThrow(/read-only/);
    expect(arena.buf.slice(HEAP_START, HEAP_START + published.length)).toEqual(published);
    resetQueue(); expect(attached.peek()).toBe(0); expect(old.peek()).toBe(0);
  });

  test.each([false, true])('nested queues share a reader safely when peeks alternate (copy=%s)', async copy => {
    const arena = new Arena();
    const nested = Array.from({ length: 65 }, (_, i) => numbers(Array.from({ length: 65 }, (_, j) => i * 1000 + j), arena));
    let outer = new SharedQueue('SharedQueue<number>', 0, 0, 0, undefined, arena);
    for (const value of nested) outer = outer.enqueue(value);
    const attached = (await initWorker(getWorkerData({ outer }, { copy }))).outer;
    let cursor = attached;
    for (let i = 0; i < nested.length; i++) {
      const inner = cursor.peek()!;
      expect(arenaOf(inner)).toBe(arenaOf(attached));
      expect(inner.peek()).toBe(i * 1000);
      expect(cursor.peek()).toBe(inner);
      expect(values(inner)).toEqual(Array.from({ length: 65 }, (_, j) => i * 1000 + j));
      cursor = cursor.dequeue();
    }
    expect(attached.peek()!.peek()).toBe(0); expect(values(outer.peek()!)).toEqual(values(nested[0]));
  });

  test('preserves special numbers and primitive/object decoding through full prefixes', () => {
    const special = [NaN, -0, 0, Infinity, -Infinity, Number.MIN_VALUE, Number.MAX_VALUE];
    expect(values(numbers(Array.from({ length: 97 }, (_, i) => special[i % special.length])))).toEqual(Array.from({ length: 97 }, (_, i) => special[i % special.length]));
    for (const type of ['boolean', 'string', 'object'] as const) {
      const expected = Array.from({ length: 97 }, (_, i) => type === 'boolean' ? !!(i & 1) : type === 'string' ? `${i}:\ufeff値😀` : { index: i, nested: [i, '値'] });
      let queue = new SharedQueue(type);
      for (const value of expected) queue = queue.enqueue(value as never);
      expect(values(queue)).toEqual(expected);
      if (type === 'object') expect(Object.isFrozen((queue.peek() as any).nested)).toBe(true);
    }
  });

  test('rejects a nonshared imported memory before any queue can cache a view', () => {
    const memory = new WebAssembly.Memory({ initial: 2, maximum: 64 });
    expect(() => new Arena({ memory })).toThrow(WebAssembly.LinkError);
  });
});
