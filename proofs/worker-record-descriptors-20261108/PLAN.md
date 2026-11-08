# Shared-state record capture — measurement plan

Baseline: `0ac8a005268335a6116f025e75f670b5cee6843e`.

`recordOf` previously materialized a complete descriptor map and then an array
of entry-pair arrays to copy enumerable data properties into a null-prototype
record. The candidate fetches descriptors directly while building that final
record. It preserves the single-snapshot path, the first symbol scan, descriptor
trap order (including hidden and symbol descriptors), and error precedence by
deferring enumerable accessor rejection until all descriptors have been read.

The prespecified public workload matrix is:

| Case | Timed public work |
| --- | --- |
| `create-distinct-1024` | Create and dispose a state with 1,024 distinct snapshots |
| `publish-distinct-1024` | Publish 1,024 fields, alternating a changed final field |
| `create-alias-1024` | Create and dispose a state with 1,024 aliases of one snapshot |
| `publish-alias-noop-1024` | Publish alternating prebuilt wrappers with unchanged 1,024 aliases |
| `create-distinct-32` | Create/dispose a 32-field state |
| `publish-distinct-1` | Publish alternating values through a one-field record |
| `create-record-1` | Create/dispose a one-field record |
| `create-single-snapshot` | Create/dispose the unchanged single-snapshot fast path |

Fixture collections are built before timing and remain immutable. Distinct
snapshots share one arena; this tests record processing without conflating it
with arena construction. Each publication batch starts with a new state outside
timing and includes one real subscriber. Timed calls retain their returned
current values for complete verification afterward. Checks cover every field's
exact snapshot identity, record keys/prototype/freezing, version, notification
identity and sequence, old snapshot contents, source records, and complete arena
bytes. No worker messaging, copying, network traffic, or complete app latency is
claimed by this benchmark.

Screen using two fresh A/B process pairs on Node and Bun, alternating pair order
and rotating workload order. Every child imports one build from the same neutral
module path. Calibrate batches to about 20 ms or more, warm each workload for at
least 200 ms of actual API work, then retain nine measured batches. Serialize
timing on CPU2 using the shared performance lock and record all production
source, WASM, generated JavaScript, runner and workload hashes.

The runner requires the exact baseline commit, compares the baseline's tracked
production/package/build-script bytes with that commit, and checks that
`worker-protocol.ts` is the only changed production source. It embeds both
versions of that file, both Git revisions, each child's full runtime versions,
actual single-CPU affinity, and start/end timestamps. A/A runs use the same baseline
path in both roles. Reproduction must use an available fixed CPU and serialize
with the shared lock; this environment uses:

```sh
flock /tmp/zerocopy-performance.lock taskset -c 2 node proofs/worker-record-descriptors-20261108/benchmark.mjs --baseline=/absolute/path/to/baseline --candidate=/absolute/path/to/candidate --bun=/absolute/path/to/bun --pairs=2 --output=/absolute/path/to/new-pilot.json
```

Only a separately recorded six-pair confirmation, with 500 ms timed warm-up and
full controls, can support a final improvement claim. Retain pilots and adverse
results. Reject meaningful repeatable control regressions; never use A/A noise
to subtract a slowdown. Report process-paired ratios and uncertainty, not pooled
batches treated as independent process observations.
