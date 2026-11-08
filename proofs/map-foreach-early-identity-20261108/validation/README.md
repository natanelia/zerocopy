# Corrected-source validation

The runtime changes are limited to `arena.ts` and `shared-map.ts`.
`source-identity.json` records their exact hashes, the portable bundle hashes,
unchanged WASM hashes against baseline
`0ac8a005268335a6116f025e75f670b5cee6843e`, and the integration runner,
subject and pinned numeric fixture hashes. It also verifies that the original
baseline and unfixed regression evidence was copied without modification.

All gates below used the same frozen production source. No timing benchmark
ran during validation, and the per-test timeouts were not changed.

| Gate | Result | Evidence |
| --- | --- | --- |
| Portable browser/Node build | Passed; 12 modules | `build-browser.txt` |
| Fresh Bun public numeric-first import regression | Passed; hook called once, original error propagated, no callbacks before error, two callbacks after restoration | `../regression/fixed-map.json` |
| Focused Bun traversal tests | 60 tests in 4 matched files passed | `focused-bun.txt` |
| Focused Node traversal tests | 60 tests in 4 matched files passed | `focused-node.txt` |
| Declaration build and main/Redux/typed-values (both exact optional modes)/geometry/worker type checks | All 7 commands passed | `type-gates.json` and individual logs |
| Installed package | Node/Bun exports, immutable snapshots, actual Node worker sharing and TypeScript consumer passed | `package.txt` |
| Full configured Bun suite, verbose diagnostic | 1,199 tests in 61 files passed; 34.33 seconds | `full-bun-verbose.txt` |

The focused command was `vitest run map-foreach.test.ts shared-map.test.ts
map-values-view.test.ts --reporter=verbose`, executed under each runtime with
the repository configuration. Vitest's filename filters matched four files.

The first full Bun attempt printed only its startup header and was interrupted
after more than 210 seconds, exiting 130. Its complete output and attempt
metadata are retained as `full-bun-interrupted.txt` and
`full-bun-interrupted.json`. It was not pinned to one CPU. No specific cause
was established. The subsequent diagnostic added verbose reporting and an
outer 180-second process bound; it retained the same configured four-worker
pool, production source, and per-test timeouts. That diagnostic completed and
reported the full passing suite. The interrupted attempt is not a passing run.

An independent source review by the List agent found no actionable issue in
the early capture or the public-entry regression: the Arena module records the
native method before an optional entry can expose an owner, the Map module
retains the existing custom-iterator fallback, and the regression installs its
hook before importing the public root entry. This was a source review, not a
performance judgment.
