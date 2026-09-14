import { expect, it } from 'vitest';
import { configureStore, createSlice } from '@reduxjs/toolkit';
import { SharedMap, getWorkerData } from '../dist/shared.js';
import { zerocopyMiddlewareOptions, isSharedCollection, createZerocopyCodec, createZerocopyDevToolsOptions } from '../dist/redux.js';

it('uses one engine for browser Redux and package-root snapshots', () => {
  const slice = createSlice({ name: 'browser', initialState: { map: new SharedMap('number') }, reducers: {
    set(state) { state.map = state.map.set('a', 42); },
  } });
  const store = configureStore({ reducer: slice.reducer, middleware: get => get(zerocopyMiddlewareOptions), devTools: false });
  const before = store.getState(); store.dispatch(slice.actions.set());
  expect(isSharedCollection(store.getState().map)).toBe(true);
  expect(before.map.size).toBe(0); expect(store.getState().map.get('a')).toBe(42);
  const codec = createZerocopyCodec(), restored = codec.parse(codec.stringify(store.getState()));
  expect(restored.map.set('b', 2).size).toBe(2);
  const serializer = createZerocopyDevToolsOptions({ mode: 'portable' }).serialize;
  expect(JSON.parse(JSON.stringify(store.getState(), serializer.replacer), serializer.reviver).map.get('a')).toBe(42);
});

it('shares a Redux snapshot with a real module worker', async () => {
  expect(crossOriginIsolated).toBe(true);
  const map = new SharedMap('object').set('a', { value: 42 });
  const worker = new Worker(new URL('./redux-worker.ts', import.meta.url), { type: 'module' });
  try {
    const received = new Promise((resolve, reject) => {
      worker.onmessage = event => resolve(event.data);
      worker.onerror = event => reject(new Error(event.message));
    });
    worker.postMessage(getWorkerData({ map }, { copy: false }));
    const next = map.set('a', { value: 99 });
    expect(await received).toEqual({ value: 42, frozen: true, rejectsWrite: true });
    expect(next.get('a')).toEqual({ value: 99 });
  } finally { worker.terminate(); }
});
