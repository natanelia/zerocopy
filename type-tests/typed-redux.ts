import { configureStore, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { SharedMap, json } from '../dist/types/shared';
import { createSharedMapValueSelector, setSharedMapValue, zerocopyMiddlewareOptions } from '../dist/types/redux';

interface Lane { id: string; speedLimit: number; points: number[][] }
const initialState = { lanes: new SharedMap(json<Lane>()), selected: 'lane-1' };
const slice = createSlice({ name: 'lanes', initialState, reducers: {
  replace(state, action: PayloadAction<Lane>) {
    state.lanes = setSharedMapValue(state.lanes, action.payload.id, action.payload);
  },
} });
const store = configureStore({ reducer: slice.reducer, middleware: get => get(zerocopyMiddlewareOptions) });
const select = createSharedMapValueSelector((state: typeof initialState) => state.lanes, state => state.selected);
const result = select(store.getState());
const speed: number | undefined = result?.speedLimit;
// @ts-expect-error Selector fields are strongly typed.
const badSpeed: string | undefined = result?.speedLimit;
// @ts-expect-error Selector values are deeply read-only.
result?.points.push([1, 2]);
// @ts-expect-error The Redux helper checks application object fields.
setSharedMapValue(initialState.lanes, 'lane-1', { id: 'lane-1', speedLimit: 'wrong', points: [] });
void speed;
