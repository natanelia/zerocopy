# Feature-map retained memory

The feature-map proof preserves the earlier synthetic-record fixture. The current website uses a separate product catalog; these recordings do not measure that catalog. It is a separate experiment from the historical SharedList investigation. Existing recordings are never rewritten.

## Work and retained revisions

The full matrix is SharedMap, native Map, Immutable.js Map and Immer Map, with 0, 2 and 4 readers, over three fresh OS processes per cell: 36 runs. Kinds rotate by trial. There is no duplicated centralized cell; a native zero-reader case is already the owner-only control.

An eight-reader-only cohort uses the same 100,000-record workload and three fresh trials for each implementation: 12 new cases and 20 stage groups. Select it with `FEATURE_MEMORY_READERS=8`. It is recorded as `eight-reader-cohort`; the original full matrix remains exactly 36 cases. Smaller runs, incomplete selections and mixed 0/2/4/8 selections remain diagnostics. No combined 48-case same-host recording is claimed by the current report.

Normal reruns measure the source and runtime built in the current checkout. They are not locked to an old commit. Use a new output directory, preserve each run's source/environment, and compare implementations within the same cohort. The published eight-reader supplement used a separate validation controller that required byte-identical runtime, adapter and dependency inputs to the earlier recording before any cases ran. That historical reference guard belongs to its preserved validation commit; it is not part of the general benchmark command.

The documentation importer's `--eight-readers` mode only imports that fixed supplement: it requires its preserved `referenceRecording`, original summary/terminal binding and identical runtime/adapter bytes. A normal fresh eight-reader command emits a new standalone cohort without that historical reference and intentionally cannot replace the fixed chart through this importer. A new documented comparison needs an explicit source and provenance review.

Each owner constructs 100,000 deterministic string-ID/object pairs. IDs run from `road/000000` to `road/099999`. Values contain a name, road class, bounds, status, revision, and nested lane/speed/access attributes. Every fifth name contains Unicode. Both workers request the same 1,000 deterministic IDs, including 90 missing IDs. The lookup job returns 12 visible rows and aggregate counts; the validation job returns at most 12 issues and aggregate counts. Two readers divide these jobs; four readers run two copies of each job. With no readers, the owner performs both jobs.

The first edit replaces 100 existing object values and retains revision 0 in every owner and reader. Edited IDs intersect the query. The next stage releases the initial root everywhere. Ten subsequent 100-value replacement batches retain only the latest root, ending at revision 11. Intermediate snapshots are dropped. Records are deeply frozen before construction and updates, including after structured cloning; no retained record is mutated.

Native Map copies the container only when the current root is also the retained root. After that fork, it mutates the exclusively owned latest Map. SharedMap uses object `setMany`, Immutable.js uses `withMutations`, and Immer uses one `produce` batch. The owner sends an initial Map clone to native/Immer readers, entry pairs to Immutable.js readers, and root descriptors backed by shared memory to SharedMap readers. Later non-shared publications clone only the 100 changed pairs. SharedMap republishes its supported root descriptors. Publication counters reject accidental full-dataset clones during sparse edits.

The proof uses actual `Worker` isolates and direct owner/reader `MessageChannel`s. Only small bounded replies and usage records reach the controller. Every cold, warm, current and retained answer is checked against the independent reference outside the measured process. The verifier requires the exact expected worker role, task, revision and answer sections, so a missing result cannot pass as an empty subset.

## Stages and accounting

Workers import their selected representation and connect their channels before the empty baseline. Five post-GC stages follow:

1. `loaded`: initial data constructed and published, before queries
2. `queried`: one cold and one repeated warm query on each assigned job
3. `edited-retained`: one edit, with both current and initial replies verified and revision 0 retained
4. `released`: initial roots dropped everywhere, with the current answer verified
5. `streamed`: ten more sparse edits, with the final answer verified

The default chart uses `edited-retained`. The difference from `loaded` to `queried` includes retained decode/query cache cost. Raw `cold` and `warm` phase labels mean the first and repeated request; they do not imply a process or JIT reset. In the zero-reader case, the owner can reuse decoded values between its two jobs within the first request. This proof is a memory measurement and does not time either query phase. Each data isolate deliberately keeps its latest bounded answer, consistently across kinds. Construction arrays, delta arrays, payloads, and completed message bodies leave their local scopes before the barriers. The controller retains baseline usage records but never a full dataset or reference map.

Every stage waits until work and publication are finished, then runs four event-loop/GC passes in every isolate and finally in the controller. The reported retained-data estimate is:

`signed summed heap change + signed summed tracked ArrayBuffer change + unique shared WASM backing capacity`

The baseline is the set of empty imported workers with connected channels. Arena identity deduplicates shared backing capacity across owner/readers and across initial/latest roots. At the quiescent barrier, capacity must agree for every observation of the same arena. Read-only attachments can retain different used-prefix counters from their respective root descriptors, so the used-prefix diagnostic takes the maximum per identity. It includes the reserved prefix. Releasing a root does not reclaim append-only arena allocations or spare capacity.

Signed components remain visible, including negative measurement noise. An unresolved nonpositive total fails validation and remains in the raw evidence; it is never clamped, hidden, or resampled to improve a result. `external` is retained as a diagnostic and is not added to tracked buffers again. Absolute process RSS and process high-water RSS are separate fields, not added to the retained estimate. The result is neither live payload size nor peak temporary allocation, virtual reservation, or browser memory.

A separate process first calibrates this exact Node build: an ordinary 8 MiB buffer must appear in `arrayBuffers`; shared WASM allocation, attachment in another worker, and growth must remain excluded. If that assumption changes, the run fails before the matrix and the formula must be revised. Calibration raw output is preserved even on failure.

## Reproduction and evidence

Use the contributor prerequisites and already-built portable `dist` from the declared runtime source commit. The proof copies these modules unchanged; it never builds or stacks an optimization candidate. Record the full source commit for the runtime when it differs from the checkout commit.

```sh
FEATURE_MEMORY_OUT=proofs/results/feature-map-memory/new-run \
node proofs/feature-map-memory.mjs
```

With freshly built modules from this checkout, the driver records HEAD as the runtime source by default. Set `FEATURE_MEMORY_RUNTIME_SOURCE` to the actual full commit only when the portable build came from a different checkout; do not copy a historical commit label onto a new build.

The destination must be new or empty. Without an explicit destination, the driver creates a timestamped directory. `FEATURE_MEMORY_ENTRIES` accepts only the validated presets 1,000, 10,000 and 100,000. Arbitrary counts can make the deterministic stride repeat IDs, so they are rejected. `FEATURE_MEMORY_READERS`, `FEATURE_MEMORY_KINDS`, and `FEATURE_MEMORY_TRIALS` also allow smaller diagnostic runs; their actual values are recorded and must not be presented as the full matrix. `FEATURE_MEMORY_VENDOR` optionally points at an offline website vendor directory with matching pinned version markers; exact copied module hashes remain in the manifest.

Each directory retains a pre-run manifest, exact portable/dependency/adapter and proof hashes, the checkout commit and dirty-tree indicator, runtime/V8/CPU/OS metadata, calibration, raw stdout, raw stderr, process exit/timeout metadata, parsed samples, and either a verified summary or a failure record. The driver verifies that proof sources, original website adapters used by the oracle, and all staged modules stay unchanged throughout recording. Worker startup and each RPC have 60-second deadlines; each fresh matrix process has a 180-second deadline. Processes run sequentially. Successful completion terminates every worker and records the controller-only final sample. Failures retain their evidence and end the run, with no favorable resampling.

The summary retains every sample and reports medians and observed minimum–maximum ranges for each component. A complete 36-run full matrix or a complete 12-run eight-reader cohort at 100,000 entries can have `chartEligible: true`; each keeps its distinct recording type. Other selections are explicitly `diagnostic` and `chartEligible: false`. The fixed documentation importer still requires the separately described historical reference binding for its eight-reader supplement. A terminal record distinguishes verified completion from failure. Three trials are not a confidence interval or a stable performance guarantee. No benefit threshold is used. Report slower or larger-memory cases alongside smaller ones.

The focused pure accounting/answer-contract checks and optional real-worker smoke check are:

```sh
node --test proofs/feature-map-memory-checks.mjs
FEATURE_MEMORY_SMOKE=1 node --test proofs/feature-map-memory-checks.mjs
```

The opt-in smoke launches all four kinds with two actual readers and 1,000 entries. It checks publication, retained revisions, replies, all stages, and clean shutdown. It requires the same exclusive benchmark execution lane as a measurement run. Both successful and failed smoke evidence remain available, separate from full-matrix recordings. Set `FEATURE_MEMORY_SMOKE_OUT` to a new named directory; the test writes a `results` subdirectory there. Smoke results are never eligible for the chart.
