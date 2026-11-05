# Final fixed confirmation of the lookup-first design

Declared before confirmation on 2026-11-05. Runtime, tests, driver, workloads and `PLAN.md` remain exactly those of local commit `ca20cb2bb4310c74a73ef0dc8623ab9b6f039191`. Only proof files may be added before this declaration is committed. No prior child-first experiment's timing or repetition plan is reused.

The complete new two-pair screen is `results/pilot-01.json`: 2,763,377 bytes, SHA-256 `66f0cb0a8908bc45809269df7fb86ef607c8df70fd0aee8c365f18cbeae866db`. Its [complete table](pilot-summary.md) retains every absolute time and pair ratio. All three tree no-op cases improved both pairs in both runtimes and eliminated shared allocation, but controls were unresolved: Node changed-tail ratio 1.2635 (both adverse), Bun changed-boolean ratio 1.1642 (both adverse), and Node reads 1.1412 with mixed pairs. These observations justify resolving the uncertainty with the fixed confirmation, not accepting the candidate.

## Locked protocol

- Run all ten unchanged cases in Node 24.22.1 and Bun 1.4.2: six balanced fresh-process pairs per runtime/case, 120 pairs and 240 measured processes in total. Tail no-op remains an unchanged-copy control.
- Reuse this complete screen's common repeat plans without recalibrating. Keep one build per process, the same neutral pathname, rotated case order, and three baseline-first plus three candidate-first pairs per case/runtime.
- Require at least 500 ms actual timed warm-up and at least eight warm-up batches per process, then eleven measured batches: 2,640 measured batches. Keep the 2,048 warm-up-batch cap and 300-second child timeout. Fail visibly if a limit prevents completing the protocol.
- Retain the 20 ms target and all common caps: 65,536 complete operations, 1,048,576 output elements and 16 MiB worst-case baseline shared allocation per batch. Retain every short/capped batch.
- Keep 1,024 public calls per complete operation, fresh private source preparation outside timing, complete final-result verification, source-content/published-byte checks and exact allocation assertions. Only each complete operation's final snapshot escapes; intermediate wrappers are not retained. The recorded initial check stays outside the warm-up floor and measured summary.
- Serialize through `/workspace/scratch/83f1d4baba1f/perf.lock`, with controller and children pinned to CPU 2. Preserve all initial, calibration, warm-up and measured observations and failures. Recheck frozen source/build/driver identities at completion.
- Report geometric means of the six independent paired latency ratios and nominal 95% log-t intervals with five degrees of freedom, plus every absolute time/control/pair. Batches are not independent subjects. An interval crossing parity does not establish equivalence; no multiple-comparison correction or universal steady-state claim is made.

This is the last list source and timing study in this round. No source tuning, selected rerun, extra case or further design follows its data. If material changed-write, tail, generic or read costs persist, or readiness remains uncertain under the conservative gate, reject and preserve the complete record. Do not pool the screen, this confirmation, or a different design to make the acceptance claim.

The existing semantic gate already passed the WASM/browser builds, 73 focused tests, TypeScript checks, four current/baseline × shared/copy worker groups, and 40 untimed build/runtime/workload checks. These prove defined correctness cases, not performance readiness. A combined full integration gate would follow only if the final performance decision accepts this source.

```sh
flock /workspace/scratch/83f1d4baba1f/perf.lock taskset -c 2 node \
  proofs/list-set-lookup-20261105/benchmark.mjs formal \
  /workspace/scratch/83f1d4baba1f/zerocopy-r4-base \
  /workspace/scratch/83f1d4baba1f/zerocopy-r4-list-lookup \
  /workspace/scratch/83f1d4baba1f/tools/bun \
  proofs/list-set-lookup-20261105/results/formal-01.json \
  proofs/list-set-lookup-20261105/results/pilot-01.json
```

The local source commit is an evidence identity; remote publication may recreate an identical tree under another commit. Reproduction may use a published checkout with identical recorded runtime/driver hashes and the fixed baseline. No committed transitive dependency lockfile is claimed.
