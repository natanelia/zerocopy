// Compile against the public package exports and generated declarations.
import { configureStore, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { SharedMap } from 'zerocopy';
import { zerocopyMiddlewareOptions, createZerocopyDevToolsOptions, createSharedMapValueSelector, createZerocopyCodec, setSharedMapValue } from 'zerocopy/redux';
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
store.dispatch(slice.actions.set({ id: 'a', value: 1 }));
const restored: unknown = createZerocopyCodec().parse('{}');
void [result, restored];
