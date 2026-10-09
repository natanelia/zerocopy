import { describe, test, expect } from 'vitest';
import { Arena, arenaOf } from './arena';
import { SharedLinkedList } from './shared-linked-list';
import { SharedDoublyLinkedList } from './shared-doubly-linked-list';
import { SharedList } from './shared-list';
import { getWorkerData, initWorker, compact } from './shared';

const kinds = [SharedLinkedList, SharedDoublyLinkedList] as const;
function make(C: any, type: string, values: any[]) {
  const arena = new Arena({ memory: new WebAssembly.Memory({ initial: 2, maximum: 256, shared: true }) });
  let list = new C(type, 0, 0, 0, arena);
  for (const value of values) list = list.append(value);
  return list;
}
function legacy(list: any, fn: (value: any, index: number) => void, reverse = false) {
  const a = arenaOf(list); let i = reverse ? list.size - 1 : 0;
  if (reverse) {
    for (let t = list.tailSize - 1; t >= 0; t--) fn(a.decode(list.valueType, a.dv.getFloat64(list.tail + t * 8, true)), i--);
    for (const raw of a.blocks(list.head, true)) fn(a.decode(list.valueType, raw), i--);
  } else {
    for (const raw of a.blocks(list.head)) fn(a.decode(list.valueType, raw), i++);
    for (let t = 0; t < list.tailSize; t++) fn(a.decode(list.valueType, a.dv.getFloat64(list.tail + t * 8, true)), i++);
  }
}
function run(list: any, fn: (value: any, index: number) => void, reverse: boolean) {
  if (reverse) list.forEachReverse(fn); else list.forEach(fn);
}
const nested = new SharedList('number').pushMany([3, 5]);
const cases = [
  ['number', (i: number) => i === 0 ? -0 : i === 1 ? NaN : i],
  ['string', (i: number) => `v${i}🙂\u0000`],
  ['object', (i: number) => ({ i, deep: [i, { key: 'value' }] })],
  ['SharedList<number>', () => nested],
] as const;

describe('block callback traversal', () => {
  for (const C of kinds) for (const [type, value] of cases) test(`${C.name} ${type} boundaries and old snapshots`, () => {
    for (const n of [0, 1, 32, 33, 65, 4097]) {
      const values = Array.from({ length: n }, (_, i) => value(i)), list = make(C, type, values);
      const before = arenaOf(list).used;
      for (const reverse of C === SharedDoublyLinkedList ? [false, true] : [false]) {
        const got: any[] = [], expected: any[] = [];
        run(list, function (v, i) { expect(this).toBeUndefined(); expect(arguments.length).toBe(2); got.push([v, i]); }, reverse);
        legacy(list, (v, i) => expected.push([v, i]), reverse);
        expect(got).toEqual(expected);
        expect(got.map(([v]) => type === 'SharedList<number>' ? v.toArray() : v)).toEqual((reverse ? [...values].reverse() : values).map(v => type === 'SharedList<number>' ? v.toArray() : v));
      }
      expect(arenaOf(list).used).toBe(before);
      if (n) {
        const prepended = list.prepend(value(9));
        const edited = (C === SharedLinkedList ? prepended.removeAfter(0) : prepended.remove(1)).append(value(10));
        expect(list.toArray()).toEqual(values);
        expect(edited.toArray()).toEqual([value(9), ...values.slice(1), value(10)]);
      }
    }
  });

  for (const C of kinds) test(`${C.name} scalar reads, decode lookup, and callback order match`, () => {
    for (const reverse of C === SharedDoublyLinkedList ? [false, true] : [false]) {
      const list = make(C, 'number', Array.from({ length: 65 }, (_, i) => i)), a = arenaOf(list);
      const dvGet = Object.getOwnPropertyDescriptor(Arena.prototype, 'dv')!.get!, decode = a.decode;
      let events: any[] = [];
      Object.defineProperty(a, 'dv', { configurable: true, get() {
        events.push('dv'); const dv = dvGet.call(a);
        return new Proxy(dv, { get(target, key) {
          if (key === 'getUint32' || key === 'getFloat64') return function (offset: number, little: boolean) {
            events.push([key, offset, little]); return target[key](offset, little);
          };
          return Reflect.get(target, key, target);
        } });
      } });
      Object.defineProperty(a, 'decode', { configurable: true, get() {
        events.push('decode:get');
        return function (type: string, raw: number) { expect(this).toBe(a); events.push(['decode', type, raw]); return decode.call(a, type, raw); };
      } });
      legacy(list, (v, i) => events.push(['callback', v, i]), reverse);
      const expected = events; events = [];
      run(list, (v, i) => events.push(['callback', v, i]), reverse);
      expect(events).toEqual(expected);
    }
  });

  for (const C of kinds) test(`${C.name} lazy decoding and exceptions stop at the same value`, () => {
    for (const reverse of C === SharedDoublyLinkedList ? [false, true] : [false]) for (const failure of ['callback', 'decode']) {
      const list = make(C, 'object', Array.from({ length: 65 }, (_, i) => ({ i }))), a = arenaOf(list), original = a.decode;
      const error = new Error('stop'); let seen: number[] = [], decoded: number[] = [];
      a.decode = function (type, raw) { const value: any = original.call(this, type, raw); decoded.push(value.i); if (failure === 'decode' && decoded.length === 4) throw error; return value; };
      const cb = (v: any) => { seen.push(v.i); if (failure === 'callback' && seen.length === 4) throw error; };
      expect(() => legacy(list, cb, reverse)).toThrow(error); const expected = [seen, decoded]; seen = []; decoded = [];
      expect(() => run(list, cb, reverse)).toThrow(error); expect([seen, decoded]).toEqual(expected);
    }
  });

  for (const C of kinds) test(`${C.name} reentrant traversal, forks, attachment, and shared growth`, async () => {
    const list = make(C, 'number', Array.from({ length: 65 }, (_, i) => i)), a = arenaOf(list), old = list.toArray();
    const reader: any = await initWorker(getWorkerData({ list }, { copy: false }));
    const copied: any = await initWorker(getWorkerData({ list }, { copy: true }));
    const prefix = a.copy(), initial = a.memory.buffer.byteLength;
    for (const reverse of C === SharedDoublyLinkedList ? [false, true] : [false]) {
      const seen: number[] = [];
      run(reader.list, (v, i) => {
        seen.push(v);
        if (seen.length === 1) {
          expect(list.toArray()).toEqual(old); expect(copied.list.toArray()).toEqual(old);
          const edited = list.prepend(-1).append(65); expect(edited.size).toBe(67);
          a.alloc(a.memory.buffer.byteLength + 65536);
          expect(reader.list.toArray()).toEqual(old);
        }
      }, reverse);
      expect(seen).toEqual(reverse ? [...old].reverse() : old);
    }
    expect(a.memory.buffer.byteLength).toBeGreaterThan(initial);
    expect(a.buf.slice(65536, prefix.length)).toEqual(prefix.slice(65536));
    expect(() => reader.list.append(7)).toThrow(/read-only/);
    expect(() => copied.list.append(7)).toThrow(/read-only/);
  });

  for (const C of kinds) test(`${C.name} Arena.blocks override receiver, arguments, getter count, and cleanup`, () => {
    for (const n of [0, 1, 65]) for (const reverse of C === SharedDoublyLinkedList ? [false, true] : [false]) {
      const list = make(C, 'number', Array.from({ length: n }, (_, i) => i)), a = arenaOf(list);
      let gets = 0, calls: any[] = [], closes = 0;
      const override = function* (...args: any[]) { calls.push([this === a, args]); try { yield 100; yield 200; } finally { closes++; } };
      Object.defineProperty(override, 'call', { value() { throw new Error('do not use user function.call'); } });
      Object.defineProperty(a, 'blocks', { configurable: true, get() { gets++; return override; } });
      let got: any[] = []; legacy(list, (v, i) => got.push([v, i]), reverse); const expected = { got, gets, calls, closes };
      gets = 0; calls = []; closes = 0; got = [];
      run(list, (v, i) => got.push([v, i]), reverse); expect({ got, gets, calls, closes }).toEqual(expected);
      gets = 0; closes = 0;
      expect(() => run(list, v => { if (v === 100) throw new Error('callback'); }, reverse)).toThrow('callback');
      expect(gets).toBe(1); expect(closes).toBe(1);
    }
  });

  for (const C of kinds) test(`${C.name} partial spans after tree edits retain every old version`, () => {
    let list = make(C, 'number', Array.from({ length: 97 }, (_, i) => i));
    let model = Array.from({ length: 97 }, (_, i) => i); const saved: any[] = [[list, model]];
    for (let step = 0; step < 120; step++) {
      const at = (step * 37) % model.length;
      if (step % 3 === 0) { list = list.insertAfter(at, 1000 + step); model = [...model.slice(0, at + 1), 1000 + step, ...model.slice(at + 1)]; }
      else if (C === SharedDoublyLinkedList) { list = list.remove(at); model = [...model.slice(0, at), ...model.slice(at + 1)]; }
      else { list = list.removeFirst(); model = model.slice(1); }
      saved.push([list, model]);
    }
    for (const [snapshot, expected] of saved) {
      expect(snapshot.toArray()).toEqual(expected);
      if (C === SharedDoublyLinkedList) expect(snapshot.toArrayReverse()).toEqual([...expected].reverse());
    }
  });

  test('reverse tail callback can replace the following head traversal', () => {
    const list = make(SharedDoublyLinkedList, 'number', Array.from({ length: 65 }, (_, i) => i)), a = arenaOf(list);
    const seen: any[] = [];
    list.forEachReverse((v: number, i: number) => {
      seen.push([v, i]);
      if (v === 64) a.blocks = function* (root, reverse) { expect(this).toBe(a); expect(root).toBe(list.head); expect(reverse).toBe(true); yield 700; };
    });
    expect(seen).toEqual([[64, 64], [700, 63]]);
  });

  test('public toArray methods preserve forEach overrides; compaction keeps scalar blocks', () => {
    class Forward extends SharedLinkedList<'number'> { forEach(fn: (v: number, i: number) => void) { fn(17, 0); } }
    class Backward extends SharedDoublyLinkedList<'number'> { forEachReverse(fn: (v: number, i: number) => void) { fn(23, 0); } }
    expect(new Forward('number').toArray()).toEqual([17]); expect(new Backward('number').toArrayReverse()).toEqual([23]);
    const list = make(SharedLinkedList, 'number', Array.from({ length: 65 }, (_, i) => i)), a = arenaOf(list), blocks = a.blocks;
    let calls = 0; a.blocks = function* (root, reverse) { calls++; yield* blocks.call(this, root, reverse); };
    expect(compact(list).toArray()).toEqual(list.toArray()); expect(calls).toBe(2);
  });
});
