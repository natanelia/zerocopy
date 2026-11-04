# Bulk list append: fixed pilot plan

Baseline: `09b1a385a7c2ac9b027a4055335ae2f9449abe6e`.
Candidate changes only `Arena.encodeRange`: when the preceding tail ends at
the allocation frontier, reserve the new suffix without copying that prefix.
All experiments and failures will remain in this new proof directory.

The pilot is a screen, not final performance clearance. Use Node 24.22.1 and
Bun 1.4.2, a single fixed CPU where available, and the shared performance lock.
Each subject imports one portable bundle in a fresh process at the same path.
Run four alternating before/after process pairs per runtime and workload.
Use common repetitions selected in disposable pilots, seven measured batches
per subject, and common warm-up iteration counts derived from the faster pilot.
No sample exclusion or picking a passing rerun. Retain full samples and hashes.

Each timed operation streams a fixed input into a new list in a prepared private
arena. Arena creation and input generation are outside timing; list construction
and every append are inside. Keep final snapshots reachable and validate every
element and any retained fork after timing. Record the shared bytes allocated
and backing capacity as separate observations, not heap/RSS measurements.

## Fixed workload matrix

| Case | Values | Batch | Purpose |
| --- | ---: | ---: | --- |
| number/1 | 4,096 | 1 | Small-batch target |
| number/4 | 4,096 | 4 | Small-batch target |
| number/8 | 4,096 | 8 | Small-batch target |
| number/16 | 4,096 | 16 | Small-batch target |
| number/31 | 4,096 | 31 | Tail/tree boundary control |
| number/32 | 4,096 | 32 | Full-tail boundary control |
| number/33 | 4,096 | 33 | Cross-tail boundary control |
| number/interleaved | 4,096 | 8 | Another list appends between batches |
| number/large | 65,536 | 65,536 | Empty-prefix large-batch control |
| boolean/8 | 4,096 | 8 | Primitive nonnumeric encoding |
| string/repeated | 4,096 | 8 | Interned-string path |
| string/unique | 4,096 | 8 | Mixed interned/uncached string control |
| object/8 | 1,024 | 8 | Serialization/allocation control |
| number/forks | 1,024 forks | 1 | Append to a retained 31-element root |

Every streaming case crosses the 32- and 1,024-element tree boundaries. Inputs
and all counts are identical between builds. Stream values are deterministic
and nonconstant; numeric values include fractions and negative values. The
large-batch case crosses the next tree-depth boundary as well.

After inspecting the complete pilot, share its gains, losses and limitations
before deciding whether a larger, separately recorded formal study is justified.
