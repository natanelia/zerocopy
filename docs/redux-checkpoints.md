# Redux additions in PR #2

PR #2 targets PR #1's branch and preserves its logical persistence codec, Redux helpers, regression tests, and browser tests. The original lifetime warning applied to the old main branch, not this immutable engine. No old-state auto-disposal workaround is required.

## Development checks

`zerocopyMiddlewareOptions` keeps Redux Toolkit checks enabled. Shared collections are validated as atomic immutable values; their entries and WASM bytes are not scanned on each dispatch. `zerocopySerializableCheck` and `zerocopyImmutableCheck` are also exported separately. The immutability policy matches Toolkit's normal primitive/frozen-object policy. Unsupported ordinary action values and mutations still produce errors.

## DevTools modes

`createZerocopyDevToolsOptions()` defaults to summary mode with a 50-state history limit. Its summary contains collection kind, size, and value type. It does not read collection contents. The sanitizer does not execute ordinary getters. The in-page store retains the real snapshots.

Summary mode explicitly enables pause, lock, jump, skip, reorder, and dispatch controls. It disables import, export, persistence, and generated tests because display summaries cannot reconstruct state. A partial DevTools features object otherwise disables unspecified controls, including time travel.

Portable mode provides the full replacer, reviver, and JSAN options as a unit. Do not replace its `serialize.options` with `true`. It retains the outer ordinary state shape, escapes literal `$jsan` and codec marker keys, and restores real writable collections. It also preserves undefined fields, sparse arrays, special numbers, null-prototype records, and own `__proto__` fields. Repeated references are encoded by value; cycles and unsupported class/function values are rejected. This copying path is not zero-copy and can be costly for large histories.

Tests use real JSAN and Redux DevTools instrumentation. They cover export/import, retained state reads, and writes after committing an older state as a new history root. They do not automate the installed browser extension's interface.

`createZerocopyDevTools` aliases `createZerocopyDevToolsOptions`. `sanitizeZerocopyState` aliases the display operation also exposed as `summarizeZerocopyState`. Do not persist a sanitizer result.

## Selectors with arguments

```ts
import { createSharedMapEntrySelector } from 'zerocopy/redux';

const selectWay = createSharedMapEntrySelector(
  (state: RootState) => state.map.ways,
  (_state: RootState, id: string) => id,
);
const way = selectWay(store.getState(), 'way-123');
```

Create one selector per component or independent key stream. It caches one result by arena object, immutable leaf address, and value type. An unrelated edit retains the selected object reference even after the bounded JSON decode cache fills. A changed entry or new arena invalidates it. The existing state-only `createSharedMapValueSelector` remains available. These selectors are synchronous.

## Complete binary checkpoints

Use `createZerocopyCodec()` from the main guide for normal portable persistence. The additional API below is for trusted, same-binary-format checkpoints:

```ts
import {
  serializeZerocopyState,
  deserializeZerocopyState,
} from 'zerocopy/redux';

const saved = serializeZerocopyState(store.getState(), {
  maxBytes: 64 * 1024 * 1024,
  maxNodes: 100_000,
  maxDepth: 128,
});
const restored: unknown = deserializeZerocopyState(saved);
// Validate the application's schema before using restored as preloadedState.
```

`encodeZerocopyState` and `decodeZerocopyState` operate on the structured packet instead of the JSON text. Public types are `ZerocopyCheckpointOptions` and `ZerocopyStatePacket`.

The checkpoint contains selected live data, not only root pointers. It compacts before export so obsolete values elsewhere in source arenas are not included. It supports all 12 collections and nested dependencies. It retains repeated references to the same snapshot wrapper in the surrounding state tree. It restores frozen ordinary state and gives every import fresh writable arena identities. Two imports can therefore be combined into nested worker snapshots without arena-ID collisions.

Use this binary API only with trusted application-generated data and the same binary format version. Envelope versions, lengths, checksums, top-level descriptors, and tree shape are checked. These checks are not authentication or full validation of a hostile WASM pointer graph. Do not expose binary checkpoint import as an untrusted network endpoint. The logical codec does not treat input as WASM pointers and is the appropriate general persistence path, with application schema validation and input limits.

Limits do not guarantee a peak-memory budget. Compaction, base64, and import reconstruction need temporary copies. Neither checkpoint API changes the append-only arena model. Old snapshots, selectors, workers, defaults, and DevTools history can retain arenas. Compact live state at controlled boundaries and release unused holders; never invalidate retained snapshots.

## Verification

Run `bun run test:redux` for all Redux unit and integration files. The stacked-PR workflow also builds WASM and browser exports, generates declarations, compiles strict consumers, runs the complete suite, executes actual Node workers and Chromium/React tests, and checks the npm package file list. It does not publish or merge the package.
