# Follow-up: isolate each workload in its own process

The first six-pair study is complete and retained as `formal-01.json`.
The Bun checkpoint targets improve substantially (paired ratios 0.18–0.29),
but its unchanged plain-state control also appears faster (ratio 0.862,
95% interval 0.776–0.957). That control does not call Base64 at all. Node's
Unicode checkpoint control has a 1.095 ratio with interval 0.987–1.216.
All Node intervals cross one; this does not establish equivalence.

The first study runs six cases in each fresh subject process. Earlier cases can
change engine and garbage-collector state for later cases. To examine this
specific uncertainty, repeat the complete six-case matrix with **one build and
one workload per fresh process**. No production change, case removal, new input
selection, or sample removal is permitted. Retain the original driver and all
original pilot/formal observations separately.

Use six balanced pairs per runtime/case: 144 fresh processes. Reverse case order
each pair and alternate AB/BA within each pair. Keep identical repetitions,
at least 500 ms actual timed warm-up, at least eight warm-up batches, nine measured
batches, CPU 2 and the common performance lock. The same neutral import directory
is replaced between processes, including every content-hashed bundle chunk.
The initial checkpoint oracle and every output check are unchanged.

The original and isolated studies must be reported separately, never pooled.
Use the isolated estimate for the final workload-specific summary because it
removes cross-case process history, irrespective of whether its gains are
larger or smaller. Do not claim unchanged controls are equivalent merely
because their confidence intervals overlap one. A persistent adverse control
effect needs investigation before accepting the optimization.
