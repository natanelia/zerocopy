# Rejected set callback traversal experiment

**Rejected after one frozen pilot. No PR and no runtime changes are retained.**

The candidate changed only `SharedSet.forEach`, `SharedOrderedSet.forEach`, and `SharedSortedSet.forEach`. When the public `values` method was unchanged, each callback consumed the existing underlying map key iterator directly and decoded the key. This removed one forwarding generator. Public method overrides, getters and subclasses retained the original iteration through a cached method lookup and `Reflect.apply`.

## Why it was rejected

The six-case pilot did not meet the predeclared requirement for material improvement in both runtimes. Node's 8192-value SharedOrderedSet callback scan was **20.5% slower**, with both process pairs slower. Node SharedSet was flat. The overridden-values control was slower in both pairs on both runtimes: **6.8% Node and 5.6% Bun**. Bun's apparent gains on some large scans do not establish a safe three-class improvement.

| Primary 8192-value mixed scan | Node paired change | Bun paired change |
| --- | ---: | ---: |
| SharedSet | +0.4% time | −17.1% time |
| SharedOrderedSet | +20.5% time | −20.0% time |
| SharedSortedSet | −9.5% time | −8.2% time |

These are exploratory estimates from two independent process pairs per row, not confirmed speedups or confidence bounds. [pilot.md](./pilot.md) gives every measured target/control, before/after times, individual pair ratios, batch-resolution diagnostics and the decision. All raw samples remain in [pilot.json.gz](./pilot.json.gz). No formal confirmation, A/A study, source retuning, or repeat pilot followed the rejection.

## Explicit compatibility boundary

The change preserves public `values()` method customization and the underlying `keys()` iterator's closing/error behavior. It does **not** preserve mutation of the native values generator's implementation prototype, such as replacing `SharedSet.prototype.values.prototype.return`. A callback can install that hook just before throwing; the old implementation has a suspended values generator to close, whereas the candidate deliberately removes it. An initial reflection guard cannot preserve that late change.

This boundary was reviewed and accepted **before timing**, following the existing merged sorted-map callback optimization's method-override scope. It is not an exemption chosen after seeing benchmark results. The `generator-return-compatibility.mjs` probe and its baseline/candidate JSON files record the difference. They are diagnostic evidence, not passing regressions. Do not describe this candidate as transparent to arbitrary generator-prototype mutation.

## Preflight evidence

- The new regression file contains 31 cases. It passes unchanged main and the candidate in both Node 24.22.1 and Bun 1.4.2.
- Candidate focused suites: 4 files, 64 passing tests in each runtime. These cover callback values/types/order/receiver/arity, special values, no shared allocation, custom methods/getters and iterator closing, reentry, growth, comparators, and shared/copy attachment.
- Main project typecheck passes.
- All 24 benchmark fixtures pass complete-output smoke verification in baseline and candidate bundles on both runtimes. The four outputs match exactly per runtime.
- Real Node worker proofs pass for all three set classes with shared and copied transports, retained old snapshots, paused iterators, new snapshots and actual writer memory growth. The same proof passes the unchanged baseline.
- All 12 native binaries are byte-identical between builds. This candidate changes JavaScript only.

The initial draft of the new tests used Vitest's `toContain(NaN)`, which uses strict equality and therefore fails for NaN. That assertion was corrected to `some(Number.isNaN)`. The two initial failing logs are retained as `draft-nan-assertion-*.txt`; this was a test assertion correction, not a runtime/source change.

## Frozen plan and completed measurement

See [PLAN.md](./PLAN.md) for the predeclared decision rule, full matrix and oracle. [freeze.json](./freeze.json) records the source, tests, harness, portable bundles and native binary hashes before timing. Its source hashes describe the archived candidate overlay, not the restored baseline production files.

The full matrix has 24 rows across all three classes, string-only/mixed values, 1024/8192-element scans, empty/small calls, unchanged values scans and public method overrides. **Only the six predeclared pilot rows were timed**: all three 8192 mixed targets and three representative controls. The other 18 rows passed smoke correctness checks but have no performance evidence. Every timed callback appended every visited value into a newly allocated array; complete arrays were retained and verified after each batch.

The driver used fresh paired processes, one neutral import path, fixed repetitions, CPU 2, the shared exclusive performance lock, retained warmup/measurement batches and full source/build identity checks. The recording contains 48 subjects and 432 measured batches. The independent verifier passed. No A/A observations exist for this candidate.

## Reproduce the archived candidate

This evidence-only branch restores all three production files to baseline and stores the exact candidate files/tests under `measured-source/`. To reproduce it, create separate baseline and candidate checkouts. Use main commit `0ca99c1da67e4d3e36e098b3f0e85d392c9c1d5e` for the baseline and this evidence branch for the candidate. In the candidate checkout, restore the measured overlay:

```sh
cp proofs/set-foreach-20261105/measured-source/shared-set.ts.txt shared-set.ts
cp proofs/set-foreach-20261105/measured-source/shared-ordered-set.ts.txt shared-ordered-set.ts
cp proofs/set-foreach-20261105/measured-source/shared-sorted-set.ts.txt shared-sorted-set.ts
cp proofs/set-foreach-20261105/measured-source/set-foreach.test.ts.txt set-foreach.test.ts
```

The equivalent runtime-only overlay is `measured-source/candidate.patch`. Do not benchmark this evidence checkout without first restoring the overlay; its active runtime is baseline.

Use Bun 1.4.2, Node 24.22.1 and the repository's pinned dependencies. Build native binaries and portable bundles with identical flags/dependencies in both checkouts (`bun run build:wasm` followed by `bun scripts/build-browser.ts`). Native binaries must match between builds. The recorded study reused the already-built baseline's exact 12 native files because no native source changed. Run the new test file, complete smoke checks and real worker proof against both prepared builds before any independent timing reproduction.

```sh
node proofs/set-foreach-20261105/smoke.mjs /absolute/candidate
bun proofs/set-foreach-20261105/smoke.mjs /absolute/candidate
node proofs/set-foreach-20261105/worker.mjs /absolute/candidate
taskset -c 2 node proofs/set-foreach-20261105/paired-benchmark.mjs \
  proofs/set-foreach-20261105/workloads.mjs \
  /absolute/baseline /absolute/candidate /absolute/bun \
  /absolute/new-pilot-recording.json pilot
```

The driver acquires `/tmp/zerocopy-performance.lock` itself; do not add an outer flock. The original study was never repeated. To inspect its arithmetic without running timings:

```sh
python3 proofs/set-foreach-20261105/verify.py proofs/set-foreach-20261105/pilot.json.gz
```

`manifest.json` records the compressed/uncompressed evidence hashes and archived artifact hashes. The stored JSON includes all changed-source text and full source/build/native identity for independent inspection. Browser tests were not run for this rejected experiment.
