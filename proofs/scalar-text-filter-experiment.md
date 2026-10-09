# Conditional scalar last-byte text filter

This is a local source/correctness experiment on exact main
`ad2a19d65a836985a2364b181bc9bd8dce6e42ad`, not an accepted optimization. No
performance measurement, remote write, PR, public API, dependency, format, or
auxiliary-module change was made. The earlier optional SIMD experiment and its
adverse first-use evidence remain separate and unchanged.

## Candidate and rationale

Only `shared-text-reader.as.ts` changes production code: 12 added lines. The
existing scanner tests eight possible starts with a first-byte SWAR mask and
verifies every marked start against the complete query. This candidate adds a
last-byte SWAR intersection for 2–16-byte needles when that approximate first
mask contains at least two marked starts. Zero and singleton masks skip the
additional data load. Broadcast query/mask preparation happens once per string,
and only if the string has at least eight legal starts and the needle has more
than one byte.

The last position was chosen before measurement because it rejects long shared
prefixes such as `aaaaaaab` in an all-`a` input. A fixed second-position filter
cannot reject those prefixes. This is a structural choice, not a claim that the
last position is universally more selective. Both endpoints can pass while an
interior byte fails (`abaa` in all `a`), and this candidate then adds work without
rejecting anything. No frequency sampling, needle-dependent position search,
length threshold, or adaptive policy is introduced.

The density guard counts *marked* SWAR bits, not exact first-byte matches. Borrow
can mark a neighboring nonmatch and can therefore activate the filter for a
chunk with only one true first-byte match. Complete query verification remains
mandatory for every surviving bit.

## Bounds, masks, and fallback

Let `p` be the chunk start, `s` the needle size, and `e` the end of string bytes.
The existing loop admits a chunk only when `p + 8 <= e - s + 1`. Therefore
`p + (s - 1) + 8 <= e`. An eight-byte load at the last-byte offset lies completely
inside the string, including at the final memory byte. The same proof would
permit any position from zero through `s - 1`. Supported arenas already bound
addresses below 2 GiB; the candidate does not extend raw-pointer validation.

At a real match, both zero-byte tests mark the same start bit. Each SWAR result
may contain false positive bits but cannot omit a zero byte, so intersecting the
two masks cannot discard a real match. The query byte and its fold byte are
extracted from the same little-endian packed word, including sizes 8, 9, and 16.
Only the supplied per-byte mask is applied. The existing complete verifier
retains its exact-mask and tail handling.

The additional lookahead does not modify `seen`, the pointer progression, or the
Unicode fallback scan. On a miss, the original first-word/remainder/final-tail
walk still examines every original byte for a high bit. An insensitive miss in
a string containing non-ASCII bytes still returns -1; an exact byte match still
returns 1, as before. No scratch write, allocation, new import, or memory growth
is added.

## Exact work and costs

The candidate adds a setup guard for every eligible-length call, two byte
extractions/broadcast multiplications when a full chunk exists, and one
needle-size/density guard per chunk. A filtered chunk adds one unaligned i64
load, one fold OR/XOR, one SWAR zero-byte test, and one mask intersection. It
removes complete-verifier work only for rejected marked starts. Tiny strings
avoid the broadcasts and data filter but still execute the setup condition.
Zero/single-candidate long strings still pay setup and loop-guard work.

The counters below come from separate instrumented WASM copies of both exact
reader sources, with production and instrumented return values cross-checked.
They are executed source-work counts, not timings or hardware instruction counts.
`Extra loads` are only the candidate's added filter loads; baseline first-word
loads and fallback scans remain common. Inputs below have 1,024 bytes except
where noted.

| Input / query | Verifier calls, baseline → candidate | Extra loads | Interpretation |
| --- | ---: | ---: | --- |
| `ok!` / `ok` | 1 → 1 | 0 | Tiny early hit; extra setup condition only |
| 12 `x` / `needle` | 0 → 0 | 0 | Seven legal starts, no chunk |
| all `x` / one byte `n` | 0 → 0 | 0 | One-byte control; chunk guards still added |
| all `x` / `needle` | 0 → 0 | 0 | Zero candidates; broadcasts and guards added |
| repeated `nxxxxxxx` / `needle` | 128 → 128 | 0 | Singleton control; no verifier saving |
| repeated `nxnxxxxx` / `needle` | 256 → 2 | 127 | Smallest true density that activates filter |
| all `a` / `ab` | 1023 → 7 | 127 | Scalar tail remains |
| all `a` / `aaaaaaab` | 1017 → 1 | 127 | Word-verifier loads 1017 → 1 |
| all `a` / 15 `a` then `b` | 1009 → 1 | 126 | Word-verifier loads 2018 → 2 |
| all `a` / `abaa` | 1021 → 1021 | 127 | Adverse endpoint-passing control |
| all `a` / `aaaa` | 1 → 1 | 1 | Adverse early-hit control |
| 1023 `a` then `b` / `aaaaaaab` | 1017 → 1 | 127 | Late match preserved |
| all `A`, insensitive / `aaaaaaab` | 1017 → 1 | 127 | ASCII folding preserved |
| 1021 `a` then `中`, insensitive / `aaaaaaab` | 1017 → 1 | 127 | Exact result remains Unicode fallback -1 |
| 14 `a` / `aaaaaaab` | 7 → 7 | 0 | Seven-start boundary |
| 15 `a` / `aaaaaaab` | 8 → 0 | 1 | Eight-start boundary |
| 16 `a` / `aaaaaaab` | 9 → 1 | 1 | Nine-start boundary |

The actual emitted `textContains16` body grows 852 → 1,019 bytes. Its 80 sibling
function bodies are byte-identical, including the batch wrapper. Every non-code
WASM section, import, and export is byte-identical. The mandatory core grows
26,118 → 26,285 bytes (+167); all nine legacy core filenames receive the same
bytes, so the 12-WASM file set grows by 1,503 raw bytes. The 12-module portable JS
output grows 227,744 → 227,968 bytes (+224) from its embedded core. There is no
additional module or loader, but the larger existing module can still affect
compile/startup cost. No zero-startup-cost claim is made.

## Correctness and reproducibility

Node 22.23.3 and Bun 1.4.2 each passed 661,056 exact-return cases and 512 batch-mask
cases against an independent byte oracle. The three tested implementations are
baseline core, candidate core, and an auxiliary *proof-only* candidate with a
bounds assertion around every string byte/word load. These assertions verify
logical bounds even when unused memory follows the string. Invalid query/count
inputs return before their invalid header/address is read. Original memory
bytes remain unchanged after each test case.

Coverage includes 1–16-byte queries, 0/1/7/8/9/15/16/17/23/24/25/31/32/33/47/48/49
legal starts, every final-memory alignment, dense and sparse prefixes, every
possible byte at every query position, punctuation and nulls, borrow-provoking
neighbors, 40,000 seeded arbitrary-byte/mask cases, and Unicode fallback tails.
The public proof additionally covers JS UTF-16 semantics, surrogate halves,
case expansion/context, cached predicates, shared/copied attachments, and actual
workers across owner memory growth.

Both baseline and candidate passed all 12 unchanged Node text/kernel/batch
proofs. The candidate's existing SharedList Vitest suite passed 23/23 under Bun.
The standard WASM and portable builds, declarations, and text-search consumer
typecheck passed. A cross-build format proof verified identical 131,072-byte
stored arenas, format 4, eight producer/reader/shared-or-copy combinations, and
144 public compiled predicates. The full repository suite, browser engines, ARM,
packaging, and performance have not been run for this candidate.

The first artifact test incorrectly expected both text exports to have different
bodies; the emitted batch wrapper actually remains identical. That expectation
was corrected to the stronger single-function assertion. An initial direct Bun
`node:test` invocation was unsupported; the synchronous proof now uses a direct
assertion runner under Bun and Node's normal runner under Node. Both original
failure logs are retained. An early browser build was attempted before the
asynchronous complete WASM build finished and failed for a missing geometry
artifact; the completed sequential rebuild passed. These were proof orchestration
issues, not hidden product failures or timing retries.

Reproduce from the experiment worktree with the pinned task-local Node/Bun:

1. Install/reuse the pinned package dependencies, then run
   `node proofs/scalar-text-filter-build.mjs`. It extracts the exact baseline
   AssemblyScript sources and builds both the baseline and bounds-checking proof.
2. Run the unchanged `build:wasm`, `build:browser`, and `build:types` scripts and
   the text-search consumer typecheck.
3. Run `node --test proofs/scalar-text-filter-correctness.mjs` and
   `bun proofs/scalar-text-filter-correctness.mjs`.
4. Build a separate clean ad2 checkout with its unchanged standard scripts for
   the baseline portable entry. Run the unchanged `text-kernel.mjs`,
   `text-search.mjs`, and `text-batch.mjs`
   proofs against each portable/core build, using their existing entry overrides.
5. Run `node proofs/scalar-text-filter-census.mjs` for counters. This creates only
   proof modules in the ignored build directory and never reads a clock.
6. Pass the baseline/candidate portable URLs to
   `proofs/scalar-text-filter-format.mjs` for cross-build storage checks.

The baseline extracted into a nested proof directory reproduced the original
root-built core byte-for-byte. Build flags are the unchanged imported shared
memory, initial 2/maximum 65536, threads, stub runtime, optimize level 3, shrink
level 0. AssemblyScript is 0.28.20. Production byte pins:

| Artifact | SHA-256 |
| --- | --- |
| Baseline reader | `7bb347ddb2736b5dc56f633b371512f2008f3c750788da92fe3e67a4f35d15c3` |
| Candidate reader | `239e01fbfb30399df45dc91e57db2fae941f862653fab817a1454112da63e8a4` |
| Baseline core | `b4c1f8d06d67abb2ff77fd615d92831ebb6a317cd2e4d8432a2bb09896100ed4` |
| Candidate core | `383a99278cb1eae78a164489493c71eeb2a0cea3b3edb3db47349fe5e54b0647` |

## Bounded proposed screen, not executed

The work reduction is sufficient to justify one independently reviewed scalar
screen; the adverse controls make promotion without measurement indefensible.
Keep this experiment distinct from SIMD and preserve every earlier result.

Use one clean Node 22.23.3 Linux x64 lane, normal flags, with four path aliases:
A0/A1 for exact ad2 and B0/B1 for this exact candidate. Require byte-identical
inventories within each alias pair. Gate on fresh standard correctness and the
proofs above before any calibration. No Bun, browser, ARM, or kernel-only timing
in this first screen, and no tuned source changes after observing results.

Freeze 12 public query-plus-scan rows: tiny early hit; seven-start dense miss;
eight-start dense miss; long one-byte miss; long zero-candidate miss; long
singleton-per-chunk miss; long two-candidate-per-chunk miss; dense last-byte miss
at lengths 8 and 16; dense endpoint-passing miss; dense early hit; insensitive
Unicode-tail miss. Use 1,024 rows per scan, fixed values and access order, and
retain fixture hashes. Do not pool the rows. All are structural classes from
the premeasurement census; none is selected using observed latency.

A concrete bounded extension of the existing text-screen design is eight fresh
warm processes plus eight cold blocks of four fresh processes, 40 processes in
all, within a fixed 240-second timing ceiling separate from correctness. Rotate
four-alias Williams orders and case order; retain the two same-byte A/A controls.
Use the existing six-batch calibration/floor rules, drift flags, and pointwise
paired-log analysis, with the process as the independent unit (df=7). Freeze the
existing 2% warm materiality margin. Validity, within-margin evidence, improvement,
loss, and unresolved results remain separate labels. Cap/floor failure, an A/A
interval excluding 1, or the existing drift rules mark the row inconclusive;
never subtract A/A bias or retry until favorable.

Retain the existing five cold lifecycle stages independently: ordinary import,
first numeric construction, unused query compilation, first valid search on the
first string memory, and first valid search on a second memory. This captures
existing-core compile/instantiate effects in import/construction and conditional
search work in later stages. Preserve raw nanoseconds, absolute deltas, and
intervals; no cold percentage-only acceptance. Cold stages are correlated within
each process and not extra independent replicates.

Freeze the actual runner, source/build inventories, fixture manifest, accounting,
timeout/partial retention, and every statistical rule before execution. On budget
expiry, retain incomplete evidence and stop. A gain confined to dense shared
prefixes cannot establish a general win; sparse, tiny, one-byte, dense early-hit,
endpoint-passing, and cold results must all remain prominent.
