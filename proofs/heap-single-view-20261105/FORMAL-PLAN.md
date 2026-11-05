# Confirmation plan, fixed before measurements

Date: 2026-11-05. The runtime remains the exact single-view implementation
committed at `c8feca5172fdaa6ffe5dda6964d99ef8af1f770f`. Its only production
change from baseline `77599337867dbf785a5f0311d34637d0b36678fc` is
`shared-priority-queue.ts`; SHA-256 is
`813507737e0d69e65dd61268c60bf1d7151f0530541453d4784e62cb7be0bb03`.

The two-pair screen supported a confirmation study: full numeric and boolean
traversals were faster in both engines. It also had substantial variability,
an apparent improvement in the unchanged Node peek control, an adverse Bun
singleton-close result, and mixed string/cache-overflow results. Those controls
remain in the study. A pilot estimate is not a confirmed effect, and a change
in an unchanged method will not be attributed to this optimization.

Keep the complete ten-case matrix, fixture construction, independent
stored-tree/native-input oracle, output retention, shared-storage checks,
repetition caps and neutral import path from [the screen plan](PLAN.md) and
[the exact screen driver](pilot.mjs). Do not tune runtime source or individual
workloads after seeing confirmation results. Both engine records must complete
before acceptance; no workload or sample may be excluded.

[The confirmation driver](benchmark.mjs) changes only the planned replication,
measured-subject warm-up and descriptive labels:

- Six balanced fresh-process pairs per engine and case: three before/after,
  three after/before. Rotate the case sequence by one position each round.
- Nine measured batches in each subject. A subject loads one build and runs
  one workload. Process medians, rather than individual batches, are the
  independent paired units.
- Every nonempty measured subject performs at least 500 ms of actual timed
  warm-up and at least eight batches at the final common repetition count.
  Empty has the existing 256-batch bound; record any unmet target or cap hit.
- Disposable coarse and fixed-count calibration retain their original
  100 ms / 150 ms settings. The common repetition count targets 8 ms, subject
  to the original output-retention cap. This is a calibration target, not a
  guaranteed minimum batch duration. Record the actual warm-up and measurement
  durations.
- Report every case in both engines, all six paired ratios, their geometric
  mean and a two-sided 95% Student-t interval on the six log ratios. Also report
  the median before and after process times. Do not treat the 54 measured
  batches per side as 54 independent observations.

All operations retain natural iterator/tuple allocation and GC costs. Caller
buffers are reused and validated in full outside timing; full materialization
still creates and retains every returned tuple array inside timing. Caches stay
active as specified in the original plan. No forced GC, flags, source tuning,
fixture resizing or new warm-up exclusions.

Use Node 24.22.1 and Bun 1.4.2 on CPU 2 with the common `perf.lock`, acquiring
the lock separately for each engine. Preserve the original screen records and
driver. Record baseline/candidate source, all imported bundle chunks, driver
hashes and start/end identity checks. Any later explanatory analysis must use
the preserved records and identify itself as supplementary.
