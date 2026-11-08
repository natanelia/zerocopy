# Large boolean List appends: measured results

Appending 262,144 booleans took **22.9% less time in Node and 39.0% less time in Bun**, using paired before/after estimates. Every one of the six process pairs favored the candidate in both runtimes. The corresponding after/before ratios were 0.771 [0.716, 0.831] and 0.610 [0.488, 0.762], with unadjusted 95% confidence intervals.

The evidence supports a scoped improvement to large boolean appends. It does **not** support a blanket claim that every other operation keeps identical performance. The Node number control estimated an 11.3% slowdown and Bun's 32,767-element boolean control estimated a 6.0% slowdown. Their intervals include no change, but the adverse estimates remain relevant. Several smaller Bun target cases are also inconclusive. Every row is included below.

## What changes

The JavaScript implementation in arena.ts specializes ordinary boolean arrays with at least 32,768 elements on little-endian hosts. It validates values into one-byte flags, then converts them directly into the final float64 slots with a native typed-array operation. Input getters finish before this path allocates or writes arena storage. Eligibility checks live in a separate helper; small boolean batches and other value types retain their existing encoding path.

Custom encoders, custom array mapping/species, invalid values, holes, reentrant getters, memory growth, alignment and real allocation failure are covered. Encoder changes made by input getters are observed without rereading the input; arbitrary numeric encoder outputs retain their original float64 values.

There is no public API, WASM binary or published storage-format change. The exact storage checks found **unchanged arena allocation and byte layout**. Temporary JavaScript heap allocation was not measured, so this is not a memory-saving claim.

## Provenance and method

The final records came from [GitHub Actions run 42496326065](https://github.com/natanelia/zerocopy/actions/runs/42496326065), [job 128779354371](https://github.com/natanelia/zerocopy/actions/runs/42496326065/job/128779354371), [artifact 13624401094](https://github.com/natanelia/zerocopy/actions/runs/42496326065/artifacts/13624401094).

| Item | Recorded value |
| --- | --- |
| Baseline commit | a4265a0608ec25eec5719496225212db6b251989 |
| Measured candidate commit | becc7f72ec6d78d41924fca88b476fa3ea5d2d06 |
| Runtimes | Node 24.22.1; Bun 1.4.2 |
| Host | Linux x64, Intel Xeon Platinum 8370C, 2.80 GHz |
| Affinity | CPU 0; all study processes serialized |
| Formal confirmation | 6 process pairs × 13 cases × 2 runtimes × 2 variants = 312 processes |
| Same-build A/A | 4 pairs × 4 cases × 2 runtimes × 2 variants = 64 processes |
| Final pilot | 2 pairs × 6 cases × 2 runtimes × 2 variants = 48 processes |
| Reference comparison | 3 processes × 4 cases × 2 runtimes × 3 implementations = 72 processes |
| Formal interval | 2026-11-08 15:46:19.936–15:54:18.891 UTC |

The complete public pushMany operation and retained-result assignment are timed, including validation, temporary storage, final value storage, tree linking and snapshot construction. Imports, fixture construction, per-batch arena reset, retention-array allocation and complete output verification are outside timing. Each batch repeatedly forks one immutable source using a dense input array. Separate source prefixes cover 31, 32 and 65 elements.

Each process gets at least eight warmup batches and 500 ms of warmup for confirmation/A/A, followed by nine measured batches. The pilot uses 150 ms. Fresh processes, a common lock, neutral import paths and alternating AB/BA order limit interference. Runtime and case order also reverse between pairs. All returned outputs and original published bytes are checked. No unfavorable samples or outliers are removed.

The estimate is the geometric mean of within-pair after/before ratios; confidence intervals use Student-t on those paired log ratios. Intervals are **unadjusted for multiple comparisons**, so borderline cases warrant caution. Displayed before/after times are medians of process medians; their quotient need not equal the paired ratio. Negative time changes mean improvement.

Raw data: [formal.json.gz](results/formal.json.gz), [aa.json.gz](results/aa.json.gz), [pilot-v2.json.gz](results/pilot-v2.json.gz), [reference-comparison.json.gz](results/reference-comparison.json.gz). [Hosted provenance](validation/hosted-provenance.json) records original and compressed hashes, exact archive membership and byte-round-trip checks. The downloaded ZIP SHA256 is 9ea14568e5ff6adaecc52f886f452076edc34a480a0db0cbe7a48d8559d78df6.

## Complete formal results

All six eligible Node cases favored the candidate in all six pairs. Their intervals fall below 1, although prefix 31 is borderline: its exact upper bound is 0.9983658. Bun has clear evidence for 262,144 elements and the 32-element-prefix case. Its empty-prefix 32,768/32,769 cases and 31-/65-element-prefix cases remain inconclusive at the stated confidence level.

### Node

| Case | Before, µs | After, µs | Paired time change | Ratio, 95% interval | Faster pairs |
| --- | ---: | ---: | ---: | --- | ---: |
| boolean-256-control | 3.336 | 3.363 | +1.4% | 1.014 [0.981, 1.047] | 2/6 |
| boolean-1024-control | 13.469 | 13.140 | -1.6% | 0.984 [0.949, 1.020] | 4/6 |
| boolean-32767-control | 707.297 | 714.000 | +2.3% | 1.023 [0.816, 1.283] | 3/6 |
| boolean-32768 | 611.876 | 464.782 | -22.7% | 0.773 [0.640, 0.934] | 6/6 |
| boolean-32769 | 708.051 | 463.168 | -27.1% | 0.729 [0.607, 0.876] | 6/6 |
| boolean-262144 | 4799.078 | 3821.946 | -22.9% | 0.771 [0.716, 0.831] | 6/6 |
| boolean-prefix-31 | 509.297 | 466.298 | -18.0% | 0.820 [0.673, 0.998] | 6/6 |
| boolean-prefix-32 | 513.232 | 463.934 | -9.5% | 0.905 [0.883, 0.928] | 6/6 |
| boolean-prefix-65 | 636.755 | 461.030 | -27.5% | 0.725 [0.717, 0.733] | 6/6 |
| number-control-1024 | 7.803 | 9.395 | +11.3% | 1.113 [0.989, 1.252] | 1/6 |
| string-control-256 | 8.301 | 8.271 | +0.1% | 1.001 [0.982, 1.019] | 3/6 |
| object-control-128 | 95.155 | 96.575 | -0.4% | 0.996 [0.877, 1.131] | 3/6 |
| scalar-boolean-push-control | 0.234 | 0.216 | -4.9% | 0.951 [0.917, 0.986] | 6/6 |

### Bun

| Case | Before, µs | After, µs | Paired time change | Ratio, 95% interval | Faster pairs |
| --- | ---: | ---: | ---: | --- | ---: |
| boolean-256-control | 6.216 | 6.239 | +0.3% | 1.003 [0.954, 1.054] | 1/6 |
| boolean-1024-control | 22.886 | 22.704 | -0.2% | 0.998 [0.959, 1.040] | 4/6 |
| boolean-32767-control | 518.735 | 529.807 | +6.0% | 1.060 [0.953, 1.179] | 0/6 |
| boolean-32768 | 530.710 | 456.733 | -14.6% | 0.854 [0.709, 1.028] | 5/6 |
| boolean-32769 | 524.656 | 510.122 | -12.8% | 0.872 [0.726, 1.048] | 6/6 |
| boolean-262144 | 4287.436 | 2879.805 | -39.0% | 0.610 [0.488, 0.762] | 6/6 |
| boolean-prefix-31 | 520.750 | 440.710 | -17.8% | 0.822 [0.667, 1.013] | 5/6 |
| boolean-prefix-32 | 516.130 | 381.604 | -20.3% | 0.797 [0.657, 0.966] | 5/6 |
| boolean-prefix-65 | 522.563 | 439.361 | -16.9% | 0.831 [0.678, 1.018] | 5/6 |
| number-control-1024 | 17.418 | 17.013 | -1.7% | 0.983 [0.929, 1.040] | 3/6 |
| string-control-256 | 7.479 | 7.351 | +1.2% | 1.012 [0.780, 1.313] | 4/6 |
| object-control-128 | 56.044 | 56.445 | -0.2% | 0.998 [0.924, 1.077] | 1/6 |
| scalar-boolean-push-control | 0.123 | 0.127 | +2.6% | 1.026 [0.956, 1.101] | 2/6 |

### Controls and limits on the claim

- **Node numbers:** ratio 1.1128 [0.9890, 1.2520], slower in five of six pairs. Three pairs were about 21–25% slower; the other three were approximately flat. The pilot was approximately flat, but that does not negate the formal result. This control has no demonstrated regression at the stated interval and also has no demonstrated equivalence.
- **Bun just below the threshold:** ratio 1.0601 [0.9533, 1.1789], slower in all six pairs. Five pairs were about 1–2% slower and one was 30.3% slower. The pilot also favored the baseline, with a 19.3% adverse estimate. The report does not discard that pair or call this control unchanged.
- **Other controls:** no control interval lies wholly above 1. The apparent 4.9% Node scalar-push gain is not attributed to this optimization; the scalar method was not changed. String/object and small-boolean rows remain in the table even where their intervals are wide.
- **Short batches:** 63 of 2,808 formal measured batches were below 2 ms. All were the Bun string control—30 before and 33 after, minimum 1.590 ms. No boolean target batch was below 2 ms. All samples were retained.
- **Scope:** these are measurements on one host and two runtime versions, with dense arrays and repeated immutable forks. They are not a guarantee for different engines, hardware, memory pressure, getter-heavy arrays or all application workloads. No Chromium timing claim is made.

## Same-build A/A results

All eight same-build intervals contain 1. They provide a noise check, not an equivalence proof. Node's 32,768-element A/A interval is particularly wide, which reinforces the caution around smaller or borderline gains.

| Runtime | Case | Paired ratio | 95% interval | A/B pairs favoring B |
| --- | --- | ---: | --- | ---: |
| node | boolean-1024-control | 0.999 | [0.925, 1.078] | 2/4 |
| node | boolean-32768 | 0.925 | [0.696, 1.229] | 2/4 |
| node | number-control-1024 | 1.003 | [0.970, 1.037] | 2/4 |
| node | scalar-boolean-push-control | 1.038 | [0.903, 1.193] | 1/4 |
| bun | boolean-1024-control | 1.006 | [0.924, 1.094] | 2/4 |
| bun | boolean-32768 | 0.988 | [0.923, 1.057] | 2/4 |
| bun | number-control-1024 | 0.989 | [0.897, 1.089] | 2/4 |
| bun | scalar-boolean-push-control | 1.002 | [0.968, 1.037] | 2/4 |

## Final pilot, all rows

The two-pair pilot is retained as a screening result. It is not pooled with the six-pair confirmation and has no reported confidence interval.

| Runtime | Case | Paired time change | After/before ratio | Faster pairs |
| --- | --- | ---: | ---: | ---: |
| node | boolean-1024-control | -4.2% | 0.958 | 2/2 |
| node | boolean-32767-control | -4.9% | 0.951 | 2/2 |
| node | boolean-32768 | -27.8% | 0.722 | 2/2 |
| node | boolean-32769 | -27.6% | 0.724 | 2/2 |
| node | boolean-262144 | -20.5% | 0.795 | 2/2 |
| node | number-control-1024 | +0.4% | 1.004 | 1/2 |
| bun | boolean-1024-control | +2.6% | 1.026 | 0/2 |
| bun | boolean-32767-control | +19.3% | 1.193 | 0/2 |
| bun | boolean-32768 | -27.9% | 0.721 | 2/2 |
| bun | boolean-32769 | -2.7% | 0.973 | 1/2 |
| bun | boolean-262144 | -35.7% | 0.643 | 2/2 |
| bun | number-control-1024 | +3.4% | 1.034 | 0/2 |

## Reference comparison, all cases

This secondary comparison uses the same boolean fixtures. SharedList.pushMany, Immutable.List.concat and one plain native source.concat each retain their result and preserve the original source. Native arrays are not frozen. Each estimate is the median of three independent process medians, with 250 ms/eight batches of warmup and nine measured batches; these comparisons have no confidence intervals.

Native concat is faster than SharedList in all eight measured contexts. SharedList is faster than Immutable.List in these contexts. These are different collection/storage contracts; the comparison is context rather than evidence for the before/after improvement. There are 84 reference batches below 2 ms, all native cases, with a minimum of 0.327 ms.

| Runtime | Case | SharedList, µs | Immutable.List, µs | Native concat, µs |
| --- | --- | ---: | ---: | ---: |
| node | boolean-1024-control | 11.354 | 45.427 | 0.734 |
| node | boolean-32768 | 457.845 | 1755.401 | 118.586 |
| node | boolean-262144 | 3695.371 | 16703.147 | 901.319 |
| node | boolean-prefix-65 | 460.870 | 2616.041 | 123.936 |
| bun | boolean-1024-control | 21.848 | 45.526 | 1.392 |
| bun | boolean-32768 | 495.515 | 1550.732 | 32.180 |
| bun | boolean-262144 | 2903.366 | 15106.798 | 2713.712 |
| bun | boolean-prefix-65 | 367.524 | 2554.697 | 35.126 |

## Correctness, storage and independent audit

| Check | Outcome |
| --- | --- |
| Hosted WASM, portable and declaration builds | Passed |
| Hosted source and typed-value checks | Passed |
| Focused Node regression suite | 73 tests passed across 3 files |
| Focused Bun regression suite | 73 tests passed across 3 files |
| Before/after workload smoke | All 13 cases passed in both runtimes; complete results and retained sources checked |
| Exact arena storage | 36 before/after pairs per runtime; allocations, descriptors and all payload bytes identical |
| Real Chromium | Passed in Chromium 153.0.8010.12 with cross-origin isolation |
| Shared worker attachment | 215,182 retained-value reads during writer activity; paused iterator, read-only rejection and complete outputs verified |
| Copied worker attachment | 207,522 retained-value reads during writer activity; the same checks passed |
| Actual writer growth in both browser cases | 393,216 to 2,752,512 bytes; original published bytes preserved |
| Formal output verification | 71,698,128 returned outputs checked across warmup/measured batches |
| A/A output verification | 45,163,616 returned outputs checked across warmup/measured batches |
| Exact source/build audit | Passed for final pilot/formal candidate and A/A baseline, both on the runner and after lossless ingestion |
| Independent audit | All 496 final hosted processes checked: schedule, fixtures, source/build hashes, medians, paired ratios, intervals and reference summaries |

[Hosted browser details](validation/hosted/browser.json), [Node allocation details](validation/hosted/allocation-node.json), [Bun allocation details](validation/hosted/allocation-bun.json), [hosted formal audit](validation/hosted/audit-formal.json), [local exact formal audit](validation/audit-local-formal.json), [independent review](validation/independent-review.json) and its [reproducible checker](validation/independent-review.py) are retained. The successful hosted job links above retain the build/type/test step logs.

Local Chromium could not start because the environment denied a socket. That startup failure was not counted as a test pass; the hosted browser proof supplies the actual browser validation. The proof uses SharedList.values() for paused iteration.

These checks cover this change's behavior and preserved format. They do not claim that every repository test, every browser engine or every consumer application was tested.

## Historical CI and reproduction

The final workflow collects no new timings and removes the temporary feature-branch trigger. Current-checkout CI still builds the package, checks source/value types, runs focused Node/Bun tests, validates all workload oracles and runs Chromium workers.

Historical evidence is audited against its measured version. CI reads formal.source.after.commit from the plain or compressed record, creates a detached worktree at that commit, installs its dependency versions, rebuilds it and checks exact source/WASM/bundle hashes. A/A uses the pinned baseline. Historical fixture/arena-byte checks use those two recorded builds, allowing later Map/List improvements to evolve the current code. Main, relevant pull requests and manual dispatch remain enabled; raw evidence and validation output are uploaded even on failure.

From a full repository checkout, use Node 24.22.1 and Bun 1.4.2. Create fresh detached checkouts for the two measured commits and finish all builds before collecting timings:

~~~sh
set -euo pipefail
proof="$PWD/proofs/list-boolean-encoding-20261108"
reproduction_dir="$(mktemp -d -t zerocopy-boolean-XXXXXX)"
baseline_checkout="$reproduction_dir/baseline"
recorded_candidate="$reproduction_dir/candidate"
git worktree add --detach "$baseline_checkout" a4265a0608ec25eec5719496225212db6b251989
git worktree add --detach "$recorded_candidate" becc7f72ec6d78d41924fca88b476fa3ea5d2d06
for checkout in "$baseline_checkout" "$recorded_candidate"; do
  (
    cd "$checkout"
    bun install
    bun run build:wasm
    bun run build:browser
  )
done
~~~

Audit the retained records and complete workload outputs without timing. The verifier accepts .json.gz directly or tries it automatically when the requested .json is absent. The independent Python checker requires SciPy and writes a fresh output file:

~~~sh
node "$proof/verify.mjs" "$proof/results/formal.json" "$recorded_candidate"
node "$proof/verify.mjs" "$proof/results/aa.json" "$baseline_checkout"
node "$proof/smoke.mjs" "$baseline_checkout" "$recorded_candidate"
node "$proof/allocation.mjs" "$baseline_checkout" "$recorded_candidate"
python "$proof/validation/independent-review.py" \
  "$proof/results" "$recorded_candidate" "$reproduction_dir/independent-retained-audit.json"
~~~

To collect a new pilot, six-pair formal confirmation, four-pair A/A and reference comparison, continue in the same shell on Linux. Each command uses one allowed CPU and a new output path:

~~~sh
benchmark_bun="$(command -v bun)"
benchmark_cpu="$(node -e 'const fs = require("node:fs"); const allowed = fs.readFileSync("/proc/self/status", "utf8").match(/^Cpus_allowed_list:\s*(\d+)/m); if (!allowed) process.exit(1); process.stdout.write(allowed[1]);')"
mkdir "$reproduction_dir/results"
taskset -c "$benchmark_cpu" node "$proof/paired-benchmark.mjs" \
  "$proof/workloads.mjs" "$baseline_checkout" "$recorded_candidate" \
  "$benchmark_bun" "$reproduction_dir/results/pilot-v2.json" pilot
taskset -c "$benchmark_cpu" node "$proof/paired-benchmark.mjs" \
  "$proof/workloads.mjs" "$baseline_checkout" "$recorded_candidate" \
  "$benchmark_bun" "$reproduction_dir/results/formal.json" formal
taskset -c "$benchmark_cpu" node "$proof/paired-benchmark.mjs" \
  "$proof/workloads.mjs" "$baseline_checkout" "$recorded_candidate" \
  "$benchmark_bun" "$reproduction_dir/results/aa.json" aa
taskset -c "$benchmark_cpu" node "$proof/compare.mjs" \
  "$recorded_candidate" "$benchmark_bun" "$reproduction_dir/results/reference-comparison.json" measure
node "$proof/verify.mjs" "$reproduction_dir/results/formal.json" "$recorded_candidate"
node "$proof/verify.mjs" "$reproduction_dir/results/aa.json" "$baseline_checkout"
python "$proof/validation/independent-review.py" \
  "$reproduction_dir/results" "$recorded_candidate" "$reproduction_dir/independent-new-audit.json"
~~~

The runners take their common benchmark lock themselves; do not wrap them in another lock on the same file. Run the commands serially, with no builds, tests or other benchmarks active. They refuse to overwrite an existing study. The Chromium correctness proof can be run separately after installing Playwright's Chromium browser:

~~~sh
node "$proof/browser.mjs" "$recorded_candidate"
~~~

Primary records are gzip-compressed with a zero timestamp and exact byte-round-trip checks; no JSON fields were rewritten. Small allocation/smoke records remain plain JSON. The [first exploratory pilot](results/pilot.json.gz), its [source](exploration/arena-v1.ts) and [workload](exploration/workloads-v1.mjs) remain available. That earlier candidate used a 256-element threshold and is not part of the final claim. Its poor small-batch results motivated the conservative 32,768-element threshold and separated guard helper.

### First exploratory pilot, retained without pooling

| Runtime | Case | Paired time change | After/before ratio | Faster pairs |
| --- | --- | ---: | ---: | ---: |
| node | boolean-255-control | +10.7% | 1.107 | 0/2 |
| node | boolean-256 | +81.2% | 1.812 | 0/2 |
| node | boolean-1024 | +39.8% | 1.398 | 0/2 |
| node | boolean-32768 | -27.0% | 0.730 | 2/2 |
| node | boolean-262144 | -18.6% | 0.814 | 2/2 |
| node | number-control-1024 | +14.5% | 1.145 | 0/2 |
| bun | boolean-255-control | -1.2% | 0.988 | 2/2 |
| bun | boolean-256 | -20.4% | 0.796 | 2/2 |
| bun | boolean-1024 | -3.5% | 0.965 | 1/2 |
| bun | boolean-32768 | -8.0% | 0.920 | 1/2 |
| bun | boolean-262144 | -24.7% | 0.753 | 2/2 |
| bun | number-control-1024 | +20.6% | 1.206 | 0/2 |
