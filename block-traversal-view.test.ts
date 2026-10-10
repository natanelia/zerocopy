import assert from 'node:assert/strict';
import { describe, expect, it } from 'vitest';
import { Arena, arenaOf, HEAP_START } from './arena';
import { structureRegistry } from './codec';
import { SharedLinkedList, SharedDoublyLinkedList, compact, compactMany, getWorkerData, initWorker } from './shared';

const classes = [SharedLinkedList, SharedDoublyLinkedList] as const;
const numbers = (n: number) => Array.from({ length: n }, (_, i) => i + 0.25);
function make(C: any, type: string, values: any[], a = new Arena()): any {
  let item = new C(type, 0, 0, 0, a, 0);
  for (const value of values) item = item.append(value);
  return item;
}
function trace(a: Arena) {
  const get = Object.getOwnPropertyDescriptor(Arena.prototype, 'dv')!.get!;
  const refresh = a.refresh;
  const calls = { dv: 0, refresh: 0 };
  Object.defineProperty(a, 'dv', { configurable: true, get() { calls.dv++; return get.call(this); } });
  a.refresh = function () { calls.refresh++; return refresh.call(this); };
  return { calls, clear() { calls.dv = calls.refresh = 0; }, restore() { delete (a as any).dv; delete (a as any).refresh; } };
}
function prefix(item: any, expected: any[]) { return expected.slice(0, item.size - item.tailSize); }
function bytes(a: Arena) { return a.buf.slice(HEAP_START, a.used); }
function unchanged(a: Arena, before: Uint8Array) {
  assert.deepEqual(a.buf.slice(HEAP_START, HEAP_START + before.length), before);
}

describe('block traversal snapshot views', () => {
  it('keeps empty roots and never-started generators free of view access', () => {
    const a = new Arena(), item = make(SharedLinkedList, 'number', numbers(65), a), probe = trace(a);
    try {
      const idle = a.blocks(item.head), reverse = a.blocks(item.head, true), empty = a.blocks(0);
      expect(probe.calls).toEqual({ dv: 0, refresh: 0 });
      idle.return(undefined); reverse.return(undefined);
      expect(empty.next()).toEqual({ done: true, value: undefined });
      expect([...a.blocks(0, true)]).toEqual([]);
      const neverStarted = a.blocks(item.head), error = new Error('stop before start');
      expect(() => neverStarted.throw(error)).toThrow(error);
      expect(probe.calls).toEqual({ dv: 0, refresh: 0 });
    } finally { probe.restore(); }
  });

  for (const C of classes) {
    it(`${C.name}: refreshes once per nonempty traversal at block and tail boundaries`, () => {
      for (const size of [0, 1, 31, 32, 33, 64, 65, 129, 4097]) {
        const expected = numbers(size), item = make(C, 'number', expected), a = arenaOf(item), probe = trace(a);
        try {
          for (const reverse of [false, true]) {
            probe.clear();
            const iterator = a.blocks(item.head, reverse);
            expect(probe.calls.dv).toBe(0);
            const want = prefix(item, expected);
            expect([...iterator]).toEqual(reverse ? want.reverse() : want);
            const count = item.head ? 1 : 0;
            expect(probe.calls).toEqual({ dv: count, refresh: count });
          }
          probe.clear();
          expect(item.toArray()).toEqual(expected);
          const count = (item.head ? 1 : 0) + item.tailSize;
          expect(probe.calls).toEqual({ dv: count, refresh: count });
          if (C === SharedDoublyLinkedList) {
            probe.clear(); expect(item.toArrayReverse()).toEqual(expected.slice().reverse());
            expect(probe.calls).toEqual({ dv: count, refresh: count });
          }
          probe.clear();
          const copy = compact(item);
          expect(probe.calls).toEqual({ dv: count, refresh: count });
          expect(copy.toArray()).toEqual(expected);
        } finally { probe.restore(); }
      }
    });

    it(`${C.name}: preserves interleaved forward, reverse, forked and independent iterators across growth`, () => {
      const expected = numbers(257), a = new Arena(), item = make(C, 'number', expected, a);
      const fork = item.insertAfter(43, -1).removeFirst(), forkExpected = expected.slice(1);
      forkExpected.splice(43, 0, -1);
      const otherExpected = numbers(97).map(n => -n), other = make(C, 'number', otherExpected);
      const oldView = a.dv, before = bytes(a);
      const iters = [a.blocks(item.head), a.blocks(item.head, true), a.blocks(fork.head), arenaOf(other).blocks(other.head)];
      const wants = [prefix(item, expected), prefix(item, expected).reverse(), prefix(fork, forkExpected), prefix(other, otherExpected)];
      const seen = iters.map(iterator => [iterator.next().value]);
      a.alloc(oldView.byteLength);
      expect(a.memory.buffer.byteLength).toBeGreaterThan(oldView.byteLength);
      expect(oldView.byteLength).toBeGreaterThan(0);
      for (let step = 1; step < 270; step++) {
        for (let i = 0; i < iters.length; i++) {
          const next = iters[i].next(); if (!next.done) seen[i].push(next.value);
        }
      }
      expect(seen).toEqual(wants);
      expect(item.toArray()).toEqual(expected); expect(fork.toArray()).toEqual(forkExpected);
      unchanged(a, before);
    });

    it(`${C.name}: captures after first next, including roots created after the previous view`, () => {
      const a = new Arena(), old = a.dv;
      a.alloc(old.byteLength); // The next root must lie outside the old view.
      const expected = numbers(65), item = make(C, 'number', expected, a), iterator = a.blocks(item.head);
      expect(item.head).toBeGreaterThanOrEqual(old.byteLength);
      const probe = trace(a);
      try {
        expect(probe.calls.dv).toBe(0);
        expect([...iterator]).toEqual(prefix(item, expected));
        expect(probe.calls).toEqual({ dv: 1, refresh: 1 });
      } finally { probe.restore(); }
    });

    for (const reverse of C === SharedDoublyLinkedList ? [false, true] : [false]) {
      it(`${C.name}: ${reverse ? 'reverse' : 'forward'} callbacks can reenter, fork and grow the owner`, () => {
        const expected = numbers(129), a = new Arena(), item = make(C, 'number', expected, a), fork = item.prepend(-1);
        const before = bytes(a), visited: number[] = [], indices: number[] = [], oldLength = a.memory.buffer.byteLength;
        let newer: any;
        item[reverse ? 'forEachReverse' : 'forEach']((value: number, index: number) => {
          if (visited.length === 3) {
            expect(item.toArray()).toEqual(expected);
            expect(fork.toArray()).toEqual([-1, ...expected]);
            newer = item.append(999);
            a.alloc(oldLength);
            expect(a.memory.buffer.byteLength).toBeGreaterThan(oldLength);
          }
          visited.push(value); indices.push(index);
        });
        expect(visited).toEqual(reverse ? expected.slice().reverse() : expected);
        const indexes = expected.map((_, i) => i);
        expect(indices).toEqual(reverse ? indexes.reverse() : indexes);
        expect(newer.toArray()).toEqual([...expected, 999]);
        unchanged(a, before);
      });
    }

    it(`${C.name}: early return and callback throws do not affect later scans`, () => {
      const expected = numbers(97), item = make(C, 'number', expected), a = arenaOf(item), error = new Error('callback stopped');
      const forward = a.blocks(item.head), reverse = a.blocks(item.head, true);
      expect(forward.next().value).toBe(expected[0]);
      forward.return(undefined); expect(forward.next().done).toBe(true);
      expect(reverse.next().value).toBe(prefix(item, expected).at(-1));
      expect(() => reverse.throw(error)).toThrow(error); expect(reverse.next().done).toBe(true);
      expect(() => item.forEach((_value: number, index: number) => { if (index === 12) throw error; })).toThrow(error);
      if (C === SharedDoublyLinkedList) expect(() => item.forEachReverse(() => { throw error; })).toThrow(error);
      expect(item.toArray()).toEqual(expected);
    });

    for (const type of ['number', 'boolean', 'string', 'object']) {
      it(`${C.name}<${type}>: source, shared, fixed-size copy, forks and compaction agree`, async () => {
        const special = [-0, NaN, Infinity, -Infinity, Number.MIN_VALUE, 1.25];
        const expected = Array.from({ length: 97 }, (_, i) => type === 'number' ? special[i % special.length]
          : type === 'boolean' ? i % 3 === 0 : type === 'string' ? `界🙂\u0000${i}` : { i, deep: { value: i } });
        const a = new Arena(), item = make(C, type, expected, a), fork = item.prepend(expected[0]);
        const before = bytes(a), rebuilt = compactMany({ item, fork });
        for (const copy of [false, true]) {
          const attached = await initWorker(getWorkerData({ item, fork }, { copy }));
          for (const current of [item, attached.item, rebuilt.item]) {
            expect(current.toArray()).toEqual(expected);
            if (C === SharedDoublyLinkedList) expect(current.toArrayReverse()).toEqual(expected.slice().reverse());
            if (type === 'object') expect(Object.isFrozen(current.get(0).deep)).toBe(true);
          }
          expect(attached.fork.toArray()).toEqual([expected[0], ...expected]);
          expect(arenaOf(attached.item).memory.buffer).toBeInstanceOf(SharedArrayBuffer);
          expect(() => attached.item.append(expected[0])).toThrow(/read-only/);
          if (copy) expect(() => arenaOf(attached.item).memory.grow(1)).toThrow();
          a.alloc(a.memory.buffer.byteLength);
          expect(attached.item.toArray()).toEqual(expected);
        }
        expect(rebuilt.fork.toArray()).toEqual([expected[0], ...expected]); unchanged(a, before);
      });
    }

    it(`${C.name}: nested decode can reenter block scans and grow the outer arena`, () => {
      const a = new Arena(), childExpected = numbers(65), child = make(SharedDoublyLinkedList, 'number', childExpected, a);
      const outer = make(C, 'SharedDoublyLinkedList<number>', Array(65).fill(child), a);
      const before = bytes(a), oldLength = a.memory.buffer.byteLength;
      const factory = structureRegistry.SharedDoublyLinkedList.fromWorkerData;
      let calls = 0;
      structureRegistry.SharedDoublyLinkedList.fromWorkerData = (data, source) => {
        calls++;
        expect([...a.blocks(child.head, true)]).toEqual(prefix(child, childExpected).reverse());
        if (calls === 1) a.alloc(oldLength);
        return factory(data, source);
      };
      try {
        const seen: number[][] = [];
        outer.forEach((value: any) => seen.push(value.toArray()));
        expect(calls).toBe(65); expect(seen).toEqual(Array(65).fill(childExpected));
        expect(a.memory.buffer.byteLength).toBeGreaterThan(oldLength);
        expect(compact(outer).toArray().map((value: any) => value.toArray())).toEqual(seen);
      } finally { structureRegistry.SharedDoublyLinkedList.fromWorkerData = factory; }
      unchanged(a, before);
    });
  }

  it('supports fixed and growing shared memories and rejects unsupported unshared imports', () => {
    for (const maximum of [2, 8]) {
      const memory = new WebAssembly.Memory({ initial: 2, maximum, shared: true });
      const a = new Arena({ memory }), expected = numbers(65), item = make(SharedDoublyLinkedList, 'number', expected, a);
      const view = a.dv, iterator = a.blocks(item.head), first = iterator.next().value;
      if (maximum > 2) { memory.grow(1); expect(view.byteLength).toBe(2 * 65536); }
      expect([first, ...iterator]).toEqual(prefix(item, expected));
      expect(item.toArrayReverse()).toEqual(expected.slice().reverse());
    }
    expect(() => new Arena({ memory: new WebAssembly.Memory({ initial: 2, maximum: 8 }) })).toThrow();
  });
});
