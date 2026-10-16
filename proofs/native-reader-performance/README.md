# Native-reader session performance screen

This prospective implementation follows the adjacent, byte-pinned METHOD v2.
It has not run against either collection implementation. Synthetic tests exercise
only the harness and mathematical rules. Execution requires successful audited
terminal correctness, reviewed exact build/preparation provenance, independent
implementation review, and a separately authenticated one-attempt authorization.

## Files and boundaries

- `owner.mjs` and `worker.mjs` are timing entry points. Their common runtime files
  use only the public portable `dist/shared.js` and `dist/worker.js` entry points.
  They never replace constructors, factories, exports, or built-ins.
- `preflight.mjs` and `preflight-worker.mjs` are separate mechanism entry points.
  Only the latter installs the narrow `WebAssembly.Instance` counter. No timing
  process loads that module; there is no patched-then-restored measurement.
  Preflights do not call endpoint clocks and report null latency fields with
  `untimed: true`; only the Supervisor records their resource-guard lifetime.
- `endpoint.mjs` forwards each real Worker/MessagePort listener registration,
  event or argument list, receiver binding, error/exit/close event and removal.
  It does not create synthetic library messages or replace a port's application
  listeners. The library receives the original event.
- `fixtures.mjs` constructs all immutable source fixtures through public APIs.
  `oracle.mjs` uses independent integer-quarter formulas and full value, shape,
  frozen-state and sampled identity checks outside batch timers.
- `cases.json` specifies the deterministic fixtures, query and fixed limits.
  The controller binds its canonical hash and the full 80-group schedule hash
  into every group configuration and report. Batch sequence receipts cover the
  row, operation offsets, variants, count and public-session versions.
- The Python controller authenticates inputs, admits one group at a time, freezes
  actually tried baseline counts, checks full-rehearsal feasibility, and retains
  partial raw evidence on any failure. Its Supervisor and headroom modules are
  the exact previously reviewed bytes.
- The Python analyzer reconstructs estimates from all twelve paired blocks,
  retains every observation, applies endpoint-specific batch/cold quality rules,
  reports both baseline comparisons, and keeps any independently valid adverse
  full-sample finding visible even when another endpoint is incomplete.

## Lifecycle and estimands

Each process imports shared then worker in the owner, records the owner's first
creation, constructs and authenticates fixtures, and starts exactly one real
`node:worker_threads` Worker. The worker imports shared then worker, connects P8,
queries its initial view, and returns its ready response. Outside timers the
initial view is fully checked before the first changed P8 publication. That
publication is the fresh worker's first eligible native reuse and is recorded
separately from all row warm-ups.

The fixed row order is P8, P1, N8, R8, C8, F8, W8. P8 remains alive for N8 and W8;
other sessions are disposed at their row end. Every active reader explicitly
retains only its initial, preceding, and current snapshots. R8 keeps only its
latest result and drops it at row end. Source versions are built once, never
mutated during measurement, and bounded at 26 arenas including the cold map,
within METHOD's unchanged 32-arena/8-MiB/1-MiB caps.

P1/P8/C8/F8 batches use two owner clocks around the complete sequential publish
and application-response loop. The application subscription starts the receiver
query clock at entry, queries and consumes its values, then queues its response
in a microtask. The library posts its synchronous ACK first on the same real
port. The owner observes that ACK in the previous message event before advancing;
sequence and count assertions run outside the measured batch. The receiver
acceptance clock starts immediately before the library's snapshot listener.
Receiver acceptance and query components overlap the owner elapsed endpoint and
are never summed into a fabricated total.

R8 and W8 use two worker clocks around their loops, excluding command transport.
N8 uses an owner-local loop and consumes returned session versions; it must send
zero snapshot messages. These controls retain their distinct meanings.

Warm-ups and pilots are retained as raw evidence, never efficacy replicates.
An in-progress batch is checkpointed before it starts; a completed timer receipt
is checkpointed before assertions. Each successful batch is subsequently marked
validated. Incomplete/failed evidence is never overwritten by another attempt.
Cold observations, setup, validation, serialization and teardown are retained.
The supervisor's entire group lifetime, including polling and reaping, supplies
the feasibility inputs. `setupMs` is elapsed setup including its cold checks;
subphase values are diagnostic and must not be added to it as disjoint costs.

Fixture byte receipts record used prefixes and committed capacity solely for
validation. Random production arena IDs are checked within the process; stable
receipts index source arenas in deterministic construction order. No comparative
memory claim is derived from these values or the sampled resource guard.

## Checks that do not execute a subject

`protocol-synthetic-test.mjs` imports only standard-library modules and the pure
endpoint/oracle helpers. It creates no Worker or target process and performs no
benchmark timing. It tests event identity/binding/removal, protocol sequence
rejection, odd-count alternation, formula checksums, and negative shape/identity
cases. The Python synthetic tests similarly import no target or launch target
processes. `node --check` parses the source without evaluating its imports.

These checks do not establish Bun Worker compatibility, native instance counts,
runtime correctness, or performance. Those remain gated by the prescribed four
mechanism groups and the complete audited execution, with no extra groups or
retries.
