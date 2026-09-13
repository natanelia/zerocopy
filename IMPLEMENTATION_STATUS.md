# Incomplete implementation upload

Do not merge this draft.

The candidate implementation was built and tested in the working environment, but
an OpenAI tool safety check blocked the GitHub upload of `arena.ts`. The upload
was stopped. This branch contains the persistent WASM core, but does not yet
integrate the candidate TypeScript wrappers, tests, or proof report. The original
runtime remains active. CI on this draft tests the original runtime, not the full
candidate. A green check here is not evidence that the candidate is integrated.

The complete source, integration patch, report, and raw measurements are delivered
as conversation artifacts. No npm release or merge was performed.

## Local candidate evidence

The complete candidate passed 280 unit tests in 13 files, type checking, the WASM
build, the portable JavaScript build, and declaration generation. A real Node
worker passed 10,000 retained snapshot reads while the writer updated and grew
memory. All 12 public collection types and nested dependencies were included.

Six unchanged snapshot counterexamples failed on the pinned original and passed
on the local candidate: queue forks, singly and doubly linked list forks, ordered
map forks, a mutable object retained by a stack, and a mutable cached map value.
Browser tests were not verified: the local browser could not access localhost
under its environment policy, and the full candidate could not be uploaded for CI.

## Measured local performance

Reference commit: `7aea44447177d37a303ab5c1b26d7c5e00e1c1f7`.
Bun 1.4.2, AssemblyScript 0.28.20, Linux x64, Intel Xeon Platinum 8573C.
Three independent process rounds, 15 measured samples per operation per round,
20 warm-ups, and full output checks outside each timed region. The reference was
also rebuilt with the candidate compiler flags. Ratios below compare against
that matched build, not only the original unoptimized build.

| Operation | Matched base / candidate |
|---|---:|
| Bulk vector creation | 10.24x |
| Indexed singly linked list reads | 21.17x |
| Indexed doubly linked list reads | 10.38x |
| Vector scans | 2.96x |
| Numeric priority queue insertion | 1.77x |
| Numeric stack creation | 1.66x |

These are microbenchmark results, not universal application speedups. Linked list
append, ordered map writes, queue creation, map lookup, and map batch writes are
slower in the candidate. The complete report includes every measured regression.
The linked list interfaces use indexed AVL trees in the candidate, which explains
the indexed-read gain and append cost.

A deterministic immutable-to-immutable batch ablation allocated 347,240 WASM bytes
versus 1,841,408 bytes for scalar updates, an 81.14% reduction. Building a vector
of 4,096 numbers allocated 66,176 bytes versus 2,052,112 in the original vector,
a 96.78% reduction. These are arena allocations, not total process memory.

## Material tradeoffs

The candidate changes the binary layout and worker wire format to v2. It is not
a binary-compatible patch. Published collection values are immutable through the
supported API; internal allocator and staging state remain mutable. A raw shared
buffer is not a read-only security boundary against arbitrary memory writes.

Each arena has one allocating writer and read-only worker attachments. Arenas are
append-only, with an allocation limit below 2 GiB and no per-node reclamation.
A retained snapshot pins its whole arena. Reset creates a new arena; dispose and
auto-GC configuration become deprecated no-ops. Bun transport copies the used
prefix by default, so that fallback is not zero-copy.

## Evidence identifiers

```
original engine SHA256: 8dfcd6c936b4875ebfcd6e13dd214d5b84d2d6301f1c5f6c68704a2f357352fa
local candidate engine SHA256: c408c5a71c9a3e8fb57fd4c010e197d8b4856201e72a677f36dbf6cb8508fba6
local candidate WASM SHA256: 7f042cfbb224e7021e98c26289dcfb166286a12127931d0f2ed5d51419d0375f
benchmark SHA256: c8609253121a9d181ff893f882ef9d7120312bdcb3ed814080471b9d7f7c3c93
```

The local artifacts contain the full immutable implementation. This draft does
not yet contain that full implementation and must not be presented as complete.
