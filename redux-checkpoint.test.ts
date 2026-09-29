import { describe, it, expect } from 'vitest';
import {
  SharedMap, SharedSet, SharedList, SharedStack, SharedQueue,
  SharedLinkedList, SharedDoublyLinkedList, SharedOrderedMap,
  SharedOrderedSet, SharedSortedMap, SharedSortedSet, SharedPriorityQueue,
  compact, getWorkerData, initWorker,
} from './shared';
import { arenaOf } from './arena';
import {
  encodeZerocopyState, decodeZerocopyState, serializeZerocopyState,
  deserializeZerocopyState, isZerocopyCollection, zerocopySerializableCheck,
} from './redux';

function drain(collection: any, method: 'pop' | 'dequeue', priority = false): unknown[] {
  const values: unknown[] = [];
  while (collection.size) { values.push(priority ? [collection.peekPriority(), collection.peek()] : collection.peek()); collection = collection[method](); }
  return values;
}
const examples = [
  ['map', () => new SharedMap('object').set('__proto__', { value: [1, 2] }).set('z', { value: [3] }), (x: any) => [...x.entries()].sort(), (x: any) => x.set('new', { value: [] })],
  ['set', () => new SharedSet().add('1').add(1).add('two'), (x: any) => [...x.values()].map(v => [typeof v, v]).sort(), (x: any) => x.add('new')],
  ['list', () => new SharedList('number').push(NaN).push(Infinity).push(-Infinity).push(-0), (x: any) => x.toArray(), (x: any) => x.push(99)],
  ['stack', () => new SharedStack('string').push('a').push('b'), (x: any) => drain(x, 'pop'), (x: any) => x.push('new')],
  ['queue', () => new SharedQueue('number').enqueue(0).enqueue(1).enqueue(2).dequeue(), (x: any) => drain(x, 'dequeue'), (x: any) => x.enqueue(99)],
  ['linked list', () => new SharedLinkedList('string').append('a').prepend('b'), (x: any) => x.toArray(), (x: any) => x.append('new')],
  ['doubly linked list', () => new SharedDoublyLinkedList('number').append(1).prepend(2), (x: any) => x.toArray(), (x: any) => x.append(99)],
  ['ordered map', () => new SharedOrderedMap('number').set('a', 1).set('b', 2).delete('a').set('a', 3), (x: any) => [...x.entries()], (x: any) => x.set('new', 99)],
  ['ordered set', () => new SharedOrderedSet().add('a').add(1).delete('a').add('a'), (x: any) => [...x.values()], (x: any) => x.add('new')],
  ['sorted map', () => new SharedSortedMap('boolean').set('z', false).set('a', true).set('é', true), (x: any) => [...x.entries()], (x: any) => x.set('new', true)],
  ['sorted set', () => new SharedSortedSet().add('z').add('a').add(2), (x: any) => [...x.values()], (x: any) => x.add('new')],
  ['priority queue', () => new SharedPriorityQueue('string', { maxHeap: true }).enqueue('a', 1).enqueue('b', 1).enqueue('c', Infinity).enqueue('d', 1), (x: any) => drain(x, 'dequeue', true), (x: any) => x.enqueue('new', 99)],
] as const;

describe('complete checkpoint round trips', () => {
  it.each(examples)('restores a writable %s with its original semantics', (_name, make, read, update) => {
    const original = compact(make() as any);
    const expected = read(original);
    const restored = deserializeZerocopyState<any>(serializeZerocopyState({ original })).original;
    expect(restored.constructor).toBe(original.constructor);
    expect(isZerocopyCollection(restored)).toBe(true);
    expect(Object.isFrozen(restored)).toBe(true);
    expect(read(restored)).toEqual(expected);
    expect(arenaOf(restored)).not.toBe(arenaOf(original));
    const changed = update(restored);
    expect(changed).not.toBe(restored);
    expect(read(restored)).toEqual(expected);
    expect(read(original)).toEqual(expected);
  });

  it('preserves repeated snapshot aliases and deeply freezes the restored state', () => {
    const map = new SharedMap('object').set('x', { inner: { value: 1 } });
    const packet = encodeZerocopyState({ a: map, b: map, ui: { open: true } });
    expect(Object.keys(packet.structures)).toHaveLength(1);
    expect(Object.isFrozen(packet)).toBe(true);
    expect(Object.isFrozen(packet.arenas)).toBe(true);
    const result = decodeZerocopyState<any>(packet);
    expect(result.a).toBe(result.b);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.ui)).toBe(true);
    expect(Object.isFrozen(result.a.get('x').inner)).toBe(true);
    expect(Reflect.set(result.a.get('x').inner, 'value', 2)).toBe(false);
  });

  it('preserves undefined, sparse arrays, special numbers, and null-prototype records', () => {
    const record = Object.create(null); record.x = undefined;
    const sparse = new Array(3); sparse[1] = undefined; sparse[2] = -0;
    const state = { record, sparse, numbers: [NaN, Infinity, -Infinity, -0], nothing: undefined, nil: null };
    const restored = deserializeZerocopyState<any>(serializeZerocopyState(state));
    expect(Object.getPrototypeOf(restored.record)).toBeNull();
    expect(Object.hasOwn(restored.record, 'x')).toBe(true);
    expect(Object.hasOwn(restored.sparse, 0)).toBe(false);
    expect(Object.hasOwn(restored.sparse, 1)).toBe(true);
    expect(Object.is(restored.sparse[2], -0)).toBe(true);
    expect(restored.numbers).toEqual(state.numbers);
    expect(Object.hasOwn(restored, 'nothing')).toBe(true);
    expect(restored.nil).toBeNull();
  });

  it('escapes tag-like user objects and prototype property names', () => {
    const state = JSON.parse('{"codec":"zerocopy-redux","version":1,"tree":["snapshot","s0"],"__proto__":{"polluted":true}}');
    const restored = deserializeZerocopyState<any>(serializeZerocopyState(state));
    expect(restored).toEqual(state);
    expect(Object.getPrototypeOf(restored)).toBe(Object.prototype);
    expect(Object.hasOwn(restored, '__proto__')).toBe(true);
    expect(({} as any).polluted).toBeUndefined();
  });

  it('restores nested dependencies and can export them to a worker again', async () => {
    const child = new SharedList('number').push(1).push(2);
    const map = new SharedMap<'SharedList<number>'>('SharedList<number>').set('child', child);
    const restored = deserializeZerocopyState<typeof map>(serializeZerocopyState(map));
    expect(restored.get('child')!.toArray()).toEqual([1, 2]);
    const worker = await initWorker<any>(getWorkerData({ restored }, { copy: true }));
    expect(worker.restored.get('child').toArray()).toEqual([1, 2]);
    expect(() => worker.restored.set('x', child)).toThrow(/read-only/);
  });

  it('checkpoints a read-only worker view and restores it as a writable collection', async () => {
    const map = new SharedMap('number').set('x', 1);
    const worker = await initWorker<any>(getWorkerData({ map }, { copy: true }));
    const restored = deserializeZerocopyState<SharedMap<'number'>>(serializeZerocopyState(worker.map));
    expect(restored.set('x', 2).get('x')).toBe(2);
    expect(worker.map.get('x')).toBe(1);
  });

  it('gives two imports distinct arena IDs before they are combined into a nested snapshot', async () => {
    const text = serializeZerocopyState(new SharedMap('number').set('x', 1));
    const a = deserializeZerocopyState<SharedMap<'number'>>(text);
    const b = deserializeZerocopyState<SharedMap<'number'>>(text).set('x', 2);
    expect(arenaOf(a).id).not.toBe(arenaOf(b).id);
    const parent = new SharedMap<'SharedMap<number>'>('SharedMap<number>').set('a', a).set('b', b);
    const worker = await initWorker<any>(getWorkerData({ parent }, { copy: true }));
    expect(worker.parent.get('a').get('x')).toBe(1);
    expect(worker.parent.get('b').get('x')).toBe(2);
  });

  it('exports live data only and does not allocate in the source arena', () => {
    const secret = 'deleted-value-that-must-not-be-in-a-checkpoint';
    const old = compact(new SharedMap('string').set('x', secret.repeat(500)));
    const current = old.set('x', 'live');
    const used = arenaOf(current).used;
    const packet = encodeZerocopyState(current);
    expect(arenaOf(current).used).toBe(used);
    expect(packet.arenas[0].used).toBeLessThan(used);
    expect(atob(packet.arenas[0].base64)).not.toContain(secret);
    expect(old.get('x')).toBe(secret.repeat(500));
    expect(decodeZerocopyState<any>(packet).get('x')).toBe('live');
  });
});

describe('checkpoint validation', () => {
  const packet = () => JSON.parse(serializeZerocopyState(new SharedMap('number').set('x', 1)));
  it.each([
    ['version', (p: any) => { p.version++; }],
    ['binary format', (p: any) => { p.format++; }],
    ['duplicate arena', (p: any) => { p.arenas.push(p.arenas[0]); }],
    ['missing arena', (p: any) => { p.arenas = []; }],
    ['arena length', (p: any) => { p.arenas[0].used++; }],
    ['checksum', (p: any) => { p.arenas[0].checksum = (p.arenas[0].checksum + 1) >>> 0; }],
    ['base64', (p: any) => { p.arenas[0].base64 = '!'; }],
    ['unknown class', (p: any) => { p.structures.s0.type = 'Date'; }],
    ['bad pointer', (p: any) => { p.structures.s0.data.root = 4; }],
    ['missing snapshot', (p: any) => { p.tree = ['snapshot', 's99']; }],
    ['invalid number', (p: any) => { p.tree = ['number', 'not-a-number']; }],
    ['duplicate object key', (p: any) => { p.tree = ['object', [['x', ['null']], ['x', ['null']]]]; }],
  ])('rejects an invalid %s', (_name, change) => {
    const p = packet(); change(p);
    expect(() => decodeZerocopyState(p)).toThrow();
  });
  it('enforces configured resource limits', () => {
    expect(() => encodeZerocopyState({}, { maxNodes: 0 })).toThrow();
    expect(() => encodeZerocopyState({ a: { b: 1 } }, { maxDepth: 1 })).toThrow(/limits/);
    expect(() => decodeZerocopyState(packet(), { maxBytes: 1 })).toThrow(/maxBytes/);
    expect(() => encodeZerocopyState([1, 2], { maxNodes: 2 })).toThrow(/limits/);
  });
  it('rejects unsupported values, accessors, symbols and cycles without executing getters', () => {
    for (const value of [new Map(), new Date(), () => 1, 1n, Symbol('x')]) expect(() => serializeZerocopyState(value)).toThrow();
    const cyclic: any = {}; cyclic.self = cyclic;
    expect(() => serializeZerocopyState(cyclic)).toThrow(/cyclic/);
    const object = { get x() { throw new Error('getter executed'); } };
    expect(() => serializeZerocopyState(object)).toThrow(/accessors/);
    expect(() => serializeZerocopyState({ [Symbol('x')]: 1 })).toThrow(/symbol/);
  });
  it('does not silently serialize custom comparator functions', () => {
    const map = new SharedSortedMap('number', (a, b) => b.localeCompare(a)).set('a', 1);
    expect(zerocopySerializableCheck.isSerializable(map)).toBe(false);
    expect(() => serializeZerocopyState(map)).toThrow(/custom comparator/);
    const set = new SharedSortedSet<string>((a, b) => b.localeCompare(a)).add('a');
    expect(() => serializeZerocopyState(set)).toThrow(/custom comparator/);
  });
});
