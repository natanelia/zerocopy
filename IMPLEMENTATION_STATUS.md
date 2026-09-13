# Candidate integration status

The full v0.2 runtime and proof programs are now integrated on this branch.
The earlier upload failure is resolved. The runtime source is the local candidate
identified in the performance report; it is no longer an unused WASM core.

This remains a draft for review, not an approved release. Several writes regress,
and the binary layout, worker protocol, and memory lifetime change. No merge or
npm release has been performed.

## Verification scope

The local candidate passed 280 unit tests in 13 files, type checking, WASM and
portable JavaScript builds, and declaration generation. A real Node worker
checked all 12 public types and nested values, including 10,000 retained reads
during writer updates and memory growth. Six unchanged snapshot counterexamples
failed on the original and passed on the candidate.

The workflow now tests the candidate, including a real Chromium worker test and
a matched-compiler benchmark. Check the Actions run for this branch's exact
commit before treating remote checks as passed. Historical local results remain
separate from new CI results. No local browser pass is claimed.

## Review limits

Public collection values are immutable through supported APIs. Internal caches,
allocation, and unpublished construction remain mutable. Raw shared memory is
not a read-only security boundary. There is one allocating writer per arena and
read-only worker attachment. Arenas are append-only with a limit below 2 GiB and
no per-node reclamation. Any retained snapshot pins its arena. Reset creates a
new lifetime; dispose and auto-GC configuration are deprecated no-ops. Bun uses a
used-prefix copy by default, so that fallback is not zero-copy.

See the proof report for all measured improvements and regressions, raw samples,
source identifiers, reproducible checks, and migration details.
