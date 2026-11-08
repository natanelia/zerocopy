# Fixed confirmation after screening

The first pilot showed favorable large-record results, but it ran all eight
cases in each process. Its unchanged single-snapshot Bun control varied from a
ratio of 0.993 to 0.345. Large-record allocation/GC history could therefore carry
into an unrelated control; host drift could contribute too. The pilot cannot
establish the source of that variation or a confirmed improvement.

Keep that pilot intact. `pilot-runner-v1.mjs` and `pilot-workloads-v1.mjs` preserve
the exact measured harness bytes. The production candidate and workload code
remain unchanged for confirmation. The only method change is isolation/order:
`benchmark.mjs` now runs **one case per fresh process**, alternates A/B order per
runtime/case/pair, and reverses runtime and case order on alternating pairs.

Run six fresh paired processes per runtime and case across all eight cases,
with at least 500 ms of actual timed warm-up and nine measured batches per
process. This is 192 independent child processes and 1,728 measured batches.
Run a separate four-pair A/A study of `create-distinct-1024` and
`create-single-snapshot` in both runtimes: 32 children and 288 measured batches.
Do not pool the pilot with confirmation, correct measurements by subtracting
A/A variation, or retune the fixed candidate in response to confirmation.

All prior source/build/affinity guards and complete workload checks remain.
Ratios use geometric means of matched process medians. Intervals are two-sided
95% Student-t intervals on paired log-ratios (five degrees of freedom for the
six-pair confirmation, three for four-pair A/A). They are per-case estimates,
not simultaneous family-wise confidence bounds.

```sh
flock /tmp/zerocopy-performance.lock taskset -c 2 node proofs/worker-record-descriptors-20261108/benchmark.mjs --baseline=/absolute/path/to/baseline --candidate=/absolute/path/to/candidate --bun=/absolute/path/to/bun --pairs=6 --warm=500 --output=/absolute/path/to/formal-v2.json
flock /tmp/zerocopy-performance.lock taskset -c 2 node proofs/worker-record-descriptors-20261108/benchmark.mjs --baseline=/absolute/path/to/baseline --candidate=/absolute/path/to/baseline --bun=/absolute/path/to/bun --pairs=4 --warm=500 --cases=create-distinct-1024,create-single-snapshot --output=/absolute/path/to/aa-v2.json
```
