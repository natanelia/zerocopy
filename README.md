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
insert       │    0.0505 │   0.0566 │ 1.12x faster
batch ins    │    0.0333 │   0.0254 │ 1.31x slower
get          │    0.0095 │   0.0068 │ 1.40x slower
has          │    0.0084 │   0.0060 │ 1.40x slower
delete       │    0.0085 │   0.0123 │ 1.45x faster
iter         │    0.0067 │   0.0028 │ 2.40x slower

--- N=1000 (100 iterations) ---
Operation     │ HAMT (ms) │ Imm (ms) │ Ratio
──────────────┼───────────┼──────────┼────────
insert       │    0.4612 │   0.3750 │ 1.23x slower
batch ins    │    0.3188 │   0.1901 │ 1.68x slower
get          │    0.0830 │   0.0994 │ 1.20x faster
has          │    0.0695 │   0.0840 │ 1.21x faster
delete       │    0.0045 │   0.0030 │ 1.51x slower
iter         │    0.2256 │   0.0217 │ 10.38x slower

--- N=10000 (100 iterations) ---
Operation     │ HAMT (ms) │ Imm (ms) │ Ratio
──────────────┼───────────┼──────────┼────────
insert       │    5.4919 │   4.0373 │ 1.36x slower
get          │    1.6247 │   0.9736 │ 1.67x slower
has          │    0.7715 │   1.0530 │ 1.36x faster
delete       │    0.0058 │   0.0064 │ 1.11x faster
iter         │    1.5197 │   0.3128 │ 4.86x slower

--- Key Advantage ---
HAMT uses SharedArrayBuffer for zero-copy worker sharing.
```

## Scripts

```bash
bun test          # Run tests
bun run bench     # Run benchmarks
bun run build     # Build WASM and bundle
```

## License

MIT
