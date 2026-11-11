# Numeric snapshot operations

`zerocopy/numeric` is an optional entry point for operations over `SharedList<'number'>`.

## Import a Float64Array

`fromFloat64(values: Float64Array)` creates a `SharedList<'number'>` from a numeric buffer. It copies the selected view into the current list arena; later changes to the input do not affect the immutable result. A subview's byte offset and length determine the copied range.

<!-- example: list-float64 -->
```ts
import { fromFloat64 } from 'zerocopy/numeric';

const samples = new Float64Array([1.25, -0, 3.5]);
const snapshot = fromFloat64(samples);
samples[0] = 99;

snapshot.get(0);                  // 1.25
Object.is(snapshot.get(1), -0);   // true
const extended = snapshot.push(4.75);
```

The factory uses a bulk byte copy for ordinary `Float64Array` inputs and preserves every stored 64-bit pattern, including signed zero and NaN payloads. Reading a value as a JavaScript number still follows the runtime's normal number behavior. Existing `pushMany` calls keep their current behavior; use this explicit factory when importing a typed numeric buffer. Importing only `zerocopy` does not load this optional factory.

Storage uses the existing little-endian numeric leaf format. Imported snapshots work with ordinary list updates, compaction, and worker transport; the core WASM module and wire format do not change.

Genuine `Float64Array` subclasses and views from another realm are supported. The factory reads intrinsic view metadata and does not call an input iterator, species constructor, or overridden properties. Other typed-array types, ordinary arrays, proxy wrappers, detached views, and views outside a resized buffer throw `TypeError`.

Every nonempty import takes a private fixed snapshot before acquiring the writer or invoking its hooks. The factory reuses at most one MiB of scratch storage for inputs of up to 131,072 elements when that buffer is free. Calls above the limit, and calls that reenter while the reusable buffer is borrowed, use uncached private storage; returned lists always have their own arena bytes. The copied length is captured at the start of the call. Coordinate concurrent writers to a `SharedArrayBuffer` if you need an atomic snapshot of all its elements; copying alone does not provide one. As with other list writes, importing a nonempty buffer requires a writable default list arena.

Custom encoders (`encode` or `encodeRange`) do not transform factory input; allocation and view hooks still apply. Inputs whose bytes exceed the allocator's hard limit of `0x7ffe0000` are rejected before making a private snapshot. Smaller inputs can still exhaust the configured arena capacity.

Performance depends on size, runtime, and prior input types. In the recorded warm comparison, importing 65,536 values after mixed input types took 77.1% less time in Node and 19.2% less in Bun. With only typed-input history, the Node result was uncertain and Bun's estimate was 9.9% lower. At 32 values, the factory took 2.27× as long in Node and 2.35× in Bun. At 1,048,576 values, time fell 68.8% in Node but rose 13.0% in Bun across all six pairs. See the [complete measurements and intervals](../proofs/list-float64-numeric-20261108/README.md) and measure your workload; existing `pushMany` remains an option for tiny inputs and million-value Bun imports. Cold-start performance was not measured.

## Count values in a range

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

## Reproduce the range-count measurements

```sh
bun install
bun run build:wasm
bun run build:browser
node proofs/numeric-benchmark.mjs
bun proofs/numeric-benchmark.mjs
node proofs/numeric-worker.mjs
```

The benchmark compares existing `forEach`, a branchless scalar Wasm kernel, SIMD Wasm, and the new public API. It alternates execution order, warms each implementation, checks checksums, and records 15 samples per case. Raw results include the runtime, architecture, and commit. Kernel speedup is reported separately from removing per-element JavaScript callbacks. Results from one CPU or runtime are not guarantees for all devices.
