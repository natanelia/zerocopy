# Redux support

[Documentation](README.md) · [Compatibility notes](redux-compatibility.md) · [Worker sharing](worker-sharing.md)

`zerocopy/redux` integrates immutable collection handles with Redux Toolkit. It provides middleware options, selectors, DevTools configuration, and a portable value codec. The adapter has no runtime dependency on Redux, React, or Immer.

## Configure a store

Immer can update the plain object that contains a collection. It does not draft the collection's internals. Keep returned snapshots, do not assign collection fields, and do not add Immer's `immerable` marker to the classes.

<!-- example: redux-store -->
```ts
import { configureStore, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { SharedMap, compact } from 'zerocopy';
import {
  zerocopyMiddlewareOptions,
  createZerocopyDevToolsOptions,
  setSharedMapValue,
} from 'zerocopy/redux';

const mapSlice = createSlice({
  name: 'map',
  initialState: () => ({
    speedLimits: compact(new SharedMap('number')),
    selectedId: null as string | null,
  }),
  reducers: {
    speedChanged(state, action: PayloadAction<{ id: string; speed: number }>) {
      state.speedLimits = setSharedMapValue(
        state.speedLimits,
        action.payload.id,
        action.payload.speed,
      );
    },
    selectionChanged(state, action: PayloadAction<string | null>) {
      state.selectedId = action.payload;
    },
  },
});

export const store = configureStore({
  reducer: { map: mapSlice.reducer },
  middleware: getDefaultMiddleware => getDefaultMiddleware(zerocopyMiddlewareOptions),
  devTools: createZerocopyDevToolsOptions(),
});
export type RootState = ReturnType<typeof store.getState>;
```

The initial `compact()` gives the store a separate arena lifetime. It allocates a new arena. Ordinary updates are also valid:

```ts
state.speedLimits = state.speedLimits.set(id, speed);
```

`setSharedMapValue()` is an optional no-op guard. It keeps the same map when an existing value passes `Object.is`. For object values, supply a pure domain comparison when equal content should count as a no-op. The helper works with Immer's mapped `Draft` type without an application cast. The core `.set()` method has no general equal-content identity guarantee.

Keep selections, panel settings, and request status in plain state. Use shared collections for data that benefits from snapshots and worker access.

## Middleware behavior

`zerocopyMiddlewareOptions` changes the serializability check's predicates and keeps the other default Toolkit middleware. Unsupported Dates, functions, promises, and other values outside collections are still reported. A global `serializableCheck: false` or blanket ignored state path is not required.

A supported frozen collection is treated as an atomic value. The check does not iterate entries, decode all values, or inspect WASM memory on dispatch. This is constant work per handle, not per entry, and relies on the immutable API contract.

`isSharedCollection()` recognizes the 12 built-in classes with their private arena brand. Prototype-only fakes, arbitrary subclasses, root descriptors, and collections with non-serializable custom comparators are not accepted. Primitive and object payloads retain the collection codec's rules.

Passing a middleware check does not make `JSON.stringify()` save collection values. A root, size, and type cannot restore a collection after reload. Use the portable codec below for that purpose.

## Select values without unstable decoded object references

Selecting a collection handle works with reference comparison:

```ts
const speedLimits = useSelector((state: RootState) => state.map.speedLimits);
```

Use a selector instance for an individual map entry:

```ts
import { createSharedMapValueSelector } from 'zerocopy/redux';

export const selectCurrentSpeed = createSharedMapValueSelector(
  (state: RootState) => state.map.speedLimits,
  state => state.map.selectedId ?? '',
);
```

Object decoding uses a bounded cache. A raw `.get()` outside that cache can return a different frozen object reference. This helper retains one result by arena identity, value type, and immutable leaf identity, so unrelated map updates can reuse the selected value.

Use one selector per component or fixed selection. For an ID prop, create it with `useMemo` and `[id]`. Do not create it on every render or share one single-result cache across many row IDs. Replacing the selected entry or compacting the arena can produce a new reference even when contents are equal.

A selector retains its last arena and value. Release unused selector instances when a workspace closes.

## DevTools: summaries or portable values

`createZerocopyDevToolsOptions()` defaults to `mode: 'summary'` and `maxAge: 50`. The monitor receives collection type, size, arena identity, and snapshot metadata, not every entity. Actual Redux state remains unchanged. In-page history can still read retained snapshots. **Summary output is for display, not backup or rehydration.**

The history cursor does not automatically move to a new action while an older state is selected. Normal DevTools controls apply; `COMMIT` makes the selected state the new history base.

For value export and restore:

```ts
const devTools = createZerocopyDevToolsOptions({ mode: 'portable', maxAge: 30 });
```

Portable mode provides JSAN replacer and reviver hooks. Restored collections are writable and do not depend on an old pointer registry. It escapes zerocopy's reserved marker in ordinary records. Plain `$jsan` keys have a separate restriction in the current adapter; read the [compatibility notes](redux-compatibility.md#jsans-reserved-property).

Portable mode walks values and allocates encoded JavaScript data. It is not zero-copy and can be expensive for large maps or long histories. Use summaries for routine large-map development and export values when needed. `maxAge` limits retained actions, not arena bytes.

## Save and restore application state

```ts
import { createZerocopyCodec } from 'zerocopy/redux';

const codec = createZerocopyCodec();
const saved = codec.stringify(store.getState());
// Save the text using the application's storage system.
const restored: unknown = codec.parse(saved);
// Validate the application schema before using restored as preloadedState.
```

Use `encode()` and `decode()` for structured data rather than text. Parsing returns `unknown`: collection validation is not validation of domain fields. Handle parse and schema errors before creating the store. Storage libraries such as redux-persist need an explicit transform or codec hook.

The codec supports all 12 classes, nested collections, ordinary records, arrays, and primitives. It preserves undefined fields, array holes, null-prototype records, NaN, infinities, and negative zero in ordinary state and compatible primitive collections. Object-typed collections still store JSON.

It preserves stack/queue order, ordered-map/set insertion order, priority-queue direction, and the existing equal-priority dequeue behavior. Portable heap child indexes are validated. Restore recomputes ranks and sizes, then writes fresh unpublished nodes; it does not treat input as a WASM pointer. Unordered map/set iteration is not a persistence contract.

Repeated references are encoded by value. Object aliases, wrapper identity, cross-version structural sharing, and memory addresses are not retained. Cycles, functions, custom comparators, arbitrary class instances, enumerable accessors, enumerable symbol keys, and custom array properties are rejected. These limits apply even when a less strict middleware configuration accepts such values.

Default codec limits are 128 nesting levels, 1,000,000 visited values, 1,000,000 items per collection/record, and 64 Mi UTF-16 code units of text. They are validation limits, not a small-memory guarantee. Encoding creates output before the final text-length check. Use lower application limits for untrusted imports. Failed imports do not reset arenas or invalidate existing Redux state.

## Workers and ownership

Send snapshots outside reducers, for example in listener middleware:

```ts
import { getWorkerData } from 'zerocopy';

worker.postMessage(getWorkerData({ speedLimits: store.getState().map.speedLimits }));
```

Do not put raw `WebAssembly.Memory`, `SharedArrayBuffer`, or worker objects in Redux actions. Attach snapshots with `initWorker()`. Include an application revision or request ID and discard stale results.

An attached snapshot is suitable for read-only UI state, but reducers cannot allocate updates in its arena. Use `compact()` for an independent writable copy. Worker sharing does not make reducers asynchronous or remove geometry-calculation costs. Browser headers and runtime differences are covered in [Worker sharing](worker-sharing.md).

## Memory and long editing sessions

Snapshots, workers, payloads, selectors, nested dependencies, and DevTools history can retain arenas. Trimming history does not reclaim dead nodes while the current snapshot still uses the same append-only arena.

Compact live state at a controlled boundary, keep the result, and release old holders. A module-default arena stays referenced until its reset function selects a new one. Reset does not compact current state. Avoid compaction on every dispatch and measure its copy cost separately. See [Architecture and memory](architecture.md).

## Tests and upstream contracts

The [contributor commands](../CONTRIBUTING.md#set-up-and-test) build the package, run core and Redux type checks, and execute integration tests. [`redux.test.ts`](../redux.test.ts) covers Toolkit, Immer, old states, codecs, workers, and selectors. [`redux-regression.test.ts`](../redux-regression.test.ts) covers codec limits, imports, heap restore, and JSAN. Browser tests cover Chromium, module workers, and React-Redux rendering.

These checks use the DevTools instrument and JSAN libraries, not the installed browser extension UI. The public-consumer type checks use generated declarations. There is no separate measured Redux performance claim.

Relevant upstream contracts: [Redux state organization](https://redux.js.org/faq/organizing-state), [Toolkit serializability middleware](https://redux-toolkit.js.org/api/serializabilityMiddleware), [Immer classes](https://immerjs.github.io/immer/complex-objects/), [React-Redux selectors](https://react-redux.js.org/api/hooks), and [DevTools instrument](https://github.com/reduxjs/redux-devtools/tree/main/packages/redux-devtools-instrument).
