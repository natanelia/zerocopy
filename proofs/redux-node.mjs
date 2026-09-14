import assert from 'node:assert/strict';
import { configureStore, createSlice } from '@reduxjs/toolkit';
import { SharedMap } from 'zerocopy';
import { isSharedCollection, zerocopyMiddlewareOptions, createZerocopyCodec } from 'zerocopy/redux';
const slice = createSlice({ name: 'node', initialState: { map: new SharedMap('number') }, reducers: {
  set(state) { state.map = state.map.set('answer', 42); },
} });
const store = configureStore({ reducer: slice.reducer, middleware: get => get(zerocopyMiddlewareOptions), devTools: false });
const old = store.getState(); store.dispatch(slice.actions.set());
assert.equal(isSharedCollection(store.getState().map), true);
assert.equal(old.map.size, 0); assert.equal(store.getState().map.get('answer'), 42);
const codec = createZerocopyCodec(), restored = codec.parse(codec.stringify(store.getState()));
assert.equal(restored.map.set('other', 1).size, 2);
console.log(JSON.stringify({ node: process.version, packageExports: true, sharedClassIdentity: true, toolkit: true, portableRestore: true }));
