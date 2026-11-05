# Inline worker constructor dispatch

## Result and scope

Inlining the twelve ordered `instanceof` checks in `getWorkerData` reduces the cost of exporting the measured wide records. Both primary fixtures were faster in **all six fresh process pairs on Node and Bun**, with paired 95% intervals excluding parity:

- 128-entry mixed record: **22.4% less time on Node**, **24.8% on Bun**.
- 128-entry late-type record: **51.3% less time on Node**, **43.0% on Bun**.

The mixed record cycles through twelve populated collection instances; the late-type record repeats one populated `SharedPriorityQueue`. Both are frozen records containing named aliases. The timed operation is the complete public `getWorkerData(input, options)` call with its output retained. Worker transport correctness is checked separately.

**Single-record performance remains inconclusive.** Node's single shared-map export has a +14.3% paired point estimate, with a time-change interval of −13.7% to +51.6%. Bun's single copied-map export is +8.6%, with an interval of −8.9% to +29.6%. Each was faster in 2/6 formal pairs. These measurements do not establish either a regression or equivalence. This report does not claim universal speedups or absence of regressions for every input.

## Change and compatibility

`shared.ts` replaces `constructorEntries.find` with direct conditional checks inside the existing serialization loop. The exact registry order and dynamic `Symbol.hasInstance` behavior remain intact. The same instance's dynamic `toWorkerData()` is still called once per named entry; subclass recognition, errors, alias metadata, arena collection and wire version 4 remain compatible.

Baseline: `0ca99c1da67e4d3e36e098b3f0e85d392c9c1d5e`. Only `shared.ts` differs in the measured runtime source. Every WASM file is identical. Exact [baseline](source-snapshots/baseline-shared.ts), [rejected helper V1](source-snapshots/helper-v1-shared.ts) and [inline V2](source-snapshots/inline-v2-shared.ts) source overlays are retained and checked against the recordings. Candidate working-tree changes were uncommitted during measurement; stored source hashes and full snapshots identify the exact code independently of checkout HEAD.

## Complete V2 formal results

Before/after columns are medians of the six per-process estimates. The paired ratio is the geometric mean of six matched after/before ratios; it need not equal the ratio of the displayed medians. Time change is `(paired ratio − 1) × 100`. Intervals are unadjusted Student-t 95% intervals on the six paired log ratios; the nine batches inside each process are not treated as independent process pairs.

| Runtime | Case | Before µs | After µs | Paired ratio (95% CI) | Time change | Faster pairs |
|---|---|---:|---:|---|---:|---:|
| node | `mixed-128-shared` | 67.284 | 55.468 | 0.776 [0.681, 0.885] | -22.4% | 6/6 |
| node | `late-128-shared` | 77.729 | 41.744 | 0.487 [0.388, 0.610] | -51.3% | 6/6 |
| node | `mixed-128-copied` | 383.630 | 327.622 | 0.773 [0.592, 1.010] | -22.7% | 5/6 |
| node | `late-128-copied` | 93.075 | 48.463 | 0.543 [0.403, 0.732] | -45.7% | 6/6 |
| node | `early-map-128-control` | 37.727 | 34.776 | 0.905 [0.808, 1.013] | -9.5% | 6/6 |
| node | `small-four-control` | 3.916 | 2.429 | 0.694 [0.485, 0.993] | -30.6% | 5/6 |
| node | `single-map-shared` | 0.987 | 1.063 | 1.143 [0.863, 1.516] | +14.3% | 2/6 |
| node | `single-late-shared` | 1.308 | 1.082 | 0.862 [0.744, 0.999] | -13.8% | 5/6 |
| node | `single-map-copied` | 12.987 | 12.679 | 0.899 [0.559, 1.447] | -10.1% | 4/6 |
| bun | `mixed-128-shared` | 37.641 | 28.144 | 0.752 [0.651, 0.869] | -24.8% | 6/6 |
| bun | `late-128-shared` | 38.749 | 21.545 | 0.570 [0.411, 0.791] | -43.0% | 6/6 |
| bun | `mixed-128-copied` | 119.443 | 115.741 | 0.918 [0.706, 1.193] | -8.2% | 3/6 |
| bun | `late-128-copied` | 56.956 | 27.550 | 0.573 [0.362, 0.906] | -42.7% | 5/6 |
| bun | `early-map-128-control` | 33.571 | 20.943 | 0.656 [0.560, 0.768] | -34.4% | 6/6 |
| bun | `small-four-control` | 2.827 | 1.829 | 0.663 [0.554, 0.794] | -33.7% | 6/6 |
| bun | `single-map-shared` | 1.248 | 1.153 | 0.896 [0.827, 0.970] | -10.4% | 6/6 |
| bun | `single-late-shared` | 1.426 | 1.316 | 0.883 [0.665, 1.171] | -11.7% | 3/6 |
| bun | `single-map-copied` | 9.225 | 10.938 | 1.086 [0.911, 1.296] | +8.6% | 2/6 |

The Node early-map control that was inconsistent in the V2 pilot improved in 6/6 formal pairs (aggregate −9.5%, interval includes parity). The two positive formal control estimates above remain visible in full; neither was dropped or retimed.

### Remaining control pairs

| Control | Formal after/before ratios, in pair order | Faster pairs | V2 pilot |
|---|---|---:|---|
| Node `single-map-shared` | 1.179625, 1.905543, 0.984399, 1.028997, 0.887950, 1.104989 | 2/6 | 0.937443, 0.627410; 2/2 faster; aggregate 0.766917 |
| Bun `single-map-copied` | 0.952396, 0.914394, 1.448339, 1.173788, 1.098121, 1.010265 | 2/6 | Not in the declared pilot matrix |

## Method

- Node 24.22.1 and Bun 1.4.2 on AMD EPYC 9V74 80-Core Processor, Linux x64, CPU affinity 2. The common `/tmp/zerocopy-performance.lock` is held for each complete recording; other local heavy work was paused.
- One build and case per fresh process, with the same neutral import path for both portable bundles. AB/BA order alternates by pair; runtime and case order also reverse.
- Formal: six process pairs, at least 500 ms of timed warmup and eight warmup batches per process, then nine measured batches. The pilot has two pairs and 150 ms warmup; A/A has four pairs and 500 ms warmup.
- All output payloads are retained until complete checks after the timed batch: exact names, types, descriptor fields, arena order/identity, freeze state and every copied byte. Published source bytes and used sizes are checked between batches. Expected types come from declared fixtures; data fields come from each collection's serializer. Random arena IDs are checked exactly within a process and normalized to first-seen indices for cross-process hashes.
- Imports, fixture/oracle construction, the retention array allocation and full verification are outside timing. Workloads are repeated exports of existing snapshots. All samples, warmups, slowdowns and batches below 2 ms remain in the recordings; there is no per-build calibration, filtering or A/A subtraction.

The original nine-case matrix and gates were unchanged between helper V1 and inline V2. Primary gates were a meaningful ≥10% paired reduction on both runtimes with intervals excluding parity; control regressions and uncertainty were reviewed separately and are disclosed above.

## Same-build diagnostics

Both sides of each A/A pair run the exact baseline. These recordings show fresh-process variation and are not estimates of the candidate's effect.

| Runtime | Case | Before µs | After µs | Paired ratio (95% CI) | Time change | Faster pairs |
|---|---|---:|---:|---|---:|---:|
| node | `mixed-128-shared` | 77.695 | 76.313 | 1.051 [0.874, 1.263] | +5.1% | 1/4 |
| node | `late-128-shared` | 96.586 | 107.186 | 1.221 [0.971, 1.537] | +22.1% | 1/4 |
| node | `single-map-shared` | 0.949 | 1.238 | 1.305 [0.922, 1.845] | +30.5% | 0/4 |
| bun | `mixed-128-shared` | 58.920 | 39.656 | 0.761 [0.428, 1.355] | -23.9% | 3/4 |
| bun | `late-128-shared` | 42.199 | 47.589 | 1.097 [0.998, 1.206] | +9.7% | 0/4 |
| bun | `single-map-shared` | 1.329 | 1.217 | 0.899 [0.511, 1.580] | -10.1% | 3/4 |

One additional early-map-only A/A recording was [predeclared](predeclared-early-aa.md) while the formal run was still in progress, because that exact disputed pilot control was absent from the original A/A subset. The [full alternate workload](workloads-early-aa.mjs) differs only in `aaCases`. The original formal and A/A scopes remain unchanged.

| Runtime | Case | Before µs | After µs | Paired ratio (95% CI) | Time change | Faster pairs |
|---|---|---:|---:|---|---:|---:|
| node | `early-map-128-control` | 36.866 | 35.429 | 0.948 [0.796, 1.128] | -5.2% | 2/4 |
| bun | `early-map-128-control` | 29.835 | 28.143 | 0.919 [0.553, 1.529] | -8.1% | 3/4 |

These diagnostic intervals do not prove the unresolved controls equivalent. No candidate effect was adjusted using A/A, and there was no additional A/B timing run after the frozen formal study.

## Pilot history, including the rejected version

### V1: helper function — rejected

The first version put the same direct checks in a helper. Its Bun early-map and single-map controls were consistently slower across both pairs, so it received no formal run and is not the shipped implementation. Its exact source and all evidence are retained.

| Runtime | Case | Before µs | After µs | Paired ratio (95% CI) | Time change | Faster pairs |
|---|---|---:|---:|---|---:|---:|
| node | `mixed-128-shared` | 93.292 | 71.683 | 0.721 | -27.9% | 2/2 |
| node | `late-128-shared` | 91.181 | 62.729 | 0.689 | -31.1% | 2/2 |
| node | `early-map-128-control` | 60.876 | 40.452 | 0.659 | -34.1% | 2/2 |
| node | `small-four-control` | 4.729 | 3.823 | 0.796 | -20.4% | 2/2 |
| node | `single-map-shared` | 1.590 | 1.529 | 0.960 | -4.0% | 1/2 |
| bun | `mixed-128-shared` | 43.724 | 38.121 | 0.876 | -12.4% | 2/2 |
| bun | `late-128-shared` | 45.757 | 43.724 | 0.940 | -6.0% | 1/2 |
| bun | `early-map-128-control` | 31.813 | 37.862 | 1.181 | +18.1% | 0/2 |
| bun | `small-four-control` | 3.311 | 2.294 | 0.691 | -30.9% | 2/2 |
| bun | `single-map-shared` | 1.486 | 2.067 | 1.392 | +39.2% | 0/2 |

### V2: checks in the existing loop

This one structural follow-up removes the helper call; it uses the identical workload and driver. Its primary wins justified formal confirmation. The conflicting Node early-map pilot pairs (0.795 and 1.525) prompted the disclosed same-build diagnostic, without filtering either sample.

| Runtime | Case | Before µs | After µs | Paired ratio (95% CI) | Time change | Faster pairs |
|---|---|---:|---:|---|---:|---:|
| node | `mixed-128-shared` | 76.293 | 54.809 | 0.718 | -28.2% | 2/2 |
| node | `late-128-shared` | 81.269 | 49.723 | 0.592 | -40.8% | 2/2 |
| node | `early-map-128-control` | 36.544 | 40.676 | 1.101 | +10.1% | 1/2 |
| node | `small-four-control` | 3.471 | 2.350 | 0.691 | -30.9% | 2/2 |
| node | `single-map-shared` | 1.285 | 0.968 | 0.767 | -23.3% | 2/2 |
| bun | `mixed-128-shared` | 52.108 | 32.052 | 0.626 | -37.4% | 2/2 |
| bun | `late-128-shared` | 52.909 | 31.300 | 0.592 | -40.8% | 2/2 |
| bun | `early-map-128-control` | 38.244 | 31.980 | 0.836 | -16.4% | 2/2 |
| bun | `small-four-control` | 3.680 | 2.077 | 0.566 | -43.4% | 2/2 |
| bun | `single-map-shared` | 1.342 | 1.223 | 0.907 | -9.3% | 2/2 |

## Correctness and compatibility checks

- Portable build and `tsc --noEmit` pass. Candidate focused worker-dispatch, worker-record and worker-attachment tests pass **41/41 on Node and Bun**.
- The **11 new tests also pass unchanged on the pinned baseline on both runtimes**. They cover all twelve populated types, all twelve subclasses, shared/copied round trips, aliases, exact hook/proxy trap order, changed first matches, serializer getters/overrides/errors and unchanged source bytes. The [exact tested file](source-snapshots/worker-constructor-dispatch.test.ts.txt) is archived.
- All nine public-operation workloads pass complete output/invariant comparisons against baseline on both runtimes via [smoke.mjs](smoke.mjs).
- The [actual Node worker proof](compatibility/node-worker.json) passes all twelve types, nested references, at least 10,000 concurrent reads, shared backing, repeated attachment and retained roots after growth/reset.
- [Chromium 153.0.8010.0 checks](compatibility/browser.json) use real workers with shared and copied transport, numeric/boolean stack and offset-queue roots after edits/growth, checkpoint maps and read-only behavior. These are correctness checks, not browser performance measurements.
- [Compatibility metadata](compatibility/validation.json) records commands and source/driver hashes; baseline test logs are in `compatibility/`. Existing unrelated full-suite Node raw-TypeScript worker import failures and the interrupted baseline Bun full run were reported separately; no full-suite pass is claimed here.

## Evidence and reproduction

[manifest.json](manifest.json) records compressed and uncompressed hashes, exact source overlay relationships and proof artifact hashes. Five gzip records retain **360 processes and 3,240 measured batches**, including all warmups and every adverse observation:

| Recording | Scope | Processes | Measured batches |
|---|---|---:|---:|
| [pilot-01.json.gz](pilot-01.json.gz) | Rejected helper V1 | 40 | 360 |
| [pilot-02.json.gz](pilot-02.json.gz) | Inline V2 pilot | 40 | 360 |
| [formal-01.json.gz](formal-01.json.gz) | Inline V2, all nine cases | 216 | 1,944 |
| [aa-01.json.gz](aa-01.json.gz) | Original same-build subset | 48 | 432 |
| [aa-early-01.json.gz](aa-early-01.json.gz) | Predeclared exact early-map control | 16 | 144 |

Console logs are retained beside the archives. `verify.py` independently checks raw hashes, build identities, full source snapshots, matching fixtures, every sample count and the paired arithmetic. `verify-package.py` additionally checks physical source overlays, proof-file hashes, the unchanged alternate A/A scope and predeclaration timing. CI runs this archival verification without rerunning benchmarks:

```sh
python3 proofs/worker-constructor-dispatch-20261105/verify-package.py
```

To reproduce timings, create separate clean checkouts at the pinned baseline. Use Node 24.22.1, Bun 1.4.2 and the pinned package dependencies. In the candidate checkout, **overlay the version being reproduced before building**: `source-snapshots/helper-v1-shared.ts` for V1 or `source-snapshots/inline-v2-shared.ts` for V2, copied verbatim to `shared.ts`. This is necessary because the current runtime is V2; a V1 filename alone does not recreate the rejected source. Build baseline and that overlaid candidate using `node scripts/build-wasm.mjs` and `bun scripts/build-browser.ts`.

From the proof checkout, supply absolute checkout paths and a new output filename. Choose an available CPU; do not wrap the driver in another flock for its lock path.

```sh
taskset -c 2 node proofs/worker-constructor-dispatch-20261105/paired-benchmark.mjs \
  proofs/worker-constructor-dispatch-20261105/workloads.mjs \
  /absolute/baseline /absolute/overlaid-candidate /absolute/bun \
  /absolute/new-formal.json formal
```

Use `pilot` or `aa` in place of `formal` for those fixed modes. For the exact extra A/A control only, use `workloads-early-aa.mjs` and mode `aa`. The driver rejects dirty baseline source, undeclared source differences, changed WASM, changed workload/driver files during a recording and an existing output path.
