import { describe, expect, it } from 'vitest';
import { Arena, HEAP_START } from './arena';
import { SharedPriorityQueue } from './shared-priority-queue';

const special = [-0, 0, NaN, Infinity, -Infinity, Number.MIN_VALUE, Number.MAX_VALUE, 1.25];
function heap(size: number, owner = new Arena()) {
  let item = new SharedPriorityQueue('number', undefined, owner);
  for (let i = 0; i < size; i++) item = item.enqueue(special[i % special.length], (i * 37) % 17);
  return { item, owner };
}
function trace(owner: Arena) {
  const getter = Object.getOwnPropertyDescriptor(Arena.prototype, 'dv')!.get!;
  const refresh = owner.refresh;
  const count = { getters: 0, refreshes: 0 };
  Object.defineProperty(owner, 'dv', { configurable: true, get() { count.getters++; return getter.call(this); } });
  owner.refresh = function () { count.refreshes++; return refresh.call(this); };
  return { count, restore() { delete (owner as any).dv; owner.refresh = refresh; } };
}

describe('heap entries view capture', () => {
  it('keeps the generator method shape and touches no view before an actual entry', () => {
    const method = SharedPriorityQueue.prototype.entries;
    expect(Object.prototype.toString.call(method)).toBe('[object GeneratorFunction]');
    expect(Object.getOwnPropertyDescriptor(SharedPriorityQueue.prototype, 'entries')).toMatchObject({ enumerable: false, writable: true, configurable: true });
    expect(method.name).toBe('entries'); expect(method.length).toBe(0);
    const { item, owner } = heap(1), empty = new SharedPriorityQueue('number', undefined, owner);
    const log = trace(owner);
    try {
      const iterator = item.entries();
      expect(iterator[Symbol.iterator]()).toBe(iterator);
      expect(Object.getPrototypeOf(iterator)).toBe(method.prototype);
      iterator.return(undefined);
      const error = new Error('before first next');
      expect(() => item.entries().throw(error)).toThrow(error);
      expect([...empty.entries()]).toEqual([]);
      expect(log.count).toEqual({ getters: 0, refreshes: 0 });
      expect(item.entries().next().done).toBe(false);
      expect(log.count).toEqual({ getters: 1, refreshes: 1 });
    } finally { log.restore(); }
  });

  it('requests one existing view per visited node on owners and read-only attachments', () => {
    for (const size of [0, 1, 31, 32, 33, 65, 1057, 4097]) {
      const { item, owner } = heap(size);
      const expected = [...item.entries()], bytes = owner.buf.slice(HEAP_START, owner.used);
      for (const reader of [owner, new Arena({ memory: owner.memory, used: owner.used, readOnly: true }),
        new Arena({ copy: owner.copy(), used: owner.used, readOnly: true })]) {
        const attached = SharedPriorityQueue.fromWorkerData(item.toWorkerData(), reader);
        const state = reader.state(), descriptor = attached.toWorkerData(), log = trace(reader);
        try {
          const result = [...attached.entries()];
          expect(result).toEqual(expected);
          expect(log.count).toEqual({ getters: size, refreshes: size });
          expect(reader.state()).toEqual(state);
          expect(attached.toWorkerData()).toEqual(descriptor);
        } finally { log.restore(); }
        expect(Buffer.compare(reader.buf.subarray(HEAP_START, reader.used), bytes)).toBe(0);
      }
    }
  });

  it('preserves suspended, interleaved and early-terminated iterators through owner growth', () => {
    const { item, owner } = heap(65), fork = item.enqueue(-32, -32);
    const expected = [...item.entries()], forkExpected = [...fork.entries()];
    const bytes = owner.buf.slice(HEAP_START, owner.used), oldEnd = owner.used;
    const a = item.entries(), b = fork.entries();
    const oldBuffer = owner.memory.buffer;
    owner.memory.grow(1); // Grow after creating the generator, before first next.
    expect(owner.memory.buffer).not.toBe(oldBuffer);
    const firstA = a.next().value, firstB = b.next().value;
    let writer = fork;
    for (let i = 0; i < 5000; i++) writer = writer.enqueue(i, -i);
    expect(writer.size).toBe(5066);
    expect([firstA, ...a]).toEqual(expected);
    expect([firstB, ...b]).toEqual(forkExpected);
    const stopped = item.entries(); stopped.next(); stopped.return(undefined);
    expect(stopped.next()).toEqual({ done: true, value: undefined });
    const thrown = item.entries(); thrown.next(); const error = new Error('stop');
    expect(() => thrown.throw(error)).toThrow(error);
    expect(thrown.next()).toEqual({ done: true, value: undefined });
    expect(Buffer.compare(owner.buf.subarray(HEAP_START, oldEnd), bytes)).toBe(0);
  });

  it('preserves binary64 values and priorities in detached entry tuples', () => {
    const priorities = [-0, Number.MIN_VALUE, 0.125, Infinity, -Infinity];
    for (const value of special) for (const priority of priorities) {
      const item = new SharedPriorityQueue('number').enqueue(value, priority);
      const result = [...item.entries()];
      expect(result).toEqual([[value, priority]]);
      result[0][0] = 42; result[0][1] = 43;
      expect(item.peek()).toBe(value); expect(item.peekPriority()).toBe(priority);
    }
  });

  it('keeps custom decoder receiver, order, reentrant growth and exceptions', () => {
    const { item, owner } = heap(33), expected = [...item.entries()];
    const decode = owner.decode, calls: number[] = [];
    let nested = false;
    owner.decode = function (type, raw) {
      expect(this).toBe(owner); expect(type).toBe('number');
      if (!nested) {
        calls.push(raw);
        if (calls.length === 1) {
          owner.memory.grow(1);
          nested = true;
          expect(item.enqueue(100, -100).entries().next().value).toEqual([100, -100]);
          nested = false;
        }
      }
      return decode.call(this, type, raw);
    };
    try {
      expect([...item.entries()]).toEqual(expected);
      expect(calls).toEqual(expected.map(([value]) => value));
      const error = new Error('decoder rejected value'); let seen = 0;
      owner.decode = () => { if (++seen === 3) throw error; return seen; };
      const iterator = item.entries();
      expect(iterator.next().value).toEqual([1, expected[0][1]]);
      expect(iterator.next().value).toEqual([2, expected[1][1]]);
      expect(() => iterator.next()).toThrow(error);
      expect(iterator.next()).toEqual({ done: true, value: undefined });
      expect(seen).toBe(3);
    } finally { owner.decode = decode; }
  });
});
