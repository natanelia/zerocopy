# Fixed confirmation after the complete screen

Declared before confirmation on 2026-11-05. Keep the exact runtime, tests, `benchmark.mjs`, `workloads.mjs` and `PLAN.md` from local screening commit `11c7328`. The confirmation commit may add proof files only. The unchanged driver records and rechecks source, complete portable bundle, WASM aliases, and driver identities.

The complete two-pair screen is `results/pilot-01.json`, 2,468,512 bytes, SHA-256 `38149259eacaa7d0f7cbd78d7aed7569a87ca8d1e29f10d50582f4e4b751a920`. See `pilot-summary.md` for every observed row. The four no-op workloads improved in both pairs in both engines and eliminated the predicted shared allocation. These results justify resolving the controls with one larger fixed study; they do not establish acceptance.

The adverse controls remain explicit: Node changed-string writes had paired ratio 1.1128, Bun JSON re-encoding 1.1149, and Bun unchanged reads 1.2073, each with both pairs slower. Bun changed-number and changed-boolean estimates were also above one. An unchanged source path does not establish unchanged performance. Do not discard these observations or combine them with confirmation estimates.

## Protocol and stopping rule

- Run exactly six fresh-process baseline/candidate pairs per case and runtime, with all ten original cases unchanged: 120 independent pairs, 240 measured processes, 2,640 measured batches.
- Use the complete pilot's common repetition plans without recalibration. Keep one build per process and the same neutral copied pathname, rotate case order as already implemented, and balance baseline-first/candidate-first order three times each.
- Keep the existing 20 ms target, complete-output and worst-case shared-allocation caps, 2,048 warm-up-batch limit, and 300-second child timeout. Actual timed warm-up must reach 500 ms and at least eight batches; collect eleven measured batches. Short/capped measured batches remain in the evidence.
- Keep public 1,024-call operations, fresh private source construction outside each batch, full final-snapshot outputs, exact shared-allocation counters, full source content and published-byte checks. The final result of each operation escapes; intermediate wrappers remain unretained. Initial recorded checks do not count toward warm-up or measured summaries.
- Use Node 24.22.1 and Bun 1.4.2, CPU 2, under the shared `perf.lock`. Retain every process/batch/check and all failures. No source tuning, changed cases, selective retiming, or additional variants follow these data.
- Judge the complete results, including every changed-write, generic and read control. Report paired geometric latency ratios and nominal 95% log-t intervals from the six process pairs (five degrees of freedom); batches are not independent subjects. These are not equivalence tests or simultaneous intervals. If material adverse controls persist or readiness remains uncertain under the conservative gate, reject the candidate and preserve the evidence.

The real Node worker proof was prepared after screening and passed before confirmation: current and unchanged-baseline readers, each with shared and copied attachments. It checks old/no-op/changed snapshots, concurrent reads and suspended iterators during writer growth, signed zero, read-only same-value writes, repeated attachment, forks and reset. It does not change the runtime or timing driver. Parent integration will supply the full combined validation only if this candidate passes the performance gate.

Run from the candidate checkout after committing this declaration:

```sh
flock /workspace/scratch/83f1d4baba1f/perf.lock taskset -c 2 node \
  proofs/list-set-noop-20261105/benchmark.mjs formal \
  /workspace/scratch/83f1d4baba1f/zerocopy-r4-base \
  /workspace/scratch/83f1d4baba1f/zerocopy-r4-list-noop \
  /workspace/scratch/83f1d4baba1f/tools/bun \
  proofs/list-set-noop-20261105/results/formal-01.json \
  proofs/list-set-noop-20261105/results/pilot-01.json
```

Local measured commit IDs identify this workspace's evidence; later publication can recreate the same tree under a different remote commit. Reproduction may use a published checkout with identical recorded runtime/driver hashes and the fixed baseline. No committed transitive dependency lockfile is claimed.
