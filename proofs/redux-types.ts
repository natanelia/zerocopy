// Compile against public package exports and generated declarations with strict mode.
import { configureStore, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { SharedMap } from 'zerocopy';
import {
  zerocopyMiddlewareOptions, createZerocopyDevToolsOptions,
  createSharedMapValueSelector, createSharedMapEntrySelector,
  createZerocopyCodec, setSharedMapValue,
  encodeZerocopyState, decodeZerocopyState,
  serializeZerocopyState, deserializeZerocopyState,
  type ZerocopyCheckpointOptions, type ZerocopyStatePacket,
} from 'zerocopy/redux';
const initialState = { ways: new SharedMap('number'), selected: 'a' };
const slice = createSlice({ name: 'map', initialState, reducers: {
  set(state, action: PayloadAction<{ id: string; value: number }>) {
    state.ways = setSharedMapValue(state.ways, action.payload.id, action.payload.value);
  },
} });
const store = configureStore({ reducer: slice.reducer,
  middleware: getDefaultMiddleware => getDefaultMiddleware(zerocopyMiddlewareOptions),
  devTools: createZerocopyDevToolsOptions({ mode: 'portable' }),
});
type State = ReturnType<typeof store.getState>;
const selector = createSharedMapValueSelector((state: State) => state.ways, state => state.selected);
const result: number | undefined = selector(store.getState());
const selectById = createSharedMapEntrySelector((state: State) => state.ways, (_state: State, id: string) => id);
const byId: number | undefined = selectById(store.getState(), 'a');
// @ts-expect-error keys must be strings
selectById(store.getState(), 1);
store.dispatch(slice.actions.set({ id: 'a', value: 1 }));
const options: ZerocopyCheckpointOptions = { maxBytes: 1024 * 1024 };
const packet: ZerocopyStatePacket = encodeZerocopyState(store.getState(), options);
const binaryRestored: unknown = decodeZerocopyState(packet);
const textRestored: unknown = deserializeZerocopyState(serializeZerocopyState(store.getState()));
const logicalRestored: unknown = createZerocopyCodec().parse(createZerocopyCodec().stringify(store.getState()));
void [result, byId, binaryRestored, textRestored, logicalRestored];
