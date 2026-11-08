# Large boolean List appends

## Candidate and scope

The candidate specializes `SharedList<boolean>.pushMany()` for ordinary arrays
with at least 32,768 elements on little-endian hosts. It validates the inputs into
one-byte flags, then uses native typed-array conversion to write the final float64
slots. Input getters finish before this path allocates or writes arena storage.
Smaller boolean batches and the other value types retain the existing path.

Custom encoders, custom array mapping/species, read-only attachments, invalid
values, holes, reentrant getters, allocation failure and memory growth are covered
by focused tests. A getter that changes the encoder is observed during iteration;
its numeric outputs retain their original float64 values.

This is a JavaScript change in `arena.ts`. It adds no public API and changes no
WASM binary or published storage format. Eligibility checks live in a separate
helper so ordinary number/string/object encoding stays small.

## Validation completed locally

| Check | Result |
| --- | --- |
| Portable build | 12 modules built successfully |
| Source TypeScript check | Passed |
| Focused Node tests | 73 tests passed across 3 files; Node 24.22.1 |
| Focused Bun tests | 73 tests passed across 3 files; Bun 1.4.2 |
| Before/after workload smoke | All 13 workloads passed in both runtimes; every retained output and original source checked |
| Exact arena storage | 36 before/after pairs per runtime; allocation, descriptors and all published arena bytes identical |
| Local Chromium | Browser process could not start: `socket() failed: Operation not permitted (1)`; no browser test pass claimed |

The storage observations support **unchanged arena allocation**, not a memory
saving claim. JavaScript temporary heap usage has not been measured.

`browser.mjs` is an untimed Chromium proof that checks complete boolean outputs,
retained forks, compaction, published bytes, and real workers reading during
writer memory growth. It covers shared and copied attachments, paused iterators
and read-only rejection. The dedicated GitHub workflow runs this proof in hosted
CI; that browser gate is still required.

## Performance evidence policy

The second candidate is awaiting measurements on an isolated GitHub Actions
runner. No performance conclusion is made before reviewing those raw results.
The first pilot remains in `results/pilot.json`; its source and workload are
retained under `exploration/`. Its small-batch results motivated the larger
threshold.

The hosted workflow first builds both checkouts, runs focused Node/Bun tests,
checks source/value types, verifies the untimed workloads and arena bytes, and
runs the Chromium worker proof. Only when `results/formal.json` is absent, it
then collects `results/pilot-v2.json`, six-pair `results/formal.json`, four-pair
`results/aa.json` and `results/reference-comparison.json`, sequentially on the
first CPU allowed to that runner. It keeps the original pilot and refuses to
overwrite existing study files. Saved confirmation skips the timing bootstrap
on later runs; exact source/build and statistical audits still run.

The common driver uses separate processes, one fixed CPU,
alternating before/after order, six paired confirmation runs, nine samples per
process and at least 500 ms of warmup. It retains all returned snapshots and
checks complete results outside the timed interval. Same-build A/A measurements
use four pairs. Source, compiler-input, WASM, bundle, workload and driver hashes
are recorded, and the verifier recomputes the paired statistics.

The temporary branch trigger is `perf/list-boolean-encoding-20261108`; main,
relevant pull requests and manual dispatch remain enabled. All raw results and
`boolean-ci-results` are uploaded even if validation or measurement fails. These
measurements will be reviewed for substantial gains and acceptable controls
before opening a pull request for the runtime change.

The target workloads append 32,768, 32,769 or 262,144 boolean values, including
31-, 32- and 65-element prefixes. Controls include smaller boolean batches,
32,767 elements immediately below the threshold, numbers, strings, objects and
scalar boolean pushes. Fixtures are ordinary dense arrays repeatedly appended
to one immutable source per batch; fixture construction and complete output
verification are excluded from timing.

`compare.mjs` provides secondary context using the same boolean fixtures with
`Immutable.List.concat(input)` and one native `source.concat(input)`. Native
arrays are copied once per request and are not frozen. This comparison does not
replace the paired before/after evidence.

## Reproduction

Build the pinned baseline commit
`a4265a0608ec25eec5719496225212db6b251989` and the candidate using the same
dependencies and build scripts. Use separate checkouts.

```sh
node proofs/list-boolean-encoding-20261108/smoke.mjs BASELINE CANDIDATE
node proofs/list-boolean-encoding-20261108/allocation.mjs BASELINE CANDIDATE
node proofs/list-boolean-encoding-20261108/browser.mjs CANDIDATE
taskset -c CPU node proofs/list-boolean-encoding-20261108/paired-benchmark.mjs \
  proofs/list-boolean-encoding-20261108/workloads.mjs \
  BASELINE CANDIDATE BUN_EXECUTABLE OUTPUT.json formal
node proofs/list-boolean-encoding-20261108/verify.mjs OUTPUT.json CANDIDATE
```

Use a new output filename for each study. The driver takes the common benchmark
lock itself. Do not run builds, tests or other benchmarks during measurement.
