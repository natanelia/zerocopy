# Heap insertion allocation report

An inserted item can take priority over a node on the heap's right path. The old code allocates a 32-byte singleton, then copies it into another node. The new code builds that node once. Each such insertion uses **32 fewer arena bytes**. Insertions that reach an empty child without taking priority use the same number of bytes as before.

**Five controls remain uncertain.** Their 95% intervals do not rule out a slowdown greater than 2%. The recorded result is `scoped-review-required-inconclusive-cells`, not a full performance clearance. No interval establishes a material loss. ARM and browser performance were not measured.

| Runtime | Uncertain control | Upper 95% latency ratio |
| --- | --- | ---: |
| Bun | Read all entries in a 4096-item heap | 1.046038 |
| Node | Push onto a singleton list | 1.026062 |
| Node | Change a number in a singleton map | 1.033142 |
| Bun | Enqueue into an empty heap | 1.027896 |
| Node | Min heap, worsening priorities, 4096 inserts | 1.023263 |

A latency ratio above 1 means the candidate took longer. The upper margin is 1.02. These five controls remain part of the result; none was removed or repeated to obtain a better outcome.

## Small before and after example

```ts
import { SharedPriorityQueue } from 'zerocopy';

const old = new SharedPriorityQueue('number').enqueue(7, 10);
const next = old.enqueue(9, 5);

old.peek();  // 7
next.peek(); // 9
```

The second insertion takes priority over the existing min-heap root. It adds 64 heap-node bytes before this change and 32 after it. The old queue still contains value 7 at priority 10. The new queue has value 9 at priority 5 above it. This count excludes JavaScript objects, the arena header and any separate encoded payload.

The same rule applies to max heaps with the comparison reversed. Equal priorities follow the existing branch. The new code uses the same node builder and produces the same heap shape. `heapMerge`, dequeue, iteration, the 32-byte node layout and transport format 4 are unchanged.

Physical addresses, the used-byte frontier and growth timing can change. An insertion can now fit where the old code exhausted the arena. Failed writes can still leave unpublished allocations; there is no new rollback guarantee. Published snapshot bytes remain unchanged.

## Equal work and arena bytes

These untimed numeric fixtures each perform **two complete builds of 4096 items in one fresh arena**. Both versions receive the same fixed priority permutation. Both start at 65,536 used bytes and 131,072 backing bytes. Node and Bun recorded the same values.

| Fixture | Promotions per build | Baseline final used bytes | Candidate final used bytes | Used bytes saved | Baseline backing bytes | Candidate backing bytes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Min heap, random priorities | 1791 | 2,067,904 | 1,953,280 | 114,624 | 2,097,152 | 1,966,080 |
| Max heap, random priorities | 1818 | 1,998,016 | 1,881,664 | 116,352 | 2,031,616 | 1,900,544 |

Each fixture has twice the per-build promotion count: 3582 or 3636. Multiplying by 32 gives the recorded used-byte saving. Backing capacity falls by 131,072 bytes in each fixture because memory grows in 65,536-byte pages. Other sizes can save used bytes without changing backing capacity. Ties and the worsening-priority control save no allocation bytes.

Used bytes include the arena's allocated prefix, including old or unreachable nodes. Backing bytes are the current WebAssembly memory buffer capacity. These numbers do not establish lower process RSS, lower reachable snapshot retention or a general application-memory reduction. They are separate from latency and from the documentation's existing memory-chart workload.

## Latency on the measured host

The October 9, 2026 screen used Node 22.23.3 and Bun 1.4.2 on Linux x64, with an AMD EPYC 7763 processor and four logical CPUs exposed to the runner. Arena creation and correctness checks were outside timing. Public mutations and natural memory growth were inside timing. This measures the listed operations, not end-to-end application latency.

The predeclared random-priority targets gave two material gains: Bun min-heap insertion had ratio 0.962696, with 95% interval [0.946768, 0.978891]; Node max-heap insertion had ratio 0.941040 [0.911725, 0.971297]. These correspond to about 3.7% and 5.9% lower latency in those cases. The other random targets and all controls are included below.

| Runtime | Workload | Candidate / baseline latency | Pointwise 95% interval | Result |
| --- | --- | ---: | --- | --- |
| Bun | Read all entries in a 4096-item heap | 1.009698 | [0.974619, 1.046038] | inconclusive |
| Node | Read all entries in a 4096-item heap | 0.993664 | [0.970769, 1.017099] | within the 2% upper margin |
| Bun | Min heap, random priorities, 4096 inserts | 0.962696 | [0.946768, 0.978891] | gain above 2% |
| Node | Min heap, random priorities, 4096 inserts | 0.955594 | [0.909660, 1.003847] | within the 2% upper margin |
| Bun | Push onto a singleton list | 1.002224 | [0.989987, 1.014613] | within the 2% upper margin |
| Node | Push onto a singleton list | 0.991856 | [0.958790, 1.026062] | inconclusive |
| Bun | Enqueue an equal priority into a singleton | 0.964781 | [0.921432, 1.010169] | within the 2% upper margin |
| Node | Enqueue an equal priority into a singleton | 0.984985 | [0.967951, 1.002320] | within the 2% upper margin |
| Bun | Change a number in a singleton map | 0.998107 | [0.984917, 1.011472] | within the 2% upper margin |
| Node | Change a number in a singleton map | 0.996564 | [0.961282, 1.033142] | inconclusive |
| Bun | Min heap, improving priorities, 4096 inserts | 0.910709 | [0.876850, 0.945876] | gain above 2% |
| Node | Min heap, improving priorities, 4096 inserts | 0.851635 | [0.823883, 0.880322] | gain above 2% |
| Bun | Pop 256 items from a 4096-item heap | 0.994114 | [0.980365, 1.008055] | within the 2% upper margin |
| Node | Pop 256 items from a 4096-item heap | 0.999949 | [0.998518, 1.001382] | within the 2% upper margin |
| Bun | Enqueue into an empty heap | 0.987207 | [0.948129, 1.027896] | inconclusive |
| Node | Enqueue into an empty heap | 0.934454 | [0.911837, 0.957631] | gain above 2% |
| Bun | Min heap, worsening priorities, 4096 inserts | 0.981886 | [0.969486, 0.994446] | within the 2% upper margin |
| Node | Min heap, worsening priorities, 4096 inserts | 0.963405 | [0.907048, 1.023263] | inconclusive |
| Bun | Max heap, random priorities, 4096 inserts | 0.967280 | [0.936931, 0.998611] | within the 2% upper margin |
| Node | Max heap, random priorities, 4096 inserts | 0.941040 | [0.911725, 0.971297] | gain above 2% |

Five cells show a gain above the declared 2% threshold, ten have an upper bound within the 2% margin, and five remain inconclusive. “Within the upper margin” is a bound on possible slowdown, not a claim of equal speed. No overall speedup is calculated. The retained [cell CSV](heap-insert-results/cells.csv) also retains every AA interval and quartet effect.

## Method and checks

The screen used ten workloads in two runtimes. Each cell had four paired AB quartets and four matched baseline-AA quartets, with balanced LRRL and RLLR order. All 40 disposable pilots completed before 640 measured processes. Each measured process supplied 21 batches, for 13,440 measured batches in total.

Both variants received the same timed repeat count and fixed warmup work. Each batch used one fresh arena. A 64 MiB batch cap bounded allocation. Mutation warmup work came from the fixed 1 GiB budget after reserving 256 initial arena frontiers. Zero-allocation read warmup retained a 10-million-iteration bound. Pop and entries controls started from identical full baseline-layout heap images.

Calibration targeted 50 ms. A predeclared exception allowed a memory-capped pilot only if all three final samples reached 20 ms. No pilot used that exception. Measured floors stayed at 10 ms per batch and 150 ms of timed warmup. All batches met the floors and the normal 40 ms/500 ms targets. No AA cell met the declared drift rule. No sample, cell or failed observation was replaced.

The analysis starts with each process's median batch time divided by its repeat count. It forms direction-preserving log ratios for adjacent pairs, averages each quartet's two pair ratios, and uses four independent quartet effects for a pointwise 95% Student-t interval with three degrees of freedom. These are exploratory intervals on one host, without a simultaneous guarantee across the 20 cells.

The complete standard suites passed: baseline 753 tests in 40 files; candidate 767 tests in 41 files. Builds, public and worker type checks, installed-package checks, exact WASM comparisons and actual Node/Bun shared/copy workers passed before timing. The [insertion tests](../shared-priority-queue-insert.test.ts) check allocation counts, old bytes, ties, signed zero, infinities, alignment, growth, memory limits and encoded values. The [binary proof](heap-insert-correctness.mjs) checks exact shapes, values and both-direction image compatibility.

An independent Python audit rebuilt all ratios and intervals from raw batch receipts and completed 568,476 checks with no discrepancy. It checked the source, complete bundles, input bytes, work counts, order, command cleanup and artifact hashes. Original runtime/compiler binaries and temporary neutral copies were not archived; their recorded identities and checks remain a limitation of this audit.

## The first pilot failure remains recorded

The [first study](https://github.com/natanelia/zerocopy/actions/runs/37876452299) passed its full prerequisites and 40 pilots. Its common plans for Bun list push and Bun map set needed 12,090,650 and 10,163,879 warmup iterations. Both exceeded a separate 10-million-iteration cap, although their byte budgets fit. The global pilot barrier stopped every measured process. That study has no measured speed ratio or confidence interval.

The [separate byte-budget study](https://github.com/natanelia/zerocopy/actions/runs/37878315068) removed only that unrelated warmup-work cap for positive-allocation cases. Its bound follows the already-fixed byte budget, not either observed failed count. Timed repeat limits, memory limits, wall/batch limits, cases, calibration exception, floors and inference stayed unchanged. All prerequisites ran again. The first study is preserved and its pilot timings are not pooled with the later results.

## Source and retained evidence

- Baseline: [3773c6e519c7c0958da13727ed1082f449f3ee25](https://github.com/natanelia/zerocopy/commit/3773c6e519c7c0958da13727ed1082f449f3ee25).
- Runtime: [9972561c60e93500ae092c2b752880dca7740fdf](https://github.com/natanelia/zerocopy/commit/9972561c60e93500ae092c2b752880dca7740fdf), tree `33e99353fbc136ea585dec2f9fce47514f4cf543`.
- Measured proof: [b52aefded8b724e21cd7ddd2713836689ddee299](https://github.com/natanelia/zerocopy/commit/b52aefded8b724e21cd7ddd2713836689ddee299), tree `1e742055d4da30a7bf29cc7653f78018db96c0e0`.
- [Complete screen artifact](https://github.com/natanelia/zerocopy/actions/runs/37878315068/artifacts/11594083423): ZIP SHA256 `0eda58744996e5311350331d2dd09f26adfe671eaff69f2a452779c409df3a16`; inner tar SHA256 `085c5d62848dd38222a2e38c67dbe576ad4765d7782d793e601371dd4c48a09e`.
- [All measured process samples](heap-insert-results/processes.csv), [arena observations](heap-insert-results/arena-observations.json) and [source/build/input hashes](heap-insert-results/provenance.json) are retained with this report. The process CSV preserves all 640 sample vectors and medians. The full CI archive additionally contains commands, journals, sources and built bundles; its hosting retention is finite.
- The existing documentation memory charts use the [fresh 90-case chart run](https://github.com/natanelia/zerocopy/actions/runs/37881914708) at the same runtime commit, with [raw artifact](https://github.com/natanelia/zerocopy/actions/runs/37881914708/artifacts/11594537933), ZIP SHA256 `6b83748accd65194689d214ed1ff5811a5c3715a211a1552617e9ba56aa4d9a7` and summary SHA256 `b318e78be89143dbc9cb3a7e6200f37e63c963ea907d35fc57cecc9ef30049af`. Its 450 memory-state samples and 1,188 reference query results were independently checked. The original chart method, units and datasets are unchanged. Those SharedList workloads do not measure the heap-insertion saving above.

Exact core WASM SHA256: baseline `b4c1f8d06d67abb2ff77fd615d92831ebb6a317cd2e4d8432a2bb09896100ed4`; candidate `08b1e91c9ee6d3602c0a100f449f51555ee35e5641e1839b7f719d016c209d90`.
