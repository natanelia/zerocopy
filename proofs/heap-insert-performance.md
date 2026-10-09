# Heap insertion allocation screen, attempt 1

Frozen baseline: `3773c6e519c7c0958da13727ed1082f449f3ee25`. Frozen runtime candidate: `9972561c60e93500ae092c2b752880dca7740fdf`, tree `33e99353fbc136ea585dec2f9fce47514f4cf543`. The candidate fuses singleton creation with persistent heap insertion, removing one discarded 32-byte node when a priority promotes. The runtime and its committed regression tests remain frozen. This is a bounded first screen, not a general speed or memory claim.

## Prerequisites and source identity

One x64 Linux runner uses Node 22.23.3 and Bun 1.4.2. Both complete standard Bun suites, WASM/portable/declaration builds, all public type checks, installed-package checks, exact baseline/candidate binary equivalence and dedicated actual Node/Bun shared/copied heap-worker proofs must pass before any pilot. Test assertions and the existing five-second test timeout are unchanged. The dedicated workers retain six queues while the owner performs 2,048 insertions and forces growth, verify old payload bytes and reads, and then attach the new queue. This runs separately from measurement processes.

The controller requires a proof-only commit directly above the frozen remote runtime candidate. Runtime, existing tests and the committed binary-equivalence proof are forbidden changes. Both complete source snapshots, dependency resolution/lockfiles, compiler contents, original package.json, all WASM and the entire emitted dist tree are retained. Unrelated numeric/geometry kernels and public declaration bytes must match; the shared core is expected to differ. Each neutral-package installation replaces the whole prior package directory, copies package.json and the complete dist inventory verbatim, and verifies them before and after execution. Both runtimes explicitly import the same absolute neutral dist/shared.js path. Comparison labels are absent from child requests.

The bounded command runner streams separate raw stdout/stderr plus immediate command metadata. Each command owns a Linux process group; timeout/interruption kills that group and verifies no live descendants remain before another child starts. Limits are 30 seconds for metadata, 180 seconds for builds/package/workers, 120 seconds for types/subjects and 600 seconds for each complete standard test command. The main CI step has a 65-minute cap inside a 90-minute job, preserving time for failure artifacts. No source, test or timing-driven retry is allowed.

## Ten public workloads

1. Min-heap: build 4,096 entries from deterministic pseudorandom priorities.
2. Max-heap: build 4,096 entries from the same priority input.
3. Min-heap: build 4,096 entries with successively better priorities. This is a declared best case and cannot alone satisfy the gain condition.
4. Enqueue once into an empty heap, repeated from the same empty snapshot.
5. Enqueue an equal-priority item into a singleton, repeated from the same singleton snapshot.
6. Min-heap: build 4,096 entries with successively worse priorities; baseline/candidate allocation counts should match.
7. Perform 256 chained pops from a fixed 4,096-entry heap.
8. Consume every value and priority in a 4,096-entry heap traversal.
9. Change a numeric value in a singleton SharedMap, repeatedly from the fixed original map.
10. Push onto a singleton SharedList, repeatedly from the fixed original list.

Cases 1 and 2 are the predeclared target rows. Others are mechanism or control rows. Heap-pop and entries fixtures use a canonical baseline-layout image, produced by an independent JavaScript reference allocator, so both arms have identical initial bytes, pointer descriptors, used frontiers and backing capacities. Other starting snapshots and input arrays are similarly identified. Fixtures are verified against real built sources before timing. Initial identity is distinct from post-operation allocation observations, which are expected to differ in changed insertion cases.

## Mutation timing and memory bounds

Every batch creates one fresh arena and its starting snapshot outside the timed region. It does not allocate a giant array of arenas. Inside timing, repeated public mutations fork from the fixed starting snapshot, or repeat whole 4,096-entry builds in that arena. Natural growth remains in the insertion workloads. There is no artificial reservation to eliminate growth. The timed region contains no explicit GC, heap draining, fixture construction, serialization or correctness checking. Mutation results escape through retained snapshot handles and scalar sinks; the entries control consumes values and priorities during its traversal.

This measures public operation/build throughput with arena creation excluded. It is not end-to-end application latency. After timing, full output, input checksum, retained original bytes and snapshot invariants are checked. Per-batch used bytes, reserved backing bytes, growth observations and process memory are retained outside timing; they are not interpreted as isolated RSS effects of the optimization.

Each workload declares a hard 64 MiB used-byte budget per batch and a finite repeat cap derived from its fixed worst-case/reference allocation. The baseline heap reference counts the exact fixed insertion sequence, avoiding an unnecessarily loose depth-times-size bound. Random cases use the same fixed permutation of [-2048, 2047], produced by Fisher-Yates with LCG seed 0x12574; input hashes include values, priorities, heap direction, operation and singleton seed/changed values. The public memory configuration caps future arenas at 64 MiB and current backing capacity is recorded separately. The common plan must fit both pilot caps, including their maximum total warmup work. Warmup is also capped at 1 GiB cumulative worst-case used bytes and 256 fresh batches, with the initial fixture/header cost reserved for every possible batch. A warmup/work cap miss is recorded as an invalid pilot/common plan. The prospective calibration-only memory-ceiling rule below is the sole exception; it does not change input size, operation, memory policy or source. No outcome is replaced by a larger favorable rerun.

## Calibration and replication

All 40 disposable pilots (both arms, ten cases, two runtimes) must succeed before any measured process starts. Pilot warmup starts with up to 65,536 public operations (or entries visited) per batch, adapts disposable warmup batch size toward 40 ms within the fixed caps, and calibration begins at the last warmup batch size. Each pilot then uses the fastest of three calibration batches to target 40 ms with a 25% cushion, hence a normal 50 ms calibration target.

Because no timing has run, the following memory-bounded calibration rule is fixed prospectively: at the declared 64 MiB worst-case memory repeat ceiling, a pilot may finish below 50 ms only when every one of its final three calibration batches is at least 20 ms, twice the unchanged measured floor. It records both the memory ceiling and normal target miss. A non-memory repeat cap, exhausted calibration steps, any final sample below 20 ms, invalid duration, or failed warmup remains invalid. The common repeat count still must fit both arms and preserve equal work. This exception never changes the measured 10 ms or warmup 150 ms floors. Every later floor miss invalidates the cell without replacement. Both arms receive the larger calibrated repeat count and identical fixed warmup work, based on the faster pilot and rounded to whole batches. The desired warmup is 500 ms; the measured validity floors are 10 ms for every batch and 150 ms of timed warmup. Actual misses of the higher targets remain recorded. A measured floor miss invalidates its cell without extending that arm's work or replacing its process.

Each runtime/case has four AB quartets and four matched baseline-AA quartets. Each comparison has two LRRL and two RLLR orientations, interleaved with seeded mode order inside four blocks. Left is baseline; right is candidate for AB and baseline for AA. This gives 20 cells, 40 pilots, 640 measured processes (320 AB / 320 AA), and 13,440 measured batches. Four fixture-check processes and prerequisite processes are additional untimed work.

Each measured process has 21 batches. For each adjacent pair, compute log(right/left) from median batch milliseconds divided by prescribed repeats; preserve role direction when chronology reverses. Average the two pair logs within a quartet. The four quartet effects, not batches or adjacent pairs, define the pointwise two-sided 95% Student-t log-ratio interval: df=3, t=3.182446305284263. Raw process/batch samples, calibration, warmup, memory observations, environment and order are retained. Each subject appends completed batch and stage receipts to a dedicated JSONL file outside timing, so later timeout/crash still leaves completed observations; its raw bytes and digest are retained alongside stdout/stderr.

AA drift means its geometric latency ratio is outside [1/1.02, 1.02] and its interval excludes 1. This invalidates the cell for inference; AB is never adjusted by AA. No outlier removal, selective omission, extra quartet or timing-driven tuning is permitted. Intervals are exploratory and pointwise, not a simultaneous family-wide guarantee.

## Decisions and evidence

- A usable AB interval with lower bound greater than 1.02 is a material adverse result.
- Missing, invalid or AA-drift cells prevent clearance.
- At least one predeclared random-insertion target must have AB upper bound below 0.98 in each runtime to establish the target gain condition.
- With that condition, all 20 AB upper bounds at or below 1.02 produce `strong-clear-requires-human-review`.
- With established target gains and no material adverse interval, any remaining usable interval crossing 1.02 produces `scoped-review-required-inconclusive-cells`. These controls remain inconclusive, not passed. No aggregate gain is calculated.

Only strong clearance exits successfully; all other complete or partial outcomes remain preserved for review. Nothing automatically creates a PR or publishes runtime changes. The workflow permits only the first attempt on the named branch, has no dispatch trigger, and archives complete or partial evidence inside a tar.gz plus SHA256 even after prerequisite or timing failures.

No memory-chart measurement is part of this screen. If the results warrant a later memory-focused PR, refresh the existing documentation chart's numbers and provenance with genuinely comparable latest measurements of its original workload. Do not redesign the chart, substitute a favorable heap workload, or confuse used arena bytes with backing capacity/RSS.
