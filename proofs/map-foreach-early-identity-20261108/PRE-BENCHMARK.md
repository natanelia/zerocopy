# Map traversal: early identity confirmation plan

This is a fresh study of the Map candidate after correcting when the native `Arena.leaves` identity is captured. The direct `SharedMap.forEach` traversal algorithm is unchanged from the earlier candidate, but its guard now uses an identity captured when `arena.ts` initializes. The separate integration regression covers a prototype hook installed before the Map module loads, including the public optional numeric entry point's import order.

No pilot is planned: the change corrects the guard's initialization order. The ten workload cases, public operations, repetitions, fixtures, output checks, and invariant checks are copied unchanged from `proofs/map-foreach-20261108/workloads.mjs`. Only study metadata changes. The old workload, worker scripts, fixtures, raw recordings, and V2 performance claims remain intact and are not pooled with this study. `source-adaptation.json` records the copied module/driver/fixture hashes and the unchanged `createWorkload` body.

## Source and output identities

The baseline remains `0ac8a005268335a6116f025e75f670b5cee6843e`. The declared changed runtime sources are exactly `arena.ts` and `shared-map.ts`; `changedWasm` is empty. The coordinator verifies the baseline against Git, captures both changed-source snapshots and all runtime/configuration/build identities, and requires every compiled WASM file to match between builds.

The study ID is `map-foreach-early-identity-20261108`. `workloads.mjs` is self-contained. `paired-benchmark.mjs` is copied byte-for-byte from the latest List numeric study's generic runner. Production sources, portable bundles, runner, and workload must remain frozen throughout each recording. A failed or adverse recording is preserved, and output files are never overwritten.

## Fixed schedule

| Case | Public operation | Repetitions per batch |
| --- | --- | ---: |
| `number-4096` | Numeric `forEach`, 4,096 entries | 64 |
| `number-65536` | Numeric `forEach`, 65,536 entries | 8 |
| `number-overlay-4096` | Numeric `forEach` after updates, deletion, and insertion | 64 |
| `number-64` | Numeric `forEach`, 64 entries | 2,048 |
| `boolean-4096` | Boolean `forEach`, 4,096 entries | 64 |
| `string-1024` | String `forEach`, 1,024 entries | 128 |
| `json-256` | JSON `forEach`, 256 entries | 256 |
| `unicode-4096` | Numeric `forEach` with Unicode keys, 4,096 entries | 64 |
| `entries-4096` | Existing `entries` scan, 4,096 entries | 64 |
| `get-4096` | Existing indexed `get` scan, 4,096 keys | 128 |

Confirmation uses all ten cases with six fresh process pairs per case and runtime: 10 × 6 × 2 builds × 2 runtimes, or 240 planned subjects. The separate baseline-versus-baseline A/A diagnostic uses `number-4096`, `string-1024`, `entries-4096`, and `get-4096`, with four pairs: 4 × 4 × 2 labels × 2 runtimes, or 64 planned subjects. The workload declares `pilotCases: []`, so the generic runner cannot accidentally collect a pilot for this plan.

Node 24.22.1 and Bun 1.4.2 run serially on CPU 2 under `/tmp/zerocopy-perf-20261108.lock`. The runner acquires the lock itself. Every build/runtime/case/pair runs in a fresh process from the same neutral public import path. Pair order alternates AB/BA, and runtime/case order reverses on alternate pairs.

Every subject performs at least 500 ms of timed-operation warmup and at least eight warmup batches, then records nine measured batches. Repetitions stay fixed. All batches, including those below 2 ms, remain included and explicitly counted. No optional builds, tests, or competing benchmark work may overlap recording.

## Timed work and correctness checks

The timed operation scans a fixed immutable map with a reusable callback that consumes every key length and value. It returns the resulting checksum plus callback count; the runner retains and verifies every returned number. Construction, imports, oracle creation, output-array allocation, and invariant checks are outside timing. This measures warmed repeated scans, not construction or cold-start performance.

After every batch, the workload compares the complete `forEach` key/value/order sequence with its fixed expected sequence, compares the complete `entries` sequence, checks the arena's used-byte count, and compares all originally published bytes. Initial expected membership and values are also checked against a native JavaScript Map. These complete comparisons are outside the timed callback; the report must not describe them as running inside each timed scan.

The existing `entries` and `get` controls retain their original bodies. Their invariant checks still invoke the changed `forEach` outside the timer, so they are mixed workloads with possible carryover into later timing. Source identity alone does not establish unchanged performance. Every control estimate, unfavorable pair, and inconclusive interval must be reported without correction or selective omission.

## Estimates and decisions

For each process, use the median of its nine batch times divided by repetitions. For each case/runtime, report the geometric mean of paired after/before ratios and an unadjusted 95% Student-t interval on the paired log ratios. The process pair is the statistical unit. The before/after medians need not divide to the reported paired ratio.

A/A describes identical-baseline repeatability. Its results are separate: never subtract them from A/B, normalize by them, or use them to cancel an adverse result. Report all 20 confirmation rows and all eight A/A rows. The corrected source's performance claims must come from this fresh recording, even though the traversal algorithm was measured earlier. There are no browser performance measurements or peak-memory claims in this study.

## Real worker proofs and record interface

`worker-fixtures.mjs` is copied byte-for-byte from the earlier Map proof. It exercises numeric special values and full-hash collisions, Unicode/string keys and values, frozen JSON, nested lists, reentrant callbacks, forks, memory growth, retained snapshots, read-only attachments, and published-byte preservation. A worker pauses inside a callback while the owner grows memory, then resumes and reads both old and newly attached roots. Both shared and copied transports must pass.

Save the new Node result as `node-worker-result.json`. Each Node/browser record contains `sources` mapping both `arena.ts` and `shared-map.ts` to SHA-256 hashes; `wasm` mapping every root WASM filename to its hash; `bundles` mapping every portable JavaScript filename to its hash; `driver` and `fixtures` hashes; runtime versions and date; and `timingMeasurements: false`. Source/build identities are checked again after the proof completes.

The existing fixture protocol is unchanged: each transport's first result is `{ type: 'scanned', ok: true, count: 1067 }`; its second result confirms retained snapshots, new roots after growth, read-only guards, all value types, and published bytes. Browser results additionally include the Chromium version and `crossOriginIsolated: true`. Browser outcomes are reported only after actual execution; Node correctness does not establish a browser pass. These worker proofs complement the dedicated late-import regression rather than replacing it.

## Commands and artifact names

After builds and correctness preflight, the root coordinator will collect new files:

```sh
node proofs/map-foreach-early-identity-20261108/check-workloads.mjs \
  /path/to/baseline /path/to/candidate
bun proofs/map-foreach-early-identity-20261108/check-workloads.mjs \
  /path/to/baseline /path/to/candidate

taskset -c 2 node proofs/map-foreach-early-identity-20261108/paired-benchmark.mjs \
  proofs/map-foreach-early-identity-20261108/workloads.mjs \
  /path/to/baseline /path/to/candidate /path/to/bun \
  /path/to/new/confirmation.json formal

taskset -c 2 node proofs/map-foreach-early-identity-20261108/paired-benchmark.mjs \
  proofs/map-foreach-early-identity-20261108/workloads.mjs \
  /path/to/baseline /path/to/candidate /path/to/bun \
  /path/to/new/aa.json aa

node proofs/map-foreach-early-identity-20261108/node-worker.mjs
node proofs/map-foreach-early-identity-20261108/browser-check.mjs
```

Record raw timing output in `confirmation.json` and `aa.json`, preserving their stdout separately. Publication may losslessly compress them to `results/confirmation.json.gz` and `results/aa.json.gz` with a hash/length manifest. The independent auditor and verifier recompute the estimates, check all schedules and identities, and bind the final worker evidence without retiming. No result is claimed by this predeclared plan.
