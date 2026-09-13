# Redux support

This guide applies to the v0.2 candidate in PR #1 and the integration additions in PR #2. It does not describe the old v0.1 implementation on `main`. The entry point is `zerocopy/redux`. Build the candidate or use a workspace link. This change does not publish npm.

## What was verified in the design

The current engine already returns frozen persistent collection handles. Old snapshots keep their arena alive. `dispose()` and `configureAutoGC()` are no-ops. There is no need to turn off an old update-count disposal mechanism on this branch. Reset selects a new default arena; it does not invalidate old Redux states.

A new collection can replace a property in a Redux Toolkit slice. Immer changes the containing plain object. It does not draft the internals of the collection. Do not add the Immer `immerable` marker to collection classes. Do not assign to collection fields. Always use the returned collection from an update method.

The Redux serializability check and actual persistence are separate concerns. Allowing a class through middleware does not make `JSON.stringify()` save its values. A root pointer, size, and type cannot restore a collection after reload. The portable codec below saves logical values and rebuilds fresh writable data.

## Configure a store

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
  // A fresh arena isolates this store from other stores in the same process.
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

The ordinary update is also valid:

```ts
state.speedLimits = state.speedLimits.set(id, speed);
```

`setSharedMapValue()` is an optional no-op guard. It returns the same map when an existing value passes `Object.is`. Thus an equal numeric update does not replace the Redux state. The core `.set()` path is unchanged. For object values, supply a pure domain comparison when equal content should count as a no-op. The helper's public-view type works with Immer's mapped `Draft` type without an application cast.

Keep actions small and plain when practical. Store large map data in shared collections. Keep selections, panel settings, and request status in plain state.

## Middleware behavior

`zerocopyMiddlewareOptions` supplies a serializability policy for shared collections and the normal primitive/frozen-object immutability policy. It keeps the default Redux Toolkit checks and other middleware. Dates, functions, promises, and other unsupported values outside a shared collection are still reported. No global `serializableCheck: false` or blanket ignored state path is required. The two policies are also exported separately as `zerocopySerializableCheck` and `zerocopyImmutableCheck`.

A supported frozen collection is treated as an atomic value. The check does not iterate its entries, decode all entities, or inspect raw WASM memory on dispatch. This is constant work per collection handle, not per item. It relies on the library's immutable-value contract. It is not a raw-memory validation service.

`isSharedCollection()` accepts the 12 built-in classes with their actual private arena brand. It does not accept a prototype-only fake, a root descriptor, or an arbitrary subclass. Custom comparator functions are not serializable and are rejected. Primitive and `object` payloads retain the engine's existing rules. `isZerocopyCollection` is an alias.

The adapter has no runtime dependency on Redux, React, or Immer. These packages are development dependencies for integration tests, not imports in the adapter. Redux Toolkit is an optional peer dependency.

## Select values without unstable decoded object references

Selecting a collection handle works with the default reference comparison:

```ts
const speedLimits = useSelector((state: RootState) => state.map.speedLimits);
```

For an individual `SharedMap` entry, use a selector instance:

```ts
import { createSharedMapValueSelector } from 'zerocopy/redux';

export const selectCurrentSpeed = createSharedMapValueSelector(
  (state: RootState) => state.map.speedLimits,
  state => state.map.selectedId ?? '',
);
```

For object-valued maps, this helper avoids repeat JSON decode results with different JavaScript references. The engine's decode cache is bounded. A raw `.get()` outside that cache can return a different frozen object on each read. The helper retains one decoded result using arena identity, value type, and immutable leaf identity. An unrelated map update can reuse the selected value.

Use one selector per component or fixed selection. Do not create a new selector on every render. `createSharedMapEntrySelector` additionally accepts selector arguments, such as a row ID. See [selectors with arguments](redux-checkpoints.md#selectors-with-arguments). A selector shared across many different row IDs still has only one cached result.

This cache is not a general deep-equality test. Replacing the selected entry or compacting its arena can produce a new reference, even for equal content. The cache holds its last arena and value. Release unused selector instances when a workspace closes. An active selector can retain an arena.

## DevTools: choose display summaries or portable values

The default `createZerocopyDevToolsOptions()` uses `mode: 'summary'` and `maxAge: 50`. The monitor receives collection kind, size, and value type. It does not receive every entity. Actual Redux state is not replaced by the summary. In-page DevTools history can still select and read retained immutable snapshots. **Summary output is for display, not for backup or rehydration.**

Summary mode retains pause, lock, jump, skip, reorder, and dispatch controls. It disables import, export, persistence, and test generation because summaries cannot reconstruct state. The sanitizer does not execute ordinary getters. `createZerocopyDevTools` and `sanitizeZerocopyState` are aliases for the options factory and summary operation.

The standard DevTools history cursor does not automatically move when a new action arrives while an old state is selected. Use the normal DevTools controls. `COMMIT` makes the selected state the starting point for a new history. Tests cover reads from old states and writes after committing an old snapshot.

For value export and restore through DevTools, opt in:

```ts
const devTools = createZerocopyDevToolsOptions({ mode: 'portable', maxAge: 30 });
```

Portable mode supplies a replacer, reviver, and JSAN options as a unit. Do not substitute `true` for its `serialize.options`. It preserves literal `$jsan` keys and the codec's marker keys in user data. It keeps the outer ordinary state shape and stores collection values in escaped codec text. Restored collections are writable and do not depend on an old pointer registry. Tests exercise real JSAN and Redux DevTools instrumentation. They do not automate the installed browser extension's UI.

Portable mode copies values and can be expensive for large maps or many actions. It is not zero-copy. Use summary mode for ordinary large-map development. Export a portable snapshot only when required. `maxAge` limits retained DevTools actions, not arena byte usage. Repeated values are encoded by value; cyclic state is rejected.

## Save and restore application state

```ts
import { createZerocopyCodec } from 'zerocopy/redux';

const codec = createZerocopyCodec();
const saved = codec.stringify(store.getState());
// Write saved to the storage system selected by the application.
const restored: unknown = codec.parse(saved);
// Validate the application schema before using restored as preloadedState.
```

Use `encode()` and `decode()` when a storage adapter expects plain structured data rather than text. Parsing returns `unknown` on purpose. Collection/type validation is not validation of application domain fields. Handle parse and validation errors before store creation. Storage libraries such as redux-persist require an explicit transform or codec hook; this adapter does not silently configure them.

The codec supports all 12 built-in collections, nested collection types, ordinary records, arrays, and primitives. It preserves undefined fields, array holes, null-prototype plain records, and numeric NaN, infinities, and negative zero in ordinary state and compatible primitive collections. Object-typed collections still store JSON, not arbitrary JavaScript objects.

It preserves stack and queue order, ordered-map/set insertion order, priority-queue heap direction, and existing equal-priority dequeue behavior. The priority heap uses validated portable child indexes. Restore recomputes heap ranks and sizes, then writes only fresh unpublished nodes. No input is treated as a WASM pointer. Unordered map/set iteration order is not a persistence contract.

Repeated references are encoded by value. Object aliases, collection wrapper identity, cross-version structural sharing, and original memory addresses are not preserved. Cycles, functions, custom comparators, arbitrary class instances, enumerable accessors, enumerable symbol keys, and custom array properties are rejected rather than treated as portable state. These restrictions apply to the logical codec even when a less strict Redux middleware configuration permits them.

Codec options provide maximum depth, visited values, items per collection/record, and text length. Defaults are 128 levels, 1,000,000 visited values, 1,000,000 items, and 64 Mi UTF-16 code units of text. These are validation limits, not a small-memory guarantee. Encoding creates its output before the final text-length check. Use lower application limits for untrusted imports. Failed imports do not reset module arenas or invalidate existing Redux state.

For advanced trusted same-format binary checkpoints, see [complete binary checkpoints](redux-checkpoints.md#complete-binary-checkpoints). That API preserves selected binary structure and repeated snapshot aliases, but is not a hostile binary-input validator. The logical codec above remains the general persistence API.

## Workers and ownership

Send snapshots outside reducers, for example from listener middleware:

```ts
import { getWorkerData } from 'zerocopy';
worker.postMessage(getWorkerData({ speedLimits: store.getState().map.speedLimits }));
```

Do not put a raw `WebAssembly.Memory`, `SharedArrayBuffer`, or worker object in a Redux action. Use `getWorkerData()` for transport and `initWorker()` at the reader. Include an application revision or request ID when worker results can arrive late. Ignore a result that does not belong to the current revision.

There is one allocating writer per arena. A worker attachment is read-only. Replacing a Redux field with an attached snapshot is suitable for read-only UI state, but reducers cannot allocate updates in that attached arena. Use `compact()` to create a writable owned copy when ownership must move. This copy is deliberate.

Node and compatible isolated browsers can share the actual WASM memory. Bun's default transport uses a used-prefix copy. The codec is separate from worker transport. String and object reads still decode values. Shared memory does not remove the CPU cost of geometry calculations or make reducers asynchronous.

Browsers need cross-origin isolation. The browser tests use COOP `same-origin` and COEP `require-corp`. Review third-party resources before turning on those headers. Direct raw-memory writes remain outside the immutable API contract and are not a security boundary.

## Memory and long editing sessions

The arena is append-only, with no per-node reclamation. Referenced snapshots, workers, transport payloads, selectors, nested dependencies, and DevTools history can keep it alive. Trimming history alone does not reclaim dead nodes if the current snapshot still belongs to the same arena.

Use `compact()` or `compactMany()` to rebuild live state in fresh storage at a controlled boundary. Keep the result, then release old holders. A module's current default arena remains referenced until its reset function selects a new one. A dedicated arena created with `compact()` avoids a shared module-default lifetime for long-lived store data. Reset alone does not compact existing state. Do not compact every dispatch or assume immediate GC. Measure rebuild cost separately from reducers.

## Build and verification

```sh
bun install
bun run build:wasm
bun run build:browser
bun run build:types
bun run typecheck
bun run typecheck:redux
bun run test
bun run proof:redux
bun run proof:node
bunx playwright install --with-deps chromium
bun run test:browser
npm pack --dry-run
```

The Redux integration workflow runs on PRs targeting either `main` or the PR #1 branch. `bun run test:redux` selects all Redux unit and integration files. Tests cover Toolkit, Immer, retained states, all collection codecs, workers, selectors, codec limits, invalid imports, exact heap restore, and JSAN. Browser tests use actual Chromium, a module worker, and React-Redux rendering. The Node proof imports built package exports. The strict type proof imports generated public declarations.

Read the checks on the exact PR commit for execution results. No Redux performance multiplier is claimed without an application benchmark. The deterministic checks verify that middleware and summaries do not scan collection entries or allocate in source arenas.

## Upstream contracts

- [Redux state organization and serializable data](https://redux.js.org/faq/organizing-state)
- [Redux Toolkit serializability middleware](https://redux-toolkit.js.org/api/serializabilityMiddleware)
- [Immer class handling](https://immerjs.github.io/immer/complex-objects/)
- [React-Redux selector reference checks](https://react-redux.js.org/api/hooks)
- [Redux DevTools instrument](https://github.com/reduxjs/redux-devtools/tree/main/packages/redux-devtools-instrument)
