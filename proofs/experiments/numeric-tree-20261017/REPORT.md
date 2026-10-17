# Grouped numeric tree scans

## Status

Stage 3 is a draft candidate. Its first full Node and Bun runs did not pass
the fixed performance gate. The large range scans improved, but two small
cases failed. The fixed identical-source diagnostic also failed in all
four runs. The raw failures remain part of this report. The candidate
has no performance clearance.

The comparison base is `afdffdcfcbd61013f120de82411c0c4a6b2d1e0e`. All local
measurements in this report used an Intel Xeon Platinum 8573C, x64, on
17 October 2026. The runtimes were Node.js 22.23.2 and Bun 1.4.2. These are
shared-host results. They do not establish ARM64 or browser performance.

## Change

The existing SIMD range kernel compares two binary64 values at a time.
Before this change, the tree scan calls the span kernel for each full
32-value leaf. Each call creates vector bounds, accumulates two counts,
and reduces those counts to one integer.

Stage 3 scans a group of sibling leaves in their parent call. It creates
the vector bounds once for the group and reduces the count once after the
group. The group contains at most 32 leaves, or 1,024 values. Counts and
bounds stay in local values. The scan writes no shared memory.

This path runs only in the SIMD build at tree depth one. Its input count
is a multiple of 32: the exported function sends only the full-leaf tree
prefix into tree traversal. Higher levels preserve that boundary. The
tail still uses the existing span kernel, including its scalar final
value when the tail has odd length.

The comparison operators remain `>=` and `<=`. A NaN value does not count.
NaN bounds and reversed bounds still return zero at the existing export.
Positive and negative zero compare equally. Infinity and subnormal values
keep their existing comparison results. The function signatures, binary
layout, public API, allocation paths, and snapshot ownership do not change.

The stage-3 scalar Wasm file equals the baseline byte for byte. In the
SIMD module, only the `treeCount` function body changes, from 96 to 229
bytes. The span, exported range, tree-box, and exported point-count bodies
are identical to their baseline bodies. Types, imports, function
signatures, and exports also have identical section bytes. This byte
comparison does not establish equal native code placement in a runtime.
See [the Wasm body audit](results/stage3-wasm-bodies.json).

## Stages and observed results

Stages 1 and 2 used five warm-up rounds, 11 measured rounds, and four
million requested values of work per batch. Stage 1 measured the direct
kernels. Stage 2 also measured the public wrappers. These were screens,
not acceptance runs.

| Stage | Change | Large-case result | Decision |
| --- | --- | --- | --- |
| 1 | Pass vector bounds and a vector count through recursive tree calls; reduce at the export | Direct SIMD range ratios: 1.081–1.248 on Node; 0.859–0.959 on Bun | Keep the evidence. Investigate the recursive vector-call cost. |
| 2 | Scan sibling leaves together, with vector recursion above that group | Public range ratios: 1.156–1.351 on Node; 1.052–1.181 on Bun | Keep the grouping. Restore the original integer recursion and small-span path. |
| 3 | Keep vector state inside each sibling group; retain the original export, span kernel, and integer recursion | Public range ratios: 1.302–1.546 on Node; 1.249–1.348 on Bun | Keep the candidate as a draft. Diagnose the failed small controls before acceptance. |

Here, a large case has at least 1,024 values. A ratio is baseline elapsed
time divided by candidate elapsed time. A ratio above one means the
candidate completed the measured work sooner. These ranges describe the
recorded runs; they are not confidence intervals or a performance promise.
The apparent recursive-call cost is a working explanation. No runtime
profile in this report proves that explanation.

## First full stage-3 comparison

The full comparison used seven warm-up rounds and 21 measured rounds.
Each batch requested eight million values of work. The call count was
`min(1_000_000, max(8, ceil(8_000_000 / size)))`. Each process ran both
variants, in alternating order. Allocation, imports, initial compilation,
input preparation, and result checks were outside the timed region.
Every timed batch result was checked after its timer stopped.

The fixed gate requires a ratio of at least 0.95 in every case. Direct
SIMD range and public range cases with at least 1,024 values must exceed
1.05. Scalar range calls and point-count calls serve as regression
controls. The complete files include every measured case and sample.

| Values | Node public range ratio | Bun public range ratio |
| ---: | ---: | ---: |
| 1 | 1.003 | 0.500 |
| 2 | 1.020 | 1.005 |
| 31 | 1.023 | 1.026 |
| 32 | 1.044 | 0.975 |
| 33 | 0.979 | 1.142 |
| 1,024 | 1.409 | 1.269 |
| 1,057 | 1.546 | 1.348 |
| 32,768 | 1.428 | 1.304 |
| 32,801 | 1.398 | 1.277 |
| 262,144 | 1.386 | 1.275 |
| 1,048,609 | 1.302 | 1.249 |

Two rows failed the gate:

- Node direct scalar range, two values: **0.937**. The baseline and
  candidate scalar Wasm files are identical.
- Bun public range, one value: **0.500**. The candidate took about twice
  as long in most samples. The span and export Wasm bodies are identical,
  but the two public calls use separate module instances and separate
  JavaScript call sites in this driver.

The Bun difference is stable within this run. It must not be dismissed as
one timer outlier. A runtime optimization or module-placement effect is
possible. An identical-source diagnostic is required before this driver
can support acceptance. The diagnostic plan was fixed before its run; see
[the method](README.md#fixed-aa-diagnostic-after-stage-3).

## Fixed identical-source diagnostic

The diagnostic copied the exact same stage-3 Wasm and portable JavaScript
files into two fresh neutral directories, `a` and `b`. It checked all
copied hashes. Four processes ran the same mixed-case workload: Node
`a/b`, Bun `a/b`, Node `b/a`, then Bun `b/a`. Both module sets in each
process had identical source and bundle bytes.

Each process measured sizes 1, 2, 32, and 1,024. It used all 21 range and
point-control rows, 25 warm-up rounds, 31 measured rounds, and eight
million requested values of work per batch. The one-million-call cap
remained. The diagnostic interval was fixed at `[0.95, 1/0.95]`. A result
outside that interval detects a difference above the permitted size when
the measured code is identical. It does not change the production gate.

| Run | Rows outside the diagnostic interval | Ratios |
| --- | --- | --- |
| Node, `a/b` | Scalar range at 2; public range at 2; SIMD range at 1,024 | 0.939; 1.079; 1.174 |
| Bun, `a/b` | SIMD range at 2 | 1.057 |
| Node, `b/a` | Scalar range at 2; public range at 2 | 0.938; 1.066 |
| Bun, `b/a` | SIMD point control at 2; SIMD range at 1,024 | 0.945; 1.059 |

All four processes completed their workloads and result checks. The
controller retained every report and then returned a failed diagnostic.
Eight of the 84 rows fell outside the fixed interval. No run was repeated
to obtain a passing result.

The Node scalar difference stayed near 0.938 when the directory roles
were reversed. It followed the benchmark role in both runs. This shows
that the present method can produce a difference of this size with
identical code. The dynamic per-call property lookup and the separate
public JavaScript call sites need further investigation before a new
acceptance run.

The two Bun one-value public ratios were 1.006 and 0.994. The original
0.500 A/B difference did not recur in this diagnostic. This does not
establish the cause of that original loss or clear it. A larger changed
callee can alter runtime compilation even when its caller's Wasm bytes
are unchanged.

The driver gained two module-path options for the neutral copies. Its
timed loop bodies and production thresholds stayed the same. Exact
driver hashes distinguish the first full stage-3 run from this diagnostic.
The diagnostic driver SHA-256 is
`40a470193594c6db0b6e5bb9a16f9850e8692f2f5c70eb266a3f70456574d7ff`.
The controller SHA-256 is
`72fff1ae8d9b600808b7230ff0a50d41ce4f0906531ec5dc5962191df5e2c480`.
See [the full cohort](results/stage3-aa/cohort.json)
and [the controller log](results/stage3-aa-controller.txt).

## First hosted workflow status is invalid

The first [hosted comparison run](https://github.com/natanelia/zerocopy/actions/runs/38997133985)
reported success even though its identical-source diagnostics and x64 Bun
performance gate failed. Its default shell used `bash -e`. The commands
sent their output through `tee`. Without `pipefail`, the success of `tee`
hid the failed benchmark command. The final step received successful step
outcomes and could not detect those failures.

That green workflow status is invalid as an acceptance result. Keep its
raw failures. They do not clear the local failures or the new method.
The complete [x64 archive](hosted-first/numeric-tree-x64-first.zip) and
[ARM64 archive](hosted-first/numeric-tree-arm64-first.zip) are retained.
[Their origin record](hosted-first/origin.json) gives the workflow run,
artifact IDs, file sizes, and verified official SHA-256 digests.

The workflow now sets the job's run shell to
`bash --noprofile --norc -euo pipefail {0}`. Each pipeline then propagates
the producer's nonzero status. A small deliberate-failure probe records
the exact shell command, producer status, and returned status in
[the pipeline check](results/pipeline-status-check.json). The probe checks
exit propagation only. It is not a passing numeric performance result.

## Corrected hosted workflow retains failed gates

[Run 38998487385](https://github.com/natanelia/zerocopy/actions/runs/38998487385)
used the corrected shell and failed on both x64 and ARM64. Its final gate
now detects the failed step outcomes. The run retained all eight A/A
processes, all four full A/B cohorts, and the correctness checks.

Eight of 168 A/A rows failed. Four of 192 full A/B rows failed: x64 Bun
public range at 33 values (0.8862456936026983), 32,768 values
(1.0393749767667657), and 32,801 values (0.9424272898724707); ARM64 Bun
scalar range at 33 values (0.9204535152602755). The 32,768-value result
misses the original strict `>1.05` target. Both Node A/B cohorts passed
their point-estimate gates, but failed method controls and Bun results
still prevent acceptance.

Both architectures passed 1,062 tests, type checks, and real-worker
proofs. All 24 x64 browser rows passed, with growth checks and no WebKit
exception. These checks are separate from the geometry timeouts in two
other workflows. The [complete second-run record](hosted-second/SUMMARY.md)
lists every failed row and links both verified archives. This run confirms
correct failure propagation. It does not clear the numeric candidate.

## Correctness evidence

The focused numeric and spatial suite passed 52 tests. The added cases
cover partial sibling groups, depth changes, IEEE edge values, old and
attached snapshots, forks, append and pop operations, memory-end loads,
and invalid pointers in unused tree children. Both scalar and SIMD
modules run the raw-memory boundary test. A read through an attached
snapshot leaves the shared bytes unchanged.

After review, the new raw-memory boundary test was changed to declare a
maximum of two Wasm pages. It never grows memory. This avoids a large
virtual memory reservation without changing the bytes that the test can
read. The focused suite passed all 52 tests again after that test-only
change. See [the review test log](results/stage3-review-tests.txt).
The existing unrelated memory-end test is unchanged.

A separate hosted worker-sessions job timed out in the existing geometry
test for an attached snapshot after memory growth. That test compares the
whole default arena buffer. The new million-value numeric fixture had
used that default arena and could leave it large for a later test. This
is a possible cause, not a proved explanation for the timeout.

The new numeric fixture now creates an explicit private `Arena`. Its
values, bounds, snapshots, and checks remain the same. At that step, the
geometry test and its time limit remained unchanged. The combined numeric, spatial, and
geometry check passed all 56 tests after the fixture change; see
[the focused log](results/private-arena-focused-tests.txt). This is a
fixture isolation check. It did not establish a full-suite pass.

The [old test source](numeric-before-private-arena.test.ts.source) and
[private-arena test source](numeric-private-arena.test.ts.source) are both
retained. Their SHA-256 digests are
`05752b3a7c259d72676309c8e584210f49237c1af5e240987099f2d56a0cc87f`
and `f9c816f87d71f7f21d9a05c57ab0b84e8e27ce2e1ba42973f711111a073c8ab5`.

The private-arena repair did not resolve the repeated x64 timeout. At PR
head `85eee3354b85f8d7d6121a72579ddc8e06a57112`, Worker sessions run
38998487324 and Numeric performance proof run 38998487320 each failed the
geometry attached-growth test. It took 5,727 ms and 5,735 ms, respectively,
against the unchanged 5,000 ms limit. Each job passed the other 1,061 tests.
The ARM64 numeric proof passed all 1,062 tests; its geometry test took
1,399 ms. These runs are separate from Numeric tree comparison run
38998487385. The failed x64 numeric proof skipped its worker and timing
steps. Its missing-artifact error followed the test failure.

The geometry assertion now uses native `Buffer.equals` for the complete
current memory buffer. It keeps the independent saved byte copy and
checks the full byte length explicitly. All bounds, owner, attached, and
old-snapshot checks remain, as does the 5,000 ms limit. This removes the
element-wise deep-comparison cost. It does not prove the cause of the
earlier timeout. This repair changes no production code.

See the [assertion repair record](hosted-second-ci/ASSERTION-REPAIR.md),
which retains the three raw hosted logs, both exact geometry test sources,
local checks, and exit codes. The before-test SHA-256 is
`d3d42533a45bee3a9086e33c1d58e8033ca8bbbbc042f47ddc182b0edaa511a4`.
The repaired-test SHA-256 is
`c7d3c72f685cd94b8e611ebb6f1c29cc79d7126f5e88a339bc80a6138a746b62`.

The focused worker proof passed on Node and Bun. A real worker repeatedly
reads an attached snapshot while the owner grows its memory and creates
new versions. It also checks the read-only write guard and the retained
old, new, and forked values. These results are in
[the test log](results/stage3-tests.txt),
[the Node worker log](results/stage3-node-worker.txt),
and [the Bun worker log](results/stage3-bun-worker.txt).

The separate hosted workflow builds the pull request base and candidate
on x64 and ARM64. It retains the identical-source diagnostic and both
runtime comparisons even when a gate fails. A final step requires every
performance gate to pass. It also runs full tests, type checks, and real
workers. The x64 job compares current-base and candidate correctness in
Chromium, Firefox, and WebKit, in automatic and forced-scalar modes.
Hosted acceptance remains open for this draft. The first workflow status
cannot establish acceptance for the reason described above.

After the byte-assertion repair, the local focused check passed 56 tests.
The first local full-suite attempt failed 15 tests: 14 worker tests lacked
the generated `shared-map.wasm` alias, and one priority-queue checkpoint
test timed out. Geometry passed. Restoring the exact core aliases specified
by `scripts/build-wasm.mjs` required no compilation or source change.
The two failed files then passed 58 tests, and the complete suite passed
all 1,062 tests in 50 files. Every attempt and exit code is retained. The
alias repair explains the missing-file errors; it does not establish the
cause of the checkpoint timeout. The test time limit was not changed.

Type checks have not run locally in the candidate worktree. Browser and
ARM64 checks have also not run locally.
The two recorded 52-test results cover the focused numeric and spatial
suite before and after the test-only maximum-memory adjustment described
above.

The browser proof distinguishes a pre-existing WebKit worker-import
memory limit from a candidate failure. That limit is allowed only if
the current base fails in a fresh browser process at the existing shared
module import with `RangeError: Out of memory`. If the candidate also
fails, its phase and error must match. This condition is reported as a
baseline limit; it is not a passing worker test. Browser checks make no
browser performance claim.

## Reproduction and retained evidence

Use the commands and fixed plan in [README.md](README.md). The experiment
directory contains the exact source and benchmark driver for each stage,
plus its emitted WAT. The unchanged spatial source is included so each
stored numeric source can be rebuilt. Raw JSON files contain source,
Wasm, and driver SHA-256 digests. The stage-2 and stage-3 public runs also
record every imported portable JavaScript file digest.
The local experiment reports name the base Git revision because the
candidate source was still uncommitted during those measurements. Their
source hashes and stored stage files identify the exact measured code.

- [Stage 1 Node samples](results/stage1-node-screen.json)
- [Stage 1 Bun samples](results/stage1-bun-screen.json)
- [Stage 2 Node samples](results/stage2-node-screen.json)
- [Stage 2 Bun samples](results/stage2-bun-screen.json)
- [Stage 3 Node samples and failed gate](results/stage3-node-full.json)
- [Stage 3 Bun samples and failed gate](results/stage3-bun-full.json)

The stage-3 source SHA-256 is
`09b2ef17f68c395c54c9378c50d21ba8276110b47626d3c60ecf7403070204c3`.
Its SIMD Wasm SHA-256 is
`6c598b7f0cb3504197d97b2a51b7927bfb36a938f2eba6f6f9d53d08616b047c`.
The unchanged scalar Wasm SHA-256 is
`5a5114191016599a916768e6141babe2a3ec265ef00e28389e194177ad821d95`.

Do not mark this candidate ready from the large-case ratios alone. The
local small-case failures, method diagnosis, ARM64 comparison, and hosted
correctness results must all be resolved before performance acceptance.
