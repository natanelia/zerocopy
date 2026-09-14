# Redux compatibility notes

The main setup is in [the Redux guide](redux.md).

## JSAN's reserved property

The DevTools integration test uses JSAN 3.1.14. That serializer can interpret an
ordinary `$jsan` property as its own control data after JSON revival. It can then
change a user record instead of restoring it unchanged.

Portable DevTools mode therefore rejects a raw `$jsan` property in plain Redux
state or action records with an explicit error. This also applies to ordinary
records nested inside an escaped `$zerocopyRedux` record. It does not silently
rename keys, disable checks, or report corrupted output as a successful restore.

The standalone `createZerocopyCodec().stringify()` and `.parse()` functions have
no `$jsan` restriction. Use them for application backups that contain this key.
A JSON value inside a SharedMap is also safe: the revived snapshot keeps its
payload in private arena storage, not in the plain graph walked by JSAN.

Our own `$zerocopyRedux` marker is escaped in ordinary user records. Normal
DevTools round trips also test undefined fields and NaN with the actual JSAN
implementation, not only native JSON.stringify/JSON.parse.

## Verification scope

The automated checks use Redux Toolkit 2.12.0, DevTools instrument 3.0.0,
React 19.2.0, React-Redux 9.2.0, Bun 1.4.2, Node 22, and Chromium through Playwright.
These are pinned integration-test versions, not a claim that each is the latest.
The build does not add these as runtime dependencies of `zerocopy/redux`.

Tests cover the DevTools instrument and serializer libraries. They do not drive
an installed Redux DevTools browser extension. Firefox, WebKit, framework-specific
SSR setups, and a redux-persist application integration are not covered by this
new test suite. Use the public codec in an explicit storage transform as required.

A passing suite establishes the tested behavior, not a promise of a performance
gain or unlimited memory. Portable export walks values. Arena storage remains
append-only until live data is rebuilt and all old holders are released.
