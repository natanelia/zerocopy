# Redux compatibility notes

The main setup is in [the Redux guide](redux.md). Additional APIs are in [the PR #2 guide](redux-checkpoints.md).

## Correction to the original assessment

The original chat assessment inspected `main`, not PR #1. PR #1 replaces the old lifetime model: frozen collection handles retain their arena, reset creates a new default arena, and the old disposal APIs are no-ops. The original auto-disposal and finalizer-slot warnings do not apply to this implementation. Do not add an obsolete finalizer workaround.

Redux can retain older snapshots and replace a collection property inside an Immer-managed plain state object. The integration tests retain 1,200 historical updates while exercising reset, compaction, and deprecated disposal calls. Classes remain non-draftable and updates must use the returned collection.

## JSAN's reserved property

Tests use JSAN 3.1.14. Its parser runs JSON revival before reference restoration. A literal `$jsan` property can then be interpreted as control data and change a user record.

PR #2 replaces the base branch's explicit rejection with an escaped transport. Collection values and marker-bearing records are stored as logical-codec JSON strings. JSAN's own reference and special-value tags are not generated. The replacer, reviver, and options must be passed together; do not replace `serialize.options` with `true`.

The outer ordinary state shape remains available to the monitor. Literal `$jsan`, `$zerocopyRedux`, and `$zerocopyReduxText` records round-trip unchanged. Tests also cover literal marker strings, empty property names, undefined fields, sparse arrays, special numbers, null-prototype records, own `__proto__` properties, and read-only collection payloads. Private temporary holders prevent the JSON reviver from deleting an explicit undefined field or decoding a user marker twice.

The standalone logical codec has no JSAN restriction. Both the logical codec and DevTools transport copy repeated values rather than preserve object identity, and reject cyclic state. Same-format binary checkpoints offer selected snapshot alias preservation, but are restricted to trusted application data.

## Verification scope

Integration-test versions are Redux Toolkit 2.12.0, DevTools instrument 3.0.0, React 19.2.0, React-Redux 9.2.0, Bun 1.4.2, Node 22, and Chromium through Playwright. These are pinned test versions, not claims that each is the latest. The adapter does not import these packages at runtime. Toolkit is an optional peer.

The strict consumer proof compiles generated package declarations with TypeScript 5.9.3. Argument-aware selector declarations use TypeScript's built-in `NoInfer`, so consumers of those declarations need TypeScript 5.4 or newer. The proof checks Redux slice assignments, argument inference, invalid argument rejection, both persistence APIs, and DevTools option compatibility without application casts.

Tests cover real DevTools instrumentation and JSAN, not an installed browser extension's UI. Firefox, WebKit, framework-specific SSR setups, and a redux-persist application are not covered by this new suite. Use the public codec in an explicit storage transform as needed. A successful decode is not validation of the application's domain schema.

A passing suite establishes tested behavior, not a guaranteed speed gain or unlimited memory. Portable export walks values. Arena storage remains append-only until live data is rebuilt and all old holders are released. Binary checkpoint envelope checks are not authentication or full validation of hostile WASM graphs.
