# Set forEach: eliminate one forwarding generator

Baseline: `0ca99c1da67e4d3e36e098b3f0e85d392c9c1d5e`.

Candidate: `SharedSet`, `SharedOrderedSet`, and `SharedSortedSet` retain one dynamic lookup of `this.values`. A method other than the module-captured native method executes through `Reflect.apply` and the original for-of callback loop. Native values traverse the existing underlying `map.keys()` iterator and decode each key directly, avoiding one generator allocation and one yield/resume per visited value. No traversal algorithm, native code, values iterator, comparator, callback signature, or set format changes.

This is an experiment, not yet an accepted improvement. The source, workload and repetition counts will be frozen before the pilot. Each measured version gets a separate preserved record; do not tune or rerun the same pilot to seek better samples.

## Compatibility scope decided before measurement

The guard preserves public `values()` method replacement, subclasses, method getters and their lookup counts, plus the underlying `map.keys()` iterator and its close/error behavior. It does **not** preserve edits to the native values generator's implementation prototype (for example, assigning `SharedSet.prototype.values.prototype.return`). The direct path intentionally has no values generator instance. A callback that installs such a return hook and then throws therefore cannot observe that removed generator. An initial prototype guard would not solve a hook installed while a callback is active.

The review decision before any timing treats native generator-prototype mutation as implementation-level customization, consistently with the existing merged `SharedSortedMap.forEach` method guard. This is an explicit compatibility limitation, not a benchmark-derived exemption or a claim of arbitrary generator-prototype transparency. The deterministic `generator-return-compatibility.mjs` probe and both recorded outputs illustrate it; they are not passing regression tests or performance evidence.

## Declared matrix and decisions

The full matrix contains 24 rows: all three classes at 1024 and 8192 values, each with string-only and mixed string/number fixtures; per-class small4, empty, unchanged values1024, and custom-values-override1024 controls. Primary rows are the three 8192-value mixed forEach scans. Secondary rows cover smaller scans and string decoding. Constructor/add work is outside timing. Each timed forEach includes a fresh output array and a callback that appends every value; every full array is retained and compared for exact value, type, count and order after each batch.

The six-row pilot and same-baseline A/A subsets are declared in workloads.mjs: all three primary targets, SharedSet small4, SharedOrderedSet override1024, and SharedSortedSet unchanged values1024. Full confirmation, if authorized after the pilot, covers every declared row.

Accept only material improvement in both Node and Bun, subject to the shared review gate. Pilot target: at least 10% lower time in the primary operations in both runtimes. A material unresolved control regression blocks acceptance; same-baseline A/A describes process noise and does not cancel an A/B loss. Unfavorable and inconclusive rows remain in the report. Formal intervals use six independent process pairs, not nine within-process batches as independent samples.

## Correctness and observability

Deterministic tests cover complete decoded values and order, numeric/string identity and special values, one callback argument and undefined receiver, no shared allocation, empty/non-callable behavior, subclass and late prototype values overrides, one values getter read, custom iterator close/error precedence, underlying map.keys getter/iterator behavior, decoding failure, nested callbacks, writes and real shared-memory growth, custom sorted comparators, and both shared/copy worker attachment. Run the same regression file on the unchanged baseline.

The benchmark's independent native Set verifies membership/types. The unchanged public values() supplies exact HAMT traversal order; ordered and sorted fixtures additionally use independent insertion/encoded-key order. Every batch verifies the complete output arrays, source descriptors, arena identity/allocation frontier, and original bytes. Assertions run outside timing; their allocations may affect later garbage collection.

## Reproduction

Use the pinned project dependencies and identical WASM files from the baseline, then build portable bundles with `bun scripts/build-browser.ts` in both checkouts. The public bundle is used in Node and Bun. Run `node proofs/set-foreach-20261105/smoke.mjs /absolute/checkout` and the equivalent Bun command for correctness before timing.

The copied common driver enforces the exclusive `/tmp/zerocopy-performance.lock`, neutral import path, source/build/WASM identity, alternating AB/BA fresh processes, at least eight warmup batches and nine retained measured batches. Pin to CPU 2 and coordinate with the root agent before running. Do not add an outer flock.

```sh
taskset -c 2 node proofs/set-foreach-20261105/paired-benchmark.mjs \
  proofs/set-foreach-20261105/workloads.mjs \
  /absolute/baseline /absolute/candidate /absolute/bun \
  proofs/set-foreach-20261105/pilot.json pilot
```

Use separate `formal.json formal` and `aa.json aa` records only after the pilot decision. Recompute saved evidence without timings using `python3 proofs/set-foreach-20261105/verify.py <recordings>`.
