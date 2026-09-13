import { describe, it, expect, vi, afterEach } from 'vitest';
import { configureStore, createSlice } from '@reduxjs/toolkit';
import { instrument, ActionCreators } from '@redux-devtools/instrument';
import jsan from 'jsan';
import {
  SharedMap, SharedSet, SharedList, SharedStack, SharedQueue,
  SharedLinkedList, SharedDoublyLinkedList, SharedOrderedMap,
  SharedOrderedSet, SharedSortedMap, SharedSortedSet, SharedPriorityQueue,
  compact, resetMap,
} from './shared';
import { configureAutoGC } from './shared-map';
import { arenaOf } from './arena';
import {
  zerocopyMiddlewareOptions, zerocopySerializableCheck, isZerocopyCollection,
  createZerocopyDevTools, sanitizeZerocopyState, createSharedMapEntrySelector,
} from './redux';

afterEach(() => vi.restoreAllMocks());
const variants = [
  ['SharedMap', () => new SharedMap('number').set('x', 1), (x: any) => x.set('x', 2), (x: any) => x.get('x')],
  ['SharedSet', () => new SharedSet<number>().add(1), (x: any) => x.add(2), (x: any) => x.size],
  ['SharedList', () => new SharedList('number').push(1), (x: any) => x.set(0, 2), (x: any) => x.get(0)],
  ['SharedStack', () => new SharedStack('number').push(1), (x: any) => x.push(2), (x: any) => x.peek()],
  ['SharedQueue', () => new SharedQueue('number').enqueue(1), (x: any) => x.enqueue(2).dequeue(), (x: any) => x.peek()],
  ['SharedLinkedList', () => new SharedLinkedList('number').append(1), (x: any) => x.removeFirst().append(2), (x: any) => x.getFirst()],
  ['SharedDoublyLinkedList', () => new SharedDoublyLinkedList('number').append(1), (x: any) => x.removeFirst().append(2), (x: any) => x.getFirst()],
  ['SharedOrderedMap', () => new SharedOrderedMap('number').set('x', 1), (x: any) => x.set('x', 2), (x: any) => x.get('x')],
  ['SharedOrderedSet', () => new SharedOrderedSet<number>().add(1), (x: any) => x.add(2), (x: any) => x.size],
  ['SharedSortedMap', () => new SharedSortedMap('number').set('x', 1), (x: any) => x.set('x', 2), (x: any) => x.get('x')],
  ['SharedSortedSet', () => new SharedSortedSet<number>().add(1), (x: any) => x.add(2), (x: any) => x.size],
  ['SharedPriorityQueue', () => new SharedPriorityQueue('number').enqueue(1, 1), (x: any) => x.enqueue(2, 0), (x: any) => x.peek()],
] as const;

describe('Redux Toolkit integration', () => {
  it.each(variants)('%s updates a frozen field without drafting collection internals', (_name, make, update, read) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const slice = createSlice({ name: 'collection', initialState: { data: make() as any, ui: { visible: true } }, reducers: {
      update(state) { state.data = update(state.data); },
      noop(state) { state.data = state.data; },
    } });
    const store = configureStore({ reducer: slice.reducer, middleware: get => get(zerocopyMiddlewareOptions), devTools: false });
    const before = store.getState();
    store.dispatch(slice.actions.noop());
    expect(store.getState()).toBe(before);
    store.dispatch(slice.actions.update());
    const after = store.getState();
    expect(after).not.toBe(before);
    expect(after.data).not.toBe(before.data);
    expect(after.ui).toBe(before.ui);
    expect(Object.isFrozen(before.data)).toBe(true);
    expect(Object.isFrozen(after.data)).toBe(true);
    expect(read(before.data)).toBe(1);
    expect(read(after.data)).toBe(2);
    expect(error).not.toHaveBeenCalled();
  });

  it('keeps 1,200 retained states readable through updates, reset, compaction and deprecated GC calls', () => {
    const slice = createSlice({ name: 'history', initialState: { data: compact(new SharedMap('number').set('x', 0)) }, reducers: {
      write(state, action) { state.data = state.data.set('x', action.payload); },
      rotate(state) { state.data = compact(state.data as SharedMap<'number'>); },
    } });
    const store = configureStore({ reducer: slice.reducer, middleware: get => get(zerocopyMiddlewareOptions), devTools: false });
    const history = [store.getState()];
    for (let i = 1; i <= 1200; i++) { store.dispatch(slice.actions.write(i)); history.push(store.getState()); }
    configureAutoGC({ enabled: true, opsThreshold: 1, memoryThreshold: 1 });
    for (const state of history) state.data.dispose();
    resetMap();
    store.dispatch(slice.actions.rotate());
    store.dispatch(slice.actions.write(9999));
    for (let i = 0; i < history.length; i++) expect(history[i].data.get('x')).toBe(i);
    expect(store.getState().data.get('x')).toBe(9999);
  });

  it('does not accept forged snapshots, unknown subclasses, or mutable classes', () => {
    expect(isZerocopyCollection(Object.freeze(Object.create(SharedMap.prototype)))).toBe(false);
    class OtherMap extends SharedMap {}
    expect(isZerocopyCollection(new OtherMap('number'))).toBe(false);
    for (const value of [new Date(), new Map(), () => 1, Symbol('x'), 1n, Promise.resolve(1)]) {
      expect(zerocopySerializableCheck.isSerializable(value)).toBe(false);
    }
  });

  it('retains serializability warnings outside collections, including action payloads', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = configureStore({ reducer: (state = { data: new SharedMap('number') }) => state, middleware: get => get(zerocopyMiddlewareOptions), devTools: false });
    store.dispatch({ type: 'bad', payload: { callback: () => 1 } });
    expect(error.mock.calls.some(call => String(call[0]).includes('non-serializable'))).toBe(true);
  });

  it('retains mutation detection for ordinary state', () => {
    const initial = { data: new SharedMap('number'), plain: { count: 0 } };
    const store = configureStore({ reducer: (state = initial) => state, middleware: get => get(zerocopyMiddlewareOptions), devTools: false });
    store.dispatch({ type: 'observe' });
    store.getState().plain.count++;
    expect(() => store.dispatch({ type: 'observe' })).toThrow(/mutat/i);
  });

  it('does not scan or allocate collection data in development checks or summary views', () => {
    const map = new SharedMap('number').setMany(Array.from({ length: 4096 }, (_, i) => [`k${i}`, i] as const));
    const used = arenaOf(map).used;
    const entries = vi.spyOn(SharedMap.prototype, 'entries').mockImplementation(() => { throw new Error('Unexpected scan'); });
    const store = configureStore({ reducer: (state = { data: map }) => state, middleware: get => get(zerocopyMiddlewareOptions), devTools: false });
    for (let i = 0; i < 20; i++) store.dispatch({ type: 'noop' });
    expect(zerocopySerializableCheck.getEntries(map)).toEqual([]);
    expect(sanitizeZerocopyState({ data: map })).toEqual({ data: { $zerocopy: 'SharedMap', size: 4096, valueType: 'number' } });
    expect(entries).not.toHaveBeenCalled();
    expect(arenaOf(map).used).toBe(used);
  });
});

describe('Redux DevTools', () => {
  function makeStore() {
    const slice = createSlice({ name: 'travel', initialState: { data: compact(new SharedMap('number').set('x', 0)) }, reducers: {
      write(state, action) { state.data = state.data.set('x', action.payload); },
    } });
    const store = configureStore({ reducer: slice.reducer, devTools: false, middleware: get => get(zerocopyMiddlewareOptions), enhancers: get => get().concat(instrument()) });
    return { slice, store };
  }
  it('uses real instrumentation to jump between retained immutable states', () => {
    const { slice, store } = makeStore();
    const zero = store.getState();
    store.dispatch(slice.actions.write(1)); const one = store.getState();
    store.dispatch(slice.actions.write(2)); const two = store.getState();
    store.liftedStore.dispatch(ActionCreators.jumpToState(1));
    expect(store.getState()).toBe(one);
    expect(store.getState().data.get('x')).toBe(1);
    store.liftedStore.dispatch(ActionCreators.jumpToState(2));
    expect(store.getState()).toBe(two);
    expect(zero.data.get('x')).toBe(0);
    expect(one.data.get('x')).toBe(1);
  });
  it('exports and imports real lifted history through the JSAN replacer/reviver', () => {
    const { slice, store } = makeStore();
    store.dispatch(slice.actions.write(1));
    store.dispatch(slice.actions.write(2));
    const config = createZerocopyDevTools({ mode: 'portable' }).serialize!;
    const encoded = jsan.stringify(store.liftedStore.getState(), config.replacer, null, config.options);
    const decoded = jsan.parse(encoded, config.reviver);
    const other = makeStore().store;
    other.liftedStore.dispatch({ type: 'IMPORT_STATE', nextLiftedState: decoded, noRecompute: true });
    expect(other.getState().data).toBeInstanceOf(SharedMap);
    expect(other.getState().data.get('x')).toBe(2);
    other.liftedStore.dispatch(ActionCreators.jumpToState(1));
    expect(other.getState().data.get('x')).toBe(1);
    other.dispatch(slice.actions.write(3));
    expect(other.getState().data.get('x')).toBe(3);
    expect(store.getState().data.get('x')).toBe(2);
  });
  it('escapes user objects that contain the DevTools tag', () => {
    const config = createZerocopyDevTools({ mode: 'portable' }).serialize!;
    const value = { __zerocopy_redux_devtools_v1__: true, checkpoint: 'ordinary user data' };
    expect(jsan.parse(jsan.stringify(value, config.replacer, null, true), config.reviver)).toEqual(value);
  });
  it('makes summary mode explicit and prevents importing summaries', () => {
    const config = createZerocopyDevTools();
    expect(config.maxAge).toBe(50);
    expect(config.features).toEqual({ import: false, export: false, persist: false });
    expect(config.serialize).toBeUndefined();
    expect(() => createZerocopyDevTools({ maxAge: 1 })).toThrow();
  });
});

describe('stable entry selectors', () => {
  it('keeps object identity after the global decode cache is full and unrelated entries change', () => {
    const map = compact(new SharedMap('object').setMany(Array.from({ length: 2050 }, (_, i) => [`k${i}`, { index: i }] as const)));
    for (let i = 0; i < 2048; i++) map.get(`k${i}`);
    const select = createSharedMapEntrySelector((state: { data: SharedMap<'object'> }) => state.data, () => 'k2049');
    const before = select({ data: map });
    expect(select({ data: map })).toBe(before);
    expect(select({ data: map.set('unrelated', { index: -1 }) })).toBe(before);
    const changed = select({ data: map.set('k2049', { index: 999 }) });
    expect(changed).not.toBe(before);
    expect(changed).toEqual({ index: 999 });
    expect(Object.isFrozen(changed)).toBe(true);
  });
  it('does not confuse equal offsets in different arenas, or different keys', () => {
    const a = compact(new SharedMap('number').set('x', 1));
    const b = compact(new SharedMap('number').set('x', 2));
    const select = createSharedMapEntrySelector((state: { data: SharedMap<'number'> }) => state.data, (_state, key: string) => key);
    expect(select({ data: a }, 'x')).toBe(1);
    expect(select({ data: b }, 'x')).toBe(2);
    expect(select({ data: a }, 'missing')).toBeUndefined();
    expect(select({ data: a }, 'x')).toBe(1);
  });
});
