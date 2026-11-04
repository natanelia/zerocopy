# Formal study plan

Baseline: `09b1a385a7c2ac9b027a4055335ae2f9449abe6e`.
Candidate production/test commit: `df43219addee389992b2551074927fa680b5922f`.
This study uses the WASM V2 implementation. Both earlier pilot recordings and
the complete JavaScript V1 source/driver remain available.

Keep every workload from [the original 14-case matrix](PLAN.md). For each
runtime and workload, run eight fresh-process pairs, alternating before/after
order. Rotate the case order by one position each round. A subject imports one
build at the same neutral path, and runs only one workload. Copy the complete
bundle directory between subjects so stale content-hashed chunks cannot remain.
Record separate Node and Bun JSON files with all source and bundle chunk hashes.

Disposable calibration first performs at least 250 ms of timed work and at least
five batches. Its calibration selects common repetitions for both builds,
targeting 16 ms per measured batch, bounded by 256 repetitions and 32 MiB of shared
allocation based on the one-operation observation. Both builds use the same
repetition count and the same warm-up batch count. The latter targets 500 ms using
the faster calibration; **500 ms is a calibration-based target, not an actual
minimum for every subject**. Record each subject's actual timed warm-up total.

After warm-up, retain nine measured batches per subject. The subject statistic
is their median elapsed time per complete operation. The paired ratio is the
candidate/baseline subject median. Report the geometric mean of the eight
paired ratios and an unadjusted 95% Student-t interval on their logarithms.
The eight process pairs, not the individual batches, are the independent units.
Keep every observation. Do not remove outliers or replace an unfavorable run.

Each complete operation constructs one list by streaming all input batches,
or creates 1,024 forks from a retained 31-value seed. The timed region includes
list/retained-wrapper construction, all `pushMany` calls, optional intervening
scalar pushes and the fork-result array. Input generation, private Arena setup,
the fork seed, the outer batch-output array and full content verification are
outside timing. Check every final value and all retained roots after every
warm-up, calibration and measured batch. For object values, also check freezing.
Record Arena used-byte deltas and final backing capacity separately. These are
not JavaScript heap or RSS measurements; timings include any growth or garbage
collection occurring within the append loop.

Run under the common `perf.lock` on CPU 2. Only after the complete formal results
will an additional A/A comparison be considered, and only to resolve a specific
remaining control/noise question. All 14 primary cases remain reportable regardless
of their direction. Browser checks, if added, are supplementary and use their
own disclosed method.
