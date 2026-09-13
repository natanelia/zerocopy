import { expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { Provider, useSelector } from 'react-redux';
import { configureStore, createSlice } from '@reduxjs/toolkit';
import { SharedMap, compact } from '../dist/shared.js';
import { zerocopyMiddlewareOptions, createSharedMapValueSelector } from '../dist/redux.js';

it('does not render an uncached selected entity for unrelated Redux updates', () => {
  const map = compact(new SharedMap('object').setMany(Array.from({ length: 2060 }, (_, i) => [String(i), { i }])));
  for (let i = 0; i < 2048; i++) map.get(String(i));
  const slice = createSlice({ name: 'react', initialState: { map, tick: 0 }, reducers: {
    unrelated(state) { state.tick++; },
    otherEntity(state) { state.map = state.map.set('other', { i: -1 }); },
    selectedEntity(state) { state.map = state.map.set('2050', { i: 42 }); },
  } });
  const store = configureStore({ reducer: slice.reducer, middleware: get => get(zerocopyMiddlewareOptions), devTools: false });
  const select = createSharedMapValueSelector(state => state.map, () => '2050');
  let renders = 0;
  const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
  function Row() {
    const value = useSelector(select, { devModeChecks: { stabilityCheck: 'always' } });
    renders++;
    return createElement('span', null, String(value.i));
  }
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  try {
    flushSync(() => root.render(createElement(Provider, { store }, createElement(Row))));
    const firstRenders = renders; expect(host.textContent).toBe('2050');
    flushSync(() => store.dispatch(slice.actions.unrelated()));
    flushSync(() => store.dispatch(slice.actions.otherEntity()));
    expect(renders).toBe(firstRenders);
    flushSync(() => store.dispatch(slice.actions.selectedEntity()));
    expect(renders).toBeGreaterThan(firstRenders); expect(host.textContent).toBe('42');
    expect(warnings).not.toHaveBeenCalled();
  } finally { flushSync(() => root.unmount()); host.remove(); warnings.mockRestore(); }
});
