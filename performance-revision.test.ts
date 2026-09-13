import { describe, test, expect } from 'vitest';
import * as S from './shared';
import { Arena, arenaOf, HEAP_START } from './arena';

function payload(snapshot: object) { const a = arenaOf(snapshot); return a.buf.slice(HEAP_START, a.used); }
function unchanged(snapshot: object, bytes: Uint8Array) { expect(arenaOf(snapshot).buf.slice(HEAP_START, HEAP_START + bytes.length)).toEqual(bytes); }
const numbers = (n: number) => Array.from({ length: n }, (_, i) => i);
function queueValues(q: any) { const values = []; while (q.size) { values.push(q.peek()); q = q.dequeue(); } return values; }
function heapValues(q: any) { const values = []; while (q.size) { values.push([q.peekPriority(), q.peek()]); q = q.dequeue(); } return values; }

describe('frontier tails and blocked persistent sequences', () => {
  for (const count of [0, 1, 31, 32, 33, 1024, 1025, 4097]) test(`vector branches and compaction at ${count}`, () => {
    const values = numbers(count), old = new S.SharedList('number').pushMany(values), before = payload(old);
    const left = old.push(123), right = old.push(456), popped = old.pop().push(789);
    expect(left.toArray()).toEqual([...values, 123]); expect(right.toArray()).toEqual([...values, 456]);
    expect(popped.toArray()).toEqual([...values.slice(0, -1), 789]); expect(old.toArray()).toEqual(values); unchanged(old, before);
    const copy = S.compact(left); expect(copy.toArray()).toEqual(left.toArray()); expect(copy.pushMany([7, 8]).toArray()).toEqual([...values, 123, 7, 8]);
    expect(arenaOf(copy)).not.toBe(arenaOf(left));
  });
  test('frontier append uses exactly eight fresh bytes, while a fork copies its visible prefix', () => {
    const a = new Arena(); let list = new S.SharedList('number', 0, 0, 0, a).push(1);
    const used = a.used, before = payload(list), next = list.push(2);
    expect(a.used - used).toBe(8); unchanged(list, before);
    const fork = list.push(3); expect(fork.toArray()).toEqual([1, 3]); expect(next.toArray()).toEqual([1, 2]);
    a.alloc(24); expect(next.push(4).toArray()).toEqual([1, 2, 4]); unchanged(list, before);
  });
  for (const C of [S.SharedLinkedList, S.SharedDoublyLinkedList]) test(`${C.name}: mixed block edits retain all sampled branches`, () => {
    let list: any = new C('number'), expected: number[] = [], state = 0x1234567;
    const retained: { list: any; expected: number[] }[] = [];
    for (let i = 0; i < 2500; i++) { list = list.append(i); expected.push(i); }
    for (let i = 0; i < 400; i++) {
      if (!(i % 40)) retained.push({ list, expected: expected.slice() });
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      const index = state % (expected.length - 1);
      if (i % 4 === 0) { list = list.prepend(-i); expected.unshift(-i); }
      else if (i % 4 === 1) { list = list.insertAfter(index, -i); expected.splice(index + 1, 0, -i); }
      else if (i % 4 === 2) { list = C === S.SharedDoublyLinkedList ? list.remove(index + 1) : list.removeAfter(index); expected.splice(index + 1, 1); }
      else { list = list.removeFirst(); expected.shift(); }
    }
    expect(list.toArray()).toEqual(expected);
    const before = payload(list), copy: any = S.compact(list); expect(copy.toArray()).toEqual(expected); unchanged(list, before);
    expect(copy.append(-999).getLast()).toBe(-999);
    for (const r of retained) expect(r.list.toArray()).toEqual(r.expected);
  });
  test('compaction drops a consumed queue prefix without changing its source', () => {
    let queue = new S.SharedQueue('number'); for (let i = 0; i < 8192; i++) queue = queue.enqueue(i);
    const original = queue; for (let i = 0; i < 8150; i++) queue = queue.dequeue();
    const before = payload(queue), copy = S.compact(queue);
    expect(queueValues(copy)).toEqual(numbers(42).map(i => i + 8150)); expect(original.peek()).toBe(0);
    expect(copy.toWorkerData().tail).toBe(0); expect(arenaOf(copy).used - HEAP_START).toBeLessThan(1000); unchanged(queue, before);
  });
});

describe('maps, journals and raw live-data compaction', () => {
  for (const C of [S.SharedMap, S.SharedOrderedMap, S.SharedSortedMap]) test(`${C.name}: inserts, overwrites and deletes preserve forks`, () => {
    let map: any = new C('number'); const model = new Map<string, number>();
    for (let i = 0; i < 3000; i++) { const key = `prefix/${i.toString().padStart(6, '0')}`; map = map.set(key, i); model.set(key, i); expect(map.size).toBe(model.size); }
    const old = map, before = payload(old), oldEntries = [...old.entries()];
    for (let i = 0; i < 400; i++) { const key = `prefix/${i.toString().padStart(6, '0')}`; if (i % 3) { map = map.set(key, -i); model.set(key, -i); } else { map = map.delete(key); model.delete(key); } }
    expect(new Map(map.entries())).toEqual(model); expect(map.size).toBe(model.size); expect([...old.entries()]).toEqual(oldEntries); unchanged(old, before);
    const compacted: any = S.compact(map); expect([...compacted.entries()]).toEqual([...map.entries()]);
    expect(compacted.set('new', 1).get('new')).toBe(1); expect(compacted.delete('missing').size).toBe(map.size);
  });
  test('sorted journal boundaries, empty keys, NUL, BOM and long shared UTF-8 prefixes', () => {
    const prefix = '界🙂'.repeat(3000), keys = ['', '\0', '\0a', '\ufeff', '🙂', '界', ...numbers(40).map(i => prefix + String(i))];
    let map = new S.SharedSortedMap('object'); const versions: typeof map[] = [];
    for (const [i, key] of keys.entries()) { versions.push(map); map = map.set(key, { x: { value: i } }); expect(map.size).toBe(i + 1); }
    const copy = S.compact(map); expect([...copy.entries()]).toEqual([...map.entries()]);
    for (const [i, key] of keys.entries()) { expect(copy.get(key)).toEqual({ x: { value: i } }); expect(versions[i].has(key)).toBe(false); expect(Object.isFrozen((copy.get(key) as any).x)).toBe(true); }
    for (const key of keys) map = map.delete(key); expect(map.size).toBe(0);
  });
  test('numeric lookup caching distinguishes roots, missing values, NaN and negative zero', () => {
    const a = new S.SharedMap('number').set('x', NaN).set('z', -0), b = a.set('x', 3), c = b.delete('x');
    for (let i = 0; i < 20; i++) { expect(a.get('x')).toBeNaN(); expect(b.get('x')).toBe(3); expect(c.get('x')).toBeUndefined(); expect(Object.is(a.get('z'), -0)).toBe(true); }
    const copy = S.compact(a); expect(copy.get('x')).toBeNaN(); expect(Object.is(copy.get('z'), -0)).toBe(true);
  });
  test('compaction removes dead history and does not parse primitive JSON payloads', () => {
    const a = new Arena(); let map = new S.SharedMap('object', 0, 0, a);
    for (let i = 0; i < 4000; i++) map = map.set('latest', { sequence: i, nested: { text: 'payload' } });
    const used = a.used, bytes = payload(map), copy = S.compact(map);
    expect(a.used).toBe(used); unchanged(map, bytes); expect(copy.get('latest')).toEqual(map.get('latest'));
    expect(arenaOf(copy).used - HEAP_START).toBeLessThan((used - HEAP_START) / 100);
  });
  test('compaction shares repeated live nested snapshots and releases obsolete dependencies', async () => {
    let inner = new S.SharedList('string').pushMany(['old', 'value']);
    const outer = new S.SharedMap('SharedList<string>').set('a', inner).set('b', inner);
    const copy = S.compactMany({ outer, inner, again: outer });
    expect(copy.outer).toBe(copy.again); expect(arenaOf(copy.inner)).toBe(arenaOf(copy.outer));
    expect(copy.outer.get('a')!.toWorkerData()).toEqual(copy.inner.toWorkerData()); expect(copy.outer.get('b')!.toWorkerData()).toEqual(copy.inner.toWorkerData()); expect(arenaOf(copy.outer.get('a')!)).toBe(arenaOf(copy.inner));
    expect(S.getWorkerData(copy, { copy: false }).arenas).toHaveLength(1);
    const attached = await S.initWorker<any>(S.getWorkerData(copy));
    expect(attached.outer.get('a').toArray()).toEqual(['old', 'value']);
    expect(() => attached.inner.push('no')).toThrow(/read-only/);
    expect(S.compact(attached.inner).push('yes').toArray()).toEqual(['old', 'value', 'yes']);
  });
  test('set variants, stacks, heaps and custom sort order survive compaction', () => {
    const set = new S.SharedSet().add(1).add('1'), ordered = new S.SharedOrderedSet().add('b').add('a'), sorted = new S.SharedSortedSet().add('b').add('a');
    const stack = new S.SharedStack('object').push({ a: 1 }).push({ b: 2 });
    let heap = new S.SharedPriorityQueue('object', { maxHeap: true }); for (let i = 0; i < 250; i++) heap = heap.enqueue({ i }, i % 17);
    const custom = new S.SharedSortedMap('number', (a, b) => b.localeCompare(a)).set('a', 1).set('z', 2);
    const copy = S.compactMany({ set, ordered, sorted, stack, heap, custom });
    expect([...copy.set.values()]).toEqual([...set.values()]); expect([...copy.ordered.values()]).toEqual(['b', 'a']); expect([...copy.sorted.values()]).toEqual(['a', 'b']);
    expect(copy.stack.peek()).toEqual({ b: 2 }); expect(copy.stack.pop().peek()).toEqual({ a: 1 }); expect(Object.isFrozen(copy.stack.peek())).toBe(true);
    expect(heapValues(copy.heap)).toEqual(heapValues(heap)); expect([...copy.custom.keys()]).toEqual(['z', 'a']);
    expect(() => S.getWorkerData({ custom: copy.custom })).toThrow(/comparator/);
  });
  test('worker wire format rejects the former layout', async () => {
    const data = S.getWorkerData({ list: new S.SharedList('number') });
    expect(data.version).toBe(3); await expect(S.initWorker({ ...data, version: 2 } as any)).rejects.toThrow(/Unsupported/);
  });
});
