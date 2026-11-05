# Rejected experiment: word copies for immutable list updates

## Decision

Do not open a PR or ship this patch. The sole pilot found mixed Node results and roughly 9–10% slower changed paths on Bun. This fails the requirement for a worthwhile improvement on both runtimes. No formal confirmation or selective rerun was performed. All pilot measurements, including unfavorable and short samples, are retained.

## Candidate

The candidate replaces `memory.copy` with the existing `copyWords` helper at two call sites in `persistent-core.as.ts`: `vecSetAt` and `tailSet`. Only `SharedList.set` calls these functions. The intended benefit was avoiding the shared-memory bulk-copy runtime path for 128-byte branches and 8–256-byte leaf/tail data. Both methods allocate the same number of bytes and preserve raw numeric bits and encoded references.

Baseline: `0ca99c1da67e4d3e36e098b3f0e85d392c9c1d5e`.

The measured candidate was an uncommitted patch on that baseline; the recording includes complete before/after changed-source snapshots and SHA-256 identities of all source, WASM, and portable bundle inputs. This branch now retains the exact source patch and proof files.

## Pilot results

Times are microseconds for one complete operation: 1,024 chained public `set()` calls retaining the final immutable snapshot, or 1,024 public `get()` calls with a retained sum. Setup and full result/snapshot/allocation verification are outside the timer. Before and after columns are medians of per-process estimates; the paired ratio is the geometric mean of the two matched after/before ratios, so it need not equal the ratio of those columns.

| Runtime | Case | Before µs | After µs | Paired ratio | Time change |
|---|---|---:|---:|---:|---:|
| node | `tree-1024` | 364.423 | 310.512 | 0.854 | -14.6% |
| node | `tree-32768` | 406.428 | 409.594 | 1.007 | +0.7% |
| node | `tail-32` | 292.223 | 254.348 | 0.875 | -12.5% |
| node | `get-control` | 22.606 | 21.891 | 0.970 | -3.0% |
| bun | `tree-1024` | 361.527 | 397.793 | 1.099 | +9.9% |
| bun | `tree-32768` | 415.229 | 455.473 | 1.100 | +10.0% |
| bun | `tail-32` | 318.668 | 348.901 | 1.092 | +9.2% |
| bun | `get-control` | 164.625 | 96.384 | 0.650 | -35.0% |

This pilot has two AB/BA process pairs and does not report confidence intervals. The Bun read control was especially noisy: its baseline estimates were 92.549 and 236.701 µs. Most read-control measured batches were below 2 ms and remain in the raw evidence. No read-control improvement is claimed.

## Method and evidence

- Node 24.22.1 and Bun 1.4.2; one case/build per fresh process, CPU affinity 2, the common `/tmp/zerocopy-performance.lock` held for the whole study.
- Identical neutral import path for both portable bundles; AB/BA and runtime/case orders alternate by process pair.
- At least 150 ms of timed warmup and eight warmup batches per process, followed by nine measured batches. Sixteen complete operations per batch, with every result retained and checked afterward.
- `pilot-01.json` retains all 32 processes and 288 measured batches, all warmup samples, full build identities, source snapshots, environment details, per-pair estimates and summary calculations. `pilot-01.log` retains console output.
- `paired-benchmark.mjs` and `workloads.mjs` are the exact frozen harness and fixture files. The generic JS-only WASM equality gate was adapted to require precisely the nine declared core/legacy WASM outputs to differ; numeric and geometry modules remain identical.
- `verify.py` independently verifies the recording's provenance checks, identities, fixture matching, sample counts and summary arithmetic without running timings.

## Correctness checks

`shared-list-word-copy.test.ts` passed all three tests on Node and Bun. Coverage includes every tail length, depth boundaries, untouched branches and published bytes, exact allocation counts, external memory growth, special floating-point values, encoded references, and copied/shared worker attachments. The existing allocation-failure suite passed all 32 tests on Bun. All nine prepared workload cases also passed complete output and invariant checks before timing; only the four declared pilot cases were timed.

## Reproduction

Build both a clean checkout at the baseline and this candidate using the repository build scripts, with Node 24.22.1 and Bun 1.4.2. The driver rejects a dirty baseline, undeclared source differences, undeclared WASM differences, changed fixture/driver files during the run, or an existing output path.

```sh
node scripts/build-wasm.mjs
bun scripts/build-browser.ts
```

From this checkout, substitute the baseline checkout and Bun executable paths below. Choose an available CPU and a new output filename; do not wrap the driver in another flock for the same path.

```sh
taskset -c 2 node proofs/vector-copy-20261105/paired-benchmark.mjs \
  proofs/vector-copy-20261105/workloads.mjs \
  /absolute/path/to/baseline /absolute/path/to/this-checkout \
  /absolute/path/to/bun /absolute/path/to/new-pilot.json pilot

python proofs/vector-copy-20261105/verify.py \
  proofs/vector-copy-20261105/pilot-01.json
```
