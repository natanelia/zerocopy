# Redux entry selector validation, 8 November 2026

Baseline: `0ac8a005268335a6116f025e75f670b5cee6843e`.

The public entry selector validates an exact frozen `SharedMap`, obtains its
owning arena, finds the selected immutable leaf, and caches one decoded result.
The existing generic class validator already obtains the owner to check the
private snapshot brand; the selector then obtains it again.

V3 validates the single accepted class and returns its owner in one pass. It
keeps the selected-key lookup and existing arena/leaf/type result cache. It adds
no lookup cache, changes no snapshot or binary layout, and keeps input-selector
order and dynamic arena reader calls.

## Before final measurements

- Run the same complete public workloads against the baseline and candidate in
  fresh Node and Bun processes, using the existing paired benchmark runner.
- Include repeated numeric and object reads, missing keys, changing keys, and
  256 independent component selectors. State wrappers change while the selected
  map remains the same, as on unrelated Redux updates.
- Include alternating map snapshots, alternating arenas, a newly constructed
  selector per call, and first-seen snapshots produced by writes.
- The write control starts with 32 entries, compacts once to bound allocation,
  then performs 512 immutable overwrites and first selections inside the timer.
  It retains and verifies the resulting map. New maps are never selected by
  setup or verification before their timed first read.
- Preserve complete source snapshots, hashes, runtime versions, CPU metadata,
  raw samples, failed candidates, and adverse results.
- Confirm a candidate only after repeated target improvements on both runtimes
  and no clear material regression in the control workloads. Inconclusive
  controls remain inconclusive, not evidence of zero regression.
- Formal measurements use six alternating process pairs, at least 500 ms of
  timed warm-up, and nine measured batches per process. Report paired log-ratio
  estimates with 95% Student-t intervals, not only the best run.
- Run representative same-build A/A controls separately if needed to assess
  host variability. Do not subtract A/A estimates from A/B results.

## Earlier explorations

V1 cached validation and the arena for the last map. It reduced repeated-read
time but slowed Bun's alternating-map and alternating-arena controls. V1 is
rejected. Seven Node pilot processes overlapped another agent's build/tests
between `2026-11-08T12:23:15Z` and `2026-11-08T12:23:19Z`; the adverse Bun
controls did not overlap that work. All samples are retained unchanged.

V2 used a shared weak map of validated owners. It helped reused maps across
selectors but slowed Node's first-seen write/select workload in both pilot
pairs (paired estimate +30.5%). V2 is rejected. The final candidate adds no weak
map or per-selector map cache.
