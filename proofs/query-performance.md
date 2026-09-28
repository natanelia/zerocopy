# Query and update performance proof

Run after `bun install`, `bun run build:wasm`, `bun run build:browser`, and
`bunx playwright install --with-deps chromium`:

```sh
node --test proofs/list-read-performance.test.mjs website/tests/task-yield.test.mjs
node proofs/query-performance.mjs
```

The proof builds the merged website baseline (`f3ba7a4`) from Git. It runs the
actual investigation benchmark in Chromium with real dedicated workers and
shared WebAssembly memory. `PERF_BASE` can select another full commit SHA.

Three variants separate the causes of a speed change:

* **Legacy:** the original library, scalar appends, and timer-based task yields.
* **Control:** the original library with the new common task scheduler and the
  existing `pushMany` API. Immutable.js and native code receive the same scheduler.
* **Candidate:** the optimized library with that same scheduler and bulk caller.

The library uses per-list leaf locality rather than one arena cache shared by
interleaved columns. A bounded, arena-local string dictionary reuses immutable
UTF-8 payloads, and decoded-string hits avoid repeated memory-buffer checks.
Unique or large strings can exceed the dictionary budget and take the uncached
path. This is not an unlimited decoded copy of the dataset.

Each variant uses the same input, query functions, independent answer reference,
Immutable.js version, worker count, and sampling protocol. There are two warmups
and seven measured samples per architecture. At 100,000 events, three fresh
contexts per variant rotate their execution order. All raw samples are kept;
results are also grouped by query so a mixed-workload median cannot hide a loss.
Smaller 1,000- and 10,000-event runs are included as smoke measurements.

Results are written to `proofs/query-results/`. `summary.json` contains the full
comparison and per-query medians; `SUMMARY.md` is displayed in Actions. Individual
JSON files retain every original worker-benchmark sample. No timing samples are
removed and no artificial delay is added to a competing implementation.

The native and Immutable.js storage implementations, query predicates, reference
logic, and existing historical benchmark records are unchanged. The new task
yield avoids timer minimum delays for **every** architecture; it must not be
presented as a zerocopy-only speedup. Collection construction and worker startup
remain outside the query phases. The workload is append-only and has repeated
messages; it is not proof of a universal win on arbitrary unique strings, small
collections, every browser, or every device. This is not a memory benchmark.
