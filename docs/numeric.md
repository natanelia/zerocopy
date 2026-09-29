# Numeric snapshot operations

`zerocopy/numeric` is an optional entry point for operations over `SharedList<'number'>`.

```ts
import { SharedList } from 'zerocopy';
import { countInRange } from 'zerocopy/numeric';

const values = new SharedList('number').pushMany([1, 2, 3, 4, NaN]);
const count = countInRange(values, 2, 3); // 2
```

The interval includes both bounds. `NaN` values do not match. A `NaN` bound or a lower bound greater than the upper bound returns zero. Infinite bounds are supported. Both signed zeros compare as zero. Non-number bounds and non-numeric lists throw `TypeError`.

The operation reads the selected immutable snapshot directly. It also works with read-only snapshots returned by `initWorker` and shared sessions. It does not allocate in the arena, write shared scratch, copy values into a temporary buffer, or create a result array. Its result is an ordinary JavaScript number.

The first non-empty call compiles a small kernel and creates one instance per `WebAssembly.Memory`. Later calls reuse that instance. Standard WebAssembly SIMD selects the `f64x2` implementation. A separate scalar build is used when the SIMD feature probe fails. Numeric values retain their existing 64-bit representation. The core module and wire format do not change.

Only the numeric entry point loads the numeric kernels. No arbitrary JavaScript callback is moved into Wasm, and ordinary list iteration keeps its existing behavior.

## Reproduce the measurements

```sh
bun install
bun run build:wasm
bun run build:browser
node proofs/numeric-benchmark.mjs
bun proofs/numeric-benchmark.mjs
node proofs/numeric-worker.mjs
```

The benchmark compares existing `forEach`, a branchless scalar Wasm kernel, SIMD Wasm, and the new public API. It alternates execution order, warms each implementation, checks checksums, and records 15 samples per case. Raw results include the runtime, architecture, and commit. Kernel speedup is reported separately from removing per-element JavaScript callbacks. Results from one CPU or runtime are not guarantees for all devices.
