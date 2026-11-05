# Native byte-oriented Base64 for checkpoint export

On this host, the native path reduces complete **Bun checkpoint export time by
70–80%** across the four fixed export workloads in the isolated study. This
includes compaction, checksums, allocation, freezing, and (for the serialize
case) JSON serialization. It is not a timing of the Base64 helper alone.

The optimization is six production lines in `redux-checkpoint.ts`: capture the
optional standard `Uint8Array.prototype.toBase64` method once, then use it for
the already compacted byte copy. The existing chunked encoder remains unchanged
for engines without the method. The decoder, validation, checksum, wire format,
public API, dependencies, and source snapshots are unchanged.

Bun 1.4.2 has the native method on this host. Node 24.22.1 does not, so its results
below are **fallback controls, not a claimed native speedup**. No browser timing
was collected. The [ECMAScript specification](https://tc39.es/ecma262/multipage/indexed-collections.html#sec-uint8array.prototype.tobase64)
defines the default padded Base64 format used here. Feature detection happens at
module import; a polyfill installed afterward does not switch the selected path.

## Isolated before/after results

The fixed baseline is `09b1a385a7c2ac9b027a4055335ae2f9449abe6e`.
Measured production commit: `f454ee97373f2634c9e6652d03c960ebeb00cb06`.
The source was not changed between the pilot, first formal study, and isolated
confirmation. Publication may have another commit ID; the source and all
portable bundle hashes are retained in each recording.

The isolated study uses one workload and one build per fresh process, six
balanced before/after pairs per workload/runtime: **144 fresh measured processes,
1,296 measured batches**, with all six workloads retained. Times are milliseconds
per complete public API operation. Before/after columns are marginal medians of
process medians. The paired ratio is the geometric mean of six after/before
process-pair ratios and need not equal the ratio of those marginal medians.
Below one favors the candidate. Intervals are unadjusted 95% Student-t intervals
on paired log ratios; the six process pairs are the independent units.

| Runtime / workload | Before ms | After ms | Paired ratio | 95% interval |
| --- | ---: | ---: | ---: | --- |
| node / plain-state | 0.00315 | 0.00311 | 0.938 | 0.808–1.089 |
| node / encode-small | 3.00886 | 2.83304 | 0.958 | 0.783–1.172 |
| node / encode-large | 15.94508 | 13.99441 | 0.933 | 0.834–1.044 |
| node / serialize-large | 15.12883 | 14.87446 | 1.011 | 0.935–1.093 |
| node / encode-unicode | 13.76370 | 13.03750 | 1.032 | 0.899–1.184 |
| node / decode-large | 3.85133 | 3.93134 | 1.041 | 0.830–1.306 |
| bun / plain-state | 0.00739 | 0.00989 | 1.083 | 0.593–1.978 |
| bun / encode-small | 3.12748 | 0.66894 | 0.227 | 0.184–0.280 |
| bun / encode-large | 8.85411 | 1.82331 | 0.198 | 0.161–0.243 |
| bun / serialize-large | 9.39136 | 2.38108 | 0.242 | 0.203–0.288 |
| bun / encode-unicode | 8.59604 | 2.56830 | 0.295 | 0.254–0.344 |
| bun / decode-large | 3.82214 | 3.42643 | 0.933 | 0.798–1.091 |

All four Bun export intervals are well below one. The plain-state and decoding
controls, and all six Node fallback controls, have intervals spanning one. Some
are wide: the isolated Bun plain-state interval is 0.593–1.978, and Node decoding
is 0.830–1.306. These controls do not establish equivalence or rule out small
regressions; there is no universal no-regression claim.

### Workloads and timed work

- `plain-state`: a small ordinary state tree without collections; it exports no
  Arena bytes and never calls Base64. 128 complete operations per batch.
- `encode-small`: a 32-number `SharedList` checkpoint, four operations per batch.
- `encode-large`: a 32,768-number list checkpoint, two operations per batch.
- `serialize-large`: that large checkpoint plus `JSON.stringify`, two per batch.
- `encode-unicode`: 2,048 distinct Unicode strings in a list, two per batch.
- `decode-large`: restore the large numeric checkpoint; the production decoder
  is unchanged. Two complete operations per batch.

The checkpoint includes the compact Arena prefix as well as collection payload,
so even a small list exports at least the existing 64 KiB Arena header region.
Before and after export identical Arena byte lengths and content for each
fixture. This change does not reduce serialized size.

Sources are built once before timing. Each batch retains all result objects in
an outer array allocated before the timer. Complete public operations, their
allocations and any garbage collection they trigger are inside timing. Imports,
fixture construction, initial reference checkpoints and verification are outside.
Every checkpoint output is checked for all Arena Base64 strings, checksums,
lengths, format, tree and expected freezing; every decode output is checked at
every value. The reference checkpoint is independently round-tripped and its
Base64 is compared against Node-compatible `Buffer` encoding. Source lists are
checked again after the case.

Each process warms its workload for at least **500 ms of actual timed work** and
at least eight batches, then records nine measured batches. Repetition counts are
fixed and equal between builds. Actual warm-up totals were 500.059–535.794 ms for
Node and 500.044–547.049 ms for Bun. Measured batch durations ranged from
0.358–85.036 ms on Node and 0.842–30.404 ms on Bun; the tiny plain-state control is
particularly noisy. The primary subject statistic is the median of all nine
batches, with no removal or replacement.

The entire portable bundle directory, including every content-hashed chunk, is
copied to the same neutral import path between fresh subjects. This keeps path
identity fixed while preventing mixed baseline/candidate chunks. Both runtimes
use the portable public entry points. AB/BA order alternates by pair; workload
order reverses each pair. All heavy work uses the shared performance lock and
measurement processes are pinned to CPU 2.

Measured on 2026-11-05 UTC: AMD EPYC 9V74, Linux 6.18.57 x64, Node 24.22.1 and
Bun 1.4.2. Runtime versions, CPU affinity, source hashes and every observation
are retained in the raw JSON.

## Why there are two formal studies

The [initial plan](PLAN.md) used six cases in each fresh subject process. Its
[complete six-pair study](results/formal-01.json.gz) confirmed large Bun export
gains, but its unchanged plain-state control also appeared faster: ratio 0.862
[0.776, 0.957]. That control never calls Base64. Node Unicode checkpoint export
had an adverse point estimate of 1.095 [0.987, 1.216].

The [follow-up plan](ISOLATED-PLAN.md) therefore isolated each workload in its own
fresh process to remove cross-case engine/garbage-collector history. It retained
the exact source, fixtures, repetition counts, all six workloads, warm-up rule
and estimator. It was planned before the follow-up data was collected. The
isolated estimates above are the final summary irrespective of whether their
gains are larger or smaller. The first study is reported below in full and is
not pooled with the follow-up. The control movement does not justify attributing
an improvement to code that the control never executes.

| Runtime / workload | Before ms | After ms | Paired ratio | 95% interval |
| --- | ---: | ---: | ---: | --- |
| node / plain-state | 0.00317 | 0.00325 | 1.051 | 0.916–1.205 |
| node / encode-small | 2.72251 | 2.70199 | 0.991 | 0.958–1.025 |
| node / encode-large | 14.71708 | 14.35041 | 0.953 | 0.814–1.116 |
| node / serialize-large | 14.95451 | 15.34169 | 1.068 | 0.884–1.290 |
| node / encode-unicode | 12.70413 | 13.93332 | 1.095 | 0.986–1.216 |
| node / decode-large | 3.89121 | 3.86902 | 1.020 | 0.940–1.107 |
| bun / plain-state | 0.00825 | 0.00733 | 0.862 | 0.776–0.957 |
| bun / encode-small | 2.63180 | 0.74460 | 0.289 | 0.219–0.383 |
| bun / encode-large | 11.30013 | 2.35586 | 0.196 | 0.160–0.241 |
| bun / serialize-large | 14.36225 | 2.44541 | 0.180 | 0.139–0.233 |
| bun / encode-unicode | 10.85425 | 2.47424 | 0.226 | 0.167–0.306 |
| bun / decode-large | 3.80638 | 3.69346 | 1.031 | 0.850–1.250 |

The earlier two-pair [pilot data](results/pilot-01.json.gz) is also retained,
separately from both formal studies. No data was discarded or overwritten.

## Correctness and validation

- Type checking and 146 existing checkpoint/descriptor tests passed.
- Three fresh-process compatibility proofs passed: Node's runtime path, Bun's
  actual native path, and Bun with the native method disabled before import.
- The native proof compares its output against `Buffer` encoding on the exact
  input view range. The fallback is exercised independently in Node and Bun.
- The proofs cover sizes 0/1/2/3/31/32/33/1023/1024/1025/4096, special numbers,
  Unicode, nested collections, repeated snapshot references, old immutable
  values, writable restoration, shared/copy attachment, and malformed packets.
- The proof runs in a dedicated compatibility CI step. Full repository
  CI runs on the published PR; the local focused log is
  [focused-validation.log](results/focused-validation.log).
- [verify.py](verify.py) independently recomputes every subject median, paired
  estimate and interval, and checks workload equality, warm-up minima, output
  verification counts, source identity and driver identity. All three recordings
  pass; [verification results](results/verification.txt) are retained.

An independent source/method review found no change to checkpoint semantics and
confirmed that the isolated driver imports exactly one build/workload per
process. The gains are specific to engines offering the native encoder.

## Evidence and reproduction

Candidate `redux-checkpoint.ts` SHA256:
`23ea362f1ca20d6c6771527b8dd2fcf8c2b3d009ae0d53039f87c836240ebf7b`.

Primary [isolated driver](isolated.mjs) SHA256:
`7a736d514522615a8acaa1f6db48c7fd46cb17db61210df3e1e9cbf4e21e08fd`.

The [archive manifest](results/archive-manifest.json) records exact original and
compressed sizes/SHA256 hashes. All 2,131,121 original JSON bytes are retained in
423,816 gzip bytes, verified by lossless decompression. Both drivers remain:
[original driver](benchmark.mjs) and [isolated driver](isolated.mjs).

- [Isolated raw data](results/isolated-01.json.gz) and [process log](results/isolated-01.log).
- [First formal raw data](results/formal-01.json.gz) and [process log](results/formal-01.log).
- [Pilot raw data](results/pilot-01.json.gz) and [process log](results/pilot-01.log).

From this checkout, using the recorded Node/Bun versions:

```sh
git worktree add --detach ../zerocopy-checkpoint-before 09b1a385a7c2ac9b027a4055335ae2f9449abe6e
(cd ../zerocopy-checkpoint-before && bun install && bun run build:wasm && bun run build:browser)
bun install
bun run build:wasm
bun run build:browser
flock /tmp/zerocopy-checkpoint-perf.lock taskset -c 2 node proofs/checkpoint-base64-20261105/isolated.mjs ../zerocopy-checkpoint-before . "$(command -v bun)" /tmp/checkpoint-isolated-new.json formal
node --test proofs/checkpoint-base64-20261105/correctness.mjs
python3 proofs/checkpoint-base64-20261105/verify.py proofs/checkpoint-base64-20261105/results/pilot-01.json.gz proofs/checkpoint-base64-20261105/results/formal-01.json.gz proofs/checkpoint-base64-20261105/results/isolated-01.json.gz
```

Choose an allowed CPU on another host. Drivers refuse to overwrite an existing
recording. A new run records its own checkout and all bundle identities; the
archived studies retain their original measurement commit and source hashes.
