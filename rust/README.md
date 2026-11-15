# Rust kernel contract

Build distributable kernels with `bun run build:wasm` (or `node scripts/build-wasm.mjs`), using the exact compiler and target in `rust-toolchain.toml`. The crate has no dependencies and uses `no_std`; users of the published npm package do not need Rust.

**Cargo's raw `.wasm` is an intermediate artifact. Never instantiate, copy, or publish it directly.** The mandatory build step promotes state placeholders to instance-local WebAssembly globals, checks the public interface against `wasm-abi.json`, optimizes, and audits the result. Only the audited files in the repository root are embedded by the portable JavaScript build.

## Memory and ownership

Each module imports the existing shared `env.memory` and no functions. Arguments and results are scalar numbers: addresses, lengths, flags, counts, and numeric values. There is no `wasm-bindgen`, serialization layer, Rust string, Rust heap allocator, or second payload buffer.

The existing format remains version 4. Published nodes begin at byte 65,536, retain their established layouts, and never move or change. Persistent updates allocate fresh nodes and copy only the records the existing data structures require. Bytes below 65,536 remain writer scratch. Readers cannot allocate, grow memory, or modify scratch or published bytes.

`memory.rs` accesses externally owned memory through raw pointers. Byte operations use volatile accesses, which permit address zero (required by the legacy direct-reader ABI). Wider unaligned operations separately handle zero; ordinary records use unaligned scalar loads/stores. Volatile does **not** provide synchronization. Correctness relies on the existing single-writer, immutable-publication contract. Do not introduce mutable Rust references or owned slices into the shared arena.

Allocator state starts at `HEAP_START`; every update checks `HEAP_START <= heap_end <= MAX_END`. `heap_end()` exposes this invariant to LLVM so fresh-record stores do not acquire redundant null checks. Any new allocation path must preserve it, including overflow checks before updating state.

## Per-instance state

Rust statics ordinarily reside in linear memory, which would share writer metadata between workers. The `state_load_*` and `state_store_*` helpers therefore use fixed, volatile compiler placeholders. `scripts/rust-wasm.mjs` rewrites their constant accesses into genuine Wasm globals with explicit initial values:

| Placeholder offsets | Private state |
| --- | --- |
| 2048–2079 | Allocator position/capacity, map batch counters, writer directory state |
| 2112–2143 | Geometry extrema, initially positive/negative infinity |

The build rejects residual state addresses, data segments, start functions, host-function imports, indirect-call tables, and **any** use of a linear-memory stack, including in writers. It follows the reader call graph and rejects reachable stores, memory copies/fills, or memory growth. Unknown instruction families require explicit audit support. Tests deliberately inject these regressions to check that the guards fail.

Keep functions in scalar locals. A seemingly harmless address-taken local or aggregate can cause LLVM to spill onto the linear stack. That stack would be shared by attached workers; do not disable the guard to make such a build pass.

## Modules

| File | Responsibility |
| --- | --- |
| `maps.rs` | Hash/radix maps, ordered-map links, journal and staged writer commands |
| `collections.rs` | Vectors, tails, block sequences, cons cells and heaps |
| `readers.rs` | Hash candidates and packed UTF-8 text predicates |
| `json.rs` | Bounded selectors over existing JSON UTF-8 records |
| `numeric.rs` | Scalar and separately built SIMD range reductions |
| `geometry.rs` | Scalar bounding boxes with instance-local extrema |

JSON selectors expect valid `JSON.stringify` output, as produced by the object codec. They are not general parsers/validators for arbitrary input. Keys are compared exactly, including hash-collision checks. Only selected scalar strings and decimal/exponent numbers are converted to JavaScript values. Safe integers and string equality predicates need no intermediate string. Full object creation remains an explicit native JSON parse; views never freeze the resulting tree unless requested.

Run `node --test scripts/rust-wasm.node.mjs` for build guards and `node proofs/rust-migration-20261115/workers.mjs` for concurrent attachment/read checks. The migration's parity proof additionally verifies both directions of compatibility with an AssemblyScript baseline; its README describes baseline preparation and performance reproduction.
