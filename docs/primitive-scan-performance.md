# Primitive sequence scans: review fixes and diagnostic proof

This change keeps the public APIs, binary format and WebAssembly core unchanged.
`SharedList.values()` walks immutable leaves without an extra generator.
Numeric and boolean scans avoid the generic value decoder.
Linked-list arrays use their known size, and primitive scans keep the same value
semantics. These changes do not accelerate map writes, indexed reads or JSON
parsing in general.

## Why use one DataView

Each list scan captures the arena's existing DataView once. Every f64 read uses
`getFloat64(address, true)`, matching little-endian WebAssembly storage without
assuming host byte order. There is no per-leaf Float64Array or DataView allocation.
The generator captures the view when its first `next()` runs, not when created.

The view only reads existing bytes of its immutable snapshot. Shared-memory
growth does not detach that older shared buffer. The writer may append bytes or
create forks, but it cannot change published bytes through the collection API.
Returned arrays, decoded JSON and iterator results can still allocate JavaScript
objects. Zero copied input bytes is not a claim of zero allocation or zero GC.

## Correctness checks

`primitive-scan-checks.mjs` runs through Vitest on source, and through Node, Bun,
Chromium, Firefox and WebKit on built public bundles. It checks f64 edge values,
leaf boundaries, callback indexes, copy/shared attachments, read-only writes,
retained forks, actual shared growth, suspended/interleaved iterators, nested
collections and linked-list forward/reverse paths.

A separate constructor trace runs outside timing. It checks that numeric and
boolean scans construct no new Float64Array or DataView, and that all direct
f64 reads explicitly request little-endian storage. This catches the original
PR implementation. It tests mechanism, not native big-endian hardware or physical
heap allocation by an optimizing runtime.

Node and each browser also run a real worker. The worker pauses an iterator;
the writer grows the arena; the worker resumes the original snapshot and checks
all values, materialization, callbacks and rejected writes. Bun runs the
same-realm attachment checks; the dedicated real-worker check is not run in Bun.

## Measurement method and limits

The workflow builds the actual PR base and candidate with the same dependencies
and build flags. All runtimes import the built public entry point, including Bun.
Each runtime runs three fresh processes (and fresh browsers), with 15 alternating
samples per case. Both variants use identical operations and validation. Warm-up
precedes adaptive calibration. A sample targets 8 ms, subject to repeat and
retained-output caps; results explicitly flag shorter batches.

All changed methods are measured for numbers and booleans at 33 and 32,769 values.
String and object controls run at 1,057 values. This is 54 rows per round, including
linked-list `toArray` and reverse arrays. Fixtures use private arenas. Result
arrays from every timed iteration remain reachable until after timing and are
then checked at every index. Object benchmark records validate both fields.
Scalar scans use a count and order-sensitive checksum. Fixture construction,
full result validation and worker setup are not included in scan timings.

Reports preserve raw samples, median, 10th/90th sample percentiles, calibrated
repeat counts, runtime versions, CPU/architecture and both checked-out commits.
A slowdown flag highlights a candidate median over 10% slower with non-overlapping
central sample bands. These bands are descriptive, not confidence intervals.

**This is diagnostic, not a performance regression gate.** Correctness, build and
type failures fail CI. Timing ratios do not. A green job does not prove a speedup.
Review all rounds and runtimes; do not select only favorable rows or small gains.
Performance may differ with callbacks, input types, cache state and engine tiering.
The prior PR's Bun-only measurements used per-leaf typed-array views and do not
establish the performance of this corrected implementation.

## Reproduce

Build `dist` in the repository and `.primitive-baseline`, using the same installed
dependencies. Then run from the repository root:

```sh
ROUND=1 node proofs/primitive-scan-performance.mjs
ROUND=1 bun proofs/primitive-scan-performance.mjs
ROUND=1 BROWSER=chromium node proofs/primitive-scan-performance.mjs
ROUND=1 BROWSER=firefox node proofs/primitive-scan-performance.mjs
ROUND=1 BROWSER=webkit node proofs/primitive-scan-performance.mjs
```

Repeat with `ROUND=2` and `ROUND=3`. Browser runs require the corresponding
Playwright browser and OS dependencies. The runner supplies isolation headers
and binds only to loopback. It does not use a service worker or external service.
Set `PRIMITIVE_BASE` or `PRIMITIVE_CANDIDATE` only for local built-bundle overrides.
Reports are written to `proofs/results/primitive-scan/<runtime>-<round>.json`.
