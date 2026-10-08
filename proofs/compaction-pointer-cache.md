# Grouped compaction pointer-cache experiment

This candidate changes only `compaction.ts` relative to main
`3773c6e519c7c0958da13727ed1082f449f3ee25`. It does not include the separate
primitive-span-copy experiment or alter the public API, binary format, source
snapshots, or primitive vector traversal.

The cache is grouped by logical arena ID and pointer kind. Raw values, ordinary
map leaves, ordered leaves, stack nodes and heap nodes retain separate type
namespaces. Repeated attached sessions with the same logical arena ID still
coalesce. Ordinary pointers use numeric keys; ordered leaves retain a
pointer/rewritten-ordinal string tuple. The latter must not share a copied leaf
when its live ordinal differs between retained snapshots.

## Deterministic mechanism and cost

`compaction-pointer-allocations.ts` extracts both exact Compactor classes and
counts executed template-string and Map-construction expressions. It compares
all descriptors, the total target allocation and every target arena payload
byte with a fixed target ID across 49 fixtures. This instrumented code is never
used for timing. Expression counts are not actual engine allocation counts,
retained heap, backing memory, peak memory or RSS estimates.

Examples from the initial correctness run:

- A 4,096-string list eliminates 4,096 per-pointer key templates for two extra
  Maps. A numeric list constructs no new group Maps.
- A 4,096-string map replaces 8,192 per-leaf/key templates with one group-kind
  template and two extra Maps.
- A singleton string list saves one key template but adds two Maps.
- 128 arenas, each with three tiny cache kinds, add 512 Maps. Total templates,
  including snapshot identities, fall from 896 to 512. This is an explicit cost
  to measure, not an assumed memory improvement.

The exact-byte fixtures include empty/singleton/32/4,096-value primitive and
JSON/string paths, many tiny arenas/types, and nested target memory growth
across attachment sessions. Focused unit tests additionally cover same-pointer
cross-kind interpretations, distinct arenas, raw types, ordered prefixes and
multiple compacted ordinals, shared stack suffixes and heap subtrees, and
retained source bytes. Real Node workers check shared and copied transport,
post-attachment source growth, read-only sources and writable compacted output.

## Prospective timing protocol

The first workflow runs x64 Node 22 and Bun 1.4.2 only, on the exact candidate
commit and pinned main. ARM64 is an explicit later dispatch. Browser timing is
not established by this workflow. No local timing has been used to accept the
candidate.

The 22 predeclared workloads cover large string/JSON lists, maps, sorted maps,
stacks and heaps; singleton generic collections; 0/32/4,096-value primitive
controls; ordered maps; repeated nested snapshots; shared blobs across two
attachments; and 1/32/128 tiny mixed-type arena groups. All source construction,
attachment, source-byte checks and full output inspection are outside timing.
The timed operation is a complete `compactMany`, plus a small result-size
checksum. New target arenas and ordinary garbage-collection costs remain part
of the operation. Sources are reused without mutation and output arenas are
not deliberately retained between calls. Initial and final compacted byte totals
are recorded separately: fresh target arena IDs are serialized into nested
values, so a wider ID can legitimately increase blob length/alignment while
preserving identical values and sharing. Full value and source-byte checks
remain required; the target byte total is not compared across different IDs.

Each subject uses one fresh runtime process and exactly one portable build.
Both roles are copied to the same neutral import URL; manifests and symlink
checks verify the copy before and after every process. Only `compaction.ts` may
differ in production; the vector method remains byte-for-byte identical, the
baseline/candidate production sources and timing driver must match committed
Git blobs, and both use identical WASM.

For each workload, separate baseline and candidate pilots choose a common
batch size and common warm-up count. Pilots are calibration only. The maximum
batch count is frozen across both A/A and A/B roles, as is twice the maximum
pilot warm-up count. Eleven batches per measured subject must each reach 20 ms;
warm-up must reach 150 ms. Floor violations remain visible and invalidate
non-inferiority inference, rather than causing a favorable rerun.

Each comparison has four independent balanced ABBA/BAAB quartets, each with two
adjacent descriptive process pairs. Direct baseline A/A uses the same work plan.
The estimand is the geometric-mean candidate/baseline latency ratio, using
quartet-mean log ratios as the four independent observations. The two-sided 95%
Student-t interval has three degrees of freedom and assumes independent,
approximately normal quartet log ratios. Batches and pairs do not increase the
inferential sample size. A/A is reported directly, never subtracted or divided
out. Intervals are per workload and unadjusted for multiple comparisons.

The prospective material-loss margin is 2% candidate latency. A lower interval
bound above 1.02 indicates a detected material loss; an upper bound at or below
1.02 supports performance within that declared margin; an interval spanning
1.02 is inconclusive. Report absolute batch and per-compaction times alongside
ratios, uncertainty, direct A/A and timing flags. Green workflow status is a
correctness/protocol result, not automatic performance acceptance, and does not
certify exact-zero or universal absence of regressions.

Reproduce the checked fixtures without timings:

```sh
bun proofs/compaction-pointer-allocations.ts .proof-baseline/compaction.ts
node --test proofs/compaction-pointer-performance.node.mjs
node proofs/compaction-pointer-worker.mjs
POINTER_MODULE=.proof-baseline/dist/shared.js node proofs/compaction-pointer-worker.mjs
```

The diagnostic controller is `proofs/compaction-pointer-performance.mjs`.
`POINTER_BASE`, `POINTER_CANDIDATE`, and `POINTER_OUTPUT` select prepared
checkouts/output. Its normal defaults are the prospective protocol above.
