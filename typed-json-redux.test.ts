import { describe, expect, it } from 'vitest';
import { configureStore, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { SharedMap, SharedList, SharedPriorityQueue, json, list } from './shared';
import { createZerocopyCodec, createSharedMapValueSelector, setSharedMapValue, zerocopyMiddlewareOptions } from './redux';

interface Lane { id: string; speedLimit: number; centerline: number[][] }
const LaneValue = json<Lane>();
const lane: Lane = { id: 'lane-1', speedLimit: 50, centerline: [[-0, 1]] };

describe('typed JSON Redux integration', () => {
  it('preserves typed snapshots in Toolkit reducers and selectors', () => {
    const initialState = { lanes: new SharedMap(LaneValue).set(lane.id, lane), selected: lane.id };
    const slice = createSlice({ name: 'lanes', initialState, reducers: {
      replace(state, action: PayloadAction<Lane>) {
        state.lanes = setSharedMapValue(state.lanes, action.payload.id, action.payload);
      },
    } });
    const store = configureStore({ reducer: slice.reducer, middleware: get => get(zerocopyMiddlewareOptions), devTools: false });
    const select = createSharedMapValueSelector((state: typeof initialState) => state.lanes, state => state.selected);
    const before = store.getState();
    const original = select(before);
    store.dispatch(slice.actions.replace({ ...lane, speedLimit: 70 }));
    expect(select(store.getState())?.speedLimit).toBe(70);
    expect(select(before)).toBe(original);
    expect(original?.speedLimit).toBe(50);
    expect(Object.isFrozen(original?.centerline[0])).toBe(true);
  });

  it('round-trips nested collections and negative zero into writable snapshots', () => {
    const codec = createZerocopyCodec();
    const lanes = new SharedMap(LaneValue).set(lane.id, lane);
    const tiles = new SharedMap(list(LaneValue)).set('tile-1', new SharedList(LaneValue).push(lane));
    const heap = new SharedPriorityQueue(LaneValue).enqueue(lane, 1);
    // The codec returns unknown; the application owns its persistence schema.
    const state = { lanes, tiles, heap };
    const restored = codec.parse(codec.stringify(state)) as typeof state;
    expect(restored.lanes.get(lane.id)).toEqual(lane);
    expect(restored.tiles.get('tile-1')?.get(0)).toEqual(lane);
    expect(restored.heap.peek()).toEqual(lane);
    expect(Object.is(restored.lanes.get(lane.id)?.centerline[0][0], -0)).toBe(true);
    expect(Object.isFrozen(restored.lanes.get(lane.id)?.centerline[0])).toBe(true);
    const changed = restored.lanes.set(lane.id, { ...lane, speedLimit: 90 });
    expect(changed.get(lane.id)?.speedLimit).toBe(90);
    expect(restored.lanes.get(lane.id)?.speedLimit).toBe(50);
    expect(lanes.get(lane.id)?.speedLimit).toBe(50);
  });

  it.each([['u'], ['n', 'NaN'], ['n', 'Infinity'], ['a', [['h']]]])('rejects invalid imported typed JSON fields: %j', (...encoded) => {
    const badValue = ['o', [['invalid', encoded]]];
    const envelope = { $zerocopyRedux: 1, value: ['c', 'SharedMap', 'json', null, [['bad', badValue]]] };
    expect(() => createZerocopyCodec().decode(envelope)).toThrow();
  });

  it('rejects primitive roots in hand-written typed JSON imports', () => {
    const envelope = { $zerocopyRedux: 1, value: ['c', 'SharedMap', 'json', null, [['bad', 42]]] };
    expect(() => createZerocopyCodec().decode(envelope)).toThrow(/plain objects or arrays/);
  });
});
