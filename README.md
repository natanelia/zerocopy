# hamt-shared

A high-performance, immutable HAMT (Hash Array Mapped Trie) implementation using WebAssembly with SharedArrayBuffer support for multi-threaded JavaScript applications.

## Features

- Immutable persistent data structure
- WASM-accelerated operations
- SharedArrayBuffer for cross-worker sharing
- Typed value support: `string`, `number`, `boolean`, `object`
- Transient mode for efficient bulk operations (like Immutable.js withMutations)
- Reference counting with automatic cleanup via FinalizationRegistry

## Installation

```bash
bun install
bun run build:wasm
```

## Usage

```typescript
import { HAMT, resetBuffer } from './hamt';

// Create typed HAMTs
const strings = new HAMT('string').set('name', 'Alice');
const numbers = new HAMT('number').set('count', 42);

// Immutable updates
const h1 = new HAMT('string').set('a', '1');
const h2 = h1.set('b', '2');  // h1 unchanged

// Batch operations
const h3 = new HAMT('string').setMany([['x', '1'], ['y', '2']]);
const values = h3.getMany(['x', 'y']);

// Iteration
h3.forEach((v, k) => console.log(k, v));

// Reset buffer between independent operations
resetBuffer();
```

## API

- `new HAMT<T>(type)` - Create HAMT with value type
- `set(key, value)` - Returns new HAMT with key set
- `get(key)` - Get value or undefined
- `has(key)` - Check key existence
- `delete(key)` - Returns new HAMT without key
- `setMany(entries)` / `getMany(keys)` / `deleteMany(keys)` - Batch ops
- `forEach(fn)` / `entries()` / `keys()` / `values()` - Iteration
- `size` - Entry count
- `resetBuffer()` - Clear WASM memory

## Benchmarks

Performance comparison vs Immutable.js:

```
--- N=100 (500 iterations) ---
Operation     │ HAMT (ms) │ Imm (ms) │ Ratio
──────────────┼───────────┼──────────┼────────
insert       │    0.0529 │   0.0770 │ 1.46x faster
batch ins    │    0.0517 │   0.0299 │ 1.73x slower
get          │    0.0086 │   0.0070 │ 1.23x slower
has          │    0.0066 │   0.0047 │ 1.41x slower
delete       │    0.0053 │   0.0049 │ 1.07x slower
iter         │    0.0057 │   0.0026 │ 2.17x slower

--- N=1000 (100 iterations) ---
Operation     │ HAMT (ms) │ Imm (ms) │ Ratio
──────────────┼───────────┼──────────┼────────
insert       │    0.4287 │   0.3591 │ 1.19x slower
batch ins    │    0.3400 │   0.1858 │ 1.83x slower
get          │    0.0747 │   0.0923 │ 1.23x faster
has          │    0.0500 │   0.0802 │ 1.60x faster
delete       │    0.0057 │   0.0030 │ 1.88x slower
iter         │    0.2050 │   0.0236 │ 8.67x slower

--- N=10000 (100 iterations) ---
Operation     │ HAMT (ms) │ Imm (ms) │ Ratio
──────────────┼───────────┼──────────┼────────
insert       │    5.0446 │   4.6805 │ 1.08x slower
get          │    1.4595 │   1.1494 │ 1.27x slower
has          │    0.5963 │   1.0766 │ 1.81x faster
delete       │    0.0986 │   0.0049 │ 20.09x slower
iter         │    1.4951 │   0.3185 │ 4.69x slower

--- N=100000 (100 iterations) ---
Operation     │ HAMT (ms) │ Imm (ms) │ Ratio
──────────────┼───────────┼──────────┼────────
insert       │   73.3939 │  86.8649 │ 1.18x faster
```

## Scripts

```bash
bun test          # Run tests
bun run bench     # Run benchmarks
bun run build     # Build WASM and bundle
```

## License

MIT
