# Confirmation protocol, fixed after the two-pair screen

The source is unchanged from the screen. Keep all ten cases and the complete
screen driver and raw results. The numerical/boolean block traversal and edited
array targets improved in both engines. Two fallback results remain uncertain:
Node JSON and Bun strings. The unchanged Node `SharedList.values()` control
also moved unexpectedly, although its bundled module differs only in the Arena
chunk import filename. Do not attribute that control movement to this change.

The screen allocated hundreds of thousands of caller output slots and callback
closures outside timing before each batch. That can change when later garbage
collection occurs. The confirmation driver prepares these buffers and callbacks
once per repetition count and reuses them across batches. It resets and verifies
each operation's **actual callback or yield count**, in addition to checking every
value and index after every batch, so stale slots cannot mask incomplete work.
Library allocations remain timed: `toArray()` still creates its output arrays,
and string/object decoding retains its normal behavior. JSON collection pauses
remain part of the measurement. No garbage collection is forced.

`benchmark.mjs` uses the same fixture definitions and ten cases as `PLAN.md`:
empty, tail-only, first block, large linked, doubly forward, doubly reverse,
string cache overflow, JSON cache overflow, edited `toArray`, unchanged values.
No further case or source tuning is planned based on confirmation results.

For each runtime, use six fresh-process pairs per case, alternating AB/BA order
three times each, and nine measured batches per process. Each fresh process
loads exactly one build and one workload from the same neutral path. Replace the
entire bundle directory between processes, including every imported chunk.
Run Node and Bun in separate lock acquisitions on CPU 2.

Disposable coarse calibration chooses a common repetition count for before and
after, targeting 12 ms per batch using the faster observed side. The cap is
524,288 retained value slots (131,072 for JSON), up to 1,048,576 operations.
A second disposable calibration warms at that exact common count and records
three trials. These probes do not become measured pairs. Each nonempty measured
subject then warms for **at least 500 ms of timed scan work and eight batches**
at its final repetition count. This minimum excludes fixture setup, output
preparation and validation. The two sides may use different warm-up batch counts.
Record all actual warm-up and measured durations.

Empty input can become an optimized no-op, especially in Bun. Its warm-up has a
256-batch maximum; record cap hits and actual durations. Empty is a behavior and
overhead control, not a headline performance claim. The output-slot cap can also
keep nonempty batches below the 12 ms calibration target; report actual minima.

Use the median of each process's nine full-operation timings. Summarize the
geometric mean of six paired after/before ratios, with an unadjusted two-sided
95% Student-t interval on the six paired log ratios (five degrees of freedom).
Batches are not independent replicates. Report every case, each pair ratio,
all raw batches, fallback losses and unchanged-control movement. These estimates
describe this machine/runtime/workload; they are not a universal performance gate.

Save source identity, candidate patch, driver hash, complete bundle manifests,
runtime versions, hardware/affinity, calibration, warm-up and all measured rows.
Check source and driver hashes again after each runtime finishes. Freeze/commit
production before launching this protocol. Do not rebuild or edit it mid-study.

Correctness evidence includes the 41-test focused run and the six existing real
worker scenarios, which pause public callbacks inside blocks while the writer
grows memory and appends. Root will perform combined full-suite/package validation
against the final sources; describe that scope separately from standalone checks.
