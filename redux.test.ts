import { afterEach, describe, expect, it, vi } from 'vitest';
import { configureStore, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import * as instrumentation from '@redux-devtools/instrument';
import { SharedMap, SharedList, SharedSet, SharedStack, SharedQueue, SharedLinkedList,
  SharedDoublyLinkedList, SharedOrderedMap, SharedOrderedSet, SharedSortedMap,
  SharedSortedSet, SharedPriorityQueue, getWorkerData, initWorker, compact, resetMap } from './shared';
import { arenaOf } from './arena';
import { configureAutoGC } from './shared-map';
import { createZerocopyCodec, isSharedCollection, isZerocopySerializable, getZerocopyEntries,
  zerocopyMiddlewareOptions, createZerocopyDevToolsOptions, summarizeZerocopyState,
  createSharedMapValueSelector, setSharedMapValue } from './redux';

const codec = createZerocopyCodec();
afterEach(() => vi.restoreAllMocks());
const kinds = ['SharedMap', 'SharedList', 'SharedSet', 'SharedStack', 'SharedQueue',
  'SharedLinkedList', 'SharedDoublyLinkedList', 'SharedOrderedMap', 'SharedOrderedSet',
  'SharedSortedMap', 'SharedSortedSet', 'SharedPriorityQueue'];
function examples(empty = false): any[] {
  const values = empty ? [] : [3, 1, 2];
  return [
    new SharedMap('number').setMany(values.map(v => [String(v), v])),
    new SharedList('number').pushMany(values),
    new SharedSet<number>().addMany(values),
    values.reduce((s, v) => s.push(v), new SharedStack('number')),
    values.reduce((s, v) => s.enqueue(v), new SharedQueue('number')),
    values.reduce((s, v) => s.append(v), new SharedLinkedList('number')),
    values.reduce((s, v) => s.append(v), new SharedDoublyLinkedList('number')),
    values.reduce((s, v) => s.set(String(v), v), new SharedOrderedMap('number')),
    values.reduce((s, v) => s.add(v), new SharedOrderedSet<number>()),
    values.reduce((s, v) => s.set(String(v), v), new SharedSortedMap('number')),
    values.reduce((s, v) => s.add(v), new SharedSortedSet<number>()),
    values.reduce((s, v) => s.enqueue(v, v), new SharedPriorityQueue('number')),
  ];
}
function contents(collection: any): any[] {
  if (collection instanceof SharedPriorityQueue) return [...collection.entries()].sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  if (collection instanceof SharedStack) { const values = []; let s = collection; while (!s.isEmpty) { values.push(s.peek()); s = s.pop(); } return values; }
  if (collection instanceof SharedQueue) { const values = []; let s = collection; while (!s.isEmpty) { values.push(s.peek()); s = s.dequeue(); } return values; }
  if (collection instanceof SharedMap || collection instanceof SharedOrderedMap || collection instanceof SharedSortedMap) return [...collection.entries()];
  const values = []; collection.forEach((v: any) => values.push(v)); return values;
}
function makeStore(instrument = false) {
  const initialState = { values: new SharedMap('number'), selected: 'a', unrelated: 0 };
  const slice = createSlice({ name: 'test', initialState, reducers: {
    set(state, action: PayloadAction<[string, number]>) { state.values = setSharedMapValue(state.values as any, ...action.payload); },
    unrelated(state) { state.unrelated++; },
  } });
  const enhance: any = (instrumentation as any).instrument ?? (instrumentation as any).default;
  const store = configureStore({ reducer: slice.reducer, middleware: get => get(zerocopyMiddlewareOptions), devTools: false,
    ...(instrument ? { enhancers: (get: any) => get().concat(enhance(() => null, { maxAge: 100 })) } : {}),
  });
  return { store, slice };
}

describe('Redux Toolkit integration', () => {
  it('keeps Immer, serializability checks, old states, and action replay working', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { store, slice } = makeStore(), first = store.getState();
    const action = slice.actions.set(['a', 1]); store.dispatch(action);
    const second = store.getState(); store.dispatch(slice.actions.set(['a', 2]));
    expect(first.values.has('a')).toBe(false); expect(second.values.get('a')).toBe(1);
    expect(store.getState().values.get('a')).toBe(2);
    expect(slice.reducer(first, action).values.get('a')).toBe(1);
    expect(Object.isFrozen(second.values)).toBe(true); expect(errors).not.toHaveBeenCalled();
  });
  it('preserves state identity for guarded no-op writes', () => {
    const { store, slice } = makeStore(); store.dispatch(slice.actions.set(['a', 1]));
    const before = store.getState(); store.dispatch(slice.actions.set(['a', 1]));
    expect(store.getState()).toBe(before);
    expect(setSharedMapValue(new SharedMap('number').set('n', NaN), 'n', NaN).get('n')).toBeNaN();
  });
  it('still reports an unrelated non-serializable action value', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { store } = makeStore(); store.dispatch({ type: 'bad', payload: new Date() });
    expect(errors).toHaveBeenCalled();
    expect(isZerocopySerializable(new Date())).toBe(false);
    expect(isZerocopySerializable(new Map())).toBe(false);
    expect(isZerocopySerializable(Promise.resolve())).toBe(false);
  });
  it('does not decode collections during dispatch checks or summary rendering', () => {
    const map = new SharedMap('object').set('a', { x: 1 });
    vi.spyOn(SharedMap.prototype, 'entries').mockImplementation(() => { throw new Error('must not scan'); });
    vi.spyOn(SharedMap.prototype, 'get').mockImplementation(() => { throw new Error('must not decode'); });
    expect(getZerocopyEntries(map)).toEqual([]); expect(isZerocopySerializable(map)).toBe(true);
    const store = configureStore({ reducer: (s = { map }) => s, middleware: get => get(zerocopyMiddlewareOptions), devTools: false });
    store.dispatch({ type: 'noop' });
    expect(summarizeZerocopyState(store.getState()).map.size).toBe(1);
  });
  it('rejects forged collection prototypes and does not trust root descriptors', () => {
    expect(isSharedCollection(Object.freeze(Object.create(SharedMap.prototype)))).toBe(false);
    expect(isSharedCollection({ root: 65536, size: 1, valueType: 'number' })).toBe(false);
    expect(isSharedCollection(Object.freeze({ constructor: SharedMap }))).toBe(false);
  });
  it('retains snapshots after legacy dispose, auto-GC settings, growth, and reset', () => {
    resetMap(); const old = new SharedMap('object').set('old', { nested: { value: 1 } });
    let next = old; configureAutoGC({ enabled: true, opsThreshold: 1 });
    for (let i = 0; i < 1100; i++) next = next.set(String(i), { text: 'x'.repeat(80) });
    old.dispose(); resetMap();
    expect(old.get('old')).toEqual({ nested: { value: 1 } });
    expect(old.set('fork', {}).size).toBe(2); expect(next.size).toBe(1101);
  });
  it('supports real DevTools time travel and a new action from an old state', () => {
    const { store, slice } = makeStore(true);
    store.dispatch(slice.actions.set(['a', 1])); const one = store.getState();
    store.dispatch(slice.actions.set(['a', 2]));
    (store as any).liftedStore.dispatch({ type: 'JUMP_TO_STATE', index: 1 });
    expect(store.getState().values.get('a')).toBe(1);
    store.dispatch(slice.actions.set(['a', 3]));
    expect(store.getState().values.get('a')).toBe(3); expect(one.values.get('a')).toBe(1);
  });
});

describe('selectors', () => {
  it('retains uncached object identity across repeated reads and unrelated writes', () => {
    resetMap(); let map = new SharedMap('object').setMany(Array.from({ length: 2060 }, (_, i) => [String(i), { i }]));
    for (let i = 0; i < 2048; i++) map.get(String(i));
    const select = createSharedMapValueSelector((s: { map: SharedMap<'object'>; key: string }) => s.map, s => s.key);
    const value = select({ map, key: '2050' });
    expect(select({ map, key: '2050' })).toBe(value);
    map = map.set('other', { i: -1 }); expect(select({ map, key: '2050' })).toBe(value);
    map = map.set('2050', { i: 2 }); expect(select({ map, key: '2050' })).not.toBe(value);
    expect(select({ map, key: 'missing' })).toBeUndefined();
  });
  it('does not reuse a pointer identity from a different arena', () => {
    resetMap(); const a = new SharedMap('number').set('a', 1);
    resetMap(); const b = new SharedMap('number').set('a', 2);
    const select = createSharedMapValueSelector((map: SharedMap<'number'>) => map, () => 'a');
    expect(select(a)).toBe(1); expect(select(b)).toBe(2); expect(select(a)).toBe(1);
    expect(select(compact(b))).toBe(2);
  });
});

describe('portable state codec', () => {
  it.each(kinds)('round-trips %s with a fresh writable arena', kind => {
    const source = examples()[kinds.indexOf(kind)], bytes = arenaOf(source).used;
    const result: any = codec.parse(codec.stringify({ collection: source }));
    expect(result.collection.constructor).toBe(source.constructor);
    expect(contents(result.collection)).toEqual(contents(source));
    expect(Object.isFrozen(result.collection)).toBe(true);
    expect(arenaOf(result.collection)).not.toBe(arenaOf(source));
    expect(arenaOf(result.collection).readOnly).toBe(false);
    expect(arenaOf(source).used).toBe(bytes);
  });
  it.each(kinds)('round-trips empty %s', kind => {
    const source = examples(true)[kinds.indexOf(kind)];
    const restored: any = codec.parse(codec.stringify(source));
    expect(restored.constructor).toBe(source.constructor); expect(restored.size).toBe(0);
  });
  it('restores nested snapshots, frozen JSON, and future writes', () => {
    const child = new SharedList('object').push({ deep: { v: 1 } });
    const source = new SharedMap<'SharedList<object>'>('SharedList<object>').set('a', child);
    const restored: any = codec.parse(codec.stringify(source));
    expect(restored.get('a').get(0)).toEqual({ deep: { v: 1 } });
    expect(Object.isFrozen(restored.get('a').get(0).deep)).toBe(true);
    const updated = restored.set('b', restored.get('a').push({ deep: { v: 2 } }));
    expect(updated.size).toBe(2); expect(restored.size).toBe(1); expect(source.size).toBe(1);
  });
  it('preserves queue offsets, stack order, map order, and heap direction', () => {
    const queue = new SharedQueue('number').enqueue(1).enqueue(2).enqueue(3).dequeue();
    expect(contents(codec.parse(codec.stringify(queue)))).toEqual([2, 3]);
    const map = new SharedOrderedMap('number').set('a', 1).set('b', 2).delete('a').set('a', 3);
    expect(contents(codec.parse(codec.stringify(map)))).toEqual([['b', 2], ['a', 3]]);
    const heap = new SharedPriorityQueue('number', { maxHeap: true }).enqueue(1, -Infinity).enqueue(2, Infinity);
    const restored: any = codec.parse(codec.stringify(heap)); expect(restored.isMaxHeap).toBe(true); expect(restored.peek()).toBe(2);
  });
  it('preserves special numbers, undefined fields, sparse arrays, and null prototypes', () => {
    const sparse = new Array(3); sparse[1] = undefined;
    const object = Object.assign(Object.create(null), { field: undefined });
    const restored: any = codec.parse(codec.stringify({ values: [NaN, Infinity, -Infinity, -0], field: undefined, sparse, object }));
    expect(restored.values).toEqual([NaN, Infinity, -Infinity, -0]);
    expect(Object.hasOwn(restored, 'field')).toBe(true); expect(0 in restored.sparse).toBe(false);
    expect(1 in restored.sparse).toBe(true); expect(restored.sparse.length).toBe(3);
    expect(Object.getPrototypeOf(restored.object)).toBe(null);
  });
  it('does not pollute prototypes when restoring object or map keys', () => {
    const value = JSON.parse('{"__proto__":{"polluted":true},"constructor":1}');
    const restored: any = codec.parse(codec.stringify(value));
    expect(Object.hasOwn(restored, '__proto__')).toBe(true); expect(({} as any).polluted).toBeUndefined();
    const map: any = codec.parse(codec.stringify(new SharedMap('number').set('__proto__', 2)));
    expect(map.get('__proto__')).toBe(2);
  });
  it('rejects functions, dates, cycles, accessors, and custom comparators', () => {
    const cycle: any = {}; cycle.self = cycle;
    for (const input of [() => 1, new Date(), cycle, { get x() { return 1; } }]) expect(() => codec.stringify(input)).toThrow();
    const sorted = new SharedSortedMap('number', (a, b) => b.localeCompare(a)).set('a', 1);
    expect(isZerocopySerializable(sorted)).toBe(false); expect(() => codec.stringify(sorted)).toThrow(/comparator/);
  });
  it('validates versions, collection types, and duplicate map keys', () => {
    expect(() => codec.parse('{"$zerocopyRedux":2,"value":null}')).toThrow();
    expect(() => codec.decode({ $zerocopyRedux: 1, value: ['c', '__proto__', 'number', null, []] })).toThrow();
    expect(() => codec.decode({ $zerocopyRedux: 1, value: ['c', 'SharedMap', 'number', null, [['a', 1], ['a', 2]]] })).toThrow(/duplicate/);
    expect(() => codec.decode({ $zerocopyRedux: 1, value: ['c', 'SharedList', 'number', null, ['wrong']] })).toThrow();
  });
  it('enforces text, depth, node, and collection limits', () => {
    expect(() => createZerocopyCodec({ maxTextLength: 2 }).parse('{} ')).toThrow();
    expect(() => createZerocopyCodec({ maxDepth: 2 }).stringify({ a: { b: { c: 1 } } })).toThrow();
    expect(() => createZerocopyCodec({ maxNodes: 2 }).stringify([1, 2])).toThrow();
    expect(() => createZerocopyCodec({ maxCollectionSize: 2 }).stringify(new SharedList('number').pushMany([1, 2, 3]))).toThrow();
    expect(() => createZerocopyCodec({ maxDepth: NaN })).toThrow();
  });
  it('exports read-only worker snapshots without writes or source resets', async () => {
    const source = { map: new SharedMap('number').set('a', 1), heap: new SharedPriorityQueue('number').enqueue(2, 3), queue: new SharedQueue('number').enqueue(4) };
    const attached = await initWorker<typeof source>(getWorkerData(source, { copy: true }));
    const before = arenaOf(attached.heap).used;
    const restored: any = codec.parse(codec.stringify(attached));
    expect(restored.map.set('b', 2).size).toBe(2); expect(restored.heap.dequeue().size).toBe(0);
    expect(arenaOf(attached.heap).used).toBe(before); expect(source.map.get('a')).toBe(1);
  });
});

describe('DevTools display and portable serialization', () => {
  it('defaults to bounded display summaries and leaves real state unchanged', () => {
    const options = createZerocopyDevToolsOptions(), map = new SharedMap('number').set('a', 1);
    expect(options.maxAge).toBe(50); expect(options.serialize).toBeUndefined();
    expect(options.stateSanitizer!({ map }).map.size).toBe(1); expect(map.get('a')).toBe(1);
  });
  it('round-trips collection state and escapes reserved markers', () => {
    const options = createZerocopyDevToolsOptions({ mode: 'portable' }).serialize!;
    const original = { map: new SharedMap('number').set('a', 1), collision: { $zerocopyRedux: 1, value: ['c', 'not-a-kind'] } };
    const restored = JSON.parse(JSON.stringify(original, options.replacer), options.reviver);
    expect(restored.map.get('a')).toBe(1); expect(restored.collision).toEqual(original.collision);
    expect(restored.map.set('b', 2).size).toBe(2);
  });
  it('keeps portable data independent of source arenas after compaction and reset', () => {
    resetMap(); const old = new SharedMap('number').set('a', 1), text = codec.stringify(old);
    compact(old); resetMap(); new SharedMap('number').set('a', 9);
    const restored: any = codec.parse(text); expect(restored.get('a')).toBe(1); expect(old.get('a')).toBe(1);
  });
});
