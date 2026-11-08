# Heap compaction confirmation plan

This plan was fixed after the two exploratory pilots and before the final V3
confirmation. The final runtime change is limited to `Compactor.heap()` and a
type-only declaration for its lazy relocation tables.

## Versions

- Baseline: main `0ca99c1da67e4d3e36e098b3f0e85d392c9c1d5e`.
- V1: flatten the postorder stack and skip null children. Its complete two-pair
  pilot is retained. Node's long-spine target and controls were not convincing;
  V1 was rejected as a standalone optimization.
- V2: also group relocation addresses by the exact arena/type identity, then use
  numeric keys within each group. Both large-heap targets improved in each pair
  on Node and Bun. The unrelated map control remained noisy, including a slower
  Node estimate.
- V3: change the optional field to a TypeScript `declare` field. The V2 field
  emitted an own undefined property on every compactor. V3 leaves the ordinary
  compactor's fields unchanged and creates heap tables only when processing a
  nonempty heap. This structural control safeguard is confirmed by emitted-code
  inspection. There is no additional V3 pilot.

The recordings embed every changed source's full text and its SHA-256. No
recording is overwritten, discarded, combined with another run, or adjusted by
an A/A result.

## Workloads and decision

The seven cases remain those declared in `workloads.mjs` before either pilot.
Primary cases compact a 4,096-node mixed-priority heap, a 4,096-node left spine,
and a group containing a 4,096-node heap with two shared forks and an alias.
Controls cover 1,024 object-valued nodes, a single node, an empty heap, and an
unrelated 1,024-entry map.

Run one final six-pair A/B study in Node 24.22.1 and Bun 1.4.2, followed by one
four-pair same-baseline A/A study on the declared balanced-heap, single-node and
map cases. All cases and all slower observations will be reported. The target
claim requires each target/runtime paired ratio interval to exclude parity;
controls are inspected separately. An inconclusive interval is not evidence of
equivalence, and no universal no-regression claim will be made. A confirmed
material control loss must be disclosed and addressed before recommending the
change.

## Measurement

Use the frozen `paired-benchmark.mjs`, one build/case per fresh process, a common
neutral package import path, CPU 2, and the common exclusive performance lock.
The runner alternates AB/BA pair order and reverses runtime/case order. Imports,
fixture creation and validation are untimed. Complete public `compact()` or
`compactMany()` calls and retention of their outputs are timed.

Each process performs at least eight warmup batches and at least 500 ms of
actual timed warmup, then nine retained measured batches. The independent
process pair is the unit of inference: use paired process-median log ratios,
their geometric mean, and unadjusted pointwise Student-t 95% intervals. Do not
pool batches as independent samples. Record and report batches shorter than
2 ms rather than dropping or replacing them.

After every batch, verify every output's full entries, sizes, heap mode, frozen
state, memory independence, node topology, shared-node counts, and group aliases.
Numeric heaps must allocate exactly one 32-byte node per unique live node.
Source bytes, used length and all retained snapshots remain unchanged. Source,
WASM, bundle, driver and workload hashes are captured and rechecked; WASM must
be identical across both builds.

Dedicated CI runs semantic tests, untimed public workload checks, real Node
workers, and independent arithmetic/evidence verification. It collects no new
performance samples. Main CI supplies the full suite, types and package checks.
