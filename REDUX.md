# Redux integration

Use `zerocopy/redux` with the immutable v0.2 engine. Keep large shared domain collections in zerocopy. Keep small UI state in ordinary Redux objects and arrays.

## What was verified on PR #1

The original `main` implementation and the PR #1 implementation have different lifetime rules. In PR #1, frozen collection handles retain their arena through a private `Snapshot` field. Updates cannot dispose an older reachable snapshot. Reset creates a new arena. The old `dispose()` and `configureAutoGC()` APIs are deprecated no-ops. Do not add the original implementation's finalizer or auto-disposal workaround.

The remaining integration work is Redux tooling, not a new memory manager. A new collection reference works with Redux reference checks. An unchanged collection reference does not force an update. Collection classes must stay non-draftable: do not add Immer's `immerable` symbol. Replace the containing property instead.

## Configure a store

```ts
import { configureStore, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { SharedMap, compact } from 'zerocopy';
import {
  zerocopyMiddlewareOptions,
  createZerocopyDevToolsOptions,
  setSharedMapValue,
} from 'zerocopy/redux';

type Way = { name: string; coordinates: number[][] };

const mapSlice = createSlice({
  name: 'map',
  // A lazy factory gives each store its own initial data.
  // compact() puts the selected data in an independent writable arena.
  initialState: () => ({
    ways: compact(new SharedMap('object')),
    selectedWayId: null as string | null,
  }),
  reducers: {
    putWay(state, action: PayloadAction<{ id: string; way: Way }>) {
      state.ways = setSharedMapValue(
        state.ways,
        action.payload.id,
        action.payload.way,
      );
    },
    removeWay(state, action: PayloadAction<string>) {
      state.ways = state.ways.delete(action.payload);
    },
  },
});

export const store = configureStore({
  reducer: { map: mapSlice.reducer },
  middleware: getDefaultMiddleware =>
    getDefaultMiddleware(zerocopyMiddlewareOptions),
  // Use false instead in a production build that must not expose state.
  devTools: createZerocopyDevToolsOptions({ maxAge: 50 }),
});
```

Direct assignment also works: `state.ways = state.ways.set(id, way)`. A call to `state.ways.set(id, way)` without assignment discards the new snapshot. It does not update the state.

`setSharedMapValue` is an optional no-op guard. It uses `Object.is` by default. For decoded JSON objects, supply a pure application-specific comparison only when its cost is justified. It does not silently perform a deep comparison. The helper accepts Immer's public-field type while checking the real frozen SharedMap and its private arena ownership at runtime. This avoids a cast in reducers.

The adapter has no Redux, React, or Immer runtime imports. Redux Toolkit is an optional peer. Both the package root and the Redux subpath use the same bundled class definitions and arena runtime.

## Development checks remain enabled

`zerocopyMiddlewareOptions` contains `serializableCheck` and `immutableCheck` settings. The two settings are also exported separately as `zerocopySerializableCheck` and `zerocopyImmutableCheck`.

Only real, frozen, built-in collection instances are accepted as shared values. A forged prototype, an arbitrary class, or a plain root descriptor is not a collection. Custom comparator functions are not serializable and still produce a warning. Ordinary action payloads and ordinary state fields still receive Redux Toolkit's checks. Thunks and other default middleware remain in place.

Shared collections are atomic values for these checks. The adapter does not enumerate their data, inspect WASM memory, or walk internal caches on each dispatch. This is an explicit serialization policy, not a claim that `JSON.stringify(store.getState())` can reconstruct collection instances.

## Selectors and reference identity

For a whole collection, use the normal selector:

```ts
const ways = useSelector(state => state.map.ways);
```

For a decoded object, use a stable entry selector. The shared JSON cache is bounded. A direct `map.get(id)` can return a newly decoded object after the cache fills, even if the logical value did not change.

```ts
import { createSharedMapEntrySelector } from 'zerocopy/redux';

type RootState = ReturnType<typeof store.getState>;

// Make one selector instance per component or independent key stream.
const selectWay = createSharedMapEntrySelector(
  (state: RootState) => state.map.ways,
  (_state: RootState, id: string) => id,
);

// In a component, create selectWay once with useMemo, then use:
// const way = useSelector(state => selectWay(state, wayId));
```

The selector caches one result. Its key includes the owning arena object, immutable leaf address, and value type. An unrelated map edit retains the selected object's reference. A changed leaf or a different arena produces a new result. `createSharedMapValueSelector` offers the same behavior with state-only input functions.

Compaction creates a new arena. It is correct for selectors to invalidate after compaction. Neither helper performs asynchronous work or changes Redux's synchronous reducer contract.

## DevTools

`createZerocopyDevToolsOptions()` defaults to summary mode. `createZerocopyDevTools()` is an alias. Summaries contain only the collection kind, size, and value type. They do not read collection entries or payload bytes. Ordinary getters are not executed by the sanitizer. `sanitizeZerocopyState` and its alias `summarizeZerocopyState` are exported for custom integration.

The real in-page store and its retained history keep full collection objects. A summary is only a monitor display. Import, export, persistence, and test generation from summaries are disabled because summaries cannot reconstruct state. Time travel and normal history controls remain available. Do not pass a sanitizer's result to a reducer or save it as a backup.

For full collection data in export/import, choose portable mode:

```ts
const devTools = createZerocopyDevToolsOptions({
  mode: 'portable',
  maxAge: 25,
  codec: createZerocopyCodec({ maxCollectionSize: 100_000 }),
});
```

Portable mode supplies the serializer and reviver used by Redux DevTools. It writes logical collection values, not raw root addresses. It can restore real collection classes in fresh writable memory. Reserved marker keys in ordinary user objects are escaped. Portable mode visits collection contents and allocates copied data. It is not zero-copy and is not the recommended default for a large map editor.

Automated tests use real Redux DevTools instrumentation and JSAN export/import. Browser tests run Redux Toolkit in Chromium. These are not a manual test of every version of the installed browser extension.

## Persistence

Use the logical codec for normal saved state:

```ts
import { createZerocopyCodec } from 'zerocopy/redux';

const codec = createZerocopyCodec({
  maxDepth: 128,
  maxNodes: 1_000_000,
  maxCollectionSize: 1_000_000,
  maxTextLength: 64 * 1024 * 1024,
});
const text = codec.stringify(store.getState());
const restored: unknown = codec.parse(text);
// Validate your application's state schema before using restored as preloadedState.
```

All 12 collection types and nested collections are supported. The format preserves undefined values, sparse arrays, special numbers, collection order where specified, and min/max priority-queue direction. Custom comparator functions, arbitrary class instances, functions, symbols, and cyclic state are rejected. Repeated ordinary object references and logical collection references are encoded by value, not as an identity graph. Equal-priority heap items have no stable insertion-order guarantee in the logical codec.

The logical format is independent of WASM addresses and arena IDs. It has its own version tag. Future format changes still require an explicit migration. An application's state schema is not validated by the collection codec. A successful parse is not proof that the value is a valid RootState.

For redux-persist, place codec encode/decode in a transform around the selected slice, or put stringify/parse in a storage adapter. Do not apply both layers to the same value. Keep the normal narrowly scoped redux-persist action exclusions, where needed. This package does not disable serializability warnings globally or add a redux-persist dependency.

### Same-format binary checkpoints

An additional checkpoint API preserves selected live binary structure and repeated snapshot aliases:

```ts
import {
  serializeZerocopyState,
  deserializeZerocopyState,
} from 'zerocopy/redux';

const checkpoint = serializeZerocopyState(store.getState(), {
  maxBytes: 64 * 1024 * 1024,
  maxNodes: 100_000,
  maxDepth: 128,
});
const restored: unknown = deserializeZerocopyState(checkpoint);
```

`encodeZerocopyState` / `decodeZerocopyState` operate on the packet rather than its JSON string. `ZerocopyCheckpointOptions` and `ZerocopyStatePacket` describe this API.

This is an advanced, same-binary-format checkpoint, not the default portable codec. It compacts selected live data before export, excludes obsolete bytes elsewhere in source arenas, and assigns a fresh writable arena identity to each import. Repeated references to the same snapshot wrapper remain identical in the restored ordinary state tree. The imported ordinary tree and decoded JSON are frozen. Two separate imports can be combined into nested collections without arena-ID collisions.

Use binary checkpoints only with trusted application-generated data. Versions, byte lengths, checksums, top-level descriptors, and state-tree structure are checked. Those checks are not authentication and do not validate an arbitrary WASM pointer graph. Do not accept untrusted binary checkpoints from a network endpoint. Limits are not a hard bound on peak memory: export/import needs temporary copies and compaction space. For untrusted external input, parse bounded logical data and validate your application schema.

## Workers and memory

Keep worker messages and shared-memory ownership outside Redux reducers. Use `getWorkerData` and `initWorker` for worker transport, not persistence. Their messages contain shared memory or byte copies and are not ordinary serializable Redux actions. Prefer plain intent actions and plain job metadata. The allocating arena has one writer; worker attachments are read-only. To edit an attached snapshot in a reducer, first create an owned writable copy with `compact` outside the reducer.

The browser still needs a secure, cross-origin-isolated context for shared memory. Set the appropriate COOP/COEP response headers and check `crossOriginIsolated`. This adapter does not change browser security requirements. Bun's default copy transport is not zero-copy.

Arenas remain append-only. Retained snapshots, selectors, workers, initial state objects, and DevTools history can keep an old arena alive. `maxAge` bounds history length but is not a WASM memory budget. A module's current arena can also retain memory until reset. Periodically rebuild live data with `compact` or `compactMany`, then release old application references when they are no longer needed. Never invalidate an older snapshot to reclaim its bytes.

No Redux speed multiplier is claimed. The deterministic tests verify that development checks and summaries do not scan shared entries or allocate in the source arena. Measure actual dispatch latency, selector behavior, worker message cost, and peak memory on your application dataset.

## Verification commands

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

The Redux integration workflow runs on PRs targeting either `main` or the PR #1 branch. It does not publish or merge the package.

## Upstream contracts

- Redux Toolkit serializability middleware: https://redux-toolkit.js.org/api/serializabilityMiddleware
- Redux Toolkit immutability middleware: https://redux-toolkit.js.org/api/immutabilityMiddleware
- Immer class behavior: https://immerjs.github.io/immer/complex-objects/
- Redux DevTools configuration: https://github.com/reduxjs/redux-devtools/tree/main/extension/docs/API
